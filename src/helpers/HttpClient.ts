import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import axiosRetry from 'axios-retry'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { URL } from 'url'
import type { AccountProxy } from '../types/Account'
import { bracketIPv6IfNeeded } from './ProxyUtils'

class HttpClient {
    private instance: AxiosInstance
    private account: AccountProxy

    constructor(account: AccountProxy) {
        this.account = account

        this.instance = axios.create({
            timeout: 20000
        })

        // Account-safety: when a proxy is configured, route the HTTP client through it
        // BY DEFAULT (opt-out via `proxyAxios: false`). Otherwise the browser uses the
        // proxy but authenticated, account-bound API calls (getuserinfo, dapi/me, the
        // OAuth token exchange) would leak the real IP — a per-account IP split Microsoft
        // can trivially correlate. A configured proxy should cover everything.
        if (HttpClient.shouldUseProxy(this.account)) {
            const agent = this.getAgentForProxy(this.account)
            this.instance.defaults.httpAgent = agent
            this.instance.defaults.httpsAgent = agent
        }

        axiosRetry(this.instance, {
            retries: 5,
            retryDelay: axiosRetry.exponentialDelay,
            shouldResetTimeout: true,
            retryCondition: error => {
                if (axiosRetry.isNetworkError(error)) return true
                if (!error.response) return true

                const status = error.response.status
                return status === 429 || (status >= 500 && status <= 599)
            }
        })
    }

    /**
     * Whether the HTTP client should egress through the account proxy. True whenever a
     * proxy URL is set and the user hasn't explicitly opted out (`proxyAxios: false`).
     * Keeping this a pure static makes the no-IP-leak guarantee unit-testable.
     */
    static shouldUseProxy(account: Pick<AccountProxy, 'url' | 'proxyAxios'>): boolean {
        return Boolean(account.url) && account.proxyAxios !== false
    }

    private getAgentForProxy(
        proxyConfig: AccountProxy
    ): HttpProxyAgent<string> | HttpsProxyAgent<string> | SocksProxyAgent {
        const { url: baseUrl, port, username, password } = proxyConfig

        let urlObj: URL
        try {
            urlObj = new URL(baseUrl)
        } catch (e) {
            try {
                // Bare host without a scheme — bracket IPv6 first so the URL parses.
                urlObj = new URL(`http://${bracketIPv6IfNeeded(baseUrl)}`)
            } catch (error) {
                throw new Error(`Invalid proxy URL format: ${baseUrl}`)
            }
        }

        const protocol = urlObj.protocol.toLowerCase()
        let proxyUrl: string

        if (username && password) {
            urlObj.username = encodeURIComponent(username)
            urlObj.password = encodeURIComponent(password)
            urlObj.port = port.toString()
            proxyUrl = urlObj.toString()
        } else {
            // urlObj.hostname can drop IPv6 brackets — re-bracket before adding the port.
            proxyUrl = `${protocol}//${bracketIPv6IfNeeded(urlObj.hostname)}:${port}`
        }

        switch (protocol) {
            case 'http:':
                return new HttpProxyAgent(proxyUrl)
            case 'https:':
                return new HttpsProxyAgent(proxyUrl)
            case 'socks4:':
            case 'socks5:':
                return new SocksProxyAgent(proxyUrl)
            default:
                throw new Error(`Unsupported proxy protocol: ${protocol}. Only HTTP(S) and SOCKS4/5 are supported!`)
        }
    }

    public async request(config: AxiosRequestConfig, bypassProxy = false): Promise<AxiosResponse> {
        if (bypassProxy) {
            const bypassInstance = axios.create()
            axiosRetry(bypassInstance, {
                retries: 3,
                retryDelay: axiosRetry.exponentialDelay
            })
            return bypassInstance.request(config)
        }

        return this.instance.request(config)
    }
}

export default HttpClient
