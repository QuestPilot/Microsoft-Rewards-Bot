export interface RewardsActivityModel {
    type: string
    offerId?: string
    hash?: string
    destination?: string
    destinationUrl?: string
    title?: string
    partner?: string
    activity?: string
    points?: number
    isCompleted?: boolean
}

export interface RewardsSwitchSummary {
    checked: boolean
    disabled: boolean
    ariaLabel?: string
    type?: string
}

export interface RewardsDisclosureSummary {
    expanded: boolean
    controls?: string
    slot?: string
    dataRac: boolean
}

export interface RewardsPanelSignals {
    dialogs: number
    disclosurePanels: number
    closeButtons: number
}

export interface RewardsPageAnalysis {
    kind: 'rewards-next' | 'unknown'
    route?: string
    actionIds: string[]
    modelTypes: string[]
    activities: RewardsActivityModel[]
    switches: RewardsSwitchSummary[]
    disclosures: RewardsDisclosureSummary[]
    panelSignals: RewardsPanelSignals
    diagnostics: string[]
    problems: string[]
}

export interface BingSearchPageAnalysis {
    kind: 'bing-search'
    searchBoxPresent: boolean
    rewardsSignals: string[]
    diagnostics: string[]
    problems: string[]
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}

export function extractNextFlightTextFromHtml(html: string): string {
    const chunks: string[] = []
    const matches = html.matchAll(/self\.__next_f\.push\(\[\d+,"(.*?)"\]\)/gs)

    for (const match of matches) {
        const raw = match[1]
        if (!raw) continue
        chunks.push(raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\u0026/g, '&'))
    }

    return chunks.join('\n')
}

export function extractReportActivityActionIds(text: string): string[] {
    const ids: string[] = []
    const matches = text.matchAll(/createServerReference\)?\s*\(\s*"([a-f0-9]{40,64})"[^)]*reportActivity/gi)
    for (const match of matches) {
        if (match[1]) ids.push(match[1])
    }

    const reverseMatches = text.matchAll(/reportActivity[\s\S]{0,300}?createServerReference\)?\s*\(\s*"([a-f0-9]{40,64})"/gi)
    for (const match of reverseMatches) {
        if (match[1]) ids.push(match[1])
    }

    return unique(ids)
}

export function extractSwitchSummaries(html: string): RewardsSwitchSummary[] {
    const switches: RewardsSwitchSummary[] = []
    const inputMatches = html.matchAll(/<input\b[^>]*\brole="switch"[^>]*>/gi)
    for (const match of inputMatches) {
        const tag = match[0] ?? ''
        switches.push({
            checked: /\bchecked(?:=|"|\s|>)/i.test(tag),
            disabled: /\bdisabled(?:=|"|\s|>)/i.test(tag),
            ariaLabel: tag.match(/\baria-label="([^"]+)"/i)?.[1],
            type: tag.match(/\btype="([^"]+)"/i)?.[1]
        })
    }

    return switches
}

export function extractDisclosureSummaries(html: string): RewardsDisclosureSummary[] {
    const disclosures: RewardsDisclosureSummary[] = []
    const buttonMatches = html.matchAll(/<button\b[^>]*\baria-expanded="(true|false)"[^>]*>/gi)
    for (const match of buttonMatches) {
        const tag = match[0] ?? ''
        disclosures.push({
            expanded: match[1] === 'true',
            controls: tag.match(/\baria-controls="([^"]+)"/i)?.[1],
            slot: tag.match(/\bslot="([^"]+)"/i)?.[1],
            dataRac: /\bdata-rac\b/i.test(tag)
        })
    }

    return disclosures
}

export function extractPanelSignals(html: string): RewardsPanelSignals {
    return {
        dialogs: (html.match(/\brole="dialog"/gi) ?? []).length,
        disclosurePanels: (html.match(/\breact-aria-DisclosurePanel\b/gi) ?? []).length,
        closeButtons: (html.match(/\b(slot|aria-label)="(?:close|fermer|cerrar|chiudi|sluiten)"/gi) ?? [])
            .length
    }
}

export function analyzeBingSearchPage(html: string): BingSearchPageAnalysis {
    const diagnostics: string[] = []
    const searchBoxPresent = /id="sb_form_q"|name="q"/i.test(html)
    const rewardsSignals = unique([
        ...Array.from(html.matchAll(/REWARDSQUIZ_[A-Za-z0-9_%-]+/gi), match => match[0] ?? ''),
        ...Array.from(html.matchAll(/WQOskey[:=]%?22?([^"&\s]+)/gi), match => match[1] ?? '')
    ])

    if (!searchBoxPresent) diagnostics.push('Bing search input not found')
    if (!rewardsSignals.length) diagnostics.push('No Rewards quiz/search attribution signals found')

    return {
        kind: 'bing-search',
        searchBoxPresent,
        rewardsSignals,
        diagnostics,
        problems: buildBingProblems({ searchBoxPresent, rewardsSignals })
    }
}

function buildBingProblems(analysis: Pick<BingSearchPageAnalysis, 'searchBoxPresent' | 'rewardsSignals'>): string[] {
    const problems: string[] = []
    if (!analysis.searchBoxPresent) problems.push('Bing search input not found')
    if (!analysis.rewardsSignals.length) problems.push('No Rewards quiz/search attribution signals found')
    return problems
}

function buildRewardsProblems(
    analysis: Pick<
        RewardsPageAnalysis,
        'modelTypes' | 'activities' | 'panelSignals' | 'disclosures' | 'actionIds'
    >
): string[] {
    const problems: string[] = []

    if (!analysis.modelTypes.length) problems.push('No Rewards RSC activity models found')
    if (
        analysis.modelTypes.includes('dailyset') &&
        !analysis.activities.some(activity => activity.type === 'dailyset' && activity.offerId && activity.hash)
    ) {
        problems.push('Daily Set models found, but no Daily Set activity has both offerId and hash')
    }
    if (
        analysis.modelTypes.includes('pointsclaim') &&
        analysis.panelSignals.disclosurePanels === 0 &&
        analysis.panelSignals.dialogs === 0
    ) {
        problems.push('pointsclaim model found, but no side-panel signal was found in the saved HTML')
    }
    if (
        (analysis.modelTypes.includes('dailystreak') || analysis.modelTypes.includes('streakbonus')) &&
        analysis.disclosures.length === 0
    ) {
        problems.push('streak models found, but no disclosure trigger was found')
    }
    if (!analysis.actionIds.length) {
        problems.push('reportActivity server action id not found in saved HTML/chunks')
    }

    return problems
}

function readStringField(context: string, field: string): string | undefined {
    const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`)
    const match = context.match(re)
    return match?.[1]?.replace(/\\u0026/g, '&')
}

function readNumberField(context: string, field: string): number | undefined {
    const re = new RegExp(`"${field}"\\s*:\\s*(-?\\d+)`)
    const match = context.match(re)
    return match?.[1] ? Number(match[1]) : undefined
}

function readBooleanField(context: string, field: string): boolean | undefined {
    const re = new RegExp(`"${field}"\\s*:\\s*(true|false)`)
    const match = context.match(re)
    return match?.[1] ? match[1] === 'true' : undefined
}

function contextAround(text: string, index: number, radius = 900): string {
    return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius))
}

function findBalancedEnd(text: string, start: number, open: string, close: string): number {
    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < text.length; i++) {
        const char = text[i]

        if (inString) {
            if (escaped) {
                escaped = false
            } else if (char === '\\') {
                escaped = true
            } else if (char === '"') {
                inString = false
            }
            continue
        }

        if (char === '"') {
            inString = true
        } else if (char === open) {
            depth++
        } else if (char === close) {
            depth--
            if (depth === 0) return i
        }
    }

    return -1
}

function extractJsonArraysAfterKey(text: string, key: string): unknown[][] {
    const arrays: unknown[][] = []
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
            const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
            if (Array.isArray(parsed)) arrays.push(parsed)
        } catch {
            // Keep scanning.
        }

        searchFrom = end + 1
    }

    return arrays
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '$undefined' ? value : undefined
}

export function extractRewardsActivities(text: string): RewardsActivityModel[] {
    const activities: RewardsActivityModel[] = []

    for (const items of extractJsonArraysAfterKey(text, 'dailySetItems')) {
        for (const item of items) {
            if (!isRecord(item)) continue
            const offerId = optionalString(item.offerId)
            if (!offerId) continue

            activities.push({
                type: 'dailyset',
                offerId,
                hash: optionalString(item.hash),
                destination: optionalString(item.destination),
                destinationUrl: optionalString(item.destination),
                title: optionalString(item.title),
                points: typeof item.points === 'number' ? item.points : undefined,
                isCompleted: typeof item.isCompleted === 'boolean' ? item.isCompleted : undefined
            })
        }
    }

    const modelMatches = text.matchAll(/"type"\s*:\s*"([^"]+)"[\s\S]{0,1200}?"model"\s*:\s*\{/g)

    for (const match of modelMatches) {
        if (match.index === undefined || !match[1]) continue
        const context = contextAround(text, match.index, 2200)
        const offerId = readStringField(context, 'offerId') ?? readStringField(context, 'activationOfferId')
        const hash = readStringField(context, 'hash') ?? readStringField(context, 'activationHash')
        const destination = readStringField(context, 'destination')
        const destinationUrl = readStringField(context, 'destinationUrl')

        if (offerId && activities.some(activity => activity.offerId === offerId)) continue

        activities.push({
            type: match[1],
            offerId: offerId && offerId !== '$undefined' ? offerId : undefined,
            hash: hash && hash !== '$undefined' ? hash : undefined,
            destination,
            destinationUrl,
            title: readStringField(context, 'title'),
            partner: readStringField(context, 'partner'),
            activity: readStringField(context, 'activity'),
            points: readNumberField(context, 'points'),
            isCompleted: readBooleanField(context, 'isCompleted')
        })
    }

    const offerMatches = text.matchAll(/"offerId"\s*:\s*"([^"]+)"/g)
    for (const match of offerMatches) {
        if (match.index === undefined || !match[1] || activities.some(activity => activity.offerId === match[1])) {
            continue
        }
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

export function analyzeRewardsPage(html: string, scriptText = ''): RewardsPageAnalysis {
    const flightText = extractNextFlightTextFromHtml(html)
    const combined = `${flightText}\n${scriptText}`
    const routeMatch = flightText.match(/"c"\s*:\s*\["","([^"]+)"/)
    const activities = extractRewardsActivities(flightText)
    const modelTypes = unique(activities.map(activity => activity.type))
    const actionIds = extractReportActivityActionIds(combined)
    const diagnostics: string[] = []

    if (!flightText) diagnostics.push('RSC flight data not found')
    if (!actionIds.length) diagnostics.push('reportActivity server action id not found')
    if (!activities.length) diagnostics.push('No rewards activity models found')

    const analysis: RewardsPageAnalysis = {
        kind: flightText ? 'rewards-next' : 'unknown',
        route: routeMatch?.[1],
        actionIds,
        modelTypes,
        activities,
        switches: extractSwitchSummaries(html),
        disclosures: extractDisclosureSummaries(html),
        panelSignals: extractPanelSignals(html),
        diagnostics,
        problems: []
    }

    analysis.problems = buildRewardsProblems(analysis)
    return analysis
}

export function analyzeSavedPage(html: string, scriptText = ''): RewardsPageAnalysis | BingSearchPageAnalysis {
    const rewards = analyzeRewardsPage(html, scriptText)
    if (rewards.kind === 'rewards-next') return rewards

    if (/id="b_content"|id="sb_form"|sb_form_q|<form[^>]+id="sb_form"/i.test(html)) {
        return analyzeBingSearchPage(html)
    }

    if (/Welcome to Microsoft Rewards|\/welcome\?idru=|Bienvenue dans Microsoft Rewards/i.test(html)) {
        return {
            ...rewards,
            kind: 'unknown',
            diagnostics: [...rewards.diagnostics, 'Rewards welcome page detected instead of dashboard'],
            problems: [
                ...rewards.problems,
                'Open the Rewards dashboard manually or finish the welcome/onboarding page before running diagnostics'
            ]
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
