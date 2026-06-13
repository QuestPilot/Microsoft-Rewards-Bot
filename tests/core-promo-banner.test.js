const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

test('Core promo banner uses the published main-branch raw asset', () => {
    const source = fs.readFileSync(path.join(root, 'src/automation/CorePromoBanner.ts'), 'utf8')

    assert.match(
        source,
        /https:\/\/raw\.githubusercontent\.com\/QuestPilot\/Microsoft-Rewards-Bot\/main\/assets\/banner-core\.png/
    )
    assert.match(source, /dashboardHost:\s*'rewards\.bing\.com'/)
    assert.match(source, /dashboardPath:\s*'\/dashboard'/)
    assert.match(source, /EdgeSearch_Dashboard/)
    assert.match(source, /cardTextPatterns:\s*\['search bar',\s*'100 points'\]/)
    assert.match(source, /cardLinkPatterns:\s*\['microsoft-edge:\/\/\?ux=searchbar',\s*'pc=esb'\]/)
})

test('browser context installs the Core promo banner init script', () => {
    const source = fs.readFileSync(path.join(root, 'src/automation/BrowserManager.ts'), 'utf8')

    assert.match(source, /installCorePromoBanner/)
    assert.match(source, /CORE_PROMO_BANNER_RUNTIME_CONFIG/)
    assert.match(source, /context\.addInitScript\(installCorePromoBanner,\s*CORE_PROMO_BANNER_RUNTIME_CONFIG\)/)
})
