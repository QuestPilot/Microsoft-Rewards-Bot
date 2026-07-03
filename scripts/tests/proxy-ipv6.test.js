const assert = require('assert/strict')
const path = require('path')
const test = require('node:test')

// Built output — npm test runs after the build, so dist/ exists.
const { bracketIPv6IfNeeded, isBareIPv6 } = require(path.join(__dirname, '..', '..', 'dist', 'helpers', 'ProxyUtils.js'))

test('bracketIPv6IfNeeded brackets bare IPv6 literals so host:port is unambiguous', () => {
    assert.equal(bracketIPv6IfNeeded('2001:db8::1'), '[2001:db8::1]')
    assert.equal(bracketIPv6IfNeeded('::1'), '[::1]')
    assert.equal(bracketIPv6IfNeeded('fe80::1ff:fe23:4567:890a'), '[fe80::1ff:fe23:4567:890a]')
})

test('bracketIPv6IfNeeded leaves IPv4, hostnames and host:port untouched', () => {
    assert.equal(bracketIPv6IfNeeded('192.168.1.1'), '192.168.1.1')
    assert.equal(bracketIPv6IfNeeded('proxy.example.com'), 'proxy.example.com')
    // one colon = host:port, not an IPv6 literal
    assert.equal(bracketIPv6IfNeeded('proxy.example.com:8080'), 'proxy.example.com:8080')
})

test('bracketIPv6IfNeeded never double-brackets or rewrites full URLs', () => {
    assert.equal(bracketIPv6IfNeeded('[2001:db8::1]'), '[2001:db8::1]')
    assert.equal(bracketIPv6IfNeeded('http://[2001:db8::1]'), 'http://[2001:db8::1]')
})

test('isBareIPv6 classifies hosts correctly', () => {
    assert.equal(isBareIPv6('2001:db8::1'), true)
    assert.equal(isBareIPv6('::1'), true)
    assert.equal(isBareIPv6('192.168.1.1'), false)
    assert.equal(isBareIPv6('[2001:db8::1]'), false)
    assert.equal(isBareIPv6('host:8080'), false)
})
