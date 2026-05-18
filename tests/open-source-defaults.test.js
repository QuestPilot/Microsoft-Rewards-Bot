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
