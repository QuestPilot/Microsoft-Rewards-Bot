const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const { analyzeSavedPage, analyzeRewardsPage, collectScriptsForPage } = require('../scripts/rewards-page-analyzer')

test('rewards page analyzer extracts models from saved earn page when fixture exists', { skip: !fs.existsSync(path.join(process.cwd(), 'Page')) }, () => {
    const pageDir = path.join(process.cwd(), 'Page')
    const file = fs
        .readdirSync(pageDir)
        .find(entry => entry.toLowerCase().includes('gagner') && /\.html?$/i.test(entry))

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
