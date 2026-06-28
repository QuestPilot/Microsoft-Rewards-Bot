'use strict'

// Rewards Desk — localhost HTTP utilities (extracted from app-window.js). The
// security gate (per-process token + host/origin pinning) and the request body-size
// limit; behaviorally covered by tests/desk-behavior.test.js (401/403/contracts).
//
// Dependencies are injected so this stays decoupled from app-window's module state:
//   getAllowedHosts() — returns the live list of accepted "host:port" strings
//                       (loopback always; the LAN address too when LAN access is on).
//                       A thunk avoids the TDZ on app-window's `server` const;
//   apiToken          — the per-process API token;
//   maxBodyBytes      — the request body cap.

const crypto = require('crypto')

function createHttp({ getAllowedHosts, apiToken, maxBodyBytes }) {
    function jsonResponse(res, statusCode, payload) {
        res.writeHead(statusCode, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff'
        })
        res.end(JSON.stringify(payload))
    }

    function safeEqual(left, right) {
        const a = Buffer.from(String(left || ''))
        const b = Buffer.from(String(right || ''))
        return a.length === b.length && crypto.timingSafeEqual(a, b)
    }

    function authorizeApiRequest(req, res) {
        const allowedHosts = getAllowedHosts()
        if (!allowedHosts.length || !allowedHosts.includes(req.headers.host)) {
            jsonResponse(res, 403, { error: 'Invalid host' })
            return false
        }
        const origin = req.headers.origin
        if (origin && !allowedHosts.some(host => origin === `http://${host}`)) {
            jsonResponse(res, 403, { error: 'Invalid origin' })
            return false
        }
        if (!safeEqual(req.headers['x-msrb-token'], apiToken)) {
            jsonResponse(res, 401, { error: 'Unauthorized' })
            return false
        }
        return true
    }

    function readApiBody(req, res, callback) {
        let body = ''
        let size = 0
        let finished = false
        req.on('data', chunk => {
            if (finished) return
            size += chunk.length
            if (size > maxBodyBytes) {
                finished = true
                jsonResponse(res, 413, { error: 'Request body too large' })
                req.destroy()
                return
            }
            body += chunk
        })
        req.on('end', () => {
            if (!finished) callback(body)
        })
    }

    function parseJson(value, fallback) {
        try {
            return JSON.parse(value)
        } catch {
            return fallback
        }
    }

    return { jsonResponse, safeEqual, authorizeApiRequest, readApiBody, parseJson }
}

module.exports = { createHttp }
