const assert = require('assert/strict')
const test = require('node:test')

const Helpers = require('../dist/helpers/Helpers').default

test('random delay multiplier scales randomized action delays', () => {
    const helpers = new Helpers()
    helpers.randomNumber = () => 1000

    assert.equal(helpers.randomDelay(1000, 1000), 1000)

    helpers.setRandomDelayMultiplier(4)
    assert.equal(helpers.randomDelay(1000, 1000), 4000)
})

test('invalid random delay multipliers fall back to normal pacing', () => {
    const helpers = new Helpers()
    helpers.randomNumber = () => 1000
    helpers.setRandomDelayMultiplier(0)

    assert.equal(helpers.randomDelay(1000, 1000), 1000)
})
