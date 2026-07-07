'use strict'

// Unit tests for the network broker behind ctx.fetch (scripts/plugins/plugin-fetch-broker.js).
// A mock fetch impl is injected so nothing hits the network — we assert the SECURITY
// gates: https-only, host allowlist, SSRF blocks (IP-literal / loopback / *.local),
// redirect refusal, and the GET/POST method allowlist.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createFetchBroker, isDangerousHost } = require('../plugins/plugin-fetch-broker')

function mockResponse(over = {}) {
    return {
        ok: over.ok !== undefined ? over.ok : true,
        status: over.status !== undefined ? over.status : 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? over.contentType || 'application/json' : null) },
        text: async () => (over.body !== undefined ? over.body : '{"ok":true}'),
    }
}

function brokerWith(hosts, impl) {
    return createFetchBroker({ allowedHosts: hosts, fetchImpl: impl || (async () => mockResponse()) })
}

test('allows an https GET to a granted host and returns the body', async () => {
    let seen = null
    const broker = brokerWith(['api.example.com'], async (url, init) => { seen = { url, init }; return mockResponse({ body: '{"v":1}' }) })
    const r = await broker.fetch('https://api.example.com/data?q=1')
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.equal(r.body, '{"v":1}')
    assert.equal(seen.init.method, 'GET')
    assert.equal(seen.init.redirect, 'manual')
})

test('rejects a host that is not in the granted allowlist', async () => {
    const broker = brokerWith(['api.example.com'])
    await assert.rejects(() => broker.fetch('https://evil.example.net/x'), /not in the plugin's granted/)
})

test('rejects non-https schemes', async () => {
    const broker = brokerWith(['api.example.com'])
    await assert.rejects(() => broker.fetch('http://api.example.com/x'), /only https/)
})

test('blocks SSRF targets: IP literals, loopback, and internal names', async () => {
    assert.equal(isDangerousHost('127.0.0.1'), true)
    assert.equal(isDangerousHost('169.254.169.254'), true) // cloud metadata
    assert.equal(isDangerousHost('10.0.0.5'), true)
    assert.equal(isDangerousHost('localhost'), true)
    assert.equal(isDangerousHost('foo.local'), true)
    assert.equal(isDangerousHost('svc.internal'), true)
    assert.equal(isDangerousHost('api.example.com'), false)
    // Even if such a host were somehow granted, the broker still refuses it.
    const broker = brokerWith(['169.254.169.254'])
    await assert.rejects(() => broker.fetch('https://169.254.169.254/latest/meta-data/'), /not allowed/)
})

test('refuses redirects (no smuggling to an un-allowlisted host)', async () => {
    const broker = brokerWith(['api.example.com'], async () => mockResponse({ status: 302 }))
    await assert.rejects(() => broker.fetch('https://api.example.com/x'), /redirects are not allowed/)
})

test('only GET and POST are allowed', async () => {
    const broker = brokerWith(['api.example.com'])
    await assert.rejects(() => broker.fetch('https://api.example.com/x', { method: 'DELETE' }), /only GET and POST/)
})

test('a broker with no granted hosts rejects everything', async () => {
    const broker = createFetchBroker({ allowedHosts: [] })
    await assert.rejects(() => broker.fetch('https://api.example.com/x'), /no granted network permissions/)
})

test('fetchJson returns an error shape instead of throwing (safe to bridge)', async () => {
    const broker = brokerWith(['api.example.com'])
    const json = await broker.fetchJson(JSON.stringify({ url: 'https://evil.net/x' }))
    const parsed = JSON.parse(json)
    assert.equal(parsed.ok, false)
    assert.match(parsed.error, /not in the plugin's granted/)
})
