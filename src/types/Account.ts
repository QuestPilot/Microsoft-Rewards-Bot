export interface Account {
    email: string
    enabled?: boolean
    password: string
    totpSecret?: string
    recoveryEmail: string
    geoLocale: 'auto' | string
    langCode: 'en' | string
    proxy: AccountProxy
    saveFingerprint: ConfigSaveFingerprint
    /**
     * Per-account override for the Microsoft Rewards dashboard variant.
     *  - 'auto' (default): detect at login (Next.js first, else legacy ASP.NET).
     *  - 'next' / 'legacy': force the variant (handy for testing both dashboards).
     * Remove this field entirely when legacy support is dropped.
     */
    dashboardMode?: 'auto' | 'next' | 'legacy'
    /**
     * Per-account override for the global `config.proxy.strictMode` kill-switch
     * (skip the account rather than run it without a configured proxy).
     *  - 'auto' (default): follow the global setting.
     *  - 'require': always skip this account without a proxy, even if the global
     *    setting is off (e.g. an account you never want to risk running unprotected).
     *  - 'exempt': never skip this account for missing a proxy, even if the global
     *    setting is on (e.g. an account you're comfortable running on your real IP).
     */
    strictProxy?: 'auto' | 'require' | 'exempt'
}

export interface AccountProxy {
    /** Route the HTTP client through the proxy too. Defaults to true when a proxy
     *  `url` is set; set false only to deliberately send API calls off-proxy. */
    proxyAxios?: boolean
    url: string
    port: number
    password: string
    username: string
}

export interface ConfigSaveFingerprint {
    mobile: boolean
    desktop: boolean
}
