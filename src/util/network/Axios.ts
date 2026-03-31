import axios, {
    AxiosError,
    AxiosInstance,
    AxiosRequestConfig,
    AxiosResponse,
} from "axios";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { AccountProxy } from "../../interface/Account";
import { getErrorMessage } from "../core/Utils";

export class AxiosClient {
  private instance: AxiosInstance;
  private account: AccountProxy;

  constructor(account: AccountProxy) {
    this.account = account;
    this.instance = axios.create();

    // If a proxy configuration is provided, set up the agent
    if (this.account.url && this.account.proxyAxios) {
      const agent = this.getAgentForProxy(this.account);
      this.instance.defaults.httpAgent = agent;
      this.instance.defaults.httpsAgent = agent;
    }
  }

  private getAgentForProxy(
    proxyConfig: AccountProxy,
  ): HttpProxyAgent<string> | HttpsProxyAgent<string> | SocksProxyAgent {
    const { proxyUrl, protocol } = this.buildProxyUrl(proxyConfig);
    const normalized = protocol.replace(/:$/, "").toLowerCase();

    switch (normalized) {
      case "http":
        return new HttpProxyAgent(proxyUrl);
      case "https":
        return new HttpsProxyAgent(proxyUrl);
      case "socks":
      case "socks4":
      case "socks5":
        return new SocksProxyAgent(proxyUrl);
      default:
        throw new Error(
          `Unsupported proxy protocol in "${proxyConfig.url}". Supported: http://, https://, socks://, socks4://, socks5://`,
        );
    }
  }

  private buildProxyUrl(proxyConfig: AccountProxy): {
    proxyUrl: string;
    protocol: string;
  } {
    const { url, port, username, password } = proxyConfig;

    if (!url) {
      throw new Error("Proxy URL is required when proxyAxios is enabled.");
    }

    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
    const candidate = hasScheme ? url : `http://${url}`;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate);
    } catch (err) {
      throw new Error(`Invalid proxy URL "${url}": ${(err as Error).message}`);
    }

    const protocol = parsedUrl.protocol.replace(/:$/, "");
    const allowed = new Set(["http", "https", "socks", "socks4", "socks5"]);
    if (!allowed.has(protocol)) {
      throw new Error(
        `Unsupported proxy protocol in "${url}". Supported: http://, https://, socks://, socks4://, socks5://`,
      );
    }

    if (!parsedUrl.port) {
      if (port) {
        parsedUrl.port = String(port);
      } else {
        throw new Error(
          `Proxy port missing for "${url}". Provide a port value.`,
        );
      }
    }

    if (username) {
      parsedUrl.username = encodeURIComponent(username);
    }

    if (password) {
      parsedUrl.password = encodeURIComponent(password);
    }

    return { proxyUrl: parsedUrl.toString(), protocol: parsedUrl.protocol };
  }

  // Generic method to make any Axios request with retry logic
  public async request(
    config: AxiosRequestConfig,
    bypassProxy = false,
  ): Promise<AxiosResponse> {
    if (bypassProxy) {
      const bypassInstance = axios.create();
      return bypassInstance.request(config);
    }

    // FIXED: Initialize lastError to prevent throwing undefined
    let lastError: unknown = new Error("Request failed with unknown error");
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.instance.request(config);
      } catch (err: unknown) {
        lastError = err;

        // Handle HTTP 407 Proxy Authentication Required
        if (this.isProxyAuthError(err)) {
          const msg = getErrorMessage(err);
          throw new Error(
            `Proxy authentication failed. Direct fallback disabled to avoid IP leakage. Details: ${msg}`,
          );
        }

        // Handle retryable network errors
        if (this.isRetryableError(err)) {
          if (attempt < maxAttempts) {
            // Exponential backoff: 1s, 2s, 4s, etc.
            const delayMs = 1000 * Math.pow(2, attempt - 1);
            await this.sleep(delayMs);
            continue;
          }
        }

        // Non-retryable error
        throw err;
      }
    }

    throw lastError;
  }

  /**
   * Check if error is HTTP 407 Proxy Authentication Required
   */
  private isProxyAuthError(err: unknown): boolean {
    const axiosErr = err as AxiosError | undefined;
    return axiosErr?.response?.status === 407;
  }

  /**
   * Check if error is retryable (network/proxy issues)
   */
  private isRetryableError(err: unknown): boolean {
    const e = err as
      | { code?: string; cause?: { code?: string }; message?: string }
      | undefined;
    if (!e) return false;

    const code = e.code || e.cause?.code;
    const isNetworkError =
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "EPIPE";

    const msg = String(e.message || "");
    const isProxyIssue = /proxy|tunnel|socks|agent/i.test(msg);

    return isNetworkError || isProxyIssue;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
