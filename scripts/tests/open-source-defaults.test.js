const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..', '..')

test('public example config starts with user-friendly Core-ready workers enabled', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'src/config.example.json'), 'utf8'))

    assert.equal(config.workers.doAppPromotions, true)
    assert.equal(config.workers.doDailyCheckIn, true)
    assert.equal(config.workers.doReadToEarn, true)
    assert.equal(config.workers.doDailyStreak, true)
    assert.equal(config.workers.doDashboardInfo, true)
    assert.equal(config.workers.doClaimPoints, true)
    assert.equal(config.workers.doApplyCoupons, true)
    assert.equal(Object.hasOwn(config.workers, 'doRedeemGoal'), false)
    assert.equal(Object.hasOwn(config, 'redeemGoal'), false)
    assert.equal(Object.hasOwn(config, 'safetyAdvisory'), false)
    assert.equal(config.terminal.enabled, false)

    // Analytics must be enabled by default (opt-out, not opt-in)
    assert.equal(config.analytics.enabled, true)

    // Personal Discord report webhooks have been replaced by analytics — must not exist
    assert.equal(Object.hasOwn(config.webhook, 'autoReport'), false)
    assert.equal(Object.hasOwn(config.webhook, 'runSummary'), false)
    assert.equal(Object.hasOwn(config.webhook, 'errorReporting'), false)
})

test('open-source premium fallbacks show concise Core hints', () => {
    const runner = fs.readFileSync(path.join(root, 'src/core/ActivityRunner.ts'), 'utf8')
    const taskBase = fs.readFileSync(path.join(root, 'src/core/TaskBase.ts'), 'utf8')

    assert.match(runner, /CORE-OPTIONAL/)
    assert.match(runner, /Learn more: https:\/\/github\.com\/QuestPilot\/Microsoft-Rewards-Bot\/blob\/HEAD\/docs\/core-plugin\.md/)
    assert.match(runner, /premiumHintsShown/)
    assert.match(taskBase, /Core unlocks full Daily Set coverage/)
})
