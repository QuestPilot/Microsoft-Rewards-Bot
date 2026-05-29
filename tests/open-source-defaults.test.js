const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')

test('public example config starts with Core-only workers disabled', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'src/config.example.json'), 'utf8'))

    assert.equal(config.workers.doAppPromotions, false)
    assert.equal(config.workers.doDailyCheckIn, false)
    assert.equal(config.workers.doReadToEarn, false)
    assert.equal(config.workers.doDailyStreak, false)
    assert.equal(config.workers.doRedeemGoal, false)
    assert.equal(config.workers.doDashboardInfo, false)
    assert.equal(config.workers.doClaimPoints, false)
})

test('open-source premium fallbacks show concise Core hints', () => {
    const runner = fs.readFileSync(path.join(root, 'src/core/ActivityRunner.ts'), 'utf8')
    const taskBase = fs.readFileSync(path.join(root, 'src/core/TaskBase.ts'), 'utf8')

    assert.match(runner, /CORE-OPTIONAL/)
    assert.match(runner, /Learn more: https:\/\/github\.com\/QuestPilot\/Microsoft-Rewards-Bot\/blob\/HEAD\/docs\/core-plugin\.md/)
    assert.match(runner, /premiumHintsShown/)
    assert.match(taskBase, /Core unlocks full Daily Set coverage/)
})
