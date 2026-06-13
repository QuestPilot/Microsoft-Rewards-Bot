const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/

function parseReleaseVersion(value) {
    const normalized = String(value ?? '').trim().replace(/^v/i, '')
    if (!RELEASE_VERSION_PATTERN.test(normalized)) return null

    const parts = normalized.split('.').map(Number)
    if (parts.some(part => !Number.isSafeInteger(part) || part < 0)) return null
    while (parts.length < 4) parts.push(0)
    return parts
}

function compareReleaseVersions(left, right) {
    const leftParts = parseReleaseVersion(left)
    const rightParts = parseReleaseVersion(right)
    if (!leftParts || !rightParts) {
        throw new Error(`Invalid MSRB release version comparison: ${left} / ${right}`)
    }

    for (let index = 0; index < 4; index += 1) {
        if (leftParts[index] > rightParts[index]) return 1
        if (leftParts[index] < rightParts[index]) return -1
    }
    return 0
}

function isReleaseVersion(value) {
    return parseReleaseVersion(value) !== null
}

module.exports = {
    compareReleaseVersions,
    isReleaseVersion,
    parseReleaseVersion
}
