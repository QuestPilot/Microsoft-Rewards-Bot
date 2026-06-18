const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')

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
