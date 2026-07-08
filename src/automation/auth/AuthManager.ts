import type { Page } from 'patchright'
import { saveSessionData, saveDashboardVariant } from '../../helpers/ConfigLoader'
import type { MicrosoftRewardsBot } from '../../index'
import { getCurrentContext } from '../../context/ExecutionContext'
import { URLS } from '../DashboardSelectors'
import type { DashboardVariant } from '../../types/Dashboard'

import { AccountLockedError } from './AuthErrors'
import { CodeStrategy } from './strategies/CodeStrategy'
import { EmailStrategy } from './strategies/EmailStrategy'
import { MobileStrategy } from './strategies/MobileStrategy'
import { PasswordlessStrategy } from './strategies/PasswordlessStrategy'
import { RecoveryStrategy } from './strategies/RecoveryStrategy'
import { TotpStrategy } from './strategies/TotpStrategy'

import type { Account } from '../../types/Account'

type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'SIGN_IN_ANOTHER_WAY'
    | 'SIGN_IN_ANOTHER_WAY_EMAIL'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'RECOVERY_EMAIL_INPUT'
    | 'ACCOUNT_LOCKED'
    | 'ERROR_ALERT'
    | '2FA_TOTP'
    | 'LOGIN_PASSWORDLESS'
    | 'GET_A_CODE'
    | 'GET_A_CODE_2'
    | 'OTP_CODE_ENTRY'
    | 'UNKNOWN'
    | 'CHROMEWEBDATA_ERROR'
    | 'UNEXPECTED_NOTICE'

export class AuthManager {
    emailStrategy: EmailStrategy
    passwordlessStrategy: PasswordlessStrategy
    totpStrategy: TotpStrategy
    codeStrategy: CodeStrategy
    recoveryStrategy: RecoveryStrategy

    private readonly selectors = {
        primaryButton: 'button[data-testid="primaryButton"]',
        secondaryButton: 'button[data-testid="secondaryButton"]',
        emailIcon: '[data-testid="tile"]:has(svg path[d*="M5.25 4h13.5a3.25"])',
        emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"]',
        recoveryEmail: '[data-testid="proof-confirmation"]',
        passwordIcon: '[data-testid="tile"]:has(svg path[d*="M11.78 10.22a.75.75"])',
        accountLocked: '#serviceAbuseLandingTitle',
        errorAlert: 'div[role="alert"]',
        passwordEntry: '[data-testid="passwordEntry"]',
        emailEntry: 'input#usernameEntry',
        kmsiVideo: '[data-testid="kmsiVideo"]',
        passKeyVideo: '[data-testid="biometricVideo"]',
        passKeyError: '[data-testid="registrationImg"]',
        passwordlessCheck: '[data-testid="deviceShieldCheckmarkVideo"]',
        totpInput: 'input[name="otc"]',
        totpInputOld: 'form[name="OneTimeCodeViewForm"]',
        identityBanner: '[data-testid="identityBanner"]',
        viewFooter: '[data-testid="viewFooter"] >> [role="button"]',
        otherWaysToSignIn: '[data-testid="viewFooter"] span[role="button"]',
        otpCodeEntry: '[data-testid="codeEntry"]',
        backButton: '#back-button',
        bingProfile: '#id_n',
        requestToken: 'input[name="__RequestVerificationToken"]',
        requestTokenMeta: 'meta[name="__RequestVerificationToken"]',
        otpInput: 'div[data-testid="codeEntry"]'
    } as const

    constructor(private bot: MicrosoftRewardsBot) {
        this.emailStrategy = new EmailStrategy(this.bot)
        this.passwordlessStrategy = new PasswordlessStrategy(this.bot)
        this.totpStrategy = new TotpStrategy(this.bot)
        this.codeStrategy = new CodeStrategy(this.bot)
        this.recoveryStrategy = new RecoveryStrategy(this.bot)
    }

    async login(page: Page, account: Account) {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting login process')

            // Enter via the Rewards sign-in/enrollment scenario, NOT /dashboard. The
            // `createuser?...&userScenarioId=anonsignin` entry forces Microsoft's full
            // OAuth round-trip, which is what mints the rewards.bing.com session cookie.
            // Starting at /dashboard assumes an already-authenticated session and leaves
            // legacy accounts stranded on /welcome with an UNauthenticated session
            // (getuserinfo → HTTP 401). The reference bot fixed this exact "stuck login"
            // bug with the same change (its commit 64cd22d). This is variant-agnostic:
            // both legacy and Next.js accounts need the session established here, then
            // idru=/ redirects each to its own dashboard.
            await page
                .goto('https://rewards.bing.com/createuser?idru=%2F&userScenarioId=anonsignin', {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => {})
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.browser.utils.disableFido(page)

            const maxIterations = 25
            let iteration = 0
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0
            // Tracks whether the last completed action was accepting the KMSI prompt.
            // Microsoft sometimes opens a passkey registration page immediately after KMSI
            // acceptance, which can trigger an OS-level dialog that closes the page.
            // In that scenario we treat the page closure as a successful login.
            let kmsiJustAccepted = false
            // Track forward progress so that an OS-level credential dialog (Windows Hello /
            // passkey) that forces the page closed is treated as recoverable instead of fatal.
            let emailEntered = false
            let passwordEntered = false

            while (iteration < maxIterations) {
                if (page.isClosed()) {
                    // TODO(review) [SEC]: treating a page closure as login success can
                    // mint an empty session. Cannot gate cleanly on a positive signal:
                    // the page is already closed (isBingSignedIn needs a live bing.com
                    // page) and there is no existing helper to assert an auth cookie on
                    // a closed context. Left as-is to avoid destabilising the login flow.
                    if (kmsiJustAccepted || emailEntered || passwordEntered) {
                        const reason = kmsiJustAccepted
                            ? 'KMSI acceptance'
                            : passwordEntered
                              ? 'password entry'
                              : 'email entry'
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LOGIN',
                            `Page closed after ${reason} — Microsoft triggered OS-level dialog (Windows Hello / passkey), attempting best-effort session recovery`
                        )
                        break
                    }
                    throw new Error('Page closed unexpectedly')
                }

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `State check iteration ${iteration}/${maxIterations}`)

                const state = await this.detectCurrentState(page, account)
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Current state: ${state}`)

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `State transition: ${previousState} → ${state}`)
                }

                // UNKNOWN is intentionally INCLUDED here: a page that stays UNKNOWN
                // (e.g. a Microsoft dead-end/interstitial we have no selector for)
                // used to spin every iteration doing nothing until the whole login
                // hit maxIterations and failed. Counting it lets the reload recovery
                // below kick in and unstick the run.
                if (state === previousState && state !== 'LOGGED_IN') {
                    sameStateCount++
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN',
                        `Same state count: ${sameStateCount}/4 for state "${state}"`
                    )
                    if (sameStateCount >= 4) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `Stuck in state "${state}" for 4 loops, refreshing page`
                        )
                        await page.reload({ waitUntil: 'domcontentloaded' })
                        await this.bot.utils.wait(3000)
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Successfully logged in')
                    break
                }

                const shouldContinue = await this.handleState(state, page, account)
                if (!shouldContinue) {
                    throw new Error(`Login failed or aborted at state: ${state}`)
                }

                // Track forward progress — used to detect graceful page closures caused
                // by OS-level credential dialogs (Windows Hello / passkey registration).
                if (state === 'EMAIL_INPUT') emailEntered = true
                if (state === 'PASSWORD_INPUT') passwordEntered = true

                // Track whether KMSI was just the last processed state.
                // Reset on any meaningful forward progress to avoid masking real errors.
                if (state === 'KMSI_PROMPT') {
                    kmsiJustAccepted = true
                } else if (state !== 'UNKNOWN') {
                    kmsiJustAccepted = false
                }

                await this.bot.utils.wait(1000)
            }

            if (iteration >= maxIterations) {
                throw new Error('Login timeout: exceeded maximum iterations')
            }

            // If the page was closed after KMSI acceptance, finalization will be
            // best-effort only (gotos will no-op, cookies may be partially saved).
            // TODO(review) [SEC]: same caveat as the in-loop page-close handler —
            // saving cookies from a closed context here is treated as success without
            // a positive auth-cookie check. No clean existing signal to gate on, so
            // left unchanged to avoid breaking the login flow.
            if (page.isClosed()) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    'Page is closed at finalization — attempting best-effort session save'
                )
                try {
                    const cookies = await page.context().cookies()
                    await saveSessionData(this.bot.config.sessionPath, cookies, account.email, this.bot.isMobile)
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN',
                        `Saved ${cookies.length} cookies from closed page context`
                    )
                } catch {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not save cookies from closed context')
                }
                return
            }

            await this.finalizeLogin(page, account)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async detectCurrentState(page: Page, account?: Account): Promise<LoginState> {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

        const url = new URL(page.url())
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Current URL: ${url.hostname}${url.pathname}`)

        if (url.hostname === 'chromewebdata') {
            this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', 'Detected chromewebdata error page')
            return 'CHROMEWEBDATA_ERROR'
        }

        if (url.hostname === 'account.live.com' && url.pathname.includes('/interrupt/passkey')) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Detected passkey enrollment interrupt')
            return 'PASSKEY_ERROR'
        }

        const isLocked = await this.checkSelector(page, this.selectors.accountLocked)
        if (isLocked) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Account locked selector found')
            return 'ACCOUNT_LOCKED'
        }

        // TODO(review) [SEC]: this infers LOGGED_IN from the hostname alone, which can
        // false-positive on a signed-out rewards/account page. Not gated here because
        // isBingSignedIn only validates the bing.com header (absent on rewards.bing.com /
        // account.microsoft.com) so using it would false-negative and break real logins,
        // and there is no clean existing auth-cookie signal. Left as-is intentionally.
        if (url.hostname === 'rewards.bing.com' || url.hostname === 'account.microsoft.com') {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'On rewards/account page, assuming logged in')
            return 'LOGGED_IN'
        }

        const stateChecks: Array<[string, LoginState]> = [
            [this.selectors.errorAlert, 'ERROR_ALERT'],
            [this.selectors.passwordEntry, 'PASSWORD_INPUT'],
            [this.selectors.emailEntry, 'EMAIL_INPUT'],
            [this.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
            [this.selectors.kmsiVideo, 'KMSI_PROMPT'],
            [this.selectors.passKeyVideo, 'PASSKEY_VIDEO'],
            [this.selectors.passKeyError, 'PASSKEY_ERROR'],
            [this.selectors.passwordIcon, 'SIGN_IN_ANOTHER_WAY'],
            [this.selectors.emailIcon, 'SIGN_IN_ANOTHER_WAY_EMAIL'],
            [this.selectors.emailIconOld, 'SIGN_IN_ANOTHER_WAY_EMAIL'],
            [this.selectors.passwordlessCheck, 'LOGIN_PASSWORDLESS'],
            [this.selectors.totpInput, '2FA_TOTP'],
            [this.selectors.totpInputOld, '2FA_TOTP'],
            [this.selectors.otpCodeEntry, 'OTP_CODE_ENTRY'], // PR 450
            [this.selectors.otpInput, 'OTP_CODE_ENTRY'] // My Fix
        ]

        const results = await Promise.all(
            stateChecks.map(async ([sel, state]) => {
                const visible = await this.checkSelector(page, sel)
                return visible ? state : null
            })
        )

        const visibleStates = results.filter((s): s is LoginState => s !== null)
        if (visibleStates.length > 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Visible states: [${visibleStates.join(', ')}]`)
        }

        const [identityBanner, primaryButton, passwordEntry] = await Promise.all([
            this.checkSelector(page, this.selectors.identityBanner),
            this.checkSelector(page, this.selectors.primaryButton),
            this.checkSelector(page, this.selectors.passwordEntry)
        ])

        if (identityBanner && primaryButton && !passwordEntry && !results.includes('2FA_TOTP')) {
            const codeState = account?.password ? 'GET_A_CODE' : 'GET_A_CODE_2'
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `Get code state detected: ${codeState} (has password: ${!!account?.password})`
            )
            results.push(codeState)
        }

        let foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0) {
            // Before giving up as UNKNOWN, check for Microsoft's "dead-end" notice
            // page ("You have reached a page that is not normally shown / Microsoft
            // will never ask you to copy or share this URL"). It carries none of the
            // known form selectors, so it used to fall through to UNKNOWN and spin
            // the login loop until it timed out.
            if (await this.pageHasUnexpectedNotice(page)) {
                this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', 'Microsoft "page not normally shown" notice detected')
                return 'UNEXPECTED_NOTICE'
            }
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'No matching states found')
            return 'UNKNOWN'
        }

        if (foundStates.includes('ERROR_ALERT')) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `ERROR_ALERT found - hostname: ${url.hostname}, has 2FA: ${foundStates.includes('2FA_TOTP')}`
            )
            if (url.hostname !== 'login.live.com') {
                foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
            }
            if (foundStates.includes('2FA_TOTP')) {
                foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
            }
            if (foundStates.includes('ERROR_ALERT')) return 'ERROR_ALERT'
        }

        const priorities: LoginState[] = [
            'ACCOUNT_LOCKED',
            'PASSKEY_VIDEO',
            'PASSKEY_ERROR',
            'KMSI_PROMPT',
            'PASSWORD_INPUT',
            'EMAIL_INPUT',
            'SIGN_IN_ANOTHER_WAY', // Prefer password option over email code
            'SIGN_IN_ANOTHER_WAY_EMAIL',
            'OTP_CODE_ENTRY',
            'GET_A_CODE',
            'GET_A_CODE_2',
            'LOGIN_PASSWORDLESS',
            '2FA_TOTP'
        ]

        for (const priority of priorities) {
            if (foundStates.includes(priority)) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Selected state by priority: ${priority}`)
                return priority
            }
        }

        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `Returning first found state: ${foundStates[0]}`)
        return foundStates[0] as LoginState
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 200 })
            .then(() => true)
            .catch(() => false)
    }

    /**
     * Detect Microsoft's generic "this page is not normally shown" dead-end notice.
     * Matched by visible text rather than a selector, because the page carries no
     * stable testid. Only consulted when no real login form selector matched, so
     * the extra innerText read does not run on every state check.
     */
    private async pageHasUnexpectedNotice(page: Page): Promise<boolean> {
        try {
            const text = await page
                .evaluate(() => (document.body && document.body.innerText ? document.body.innerText : ''))
                .catch(() => '')
            const t = text.toLowerCase()
            return (
                t.includes('not normally shown') ||
                t.includes('copy or share this url') ||
                t.includes('never ask you to copy')
            )
        } catch {
            return false
        }
    }

    private async clickUsePasswordOption(page: Page): Promise<boolean> {
        const passwordTile = page.locator(this.selectors.passwordIcon).first()
        if (await passwordTile.isVisible().catch(() => false)) {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting password sign-in tile')
            await passwordTile.click().catch(async () => {
                await this.bot.browser.utils.ghostClick(page, this.selectors.passwordIcon)
            })
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
            return true
        }

        for (const label of ['Use your password', 'Use my password']) {
            const links = page.getByText(label, { exact: false })
            const count = await links.count().catch(() => 0)

            for (let i = 0; i < count; i++) {
                const link = links.nth(i)
                const visible = await link.isVisible().catch(() => false)
                if (!visible) continue

                this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Selecting "${label}"`)
                await link.click().catch(async () => {
                    await this.bot.browser.utils.ghostClick(page, this.selectors.viewFooter)
                })
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                return true
            }
        }

        return false
    }

    private async clickOtherSignInMethods(page: Page): Promise<boolean> {
        const footerButtons = page.locator(this.selectors.otherWaysToSignIn)
        const count = await footerButtons.count().catch(() => 0)

        for (let i = count - 1; i >= 0; i--) {
            const button = footerButtons.nth(i)
            const visible = await button.isVisible().catch(() => false)
            if (!visible) continue

            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting alternative sign-in methods')
            await button.click().catch(async () => {
                await this.bot.browser.utils.ghostClick(page, this.selectors.otherWaysToSignIn)
            })
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
            return true
        }

        return false
    }

    private async handleState(state: LoginState, page: Page, account: Account): Promise<boolean> {
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Processing state: ${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = 'This account has been locked! Remove from config and restart!'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new AccountLockedError(msg, 'service_abuse')
            }

            case 'ERROR_ALERT': {
                const alertEl = page.locator(this.selectors.errorAlert)
                const errorMsg = await alertEl.innerText().catch(() => 'Unknown Error')
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', `Account error: ${errorMsg}`)
                throw new Error(`Microsoft login error: ${errorMsg}`)
            }

            case 'LOGGED_IN':
                return true

            case 'EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Entering email')
                const emailResult = await this.emailStrategy.enterEmail(page, account.email)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after email entry')
                })
                // Don't assert success: on 'error' the field wasn't found/submitted, so
                // just warn and let the next loop re-detect the real state.
                if (emailResult === 'error') {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        'Email entry did not complete cleanly — re-detecting login state'
                    )
                } else {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Email entered successfully')
                }
                return true
            }

            case 'PASSWORD_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Entering password')
                const passwordResult = await this.emailStrategy.enterPassword(page, account.password)
                // Press Escape immediately after password submission to dismiss any
                // browser-level save-password banner or Windows Hello prompt that Edge
                // injects — this prevents the OS credential dialog from closing the page.
                await page.keyboard.press('Escape').catch(() => {})
                await this.bot.utils.wait(300)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after password entry')
                })
                // Don't assert success: on 'error' the field wasn't found/submitted, so
                // just warn and let the next loop re-detect the real state.
                if (passwordResult === 'error') {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        'Password entry did not complete cleanly — re-detecting login state'
                    )
                } else {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Password entered successfully')
                }
                return true
            }

            case 'GET_A_CODE': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Attempting to bypass "Get code" page')

                if (await this.clickUsePasswordOption(page)) {
                    return true
                }

                if (await this.clickOtherSignInMethods(page)) {
                    return true
                }

                // First check: look for "Use your password" — a Fluent UI span[role="button"] OUTSIDE viewFooter
                // Must use Playwright .click() (not native DOM .click()) because Fluent UI
                // uses React synthetic events that only fire on proper mouse event sequences
                const anyRoleButton = await page
                    .waitForSelector('span[role="button"]', { state: 'visible', timeout: 3000 })
                    .catch(() => null)

                if (anyRoleButton) {
                    const buttons = page.locator('span[role="button"]')
                    const count = await buttons.count()

                    for (let i = 0; i < count; i++) {
                        const btn = buttons.nth(i)
                        const isVisible = await btn.isVisible().catch(() => false)
                        if (!isVisible) continue

                        const isInFooter = await btn
                            .evaluate(el => !!el.closest('[data-testid="viewFooter"]'))
                            .catch(() => true)

                        if (!isInFooter) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'LOGIN',
                                '"Use password" link found on page, clicking directly (skipping "Other ways")'
                            )
                            await btn.click()
                            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                            return true
                        }
                    }
                }

                // Second check: is the password tile icon already visible?
                const passwordIconDirect = await page
                    .waitForSelector(this.selectors.passwordIcon, { state: 'visible', timeout: 1500 })
                    .catch(() => null)

                if (passwordIconDirect) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '"Use password" tile found, clicking directly')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.passwordIcon)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    return true
                }

                // Third check: password entry field already visible
                const passwordEntryDirect = await page
                    .waitForSelector(this.selectors.passwordEntry, { state: 'visible', timeout: 1000 })
                    .catch(() => null)

                if (passwordEntryDirect) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN',
                        'Password entry field already visible, no bypass needed'
                    )
                    return true
                }

                // Fallback: try to find "Other ways to sign in" link
                const otherWaysLink = await page
                    .waitForSelector(this.selectors.otherWaysToSignIn, { state: 'visible', timeout: 3000 })
                    .catch(() => null)

                if (otherWaysLink) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Found "Other ways to sign in" link')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.otherWaysToSignIn)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN',
                            'Network idle timeout after clicking other ways'
                        )
                    })
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '"Other ways to sign in" clicked')
                    return true
                }

                // Fallback: try the generic viewFooter selector
                const footerLink = await page
                    .waitForSelector(this.selectors.viewFooter, { state: 'visible', timeout: 2000 })
                    .catch(() => null)

                if (footerLink) {
                    await this.bot.browser.utils.ghostClick(page, this.selectors.viewFooter)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after footer click')
                    })
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Footer link clicked')
                    return true
                }

                // If no links found, try clicking back button
                const backBtn = await page
                    .waitForSelector(this.selectors.backButton, { state: 'visible', timeout: 2000 })
                    .catch(() => null)

                if (backBtn) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'No sign in options found, clicking back button')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.backButton)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after back button')
                    })
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not find way to bypass Get Code page')
                return true
            }

            case 'GET_A_CODE_2': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Handling "Get a code" flow')
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after primary button click')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Initiating code login handler')
                await this.codeStrategy.handle(page)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Code login handler completed successfully')
                return true
            }

            case 'SIGN_IN_ANOTHER_WAY_EMAIL': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting "Send a code to email"')

                const emailSelector = await Promise.race([
                    this.checkSelector(page, this.selectors.emailIcon).then(found =>
                        found ? this.selectors.emailIcon : null
                    ),
                    this.checkSelector(page, this.selectors.emailIconOld).then(found =>
                        found ? this.selectors.emailIconOld : null
                    )
                ])

                if (!emailSelector) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Email icon not found')
                    return false
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    `Using ${emailSelector === this.selectors.emailIcon ? 'new' : 'old'} email icon selector`
                )
                await this.bot.browser.utils.ghostClick(page, emailSelector)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after email icon click')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Initiating code login handler')
                await this.codeStrategy.handle(page)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Code login handler completed successfully')
                return true
            }

            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery email input detected')
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout on recovery page')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Initiating recovery email handler')
                await this.recoveryStrategy.handle(page, account?.recoveryEmail)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery email handler completed successfully')
                return true
            }

            case 'CHROMEWEBDATA_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'chromewebdata error detected, attempting recovery')
                try {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `Navigating to ${this.bot.config.baseURL}`)
                    await page
                        .goto(this.bot.config.baseURL, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Recovery navigation successful')
                    return true
                } catch {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Fallback to login.live.com')
                    await page
                        .goto('https://login.live.com/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Fallback navigation successful')
                    return true
                }
            }

            case 'UNEXPECTED_NOTICE': {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    'On Microsoft "page not normally shown" notice — attempting recovery'
                )

                // 1) Many variants of this page carry a Continue / primary button.
                //    Try it first so we resume the flow without losing progress.
                const continued = await this.bot.browser.utils
                    .ghostClick(page, `${this.selectors.primaryButton}, a[href*="account.microsoft.com"]`)
                    .catch(() => false)
                if (continued) {
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                    await this.bot.utils.wait(1500)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Notice page: clicked continue, re-evaluating')
                    return true
                }

                // 2) Otherwise it is a true dead-end. Re-navigate to the dashboard to
                //    restart the sign-in flow from a known-good entry point.
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Notice page: no continue button, re-navigating to dashboard')
                await page
                    .goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 10000 })
                    .catch(() => {})
                await this.bot.utils.wait(2500)
                return true
            }

            case '2FA_TOTP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP 2FA authentication required')
                await this.totpStrategy.handle(page, account.totpSecret)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP 2FA handler completed successfully')
                return true
            }

            case 'SIGN_IN_ANOTHER_WAY': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Selecting "Use my password"')
                await this.bot.browser.utils.ghostClick(page, this.selectors.passwordIcon)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after password icon click')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Password option selected')
                return true
            }

            case 'KMSI_PROMPT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Accepting KMSI prompt')
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)

                // Brief pause: Microsoft may immediately redirect to a passkey registration
                // step after KMSI acceptance. We proactively detect and dismiss it here
                // before it can trigger the OS-level "Save your passkey" security dialog,
                // which has no programmatic way to be dismissed and would close the page.
                await this.bot.utils.wait(2000)

                if (!page.isClosed()) {
                    const hasPasskeyVideo = await this.checkSelector(page, this.selectors.passKeyVideo)
                    const hasPasskeyError = await this.checkSelector(page, this.selectors.passKeyError)
                    if (hasPasskeyVideo || hasPasskeyError) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LOGIN',
                            'Passkey registration prompt appeared after KMSI — dismissing immediately'
                        )
                        await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                        await this.bot.utils.wait(1000)
                    }
                }

                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after KMSI acceptance')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'KMSI prompt accepted')
                return true
            }

            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Skipping Passkey prompt')
                await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after Passkey skip')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passkey prompt skipped')
                return true
            }

            case 'LOGIN_PASSWORDLESS': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Handling passwordless authentication')
                await this.passwordlessStrategy.handle(page)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after passwordless auth')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passwordless authentication completed successfully')
                return true
            }

            case 'OTP_CODE_ENTRY': {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    'OTP code entry page detected, attempting to find password option'
                )

                if (await this.clickUsePasswordOption(page)) {
                    return true
                }

                if (await this.clickOtherSignInMethods(page)) {
                    return true
                }

                // Click "Use your password" footer if text lookup did not expose it
                const footerLink = await page
                    .waitForSelector(this.selectors.viewFooter, { state: 'visible', timeout: 2000 })
                    .catch(() => null)

                if (footerLink) {
                    await this.bot.browser.utils.ghostClick(page, this.selectors.viewFooter)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Footer link clicked')
                } else {
                    // PR 450 Fix: Click Back Button if footer not found
                    const backButton = await page
                        .waitForSelector(this.selectors.backButton, { state: 'visible', timeout: 2000 })
                        .catch(() => null)

                    if (backButton) {
                        await this.bot.browser.utils.ghostClick(page, this.selectors.backButton)
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Back button clicked')
                    } else {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'No navigation option found on OTP page')
                    }
                }

                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Network idle timeout after OTP navigation')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Navigated back from OTP entry page')
                return true
            }

            case 'UNKNOWN': {
                const url = new URL(page.url())
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `Unknown state at ${url.hostname}${url.pathname}, waiting`
                )
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Unhandled state: ${state}, continuing`)
                return true
        }
    }

    private async finalizeLogin(page: Page, account: Account) {
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Finalizing login')

        await page.goto(this.bot.config.baseURL, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

        const loginRewardsSuccess = new URL(page.url()).hostname === 'rewards.bing.com'
        if (loginRewardsSuccess) {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Logged into Microsoft Rewards successfully')
        } else {
            this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'Could not verify Rewards Dashboard, assuming login valid')
        }

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting Bing session verification')
        await this.verifyBingSession(page, account)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting rewards session verification')
        await this.getRewardsSession(page)

        const browser = page.context()
        const cookies = await browser.cookies()
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Retrieved ${cookies.length} cookies`)
        await saveSessionData(this.bot.config.sessionPath, cookies, account.email, this.bot.isMobile)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Login completed, session saved')
    }

    /**
     * Detect whether the Bing page (bing.com / www.bing.com) is authenticated.
     *
     * Searches are only credited when bing.com itself carries the signed-in
     * session, which is independent from being logged into rewards.bing.com.
     * We treat the page as signed in when an account-bound header element is
     * present (rewards counter `#id_rc` or account name `#id_n`) AND the
     * anonymous "Sign in" entry point (`#id_s`/`#id_l`) is absent.
     */
    async isBingSignedIn(page: Page): Promise<boolean> {
        if (page.isClosed()) return false

        const [hasRewardsCounter, hasAccountName, hasAccountMenu, hasRewardsBadge] = await Promise.all([
            this.checkSelector(page, '#id_rc'),
            this.checkSelector(page, this.selectors.bingProfile),
            this.checkSelector(page, '[aria-label="Account Rewards and Preferences"]'),
            this.checkSelector(page, '#id_rh_w, [aria-label^="Microsoft Rewards"]')
        ])

        // A positive signal from EITHER the legacy header (#id_rc / #id_n) or the
        // current Bing header (the "Account Rewards and Preferences" flyout, id #id_h,
        // and the "Microsoft Rewards - <tier> Member" badge, #id_rh_w) means an
        // account is bound to this page. We intentionally NO LONGER require the
        // "Sign in" entry point to be absent: the modern header keeps a hidden
        // sign-in affordance inside the account flyout even when signed in, which
        // made the old `&& !hasSignIn` gate always fail and sent verification into
        // its 12-loop timeout (Microsoft removed #id_n/#id_rc/#id_s/#id_l).
        return hasRewardsCounter || hasAccountName || hasAccountMenu || hasRewardsBadge
    }

    /**
     * Positively detect an anonymous Bing page (the "Sign in" entry point is shown).
     *
     * Used as a conservative gate: callers should only treat a search session as
     * unusable when this returns `true`, so a drifted signed-in selector can never
     * cause a working account's run to be skipped.
     */
    async isBingSignedOut(page: Page): Promise<boolean> {
        if (page.isClosed()) return false

        const [hasSignIn, hasRewardsCounter, hasAccountName, hasAccountMenu, hasRewardsBadge] = await Promise.all([
            this.checkSelector(page, '#id_s, #id_l, #id_h a[aria-label="Sign in"]'),
            this.checkSelector(page, '#id_rc'),
            this.checkSelector(page, this.selectors.bingProfile),
            this.checkSelector(page, '[aria-label="Account Rewards and Preferences"]'),
            this.checkSelector(page, '#id_rh_w, [aria-label^="Microsoft Rewards"]')
        ])

        // Only declare "signed out" when a sign-in CTA is present AND none of the
        // signed-in markers (legacy or current header) are — stays conservative so
        // a drifted selector can never skip a working account's run.
        return hasSignIn && !hasRewardsCounter && !hasAccountName && !hasAccountMenu && !hasRewardsBadge
    }

    /**
     * Bridge the live.com/rewards session into a Bing search session and verify it.
     *
     * Returns `true` once bing.com reports a signed-in account. When it cannot be
     * confirmed the caller is told (via the return value) so it can retry before
     * burning a full search run that Microsoft would credit to an anonymous user.
     *
     * The federated `bing.com/fd/auth/signin` hop can occasionally demand a full
     * re-authentication (expired live.com session, not just a passkey/KMSI nudge),
     * landing on the real EMAIL_INPUT/PASSWORD_INPUT sign-in form. Without an
     * `account` to fill it with, this loop used to just wait on that form every
     * iteration until it timed out — visible in Rewards Desk as a run stuck on
     * "Verifying Bing session" showing the live Microsoft sign-in page. When an
     * account is supplied we now complete that re-login inline.
     */
    async verifyBingSession(page: Page, account?: Account): Promise<boolean> {
        const url =
            'https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F'
        // Mobile search authenticates via the OAuth access token, not the Bing
        // browser cookie session — an unconfirmed Bing header is already treated as
        // non-fatal below. The full multi-iteration loop (with networkidle gotos)
        // otherwise stalls the run ~60s on www.bing.com for no benefit, so mobile
        // does a single lightweight pass.
        const loopMax = this.bot.isMobile ? 1 : account?.password ? 12 : 6

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Verifying Bing session')

        try {
            await page
                .goto(url, {
                    waitUntil: this.bot.isMobile ? 'domcontentloaded' : 'networkidle',
                    timeout: this.bot.isMobile ? 5000 : 10000
                })
                .catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `Verification loop ${i + 1}/${loopMax}`)

                // Microsoft can inject an interrupt (passkey/KMSI) into the federated
                // sign-in redirect, or — less commonly — demand a full re-login.
                // Handle the common ones so the flow can complete instead of
                // stalling on login.live.com and never reaching Bing.
                const state = await this.detectCurrentState(page)

                // On mobile, the Bing *browser* session is irrelevant — mobile searches
                // authenticate via the OAuth access token, not the bing.com cookie. The
                // federated re-login below cannot complete in mobile's single iteration
                // (it submits the email, then the loop exits before the password page),
                // leaving the login half-done and corrupting the already-established
                // rewards.bing.com session — which bounces the whole run to /welcome and
                // makes the dashboard unreadable. The working reference bot never
                // re-logins on mobile here; mirror it and leave the rewards session intact.
                if (
                    this.bot.isMobile &&
                    (state === 'EMAIL_INPUT' || state === 'PASSWORD_INPUT' || state === '2FA_TOTP')
                ) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN-BING',
                        'Federated re-login demanded — skipped on mobile (search uses access token), preserving rewards session'
                    )
                    break
                }

                if (state === 'PASSKEY_ERROR' || state === 'PASSKEY_VIDEO') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Dismissing Passkey prompt during verification')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton).catch(() => {})
                    await this.bot.utils.wait(1000)
                } else if (state === 'KMSI_PROMPT') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Accepting KMSI prompt during verification')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton).catch(() => {})
                    await this.bot.utils.wait(1000)
                } else if (state === 'EMAIL_INPUT' && account?.email) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-BING',
                        'Federated sign-in demanded full re-login (email) during Bing verification — re-authenticating'
                    )
                    await this.emailStrategy.enterEmail(page, account.email)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                } else if (state === 'PASSWORD_INPUT' && account?.password) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-BING',
                        'Federated sign-in demanded full re-login (password) during Bing verification — re-authenticating'
                    )
                    await this.emailStrategy.enterPassword(page, account.password)
                    await page.keyboard.press('Escape').catch(() => {})
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                } else if (state === '2FA_TOTP' && account?.totpSecret) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-BING',
                        'Federated sign-in demanded 2FA during Bing verification — re-authenticating'
                    )
                    await this.totpStrategy.handle(page, account.totpSecret)
                }

                const u = new URL(page.url())
                const onBing = u.hostname === 'www.bing.com' || u.hostname === 'bing.com'
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    `On Bing: ${onBing} (${u.hostname}${u.pathname})`
                )

                if (onBing) {
                    await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                    const signedIn = await this.isBingSignedIn(page)
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `Bing signed-in indicator: ${signedIn}`)

                    if (signedIn) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing session verified successfully')
                        return true
                    }
                } else if (i >= 2) {
                    // Still drifting on a login/interrupt host after a couple of loops —
                    // re-trigger the federated sign-in to nudge it back toward Bing.
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', 'Off Bing host, re-issuing federated sign-in')
                    await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})
                }

                await this.bot.utils.wait(1000)
            }

            // Mobile search uses a separate token-based flow, so an unconfirmed Bing
            // header here is not necessarily fatal for mobile.
            if (this.bot.isMobile) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    'Bing header not confirmed (mobile) — continuing, mobile search uses access token'
                )
                return true
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-BING', 'Could not verify Bing session, continuing anyway')
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                `Verification error: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    /**
     * Record the resolved dashboard variant for the current device, and persist it
     * (best-effort) so the Rewards Desk can show an auto-detected ASP/NEW badge for
     * `auto` accounts. Persistence never blocks login — it is a cosmetic hint only.
     */
    private async commitDashboardVariant(variant: DashboardVariant): Promise<void> {
        this.bot.setDashboardVariant(variant)
        const email = getCurrentContext().account?.email
        if (email) {
            await saveDashboardVariant(this.bot.config.sessionPath, email, this.bot.isMobile, variant)
        }
    }

    /**
     * Resolve the Microsoft Rewards dashboard variant for the current device and,
     * when legacy, capture the `__RequestVerificationToken`.
     *
     * Multi-signal detection, mirroring the legacy-only reference bot (which defaults
     * LEGACY and switches to "modern" only when it positively sees `section#dailyset`):
     *  - Authoritative LEGACY signals (ASP-only): `__RequestVerificationToken`,
     *    the `var dashboard = {...}` embed, or a `getuserinfo?type=1` response that
     *    carries a `dashboard` object.
     *  - Authoritative NEXT signal: `<section id="dailyset">` (present on the new
     *    dashboard; absent on `/welcome` and login pages, so it does NOT misfire the
     *    way the broad `self.__next_f` marker did).
     *  - Default when nothing decisive shows up: LEGACY (source-style).
     *
     * Every signal is logged each iteration so a misdetection is diagnosable from the
     * run log. When legacy is removed, delete the probe/token capture and always 'next'.
     */
    private async getRewardsSession(page: Page) {
        const loopMax = 6
        const override = getCurrentContext().account?.dashboardMode ?? 'auto'

        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', `Resolving dashboard session (mode=${override})`)

        try {
            if (override === 'next') {
                await this.commitDashboardVariant('next')
                this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', 'Forced NEXT (dashboardMode)')
                return
            }

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                // Navigate to rewards root if not already there. /welcome is a redirect
                // holding page — session cookies are not active yet so all API probes
                // return 401 and no DOM signals fire. Force root so the real dashboard
                // page loads and all signals become readable.
                const parsedUrl = new URL(page.url())
                if (parsedUrl.hostname !== 'rewards.bing.com' || parsedUrl.pathname.startsWith('/welcome')) {
                    await page
                        .goto(`${URLS.home}?_=${Date.now()}`, { waitUntil: 'networkidle', timeout: 10000 })
                        .catch(() => {})
                }
                if (page.isClosed()) break

                const url = page.url()
                if (new URL(url).hostname !== 'rewards.bing.com') {
                    this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', `iter ${i + 1}: not on rewards host (url=${url})`)
                    await this.bot.utils.wait(1500)
                    continue
                }

                await this.bot.browser.utils.tryDismissAllMessages(page)
                const html = await page.content()
                const $ = await this.bot.browser.utils.loadInCheerio(html)

                // ── Collect every signal ──
                let token: string | null =
                    $(this.selectors.requestToken).attr('value') ??
                    $(this.selectors.requestTokenMeta).attr('content') ??
                    null
                if (!token) {
                    $('script').each((_, el) => {
                        if (token) return
                        const text = $(el).html() ?? ''
                        const m =
                            text.match(/"RequestVerificationToken"\s*:\s*"([^"]+)"/) ??
                            text.match(/__RequestVerificationToken['"]\s*(?:value|content)['"]\s*:\s*['"]([^'"]+)/)
                        if (m?.[1]) token = m[1]
                    })
                }
                const hasLegacyEmbed = /var\s+dashboard\s*=/.test(html)
                const hasDailySetSection = $('section#dailyset').length > 0
                const hasNextFlight = html.includes('self.__next_f') || html.includes('webpackChunk_N_E')
                const probe = await this.probeLegacyDashboardApi(page)

                this.bot.logger.info(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    `iter ${i + 1}/${loopMax} | url=${url} | token=${!!token} | varDashboard=${hasLegacyEmbed} | getuserinfo=${probe.status}(dashboard=${probe.legacy}) | section#dailyset=${hasDailySetSection} | __next_f=${hasNextFlight}`
                )

                const onWelcome = new URL(url).pathname.startsWith('/welcome')

                // ── NEXT wins first ──
                // The Next.js flight markers (self.__next_f / webpackChunk_N_E, present in
                // the server-rendered HTML immediately) and the #dailyset section appear
                // ONLY on the new dashboard. Decide on these FIRST. CRITICAL: the
                // getuserinfo API now returns 200 with a `dashboard` object on BOTH
                // dashboards, so it can NOT tell them apart — only these Next-only markers
                // (and, below, the ASP-only token/embed) are decisive. `probe` is kept for
                // logging only. Guard against /welcome, itself a Next page but not the
                // dashboard.
                if (!onWelcome && (hasDailySetSection || hasNextFlight)) {
                    await this.commitDashboardVariant('next')
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'GET-REWARD-SESSION',
                        `variant=NEXT (dailyset=${hasDailySetSection}, flight=${hasNextFlight})`
                    )
                    return
                }

                // ── LEGACY: ASP-only markers — the CSRF token or the `var dashboard=`
                // embed. getuserinfo is intentionally NOT consulted here (it answers on
                // both dashboards and would misclassify a Next account as legacy). ──
                if (override === 'legacy' || token || hasLegacyEmbed) {
                    await this.commitDashboardVariant('legacy')
                    if (token) this.bot.requestToken = token
                    else {
                        const captured = await this.captureRequestToken(page)
                        if (captured) this.bot.requestToken = captured
                    }
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'GET-REWARD-SESSION',
                        `variant=LEGACY (token=${!!this.bot.requestToken}, embed=${hasLegacyEmbed})`
                    )
                    return
                }

                await this.bot.utils.wait(1500)
            }

            // Nothing decisive after all retries. The legacy ASP markers (CSRF token /
            // `var dashboard=` embed) are ALWAYS present in the legacy HTML, so their
            // absence means this is almost certainly the new dashboard — default NEXT
            // (which also has browser-based fallbacks that degrade more gracefully than
            // legacy API calls failing). Force dashboardMode:"legacy" if ever needed.
            await this.commitDashboardVariant('next')
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `No decisive dashboard marker after ${loopMax} tries — defaulting to NEXT. If this account is on the classic (ASP) dashboard, set dashboardMode:"legacy".`
            )
        } catch (error) {
            throw this.bot.logger.error(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    /**
     * Probe the legacy JSON API (`getuserinfo?type=1`) from the page context so the
     * session cookies are attached automatically. A `dashboard` object in the
     * response is a definitive "this account is on the legacy ASP dashboard" signal;
     * the Next.js dashboard 404s this endpoint. Retried a few times because the page
     * may still be settling right after login.
     */
    private async probeLegacyDashboardApi(page: Page): Promise<{ legacy: boolean; status: number }> {
        if (page.isClosed()) return { legacy: false, status: -1 }
        try {
            return await page.evaluate(async () => {
                try {
                    const res = await fetch('https://rewards.bing.com/api/getuserinfo?type=1', {
                        credentials: 'include',
                        headers: { 'X-Requested-With': 'XMLHttpRequest' }
                    })
                    if (!res.ok) return { legacy: false, status: res.status }
                    const data = (await res.json().catch(() => null)) as { dashboard?: unknown } | null
                    return { legacy: !!(data && data.dashboard), status: res.status }
                } catch {
                    // status 0 = fetch threw (e.g. cross-origin / network) before a response.
                    return { legacy: false, status: 0 }
                }
            })
        } catch {
            // status -2 = the page navigated mid-evaluation (e.g. a /welcome bounce).
            return { legacy: false, status: -2 }
        }
    }

    /**
     * Capture the legacy `__RequestVerificationToken` from the rewards page. The page
     * can briefly sit on `/welcome` before settling on the dashboard home, so this
     * retries and nudges back to the home when it has drifted.
     */
    private async captureRequestToken(page: Page): Promise<string | null> {
        for (let i = 0; i < 5; i++) {
            if (page.isClosed()) break

            if (new URL(page.url()).hostname === 'rewards.bing.com') {
                await this.bot.browser.utils.tryDismissAllMessages(page)
                const html = await page.content()
                const $ = await this.bot.browser.utils.loadInCheerio(html)

                let token: string | null =
                    $(this.selectors.requestToken).attr('value') ??
                    $(this.selectors.requestTokenMeta).attr('content') ??
                    null

                if (!token) {
                    $('script').each((_, el) => {
                        if (token) return
                        const text = $(el).html() ?? ''
                        const tokenMatch =
                            text.match(/"RequestVerificationToken"\s*:\s*"([^"]+)"/) ??
                            text.match(/__RequestVerificationToken['"]\s*(?:value|content)['"]\s*:\s*['"]([^'"]+)/)
                        if (tokenMatch?.[1]) {
                            token = tokenMatch[1]
                        }
                    })
                }

                if (token) return token

                // Drifted to /welcome (or a non-home page) → nudge back to the home.
                if (page.url().includes('/welcome') || new URL(page.url()).pathname.length > 1) {
                    await page
                        .goto(`${URLS.home}?_=${Date.now()}`, { waitUntil: 'networkidle', timeout: 8000 })
                        .catch(() => {})
                }
            }

            await this.bot.utils.wait(1000)
        }
        return null
    }

    /**
     * Re-scrape `__RequestVerificationToken` from the CURRENT page. Needed after any
     * navigation that can rotate the legacy dashboard's anti-forgery cookie pairing —
     * e.g. the mobile app-token OAuth detour (MobileStrategy.get), whose `finally`
     * always reloads the rewards dashboard whether the token exchange succeeded or
     * not. `requestToken` is otherwise captured once at login (getRewardsSession)
     * and never touched again; reusing that pre-detour token against post-detour
     * cookies is a stale token/cookie mismatch that ASP.NET rejects, and every
     * legacy call built from the pair (report-activity, claim-points, dashboard
     * JSON) then fails with a uniform 400 for the rest of the run. No-op if no
     * token is found (e.g. the NEXT dashboard variant has none) — keeps whatever
     * token is already set.
     */
    async refreshRequestToken(page: Page): Promise<void> {
        const captured = await this.captureRequestToken(page)
        if (captured) this.bot.requestToken = captured
    }

    async getAppAccessToken(page: Page, account: Account) {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', 'Requesting mobile access token')
        return await new MobileStrategy(this.bot, page).get(account.email, account)
    }
}
