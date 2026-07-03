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
