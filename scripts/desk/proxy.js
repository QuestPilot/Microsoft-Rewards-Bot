'use strict'

// Rewards Desk — proxy helpers (extracted from app-window.js). Builds proxy agents
// from an account proxy config and tests connectivity for the Accounts page proxy
// check (/api/test-proxies). Behavior identical to the original inline version.

function getProxyAgent(proxy) {
    if (!proxy || !proxy.url) return null;
    let url = proxy.url;
    if (!/^https?:\/\//i.test(url) && !/^socks/i.test(url)) {
        url = 'http://' + url;
    }
    if (proxy.port && !/:[0-9]+$/.test(url)) {
        url = url.replace(/\/+$/, '') + ':' + proxy.port;
    }
    if (proxy.username && proxy.password) {
        const urlObj = new URL(url);
        urlObj.username = encodeURIComponent(proxy.username);
        urlObj.password = encodeURIComponent(proxy.password);
        url = urlObj.toString();
    } else if (proxy.username) {
        const urlObj = new URL(url);
        urlObj.username = encodeURIComponent(proxy.username);
        url = urlObj.toString();
    }

    if (/^socks/i.test(url)) {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        return {
            httpAgent: new SocksProxyAgent(url),
            httpsAgent: new SocksProxyAgent(url)
        };
    } else {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        const { HttpProxyAgent } = require('http-proxy-agent');
        return {
            httpAgent: new HttpProxyAgent(url),
            httpsAgent: new HttpsProxyAgent(url)
        };
    }
}

async function testProxy(proxy) {
    const start = Date.now();
    const agents = getProxyAgent(proxy);
    if (!agents) return { ok: false, error: 'No proxy configured' };

    try {
        const axios = require('axios');
        await axios.get('https://login.live.com', {
            httpAgent: agents.httpAgent,
            httpsAgent: agents.httpsAgent,
            timeout: 8000,
            validateStatus: () => true
        });
        return {
            ok: true,
            latencyMs: Date.now() - start
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message || 'Connection timeout'
        };
    }
}

module.exports = { getProxyAgent, testProxy }
