const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const controllerPath = path.join(root, 'dist', 'automation', 'PageController.js')

function createController() {
    assert.ok(fs.existsSync(controllerPath), 'run npm run build before dashboard parser tests')

    const PageController = require(controllerPath).default
    return new PageController({
        isMobile: true,
        logger: {
            debug() {},
            warn() {},
            error() {}
        }
    })
}

test('dashboard parser extracts dashboard data from escaped Next.js flight chunks', () => {
    const controller = createController()
    const dashboard = {
        userStatus: {
            availablePoints: 42,
            counters: {
                pcSearch: [],
                mobileSearch: []
            }
        },
        dailySetPromotions: {},
        morePromotions: []
    }

    const html = `<script>self.__next_f.push([1,${JSON.stringify(`1:${JSON.stringify(dashboard)}`)}])</script>`
    const parsed = controller.parseDashboardHtml(html)

    assert.equal(parsed.userStatus.availablePoints, 42)
})

test('dashboard parser extracts dashboard data from __NEXT_DATA__', () => {
    const controller = createController()
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: {
            pageProps: {
                dashboard: {
                    userStatus: {
                        availablePoints: 55,
                        counters: {
                            pcSearch: [],
                            mobileSearch: []
                        }
                    },
                    dailySetPromotions: {},
                    morePromotions: []
                }
            }
        }
    })}</script>`

    const parsed = controller.parseDashboardHtml(html)

    assert.equal(parsed.userStatus.availablePoints, 55)
})

test('dashboard parser extracts minimal data from Rewards Next.js RSC models when fixture exists', () => {
    const fixture = path.join(root, 'Dash-Msn-Rw', 'New', 'Dashboard – Microsoft Rewards.html')
    if (!fs.existsSync(fixture)) return

    const controller = createController()
    const parsed = controller.parseDashboardHtml(fs.readFileSync(fixture, 'utf8'))

    assert.equal(parsed.userStatus.availablePoints, 2499)
    assert.equal(parsed.userProfile.attributes.country, 'fr')
    assert.ok(parsed.dailySetPromotions['06/04/2026']?.length >= 3)

    const child2 = parsed.dailySetPromotions['06/04/2026'].find(
        item => item.offerId === 'Global_DailySet_20260604_Child2'
    )
    assert.equal(child2.hash, 'e33cf04d34e275d4b878e60be5bd0f91d2dd24681e71d30351208250d975005c')
    assert.equal(child2.pointProgressMax, 10)
    assert.equal(child2.complete, true)
})
