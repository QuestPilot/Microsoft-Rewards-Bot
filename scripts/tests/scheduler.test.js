const assert = require('assert/strict')
const test = require('node:test')

const { getNextScheduledRun } = require('../../dist/core/Scheduler')

test('scheduler moves to tomorrow when jittered target already passed after a long run', () => {
    const run = getNextScheduledRun(
        {
            enabled: true,
            runOnStartup: false,
            timezone: 'Africa/Juba',
            startTime: '07:00',
            randomDelay: {
                min: '31min',
                max: '31min'
            }
        },
        new Date('2026-06-02T07:59:02.000Z')
    )

    assert.equal(run.target > new Date('2026-06-02T07:59:02.000Z'), true)
    assert.equal(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Juba',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).format(run.target),
        '03/06/2026, 07:31:00'
    )
})
