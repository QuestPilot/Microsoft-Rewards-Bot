'use strict'

// Rewards Desk — documentation viewer helpers (extracted from app-window.js as the
// first step of the Desk modularization). Lists and reads docs/*.md for the in-app
// docs page (/api/docs). Pure leaf: only fs/path + the project root and app version
// passed in. Behavior is identical to the original inline implementation.

const fs = require('fs')
const path = require('path')

function createDocs({ root, appVersion }) {
    const DOCS_DIR = path.join(root, 'docs')

    function titleizeDoc(name) {
        const base = name.replace(/\.md$/i, '')
        if (base.toLowerCase() === 'readme') return 'Overview'
        return base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }

    function docTitle(name) {
        // Prefer the file's first H1 so nav labels match the actual page title;
        // fall back to a titleized filename.
        try {
            const text = fs.readFileSync(path.join(DOCS_DIR, name), 'utf8')
            const match = text.match(/^\s*#\s+(.+?)\s*$/m)
            if (match) return name.toLowerCase() === 'readme.md' ? 'Overview' : match[1].trim()
        } catch {
            // fall through
        }
        return titleizeDoc(name)
    }

    function listDocs() {
        const DOC_ORDER = [
            'README.md',
            'rewards-desk.md', 'updates.md', 'docker.md', 'node-version.md', 'scheduler.md', 'troubleshooting.md', 'licensing.md',
            'core-plugin.md', 'core-plugin-reference.md', 'dashboard.md',
            'plugins.md', 'create-plugin.md', 'plugin-api.md', 'plugin-marketplace.md',
            'auto-update-release.md', 'core-release-security.md', 'dashboard-testing.md', 'safety-advisory.md', 'selectors-reference.md',
        ]
        const CORE_DOCS = new Set(['core-plugin.md', 'core-plugin-reference.md', 'dashboard.md'])
        const CATEGORY_START = {
            'rewards-desk.md': 'For Everyone',
            'core-plugin.md': 'Core',
            'plugins.md': 'Developers',
            'auto-update-release.md': 'Maintainers',
        }
        try {
            const found = fs.readdirSync(DOCS_DIR).filter(f => /\.md$/i.test(f))
            found.sort((a, b) => {
                const ai = DOC_ORDER.findIndex(n => n.toLowerCase() === a.toLowerCase())
                const bi = DOC_ORDER.findIndex(n => n.toLowerCase() === b.toLowerCase())
                const ap = ai === -1 ? 1000 : ai
                const bp = bi === -1 ? 1000 : bi
                return ap - bp || a.localeCompare(b)
            })
            const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
            const list = found.map(name => {
                let isNew = false
                try { isNew = (Date.now() - fs.statSync(path.join(DOCS_DIR, name)).mtimeMs) < SEVEN_DAYS } catch {}
                return {
                    name,
                    title: docTitle(name),
                    core: CORE_DOCS.has(name.toLowerCase()),
                    category: CATEGORY_START[name.toLowerCase()] || null,
                    isNew,
                }
            })
            const whatsNew = { name: 'whats-new', title: "What's New", core: false, category: null, isNew: false, virtual: true }
            return { files: [whatsNew, ...list], default: list.length ? list[0].name : null, version: appVersion }
        } catch {
            return { files: [], default: null, version: appVersion }
        }
    }

    function readDocFile(name) {
        // Prevent path traversal — only allow a bare .md filename inside docs/
        if (!/^[\w.-]+\.md$/i.test(name)) return null
        const full = path.join(DOCS_DIR, name)
        if (!full.startsWith(DOCS_DIR)) return null
        try {
            return fs.readFileSync(full, 'utf8')
        } catch {
            return null
        }
    }

    return { DOCS_DIR, titleizeDoc, docTitle, listDocs, readDocFile }
}

module.exports = { createDocs }
