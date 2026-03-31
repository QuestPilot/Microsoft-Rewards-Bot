export interface Account {
    /** Enable/disable this account (if false, account will be skipped during execution) */
    enabled?: boolean;
    email: string;
    password: string;
    /** Optional TOTP secret in Base32 (e.g., from Microsoft Authenticator setup) */
    totp?: string;
    /** Recovery email used during security challenge verification. Leave empty if not needed. */
    recoveryEmail?: string;
    /** Phone number associated with account (required for redeeming free rewards/gift cards) */
    phoneNumber?: string;
    proxy: AccountProxy;
}

export interface AccountProxy {
    proxyAxios: boolean;
    url: string;
    port: number;
    password: string;
    username: string;
}