const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

test('browser contexts use a large desktop viewport', () => {
    const viewport = fs.readFileSync(path.join(root, 'src/automation/BrowserViewport.ts'), 'utf8')
    const browserManager = fs.readFileSync(path.join(root, 'src/automation/BrowserManager.ts'), 'utf8')
    const index = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')

    assert.match(viewport, /width:\s*1440/)
    assert.match(viewport, /height:\s*900/)
    assert.match(browserManager, /--start-maximized/)
    assert.match(browserManager, /newContextOptions:\s*{[\s\S]*viewport:\s*DESKTOP_BROWSER_VIEWPORT/)
    assert.match(index, /setViewportSize\(DESKTOP_BROWSER_VIEWPORT\)/)
    assert.doesNotMatch(index, /width:\s*768,\s*height:\s*1024/)
})
