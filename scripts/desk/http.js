'use strict'

// Rewards Desk — localhost HTTP utilities (extracted from app-window.js). The
// security gate (per-process token + host/origin pinning) and the request body-size
// limit; behaviorally covered by tests/desk-behavior.test.js (401/403/contracts).
//
// Dependencies are injected so this stays decoupled from app-window's module state:
//   getServerAddress() — returns the live server.address() (the `server` const is
//                        defined later in app-window.js, so a thunk avoids the TDZ);
//   apiToken           — the per-process API token;
//   maxBodyBytes       — the request body cap.

const crypto = require('crypto')

function createHttp({ getServerAddress, apiToken, maxBodyBytes }) {
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
        const address = getServerAddress()
        const expectedHost = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : null
        if (!expectedHost || req.headers.host !== expectedHost) {
            jsonResponse(res, 403, { error: 'Invalid host' })
            return false
        }
        const origin = req.headers.origin
        if (origin && origin !== `http://${expectedHost}`) {
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
