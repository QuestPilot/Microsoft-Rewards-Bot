const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

// The Core-only "Capture dashboard pages" maintenance harvester plugs into the
// existing premium-task seam: a PremiumTaskMap key, an ActivityRunner no-op stub,
// a Main() invocation gated by an OPT-IN config flag, and a Desk toggle. The real
// implementation ships only in the compiled Core plugin — the public bot must
// carry a clean no-op so forks get nothing.

test('PremiumTaskMap exposes the dashboard-capture task and its result type', () => {
    const api = read('src/core/InternalPluginAPI.ts')
    assert.match(api, /doCaptureDashboardPages:\s*\(page: Page\)\s*=>\s*Promise<DashboardCaptureResult>/)
    assert.match(api, /export interface DashboardCaptureResult/)
    assert.match(api, /captured:\s*number/)
    assert.match(api, /routes:\s*string\[\]/)
    assert.match(api, /problems:\s*string\[\]/)
})

test('ActivityRunner ships a clean no-op capture stub without Core', () => {
    const runner = read('src/core/ActivityRunner.ts')
    assert.match(runner, /doCaptureDashboardPages\s*=\s*async\s*\(page: Page\)/)
    // Delegates to the plugin implementation when installed…
    assert.match(runner, /if \(this\.premiumTasks\.doCaptureDashboardPages\)/)
    // …otherwise returns an empty result (nothing captured, no points, no throw).
    assert.match(runner, /return \{ captured: 0, routes: \[\], outputDir: 'Page', problems: \[\] \}/)
})

test('Main() runs the harvester only when the opt-in core flag is set', () => {
    const index = read('src/index.ts')
    assert.match(index, /if \(this\.config\.core\?\.captureDashboardPages\)/)
    assert.match(index, /this\.activities\.doCaptureDashboardPages\(this\.mainMobilePage\)/)
})

test('capture flag is opt-in (default false) and schema-validated', () => {
    const example = JSON.parse(read('src/config.example.json'))
    const live = JSON.parse(read('src/config.json'))
    assert.equal(example.core.captureDashboardPages, false)
    assert.equal(live.core.captureDashboardPages, false)

    const types = read('src/types/Config.ts')
    assert.match(types, /captureDashboardPages\?:\s*boolean/)

    const schema = read('src/helpers/SchemaValidator.ts')
    assert.match(schema, /captureDashboardPages:\s*z\.boolean\(\)\.optional\(\)/)
})

test('Desk wires the capture toggle as a Core, next-only, points-less control', () => {
    const desk = read('scripts/app-window.js')
    // Toggle element + master key list.
    assert.match(desk, /id="tog-core-captureDashboardPages"/)
    assert.match(desk, /'captureDashboardPages'/)
    // Named "Page Harvester" in the UI.
    assert.match(desk, /Page Harvester/)
    // Badged next-only so legacy accounts aren't misled.
    assert.match(desk, /CORE_NEXT_ONLY\s*=\s*\{[^}]*captureDashboardPages:true/)
    // It grants no points — must NOT appear in the points-estimate map, and must
    // NOT be wired to a backing open-source worker flag (it has none).
    const est = desk.slice(desk.indexOf('var CORE_EST'), desk.indexOf('var CORE_EST') + 700)
    assert.doesNotMatch(est, /captureDashboardPages/)
    const workerMap = desk.slice(desk.indexOf('CORE_WORKER_MAP = {'), desk.indexOf('CORE_WORKER_MAP = {') + 200)
    assert.doesNotMatch(workerMap, /captureDashboardPages/)
})

test('Main() auto-disables capture toggle in config.json after a successful capture', () => {
    const index = read('src/index.ts')
    assert.match(index, /captureDashboardPages = false/)
    assert.match(index, /config\.json/)
    assert.match(index, /cfgRaw\.core\.captureDashboardPages = false/)
})

test('punchcard URL rewards with Bing search destination are treated as UrlReward not SearchOnBing', () => {
    const taskBase = read('src/core/TaskBase.ts')
    // Punchcard children must be excluded from the URL-pattern-based SearchOnBing
    // classification so they go through UrlReward and navigate to the tracked
    // destination URL (OCID), not a generic search that earns nothing.
    assert.match(taskBase, /offerId.*punchcard.*return false|includes.*punchcard.*return false/)
    // String-based check (fields contain 'searchonbing') must still come BEFORE
    // the punchcard guard so genuine search punchcards are not broken.
    const body = taskBase.slice(taskBase.indexOf('isSearchOnBingPromotion'))
    const stringCheckIdx = body.indexOf("fields.includes('searchonbing')")
    const punchcardGuardIdx = body.indexOf("includes('punchcard')")
    assert.ok(stringCheckIdx < punchcardGuardIdx, 'string check must precede punchcard guard')
})
