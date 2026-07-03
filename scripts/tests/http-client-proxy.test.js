const assert = require('assert/strict')
const test = require('node:test')

const HttpClient = require('../../dist/helpers/HttpClient').default

// Account-safety regression guard: a configured proxy MUST cover the HTTP client by
// default. If this silently flips back to opt-in, authenticated account API calls
// (getuserinfo, dapi/me, OAuth token exchange) leak the real IP — see HttpClient.ts.

test('a configured proxy is used by default (proxyAxios omitted)', () => {
    assert.equal(HttpClient.shouldUseProxy({ url: 'http://1.2.3.4', proxyAxios: undefined }), true)
})

test('a configured proxy is used when proxyAxios is true', () => {
    assert.equal(HttpClient.shouldUseProxy({ url: 'http://1.2.3.4', proxyAxios: true }), true)
})

test('proxyAxios:false is honored as an explicit opt-out', () => {
    assert.equal(HttpClient.shouldUseProxy({ url: 'http://1.2.3.4', proxyAxios: false }), false)
})

test('no proxy is used when no proxy URL is set', () => {
    assert.equal(HttpClient.shouldUseProxy({ url: '', proxyAxios: true }), false)
})
