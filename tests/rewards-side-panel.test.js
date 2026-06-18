const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')
const { chromium } = require('patchright')

const enabled = process.env.MSRB_DASHBOARD_MOCK_TEST === '1'
const controllerPath = path.join(__dirname, '..', 'dist', 'automation', 'RewardsSidePanelController.js')

function getController() {
    return require(controllerPath).RewardsSidePanelController
}

function mockRewardsHtml({ checked = false, disabled = false, imageSrc = 'https://bing.com/th?id=OMR.Icons.Fire.png', switchKind = 'input' } = {}) {
    const switchMarkup =
        switchKind === 'button'
            ? `<button role="switch" aria-checked="${checked ? 'true' : 'false'}" ${disabled ? 'aria-disabled="true" disabled' : ''} onclick="
                if (this.getAttribute('aria-disabled') !== 'true') {
                  this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
                }
              ">Protection</button>`
            : `<label data-rac ${disabled ? 'data-disabled="true"' : ''}>
          <span>
            <input role="switch" type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          </span>
        </label>`

    return `<!doctype html>
<html>
<body>
  <section id="snapshot">
    <button slot="trigger" aria-expanded="false" onclick="
      this.setAttribute('aria-expanded','true');
      document.querySelector('#snapshot-content').hidden = false;
    ">Progress</button>
    <div id="snapshot-content" hidden>
      <button data-rac aria-expanded="false" onclick="
        this.setAttribute('aria-expanded','true');
        document.querySelector('#streak-panel').hidden = false;
      ">
        <img src="${imageSrc}" alt="Daily streak">
      </button>
      <div id="streak-panel" class="react-aria-DisclosurePanel" role="group" hidden>
        ${switchMarkup}
        <button aria-label="Close" onclick="document.querySelector('#streak-panel').hidden = true">x</button>
      </div>
    </div>
  </section>
</body>
</html>`
}

async function withPage(html, fn) {
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent(html)
        await fn(page)
    } finally {
        await browser.close()
    }
}

test('mock dashboard expands snapshot, opens streak panel, and enables switch', async () => {
    if (!enabled) return
    assert.ok(fs.existsSync(controllerPath), 'run npm run build before dashboard mock tests')

    await withPage(mockRewardsHtml({ checked: false }), async page => {
        const RewardsSidePanelController = getController()
        const panel = new RewardsSidePanelController(page)

        assert.equal(await panel.expandDisclosure('section#snapshot'), true)
        assert.equal(await panel.openFirstCardByImageToken('Fire', 'section#snapshot'), true)

        const result = await panel.setFirstSwitchState(true)
        assert.equal(result.found, true)
        assert.equal(result.disabled, false)
        assert.equal(result.before, false)
        assert.equal(result.after, true)
        assert.equal(result.changed, true)
    })
})

test('mock dashboard can disable an already enabled switch', async () => {
    if (!enabled) return
    assert.ok(fs.existsSync(controllerPath), 'run npm run build before dashboard mock tests')

    await withPage(mockRewardsHtml({ checked: true }), async page => {
        const RewardsSidePanelController = getController()
        const panel = new RewardsSidePanelController(page)

        await panel.expandDisclosure('section#snapshot')
        await panel.openFirstCardByImageToken('Fire', 'section#snapshot')

        const result = await panel.setFirstSwitchState(false)
        assert.equal(result.found, true)
        assert.equal(result.before, true)
        assert.equal(result.after, false)
        assert.equal(result.changed, true)
    })
})

test('mock dashboard reports disabled switch without crashing', async () => {
    if (!enabled) return
    assert.ok(fs.existsSync(controllerPath), 'run npm run build before dashboard mock tests')

    await withPage(mockRewardsHtml({ checked: true, disabled: true }), async page => {
        const RewardsSidePanelController = getController()
        const panel = new RewardsSidePanelController(page)

        await panel.expandDisclosure('section#snapshot')
        await panel.openFirstCardByImageToken('Fire', 'section#snapshot')

        const result = await panel.setFirstSwitchState(false)
        assert.equal(result.found, true)
        assert.equal(result.disabled, true)
        assert.equal(result.before, true)
        assert.equal(result.after, true)
        assert.equal(result.changed, false)
    })
})

test('mock dashboard opens first snapshot card when image src has no token', async () => {
    if (!enabled) return
    assert.ok(fs.existsSync(controllerPath), 'run npm run build before dashboard mock tests')

    await withPage(mockRewardsHtml({ imageSrc: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }), async page => {
        const RewardsSidePanelController = getController()
        const panel = new RewardsSidePanelController(page)

        assert.equal(await panel.expandDisclosure('section#snapshot'), true)
        assert.equal(await panel.openFirstCardByImageToken('Fire', 'section#snapshot'), true)
    })
})

test('mock dashboard can toggle a button role switch', async () => {
    if (!enabled) return
    assert.ok(fs.existsSync(controllerPath), 'run npm run build before dashboard mock tests')

    await withPage(mockRewardsHtml({ checked: false, switchKind: 'button' }), async page => {
        const RewardsSidePanelController = getController()
        const panel = new RewardsSidePanelController(page)

        await panel.expandDisclosure('section#snapshot')
        await panel.openFirstCardByImageToken('Fire', 'section#snapshot')

        const result = await panel.setFirstSwitchState(true)
        assert.equal(result.found, true)
        assert.equal(result.disabled, false)
        assert.equal(result.before, false)
        assert.equal(result.after, true)
        assert.equal(result.changed, true)
    })
})
