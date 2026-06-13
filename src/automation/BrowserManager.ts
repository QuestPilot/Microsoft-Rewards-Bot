import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'
import { newInjectedContext } from 'fingerprint-injector'
import rebrowser, { BrowserContext } from 'patchright'

import { loadSessionData, saveFingerprintData } from '../helpers/ConfigLoader'
import type { MicrosoftRewardsBot } from '../index'
import { DESKTOP_BROWSER_VIEWPORT, DESKTOP_BROWSER_WINDOW_ARG } from './BrowserViewport'
import { CORE_PROMO_BANNER_RUNTIME_CONFIG, installCorePromoBanner } from './CorePromoBanner'
import { FingerprintManager } from './FingerprintManager'

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
    private detectedBrowserChannel?: Promise<BrowserCandidate>
    private static readonly DETECTION_CLOSE_TIMEOUT_MS = 5_000
    private readonly activeBrowsers = new Set<rebrowser.Browser>()
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
        '--start-maximized',
        DESKTOP_BROWSER_WINDOW_ARG
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Attempts to find the best Chromium-based browser.
     * Preference: Patchright bundled Chromium > Google Chrome > Microsoft Edge.
     * Edge can block account.live.com on some Windows installations.
     */
    private async detectBrowserChannel(): Promise<BrowserCandidate> {
        if (this.detectedBrowserChannel) {
            return this.detectedBrowserChannel
        }

        this.detectedBrowserChannel = this.detectBrowserChannelOnce().catch(error => {
            this.detectedBrowserChannel = undefined
            throw error
        })

        return this.detectedBrowserChannel
    }

    private async detectBrowserChannelOnce(): Promise<BrowserCandidate> {
        for (const channel of [undefined, 'chrome', 'msedge'] as const) {
            let testBrowser: rebrowser.Browser | undefined
            try {
                testBrowser = await rebrowser.chromium.launch({
                    headless: true,
                    ...(channel && { channel })
                })
                return channel
            } catch {
                // Channel not available, try next
            } finally {
                if (testBrowser?.isConnected()) {
                    await this.closeDetectionBrowser(testBrowser).catch(() => {})
                }
            }
    private async assertBundledChromiumAvailable(): Promise<void> {
        try {
            const testBrowser = await rebrowser.chromium.launch({ headless: true })
            await testBrowser.close()
        } catch {
            throw new Error(
                'Patchright Chromium is not installed. Run `npx patchright install chromium` and try again.'
            )
        }
    }

    private async closeDetectionBrowser(browser: rebrowser.Browser): Promise<void> {
        let timeout: NodeJS.Timeout | undefined
        try {
            await Promise.race([
                browser.close(),
                new Promise<void>((_, reject) => {
                    timeout = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Browser detection close timed out after ${BrowserManager.DETECTION_CLOSE_TIMEOUT_MS}ms`
                                )
                            ),
                        BrowserManager.DETECTION_CLOSE_TIMEOUT_MS
                    )
                })
            ])
        } finally {
            if (timeout) clearTimeout(timeout)
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

            await this.assertBundledChromiumAvailable()
            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                'Using browser channel: chromium (Patchright bundled)'
            )

            browser = await rebrowser.chromium.launch({
                headless: this.bot.config.headless,
                ...(proxyConfig && { proxy: proxyConfig }),
                args: [...BrowserManager.BROWSER_ARGS]
            })
            this.activeBrowsers.add(browser)
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
        const browsers = [...this.activeBrowsers]
        this.activeBrowsers.clear()
        await Promise.allSettled(browsers.map(browser => browser.close()))
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
