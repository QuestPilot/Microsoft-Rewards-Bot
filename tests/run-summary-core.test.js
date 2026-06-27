const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8')

test('run summary is driven by analytics, not a Discord embed', () => {
    // Coupon data collection still happens — the data feeds analytics
    assert.match(source, /coupons:\s*AppliedCoupon\[\]/)
    assert.match(source, /this\.userData\.coreStats\.coupons\.push\(\.\.\.couponResult\.coupons\)/)

    // Run summary fires an analytics event (not a personal Discord webhook embed)
    assert.match(source, /analytics\.track\(\s*'run_completed'/)
    assert.match(source, /AnalyticsService/)

    // Removed: personal Discord run-report machinery must not be present
    assert.doesNotMatch(source, /buildRunSummaryEmbed/)
    assert.doesNotMatch(source, /formatCouponSummary/)
    assert.doesNotMatch(source, /summaryConfig\.discordUrl/)
    assert.doesNotMatch(source, /sendAutoReport/)
})

test('maintainer error relay (Core-API → Discord) is kept and gated by analytics', () => {
    // The dual-channel helper exists: PostHog event + Discord relay
    assert.match(source, /private async reportRunError/)
    assert.match(source, /import \{ reportError, type ErrorReportInput \} from '\.\/notifications\/ErrorReport'/)
    // Discord relay only fires when telemetry is on (single switch)
    assert.match(source, /if \(this\.analytics\.isEnabled\) \{\s*await reportError\(input\)/)
    // All three failure kinds still flow through the helper
    assert.match(source, /kind: 'run_fatal'/)
    assert.match(source, /kind: 'account_zero_points'/)
    assert.match(source, /kind: 'account_failed'/)
})
