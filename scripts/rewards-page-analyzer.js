const fs = require('fs')
const path = require('path')

function unique(values) {
    return [...new Set(values.filter(Boolean))]
}

function safeReadText(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return ''
    }
}

function extractNextFlightTextFromHtml(html) {
    const chunks = []
    const matches = html.matchAll(/self\.__next_f\.push\(\[\d+,"(.*?)"\]\)/gs)
    for (const match of matches) {
        const raw = match[1]
        if (!raw) continue
        chunks.push(raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\u0026/g, '&'))
    }
    return chunks.join('\n')
}

function extractReportActivityActionIds(text) {
    const ids = []
    for (const match of text.matchAll(/createServerReference\)?\s*\(\s*"([a-f0-9]{40,64})"[^)]*reportActivity/gi)) {
        if (match[1]) ids.push(match[1])
    }
    for (const match of text.matchAll(/reportActivity[\s\S]{0,300}?createServerReference\)?\s*\(\s*"([a-f0-9]{40,64})"/gi)) {
        if (match[1]) ids.push(match[1])
    }
    return unique(ids)
}

function extractDisclosureSummaries(html) {
    const disclosures = []
    const buttonMatches = html.matchAll(/<button\b[^>]*\baria-expanded="(true|false)"[^>]*>/gi)
    for (const match of buttonMatches) {
        const tag = match[0]
        disclosures.push({
            expanded: match[1] === 'true',
            controls: tag.match(/\baria-controls="([^"]+)"/i)?.[1],
            slot: tag.match(/\bslot="([^"]+)"/i)?.[1],
            dataRac: /\bdata-rac\b/i.test(tag)
        })
    }
    return disclosures
}

function extractSwitchSummaries(html) {
    const switches = []
    const inputMatches = html.matchAll(/<input\b[^>]*\brole="switch"[^>]*>/gi)
    for (const match of inputMatches) {
        const tag = match[0]
        switches.push({
            checked: /\bchecked(?:=|"|\s|>)/i.test(tag),
            disabled: /\bdisabled(?:=|"|\s|>)/i.test(tag),
            ariaLabel: tag.match(/\baria-label="([^"]+)"/i)?.[1],
            type: tag.match(/\btype="([^"]+)"/i)?.[1]
        })
    }
    return switches
}

function extractPanelSignals(html) {
    return {
        dialogs: (html.match(/\brole="dialog"/gi) ?? []).length,
        disclosurePanels: (html.match(/\breact-aria-DisclosurePanel\b/gi) ?? []).length,
        closeButtons: (html.match(/\b(slot|aria-label)="(?:close|fermer|cerrar|chiudi|sluiten)"/gi) ?? []).length
    }
}

function analyzeBingSearchPage(html) {
    const diagnostics = []
    const searchBoxPresent = /id="sb_form_q"|name="q"/i.test(html)
    const rewardsSignals = unique([
        ...Array.from(html.matchAll(/REWARDSQUIZ_[A-Za-z0-9_%-]+/gi), match => match[0]),
        ...Array.from(html.matchAll(/WQOskey[:=]%?22?([^"&\s]+)/gi), match => match[1])
    ])

    if (!searchBoxPresent) diagnostics.push('Bing search input not found')
    if (!rewardsSignals.length) diagnostics.push('No Rewards quiz/search attribution signals found')

    return {
        kind: 'bing-search',
        searchBoxPresent,
        rewardsSignals,
        diagnostics,
        problems: []
    }
}

function buildRewardsProblems(analysis) {
    const problems = []

    if (!analysis.modelTypes?.length) problems.push('No Rewards RSC activity models found')
    if (analysis.modelTypes?.includes('dailyset') && !analysis.activities.some(activity => activity.type === 'dailyset' && activity.offerId && activity.hash)) {
        problems.push('Daily Set models found, but no Daily Set activity has both offerId and hash')
    }
    if (analysis.modelTypes?.includes('pointsclaim') && analysis.panelSignals?.disclosurePanels === 0 && analysis.panelSignals?.dialogs === 0) {
        problems.push('pointsclaim model found, but no side-panel signal was found in the saved HTML')
    }
    if (
        (analysis.modelTypes?.includes('dailystreak') || analysis.modelTypes?.includes('streakbonus')) &&
        analysis.disclosures?.length === 0
    ) {
        problems.push('streak models found, but no disclosure trigger was found')
    }
    if (!analysis.actionIds?.length) {
        problems.push('reportActivity server action id not found in saved HTML/chunks')
    }

    return problems
}

function buildBingProblems(analysis) {
    const problems = []
    if (!analysis.searchBoxPresent) problems.push('Bing search input not found')
    if (!analysis.rewardsSignals?.length) problems.push('No Rewards quiz/search attribution signals found')
    return problems
}

function readStringField(context, field) {
    const match = context.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`))
    return match?.[1]?.replace(/\\u0026/g, '&')
}

function readNumberField(context, field) {
    const match = context.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+)`))
    return match?.[1] ? Number(match[1]) : undefined
}

function readBooleanField(context, field) {
    const match = context.match(new RegExp(`"${field}"\\s*:\\s*(true|false)`))
    return match?.[1] ? match[1] === 'true' : undefined
}

function contextAround(text, index, radius = 900) {
    return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius))
}

function findBalancedEnd(text, start, open, close) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < text.length; i++) {
        const char = text[i]

        if (inString) {
            if (escaped) escaped = false
            else if (char === '\\') escaped = true
            else if (char === '"') inString = false
            continue
        }

        if (char === '"') inString = true
        else if (char === open) depth++
        else if (char === close) {
            depth--
            if (depth === 0) return i
        }
    }

    return -1
}

function extractJsonArraysAfterKey(text, key) {
    const arrays = []
    const marker = `"${key}":[`
    let searchFrom = 0

    while (searchFrom < text.length) {
        const markerIndex = text.indexOf(marker, searchFrom)
        if (markerIndex === -1) break

        const start = markerIndex + `"${key}":`.length
        const end = findBalancedEnd(text, start, '[', ']')
        if (end === -1) {
            searchFrom = markerIndex + marker.length
            continue
        }

        try {
            const parsed = JSON.parse(text.slice(start, end + 1))
            if (Array.isArray(parsed)) arrays.push(parsed)
        } catch {
            /* Keep scanning. */
        }

        searchFrom = end + 1
    }

    return arrays
}

function extractRewardsActivities(text) {
    const activities = []

    for (const items of extractJsonArraysAfterKey(text, 'dailySetItems')) {
        for (const item of items) {
            if (!item || typeof item !== 'object' || !item.offerId) continue
            activities.push({
                type: 'dailyset',
                offerId: item.offerId,
                hash: item.hash,
                destination: item.destination,
                destinationUrl: item.destination,
                title: item.title,
                points: item.points,
                isCompleted: item.isCompleted
            })
        }
    }

    for (const match of text.matchAll(/"type"\s*:\s*"([^"]+)"[\s\S]{0,1200}?"model"\s*:\s*\{/g)) {
        if (match.index === undefined || !match[1]) continue
        const context = contextAround(text, match.index, 2200)
        const offerId = readStringField(context, 'offerId') ?? readStringField(context, 'activationOfferId')
        const hash = readStringField(context, 'hash') ?? readStringField(context, 'activationHash')
        if (offerId && activities.some(activity => activity.offerId === offerId)) continue
        activities.push({
            type: match[1],
            offerId: offerId && offerId !== '$undefined' ? offerId : undefined,
            hash: hash && hash !== '$undefined' ? hash : undefined,
            destination: readStringField(context, 'destination'),
            destinationUrl: readStringField(context, 'destinationUrl'),
            title: readStringField(context, 'title'),
            partner: readStringField(context, 'partner'),
            activity: readStringField(context, 'activity'),
            points: readNumberField(context, 'points'),
            isCompleted: readBooleanField(context, 'isCompleted')
        })
    }

    for (const match of text.matchAll(/"offerId"\s*:\s*"([^"]+)"/g)) {
        if (match.index === undefined || !match[1] || activities.some(activity => activity.offerId === match[1])) continue
        const context = contextAround(text, match.index, 900)
        activities.push({
            type: 'offer',
            offerId: match[1],
            hash: readStringField(context, 'hash'),
            destination: readStringField(context, 'destination'),
            destinationUrl: readStringField(context, 'destinationUrl'),
            title: readStringField(context, 'title'),
            points: readNumberField(context, 'points'),
            isCompleted: readBooleanField(context, 'isCompleted')
        })
    }

    return activities
}

function analyzeRewardsPage(html, scriptText = '') {
    const flightText = extractNextFlightTextFromHtml(html)
    const combined = `${flightText}\n${scriptText}`
    const activities = extractRewardsActivities(flightText)
    const diagnostics = []

    if (!flightText) diagnostics.push('RSC flight data not found')
    if (!activities.length) diagnostics.push('No rewards activity models found')

    return {
        kind: flightText ? 'rewards-next' : 'unknown',
        route: flightText.match(/"c"\s*:\s*\["","([^"]+)"/)?.[1],
        actionIds: extractReportActivityActionIds(combined),
        modelTypes: unique(activities.map(activity => activity.type)),
        activities,
        switches: extractSwitchSummaries(html),
        disclosures: extractDisclosureSummaries(html),
        panelSignals: extractPanelSignals(html),
        diagnostics,
        problems: []
    }
}

function collectScriptsForPage(pageFile) {
    const pageDir = path.dirname(pageFile)
    const baseName = path.basename(pageFile).replace(/\.html?$/i, '')
    const candidates = [
        path.join(pageDir, `${baseName}_files`),
        path.join(pageDir, `${baseName}_fichiers`)
    ]
    const assetDirs = candidates.filter(dir => fs.existsSync(dir))
    if (!assetDirs.length) return ''

    return assetDirs
        .flatMap(assetDir => fs
            .readdirSync(assetDir)
            .filter(file => file.endsWith('.js'))
            .map(file => path.join(assetDir, file)))
        .map(file => safeReadText(file))
        .filter(Boolean)
        .join('\n')
}

function analyzeSavedPage(html, scriptText = '') {
    const rewards = analyzeRewardsPage(html, scriptText)
    if (rewards.kind === 'rewards-next') return rewards

    if (/id="b_content"|id="sb_form"|sb_form_q|<form[^>]+id="sb_form"/i.test(html)) {
        const bing = analyzeBingSearchPage(html)
        bing.problems = buildBingProblems(bing)
        return bing
    }

    if (/Welcome to Microsoft Rewards|\/welcome\?idru=|Bienvenue dans Microsoft Rewards/i.test(html)) {
        return {
            ...rewards,
            kind: 'unknown',
            diagnostics: [...rewards.diagnostics, 'Rewards welcome page detected instead of dashboard'],
            problems: [...rewards.problems, 'Open the Rewards dashboard manually or finish the welcome/onboarding page before running diagnostics']
        }
    }

    if (/rewards\.bing\.com/i.test(html)) {
        return {
            ...rewards,
            kind: 'unknown',
            diagnostics: [...rewards.diagnostics, 'Rewards page detected, but no Next.js RSC dashboard payload was found'],
            problems: [...rewards.problems, 'Saved/live page is not the Rewards dashboard payload expected by the analyzer']
        }
    }

    return rewards
}

function summarizeAnalysis(file, analysis) {
    if (analysis.kind === 'bing-search') {
        return {
            file,
            kind: analysis.kind,
            searchBoxPresent: analysis.searchBoxPresent,
            rewardsSignals: analysis.rewardsSignals,
            diagnostics: analysis.diagnostics,
            problems: buildBingProblems(analysis)
        }
    }

    return {
        file,
        kind: analysis.kind,
        route: analysis.route,
        actionIds: analysis.actionIds,
        modelTypes: analysis.modelTypes,
        activityCount: analysis.activities.length,
        switchCount: analysis.switches.length,
        disclosureCount: analysis.disclosures.length,
        panelSignals: analysis.panelSignals,
        diagnostics: analysis.diagnostics,
        problems: buildRewardsProblems(analysis),
        sampleActivities: analysis.activities.slice(0, 12)
    }
}

function collectAssetDirectoriesForPage(pageFile) {
    const pageDir = path.dirname(pageFile)
    const baseName = path.basename(pageFile).replace(/\.html?$/i, '')
    return [`${baseName}_files`, `${baseName}_fichiers`]
        .map(name => path.join(pageDir, name))
        .filter(dir => fs.existsSync(dir))
}

function collectAssetStats(pageFile) {
    return collectAssetDirectoriesForPage(pageFile).map(dir => ({
        dir: path.basename(dir),
        jsFiles: fs
            .readdirSync(dir)
            .filter(file => file.endsWith('.js'))
            .length
    }))
}

function runCli() {
    const root = process.cwd()
    const pageDir = path.join(root, 'Page')
    if (!fs.existsSync(pageDir)) {
        console.error('Page/ directory not found')
        process.exit(1)
    }

    const files = fs.readdirSync(pageDir).filter(file => /\.html?$/i.test(file))
    const analyses = files.map(file => {
        const fullPath = path.join(pageDir, file)
        const html = fs.readFileSync(fullPath, 'utf8')
        const scriptText = collectScriptsForPage(fullPath)
        const analysis = analyzeSavedPage(html, scriptText)
        return { ...summarizeAnalysis(file, analysis), assets: collectAssetStats(fullPath) }
    })

    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), analyses }, null, 2))
}

if (require.main === module) {
    runCli()
}

module.exports = {
    analyzeRewardsPage,
    analyzeSavedPage,
    analyzeBingSearchPage,
    extractNextFlightTextFromHtml,
    extractReportActivityActionIds,
    extractRewardsActivities,
    extractSwitchSummaries,
    extractDisclosureSummaries,
    extractPanelSignals,
    collectScriptsForPage
}
