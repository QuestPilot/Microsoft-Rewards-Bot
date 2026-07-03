const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..', '..')

test('activity routing no longer depends on the retired exploreonbing section name', () => {
    const taskBase = fs.readFileSync(path.join(root, 'src/core/TaskBase.ts'), 'utf8')

    assert.match(taskBase, /isSearchOnBingPromotion\(activity\)/)
    assert.doesNotMatch(taskBase, /name\.includes\('exploreonbing'\)/)
    assert.match(taskBase, /features\.includes\('vstooltip'\)/)
})

test('browser-mode activity fallbacks use an active page instead of hardcoded mobile page', () => {
    for (const file of ['UrlReward.ts', 'Quiz.ts', 'FindClippy.ts']) {
        const source = fs.readFileSync(path.join(root, 'src/core/tasks/api', file), 'utf8')

        assert.match(source, /this\.getActiveTaskPage\(\)/, file)
        assert.doesNotMatch(source, /const page = this\.bot\.mainMobilePage/, file)
    }
})

test('ghost click has a locator fallback after ghost cursor failure', () => {
    const source = fs.readFileSync(path.join(root, 'src/automation/AutomationUtils.ts'), 'utf8')

    assert.match(source, /scrollIntoViewIfNeeded/)
    assert.match(source, /Ghost cursor failed/)
    assert.match(source, /locator\.click\(fallbackOptions\)/)
})

test('legacy daily-set urlreward offers are NOT rerouted to the dead bingqa quiz endpoint', () => {
    const taskBase = fs.readFileSync(path.join(root, 'src/core/TaskBase.ts'), 'utf8')

    // The daily-set (dsetqu/isconversation/pollscenarioid) reroute to doQuiz exists
    // only for the Next.js dashboard. On legacy these offers must fall through to
    // doUrlReward (rewards.bing.com/api/reportactivity → 200) — the bingqa endpoint
    // rejects them with HTTP 400 (0 points). The variant gate must guard the reroute.
    assert.match(
        taskBase,
        /dashboardVariant !== 'legacy' &&[\s\S]{0,160}form=dsetqu\|pollscenarioid\|filters=isconversation/
    )

    // Polls are skipped entirely on legacy (the reference bot does the same).
    assert.match(taskBase, /Skipped Poll on legacy dashboard/)
})

test('legacy quiz endpoint treats HTTP 400 as a non-fatal "no points" outcome', () => {
    const legacy = fs.readFileSync(
        path.join(root, 'src/automation/dashboard/legacy/LegacyDashboardActions.ts'),
        'utf8'
    )

    // A genuine bingqa 400 (offer not creditable via the quiz endpoint) must not be
    // logged as a hard error — it is expected and matches the reference bot.
    assert.match(legacy, /status === 400/)
    assert.match(legacy, /bingqa returned 400/)
})
