import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'
import { newInjectedContext } from 'fingerprint-injector'
import fs from 'fs'
import os from 'os'
import path from 'path'
import rebrowser, { BrowserContext } from 'patchright'

import { loadSessionData, saveFingerprintData } from '../helpers/ConfigLoader'
import type { MicrosoftRewardsBot } from '../index'
import { DESKTOP_BROWSER_VIEWPORT, DESKTOP_BROWSER_WINDOW_ARG } from './BrowserViewport'
import { CORE_PROMO_BANNER_RUNTIME_CONFIG, installCorePromoBanner } from './CorePromoBanner'
import { FingerprintManager } from './FingerprintManager'
import { installMagicCursor } from './MagicCursor'

import type { Account, AccountProxy } from '../types/Account'

/* Test Stuff
https://abrahamjuliot.github.io/creepjs/
https://botcheck.luminati.io/
https://fv.pro/
https://pixelscan.net/
https://www.browserscan.net/
*/

interface BrowserCreationResult {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

type BrowserChannel = 'chrome' | 'msedge'

class BrowserManager {
    private readonly bot: MicrosoftRewardsBot
    private readonly activeBrowsers = new Set<rebrowser.Browser>()
    // True when "headless" was requested from the Desk on a real desktop: the
    // window is launched off-screen (hidden) instead of truly headless, so the
    // user can reveal it on demand via the "Show browser" button.
    private hiddenWindowMode = false
    private showBrowserWatcher: ReturnType<typeof setInterval> | null = null
    // Cross-process control file the Desk touches to ask for the window to be
    // shown. Kept in tmp so both the Desk and this child agree on the path.
    private static readonly SHOW_BROWSER_SIGNAL = path.join(os.tmpdir(), 'msrb-show-browser.signal')
    private static readonly BROWSER_ARGS = [
        '--no-sandbox',
        '--mute-audio',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-user-media-security=true',
        '--disable-blink-features=Attestation',
        // Disable all passkey / WebAuthn / credential-manager UI at the browser level.
        // WebAuthenticationConditionalUI: prevents the "Save your passkey" OS dialog.
        // PasskeyUpgrade: blocks in-browser passkey upgrade prompts.
        // PasswordLeakDetection: stops password-breach popups from interrupting flow.
        // AutofillEnablePasswordsAccountStorage: prevents cloud-stored credential dialogs.
        // FedCM / FedCmIdpSigninStatus: disables Federated Credential Management (new sign-in API).
        // EdgeDefaultWallet / MicrosoftEdgeIdentityFeature / MSAEdgeSSOForOffice: Edge-specific
        // credential and identity features that can trigger OS-level Windows Hello prompts.
        '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys,WebAuthenticationConditionalUI,PasskeyUpgrade,PasswordLeakDetection,AutofillEnablePasswordsAccountStorage,FedCM,FedCmIdpSigninStatus,EdgeDefaultWallet,MicrosoftEdgeIdentityFeature,MSAEdgeSSOForOffice',
        '--disable-save-password-bubble',
        // Prevents the native OS credential picker from being invoked
        '--password-store=basic',
        // WebRTC leak prevention — prevents real IP exposure behind proxy
        '--enforce-webrtc-ip-handling-policy',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-webrtc-hw-encoding',
        '--disable-webrtc-hw-decoding',
        // NOTE: no `--start-maximized`. The context uses a fixed viewport that
        // matches the injected fingerprint's screen (see DESKTOP_BROWSER_VIEWPORT),
        // so the OS window must be sized to that same viewport. Maximizing the
        // window while the page stays at a smaller fixed viewport creates a
        // window/viewport geometry mismatch that is an easy bot tell.
        DESKTOP_BROWSER_WINDOW_ARG
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    private assertBundledChromiumAvailable(): void {
        if (!fs.existsSync(rebrowser.chromium.executablePath())) {
            throw new Error(
                'Patchright Chromium is not installed. Restart the launcher to repair it, or run `npm run browser:install`.'
            )
        }
    }

    async createBrowser(account: Account): Promise<BrowserCreationResult> {
        let browser: rebrowser.Browser
        let channel: BrowserChannel | undefined
        try {
            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                'Initializing browser — detecting available channel (Chromium › Chrome › Edge)...'
            )

            const proxyConfig = account.proxy.url
                ? {
                      server: this.formatProxyServer(account.proxy),
                      ...(account.proxy.username &&
                          account.proxy.password && {
                              username: account.proxy.username,
                              password: account.proxy.password
                          })
                  }
                : undefined

            this.assertBundledChromiumAvailable()
            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                'Using browser channel: chromium (Patchright bundled)'
            )

            // On a real desktop (Desk), "headless" really means "keep the window
            // out of the way", not "no window at all" — the user can still reveal
            // it on demand. Docker / headless servers and plain CLI runs keep TRUE
            // headless (there may be no display at all, e.g. a VPS).
            const wantsHeadless = !!this.bot.config.headless
            const isUiChild = process.env.MSRB_UI_CHILD === '1' || process.argv.includes('--ui-child')
            this.hiddenWindowMode = wantsHeadless && isUiChild && !BrowserManager.isDocker()

            browser = await rebrowser.chromium.launch({
                headless: wantsHeadless && !this.hiddenWindowMode,
                ...(proxyConfig && { proxy: proxyConfig }),
                args: [
                    ...BrowserManager.BROWSER_ARGS,
                    // Launch far off-screen so the window is effectively hidden
                    // until the user clicks "Show browser" (see revealWindows).
                    ...(this.hiddenWindowMode ? ['--window-position=-32000,-32000'] : [])
                ]
            })
            this.activeBrowsers.add(browser)
            if (this.hiddenWindowMode) this.startShowBrowserWatcher()
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Launch failed: ${errorMessage}`)
            throw error
        }

        try {
            const sessionData = await loadSessionData(
                this.bot.config.sessionPath,
                account.email,
                account.saveFingerprint,
                this.bot.isMobile
            )

            const fingerprint =
                sessionData.fingerprint ??
                (await this.generateFingerprint(this.bot.isMobile, channel === 'msedge' ? 'edge' : 'chrome'))

            const context = await newInjectedContext(browser as any, {
                fingerprint,
                newContextOptions: {
                    viewport: DESKTOP_BROWSER_VIEWPORT,
                    screen: DESKTOP_BROWSER_VIEWPORT
                }
            })
            context.once('close', () => {
                this.activeBrowsers.delete(browser)
                void browser.close().catch(() => {})
            })

            await context.addInitScript(() => {
                // Disable WebAuthn/FIDO
                Object.defineProperty(navigator, 'credentials', {
                    value: {
                        create: () => Promise.reject(new Error('WebAuthn disabled')),
                        get: () => Promise.reject(new Error('WebAuthn disabled'))
                    }
                })

                // WebRTC IP leak prevention — force through proxy only
                const origRTCPeerConnection = window.RTCPeerConnection
                if (origRTCPeerConnection) {
                    window.RTCPeerConnection = new Proxy(origRTCPeerConnection, {
                        construct(target, args) {
                            const config = args[0] || {}
                            config.iceServers = []
                            args[0] = config
                            return new target(...args)
                        }
                    }) as any
                }
            })

            await context.addInitScript(installCorePromoBanner, CORE_PROMO_BANNER_RUNTIME_CONFIG)

            // Persistent magic cursor overlay — skipped in headless mode (no
            // window to see it, and the extra init script wastes time).
            if (!this.bot.config.headless) {
                await context.addInitScript(installMagicCursor)
            }

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000))

            await context.addCookies(sessionData.cookies)

            // Restore localStorage/sessionStorage if previously saved
            if (sessionData.storageState) {
                for (const origin of sessionData.storageState) {
                    if (origin.localStorage?.length) {
                        const page = await context.newPage()
                        await page
                            .goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 10000 })
                            .catch(() => {})
                        await page.evaluate((items: Array<{ name: string; value: string }>) => {
                            for (const item of items) {
                                try {
                                    localStorage.setItem(item.name, item.value)
                                } catch {}
                            }
                        }, origin.localStorage)
                        await page.close()
                    }
                }
            }

            if (
                (account.saveFingerprint.mobile && this.bot.isMobile) ||
                (account.saveFingerprint.desktop && !this.bot.isMobile)
            ) {
                await saveFingerprintData(this.bot.config.sessionPath, account.email, this.bot.isMobile, fingerprint)
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Created browser with User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`
            )
            this.bot.logger.debug(this.bot.isMobile, 'BROWSER-FINGERPRINT', JSON.stringify(fingerprint))

            return { context: context as unknown as BrowserContext, fingerprint }
        } catch (error) {
            this.activeBrowsers.delete(browser)
            await browser.close().catch(() => {})
            throw error
        }
    }

    async closeAll(): Promise<void> {
        if (this.showBrowserWatcher) {
            clearInterval(this.showBrowserWatcher)
            this.showBrowserWatcher = null
        }
        const browsers = [...this.activeBrowsers]
        this.activeBrowsers.clear()
        await Promise.allSettled(browsers.map(browser => browser.close()))
    }

    private static isDocker(): boolean {
        try {
            if (fs.existsSync('/.dockerenv')) return true
            return fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker')
        } catch {
            return false
        }
    }

    /**
     * Watch the cross-process control file the Desk writes when the user clicks
     * "Show browser". Started only in hidden-window mode. Purely a convenience
     * channel — any failure is swallowed so it can never break a run.
     */
    private startShowBrowserWatcher(): void {
        if (this.showBrowserWatcher) return
        try {
            fs.rmSync(BrowserManager.SHOW_BROWSER_SIGNAL, { force: true })
        } catch {
            /* ignore stale-signal cleanup errors */
        }
        this.showBrowserWatcher = setInterval(() => {
            try {
                if (!fs.existsSync(BrowserManager.SHOW_BROWSER_SIGNAL)) return
                fs.rmSync(BrowserManager.SHOW_BROWSER_SIGNAL, { force: true })
                void this.revealWindows()
            } catch {
                /* cosmetic control channel — never break the run */
            }
        }, 1000)
        // Don't keep the process alive just for this watcher.
        this.showBrowserWatcher.unref?.()
    }

    /**
     * Bring every active (off-screen) browser window back on-screen via CDP.
     * Best-effort: a browser that is mid-close or a CDP call that fails is just
     * skipped — the run is unaffected either way.
     */
    async revealWindows(): Promise<void> {
        for (const browser of [...this.activeBrowsers]) {
            try {
                for (const context of browser.contexts()) {
                    const page = context.pages()[0]
                    if (!page) continue
                    const rawSession = await context.newCDPSession(page).catch(() => null)
                    if (!rawSession) continue
                    const session = rawSession as unknown as {
                        send: (method: string, params?: unknown) => Promise<unknown>
                        detach: () => Promise<void>
                    }
                    const target = (await session.send('Browser.getWindowForTarget').catch(() => null)) as {
                        windowId?: number
                    } | null
                    if (typeof target?.windowId !== 'number') continue
                    await session
                        .send('Browser.setWindowBounds', {
                            windowId: target.windowId,
                            // Restore to the same geometry the window normally uses
                            // (OS window sized to the injected viewport) so revealing
                            // never creates a window/viewport mismatch tell.
                            bounds: {
                                windowState: 'normal',
                                left: 60,
                                top: 60,
                                width: DESKTOP_BROWSER_VIEWPORT.width,
                                height: DESKTOP_BROWSER_VIEWPORT.height
                            }
                        })
                        .catch(() => {})
                    await session.detach().catch(() => {})
                }
                this.bot.logger.info(this.bot.isMobile, 'BROWSER', 'Browser window revealed on request (Show browser)')
            } catch {
                /* a browser may be mid-close — ignore */
            }
        }
    }

    private formatProxyServer(proxy: AccountProxy): string {
        try {
            const urlObj = new URL(proxy.url)
            const protocol = urlObj.protocol.replace(':', '')
            return `${protocol}://${urlObj.hostname}:${proxy.port}`
        } catch {
            return `${proxy.url}:${proxy.port}`
        }
    }

    async generateFingerprint(isMobile: boolean, browser: 'chrome' | 'edge' = 'chrome') {
        const fingerPrintData = new FingerprintGenerator().getFingerprint({
            devices: isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: isMobile ? ['android', 'ios'] : ['windows', 'linux'],
            browsers: [{ name: browser }]
        })

        const userAgentManager = new FingerprintManager(this.bot)
        const updatedFingerPrintData = await userAgentManager.updateFingerprintUserAgent(
            fingerPrintData,
            isMobile,
            browser
        )

        return updatedFingerPrintData
    }
}

export default BrowserManager
