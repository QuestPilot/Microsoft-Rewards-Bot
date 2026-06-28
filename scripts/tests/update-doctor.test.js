const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const doctor = require('../update-doctor')

test('update doctor parses plugins.jsonc-style comments without losing URLs', () => {
    const parsed = JSON.parse(doctor.stripJsonComments(`{
        // Core stays enabled
        "core": { "enabled": true, "supportUrl": "https://example.test/a//b" },
    }`))

    assert.equal(parsed.core.enabled, true)
    assert.equal(parsed.core.supportUrl, 'https://example.test/a//b')
})

test('update doctor gives Docker-specific update action', () => {
    assert.match(
        doctor.actionForUpdateResult({ status: 'update-available', docker: true }),
        /Docker users must pull or rebuild/
    )
    assert.match(
        doctor.actionForUpdateResult({ status: 'update-available', docker: false }),
        /Run npm start/
    )
})

test('Core release check enforces exact version policy and required targets', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts/check-core-release-artifact.js'), 'utf8')

    assert.match(source, /required_core_version/)
    assert.match(source, /minimum_core_version/)
    assert.match(source, /win32-x64-node-24\.15\.0/)
    assert.match(source, /linux-x64-node-24\.15\.0/)
    assert.match(source, /linux-arm64-node-24\.15\.0/)
    assert.match(source, /darwin-x64-node-24\.15\.0/)
    assert.match(source, /compatibleArtifactSource/)
    assert.match(source, /does not match Core package version/)
})

test('Core release PowerShell script fails early on inconsistent release inputs', () => {
    const scriptPath = path.join(process.cwd(), '..', 'Core-Source', 'scripts', 'release-core-multitarget.ps1')
    const source = fs.readFileSync(scriptPath, 'utf8')

    assert.match(source, /Assert-RepositoryRoot/)
    assert.match(source, /Assert-CommandAvailable/)
    assert.match(source, /Assert-NotVersionDowngrade/)
    assert.match(source, /Strict Core release policy requires required Core version/)
    assert.match(source, /Assert-OpenSourceCoreRelease/)
    assert.match(source, /Assert-CoreApiVersionPolicy/)
})
