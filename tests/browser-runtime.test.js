const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const browserManager = fs.readFileSync(path.resolve(__dirname, '../src/automation/BrowserManager.ts'), 'utf8')
const main = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8')

test('browser runtime requires Patchright Chromium instead of silently using system Chrome', () => {
    assert.match(browserManager, /npx patchright install chromium/)
    assert.match(browserManager, /chromium \(Patchright bundled\)/)
    assert.doesNotMatch(browserManager, /for \(const channel of \[undefined, 'chrome', 'msedge'\]/)
})

test('browser processes are tracked and closed during shutdown paths', () => {
    assert.match(browserManager, /activeBrowsers = new Set/)
    assert.match(browserManager, /async closeAll\(\)/)
    assert.match(main, /await rewardsBot\.closeAllBrowsers\(\)/)
})
