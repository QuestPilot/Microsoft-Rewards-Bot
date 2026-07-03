import axios from 'axios'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import type { MicrosoftRewardsBot } from '../index'
import type { ChromeVersion, EdgeVersion } from '../types/UserAgentUtil'

export class FingerprintManager {
    private static readonly NOT_A_BRAND_VERSION = '99'

    constructor(private bot: MicrosoftRewardsBot) {}

    async getUserAgent(isMobile: boolean, browser: 'chrome' | 'edge' = 'chrome') {
        const system = this.getSystemComponents(isMobile)
        const app = await this.getAppComponents(isMobile)

        const uaTemplate =
            browser === 'edge'
                ? isMobile
                    ? `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Mobile Safari/537.36 EdgA/${app.edge_version}`
                    : `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Safari/537.36 Edg/${app.edge_version}`
                : isMobile
                  ? `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Mobile Safari/537.36`
                  : `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${app.chrome_reduced_version} Safari/537.36`

        const browserBrand =
            browser === 'edge'
                ? { name: 'Microsoft Edge', version: app.edge_version, major: app.edge_major_version }
                : { name: 'Google Chrome', version: app.chrome_version, major: app.chrome_major_version }

        // platformVersion (Sec-CH-UA-Platform-Version) must be consistent with the
        // forced platform. On Windows (UA "Windows NT 10.0") Chromium reports a
        // UA-CH platformVersion of 10/13/15 for Windows 10/11 — a random 1-15 value
        // is an obvious bot tell. On Android, report a current major (10-14) so it
        // matches the "Android <ver>" token in the UA string.
        const platformVersion = isMobile
            ? `${10 + Math.floor(Math.random() * 5)}.0.0`
            : (['10.0.0', '13.0.0', '15.0.0'] as const)[Math.floor(Math.random() * 3)]

        const uaMetadata = {
            isMobile,
            platform: isMobile ? 'Android' : 'Windows',
            fullVersionList: [
                { brand: 'Not/A)Brand', version: `${FingerprintManager.NOT_A_BRAND_VERSION}.0.0.0` },
                { brand: browserBrand.name, version: browserBrand.version },
                { brand: 'Chromium', version: app['chrome_version'] }
            ],
            brands: [
                { brand: 'Not/A)Brand', version: FingerprintManager.NOT_A_BRAND_VERSION },
                { brand: browserBrand.name, version: browserBrand.major },
                { brand: 'Chromium', version: app['chrome_major_version'] }
            ],
            platformVersion,
            architecture: isMobile ? '' : 'x86',
            bitness: isMobile ? '' : '64',
            model: ''
        }

        return { userAgent: uaTemplate, userAgentMetadata: uaMetadata }
    }

    async getChromeVersion(isMobile: boolean): Promise<string> {
        try {
            const request = {
                url: 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json',
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            }

            const response = await axios(request)
            const data: ChromeVersion = response.data
            return data.channels.Stable.version
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'USERAGENT-CHROME-VERSION',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    async getEdgeVersions(isMobile: boolean) {
        try {
            const request = {
                url: 'https://edgeupdates.microsoft.com/api/products',
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            }

            const response = await axios(request)
            const data: EdgeVersion[] = response.data
            const stable = data.find(x => x.Product == 'Stable') as EdgeVersion
            return {
                android: stable.Releases.find(x => x.Platform == 'Android')?.ProductVersion,
                windows: stable.Releases.find(x => x.Platform == 'Windows' && x.Architecture == 'x64')?.ProductVersion
            }
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'USERAGENT-EDGE-VERSION',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    getSystemComponents(mobile: boolean): string {
        if (mobile) {
            const androidVersion = 10 + Math.floor(Math.random() * 5)
            return `Linux; Android ${androidVersion}; K`
        }

        return 'Windows NT 10.0; Win64; x64'
    }

    async getAppComponents(isMobile: boolean) {
        const versions = await this.getEdgeVersions(isMobile)
        const edgeVersion = isMobile ? versions.android : (versions.windows as string)
        const edgeMajorVersion = edgeVersion?.split('.')[0]

        const chromeVersion = await this.getChromeVersion(isMobile)
        const chromeMajorVersion = chromeVersion?.split('.')[0]
        const chromeReducedVersion = `${chromeMajorVersion}.0.0.0`

        return {
            not_a_brand_version: `${FingerprintManager.NOT_A_BRAND_VERSION}.0.0.0`,
            not_a_brand_major_version: FingerprintManager.NOT_A_BRAND_VERSION,
            edge_version: edgeVersion as string,
            edge_major_version: edgeMajorVersion as string,
            chrome_version: chromeVersion as string,
            chrome_major_version: chromeMajorVersion as string,
            chrome_reduced_version: chromeReducedVersion as string
        }
    }

    async updateFingerprintUserAgent(
        fingerprint: BrowserFingerprintWithHeaders,
        isMobile: boolean,
        browser: 'chrome' | 'edge' = 'chrome'
    ): Promise<BrowserFingerprintWithHeaders> {
        try {
            const userAgentData = await this.getUserAgent(isMobile, browser)
            const componentData = await this.getAppComponents(isMobile)
            const browserBrand =
                browser === 'edge'
                    ? { name: 'Microsoft Edge', version: componentData.edge_version, major: componentData.edge_major_version }
                    : { name: 'Google Chrome', version: componentData.chrome_version, major: componentData.chrome_major_version }

            //@ts-expect-error Errors due it not exactly matching
            fingerprint.fingerprint.navigator.userAgentData = userAgentData.userAgentMetadata
            fingerprint.fingerprint.navigator.userAgent = userAgentData.userAgent
            fingerprint.fingerprint.navigator.appVersion = userAgentData.userAgent.replace(
                `${fingerprint.fingerprint.navigator.appCodeName}/`,
                ''
            )

            fingerprint.headers['user-agent'] = userAgentData.userAgent
            fingerprint.headers['sec-ch-ua'] =
                `"${browserBrand.name}";v="${browserBrand.major}", "Not=A?Brand";v="${componentData.not_a_brand_major_version}", "Chromium";v="${componentData.chrome_major_version}"`
            fingerprint.headers['sec-ch-ua-full-version-list'] =
                `"${browserBrand.name}";v="${browserBrand.version}", "Not=A?Brand";v="${componentData.not_a_brand_version}", "Chromium";v="${componentData.chrome_version}"`

            /*
            Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 EdgA/129.0.0.0
            sec-ch-ua-full-version-list: "Microsoft Edge";v="129.0.2792.84", "Not=A?Brand";v="8.0.0.0", "Chromium";v="129.0.6668.90"
            sec-ch-ua: "Microsoft Edge";v="129", "Not=A?Brand";v="8", "Chromium";v="129"
    
            Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36
            "Google Chrome";v="129.0.6668.90", "Not=A?Brand";v="8.0.0.0", "Chromium";v="129.0.6668.90"
            */

            return fingerprint
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'USER-AGENT-UPDATE',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
