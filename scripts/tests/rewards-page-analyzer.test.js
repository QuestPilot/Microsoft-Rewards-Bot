const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
    analyzeSavedPage,
    analyzeRewardsPage,
    collectScriptsForPage,
    normalizeModelType
} = require('../diagnostics/rewards-page-analyzer')

// Skip unless the actual earn-page fixture file is present. A bare (possibly
// empty) Page/ directory must not turn this optional fixture test into a failure.
function findEarnFixture() {
    const pageDir = path.join(process.cwd(), 'Page')
    if (!fs.existsSync(pageDir)) return null
    try {
        return fs
            .readdirSync(pageDir)
            .find(entry => entry.toLowerCase().includes('gagner') && /\.html?$/i.test(entry)) || null
    } catch {
        return null
    }
}

test('rewards page analyzer extracts models from saved earn page when fixture exists', { skip: !findEarnFixture() }, () => {
    const pageDir = path.join(process.cwd(), 'Page')
    const file = findEarnFixture()

    assert.ok(file, 'earn page fixture should exist')

    const html = fs.readFileSync(path.join(pageDir, file), 'utf8')
    const scriptText = collectScriptsForPage(path.join(pageDir, file))
    const analysis = analyzeRewardsPage(html, scriptText)

    assert.ok(analysis.modelTypes.includes('dailyset') || analysis.modelTypes.includes('streak'))
    assert.ok(analysis.activities.length > 0)
    assert.ok(analysis.activities.some(activity => activity.offerId || activity.destination || activity.destinationUrl))
    assert.ok(Array.isArray(analysis.switches))
    assert.ok(Array.isArray(analysis.disclosures))
    assert.ok(analysis.panelSignals)
    assert.ok(Array.isArray(analysis.problems))
})

test('saved page analyzer classifies Bing search captures separately', () => {
    const html = '<html><body><form id="sb_form"><input id="sb_form_q" name="q"></form></body></html>'
    const analysis = analyzeSavedPage(html)

    assert.equal(analysis.kind, 'bing-search')
    assert.equal(analysis.searchBoxPresent, true)
    assert.ok(analysis.problems.includes('No Rewards quiz/search attribution signals found'))
})

test('collectScriptsForPage supports browser _files asset directories', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'msrb-analyzer-'))
    const pageFile = path.join(temp, 'Dashboard.htm')
    const assetDir = path.join(temp, 'Dashboard_files')
    fs.writeFileSync(pageFile, '<html></html>')
    fs.mkdirSync(assetDir)
    fs.writeFileSync(path.join(assetDir, 'chunk.js'), 'reportActivity createServerReference("abc")')

    assert.match(collectScriptsForPage(pageFile), /reportActivity/)
})

test('rewards page analyzer keeps daily set offer hashes paired with their item', () => {
    const fixture = path.join(process.cwd(), 'Dash-Msn-Rw', 'New', 'Dashboard – Microsoft Rewards.html')
    if (!fs.existsSync(fixture)) return

    const analysis = analyzeRewardsPage(fs.readFileSync(fixture, 'utf8'))
    const child2 = analysis.activities.find(activity => activity.offerId === 'Global_DailySet_20260604_Child2')

    assert.equal(child2.hash, 'e33cf04d34e275d4b878e60be5bd0f91d2dd24681e71d30351208250d975005c')
    assert.equal(child2.title, 'Russell’s summer bliss')
})

test('static Rewards routes do not require activity models or a reportActivity action id', () => {
    const html = '<script>self.__next_f.push([1,"\\"c\\":[\\"\\",\\"about\\"]"])</script>'
    const analysis = analyzeSavedPage(html)

    assert.equal(analysis.kind, 'rewards-next')
    assert.equal(analysis.route, 'about')
    assert.deepEqual(analysis.problems, [])
    assert.deepEqual(analysis.diagnostics, [])
})

test('missing lazy reportActivity chunk is diagnostic rather than a capture failure', () => {
    const html = '<script>self.__next_f.push([1,"\\"c\\":[\\"\\",\\"earn\\"],\\"type\\":\\"dailyset\\",\\"model\\":{\\"offerId\\":\\"offer-1\\",\\"hash\\":\\"hash-1\\"}"])</script>'
    const analysis = analyzeSavedPage(html)

    assert.deepEqual(analysis.problems, [])
    assert.ok(analysis.diagnostics.some(message => message.includes('may load only during an activity')))
})

test('RSC model types are normalized across embedded whitespace', () => {
    assert.equal(normalizeModelType('streakbo\nnus'), 'streakbonus')
    assert.equal(normalizeModelType('  DailySet  '), 'dailyset')
})

test('TypeScript and CLI analyzers retain the same route-aware rules', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'automation', 'RewardsPageAnalyzer.ts'), 'utf8')

    assert.match(source, /ACTIVITY_ROUTES = new Set\(\['dashboard', 'earn'\]\)/)
    assert.match(source, /ACTIVITY_ROUTES\.has\(analysis\.route\)/)
    assert.match(source, /normalizeModelType\(match\[1\]\)/)
    assert.doesNotMatch(source, /problems\.push\('reportActivity server action id not found/)
})
