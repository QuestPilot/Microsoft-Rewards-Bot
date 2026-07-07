'use strict'

// Earnings estimator — a complete, sandbox-safe example plugin.
//
// It shows the whole Phase 2 capability surface working together, with NO Node APIs
// (no require/fs/http/process) and NO Desk patching:
//   - ctx.settings : the values the user typed in the Desk (see plugin.json "settings")
//   - ctx.storage  : a scoped key/value store that survives across runs
//   - ctx.ui.panel : a read-only panel rendered in the Desk Plugins page
//
// After each account finishes, it adds that account's collected points to a running
// total, then shows what those points are worth and projects them over N days.

module.exports = {
    name: 'earnings-estimator',
    version: '1.0.0',

    register(ctx) {
        // Render the panel once on load so it isn't blank before the first run.
        renderPanel(ctx)
    },

    onAccountEnd(ctx) {
        const points = Number(ctx.result && ctx.result.collectedPoints) || 0
        const total = (Number(ctx.storage.get('totalPoints')) || 0) + points
        const runs = (Number(ctx.storage.get('runs')) || 0) + 1
        ctx.storage.set('totalPoints', total)
        ctx.storage.set('runs', runs)
        renderPanel(ctx)
    }
}

function renderPanel(ctx) {
    const pointsPerEuro = Number(ctx.settings.pointsPerEuro) || 1500
    const days = Number(ctx.settings.days) || 30
    const total = Number(ctx.storage.get('totalPoints')) || 0
    const runs = Number(ctx.storage.get('runs')) || 0

    const eurosSoFar = total / pointsPerEuro
    const avgPerRun = runs > 0 ? total / runs : 0
    const projectedEuros = (avgPerRun * days) / pointsPerEuro

    ctx.ui.panel({
        title: 'Earnings estimate',
        stats: [
            { label: 'Collected', value: total.toLocaleString() + ' pts', hint: runs + ' run(s)' },
            { label: 'Worth now', value: eurosSoFar.toFixed(2) + ' €' },
            { label: 'Over ' + days + ' days', value: projectedEuros.toFixed(2) + ' €', hint: '~' + Math.round(avgPerRun) + ' pts/run' }
        ],
        lines: runs === 0 ? ['Run the bot once to start estimating.'] : []
    })
}
