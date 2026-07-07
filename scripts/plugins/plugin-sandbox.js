'use strict'

// Plugin sandbox — runs an UNTRUSTED third-party plugin inside a V8 isolate
// (isolated-vm) with NO Node APIs. This is the capability boundary for the
// marketplace: the plugin cannot reach fs, process, child_process, the network,
// the OS credential vault, or the bot object. Only the public plugin surface is
// bridged across the boundary, and ONLY plain JSON data crosses it.
//
// What is intentionally NOT solved here: crash/OOM isolation. isolated-vm runs
// in-process, and its own docs warn that hostile code can crash the process via
// V8 OOM. True crash isolation = host this module inside a child process and
// restart it on death (see Task #7 "plugin-host robustness"). This module is
// written host-agnostic so it can run either in-process or driven from a child.
//
// Trusted plugins that genuinely need fs/accounts ("Trusted Mode") do NOT run
// here — they keep the in-process path behind explicit local user consent.

const ivm = require('isolated-vm')

const noop = () => {}

// Runs inside the isolate. Defines the bridged public context and the host
// entry points (__loadPlugin/__register/__emit/__lifecycle). It reads the
// untrusted source/config/apiVersion from globals set BEFORE this is evaluated,
// so no untrusted text is ever interpolated into evaluated code. The bridged
// `log` mirrors the public PluginLogger contract: (source, tag, message, color?).
const BOOTSTRAP = `
'use strict';
globalThis.__state = { sinks: [], diagnostics: [], selectors: {}, plugin: null };
function __toStr(x){
  try { return typeof x === 'string' ? x : (x && x.stack) ? String(x.stack) : JSON.stringify(x); }
  catch (_) { return String(x); }
}
function __log4(level){ return function(source, tag, message){ __log(level, source, tag, __toStr(message)); }; }
function __parse(json, fallback){ try { return JSON.parse(json); } catch (_) { return fallback; } }
// Scoped key/value store bridged to the host (JSON only). A missing key yields "" from
// __storageGet; a present one yields {"v":<value>} so a stored null is distinguishable.
globalThis.__storage = {
  get: function(key){ var s = __storageGet(String(key)); return s ? __parse(s, {}).v : undefined; },
  set: function(key, value){ __storageSet(String(key), JSON.stringify(value === undefined ? null : value)); },
  delete: function(key){ __storageDelete(String(key)); },
  keys: function(){ return __parse(__storageKeys(), []); }
};
globalThis.__ctx = {
  apiVersion: globalThis.__apiVersion,
  config: __parse(globalThis.__configJson || '{}', {}),
  settings: __parse(globalThis.__settingsJson || '{}', {}),
  storage: globalThis.__storage,
  ui: { panel: function(data){ __panel(JSON.stringify(data && typeof data === 'object' ? data : {})); } },
  // Brokered HTTPS fetch — the host performs the request (see plugin-fetch-broker.js).
  // Absent __fetchRef means no net permission was granted -> reject.
  fetch: function(url, options){
    if (typeof __fetchRef === 'undefined') return Promise.reject(new Error('this plugin has no granted network permissions'));
    var args = JSON.stringify({ url: String(url), options: (options && typeof options === 'object') ? options : {} });
    return __fetchRef.apply(undefined, [args], { arguments: { copy: true }, result: { promise: true, copy: true } })
      .then(function(json){ var r = JSON.parse(json); if (r && r.error) throw new Error(r.error); return r; });
  },
  log: { info: __log4('info'), warn: __log4('warn'), error: __log4('error'), debug: __log4('debug') },
  registerSelectors: function(s){ if (s && typeof s === 'object') Object.assign(__state.selectors, s); },
  registerDiagnostics: function(fn){ if (typeof fn === 'function') __state.diagnostics.push(fn); },
  registerNotificationSink: function(fn){ if (typeof fn === 'function') __state.sinks.push(fn); }
};
globalThis.__loadPlugin = function(){
  var module = { exports: {} };
  var ex = module.exports;
  var sandboxRequire = function(name){ throw new Error('require("' + name + '") is blocked in the plugin sandbox'); };
  var factory = new Function('module', 'exports', 'require', globalThis.__source);
  factory(module, ex, sandboxRequire);
  var p = module.exports && (module.exports.default || module.exports.plugin || module.exports);
  if (!p || typeof p !== 'object') throw new Error('Plugin must export an object { name, version, register }');
  __state.plugin = p;
  return JSON.stringify({
    name: typeof p.name === 'string' ? p.name : null,
    version: typeof p.version === 'string' ? p.version : null,
    hasRegister: typeof p.register === 'function',
    hooks: {
      onBotInitialized: typeof p.onBotInitialized === 'function',
      onAccountStart: typeof p.onAccountStart === 'function',
      onAccountEnd: typeof p.onAccountEnd === 'function',
      destroy: typeof p.destroy === 'function'
    }
  });
};
globalThis.__register = async function(){
  if (typeof __state.plugin.register === 'function') await __state.plugin.register(__ctx);
};
globalThis.__emit = async function(notifJson){
  var n = JSON.parse(notifJson);
  for (var i = 0; i < __state.sinks.length; i++) {
    try { await __state.sinks[i](n); }
    catch (e) { __log('error', 'main', 'PLUGIN-SANDBOX', 'notification sink error: ' + (e && e.message ? e.message : e)); }
  }
};
globalThis.__lifecycle = async function(name, payloadJson){
  var p = __state.plugin;
  if (!p || typeof p[name] !== 'function') return;
  var base = { apiVersion: __ctx.apiVersion, config: __ctx.config, settings: __ctx.settings, storage: __ctx.storage, ui: __ctx.ui, fetch: __ctx.fetch, log: __ctx.log };
  var payload = payloadJson ? JSON.parse(payloadJson) : {};
  await p[name](Object.assign(base, payload));
};
`

/**
 * Boot a sandboxed plugin. Returns a handle exposing its metadata plus methods
 * to deliver notifications and lifecycle events. All inputs/outputs that cross
 * the isolate boundary are plain JSON.
 *
 * @param {object} options
 * @param {string} options.source        Untrusted plugin source (CommonJS index.js text).
 * @param {object} [options.config]      Plugin-specific config (plain JSON).
 * @param {string} [options.apiVersion]  PLUGIN_API_VERSION to expose.
 * @param {object} [options.log]         Host PluginLogger { info,warn,error,debug } — each (source, tag, message, color?).
 * @param {number} [options.memoryLimitMb] Isolate memory cap (MB, min 8).
 * @param {number} [options.timeoutMs]   Per-call wall-clock timeout (ms).
 * @param {function} [options.onCatastrophicError] Host hook for unrecoverable isolate errors.
 */
async function createPluginSandbox(options = {}) {
    const {
        source,
        config = {},
        settings = {},
        storage,
        onPanel,
        fetchBroker,
        apiVersion = '1.0.0',
        log = {},
        memoryLimitMb = 64,
        timeoutMs = 5000,
        onCatastrophicError
    } = options

    if (typeof source !== 'string' || source.length === 0) {
        throw new Error('createPluginSandbox: source code (string) is required')
    }

    // Inert defaults so ctx.storage / ctx.ui always exist inside the isolate even when
    // the host wired nothing — a plugin never crashes touching an ungranted capability.
    const hostStorage = storage && typeof storage.get === 'function'
        ? storage
        : { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] }
    const hostPanel = typeof onPanel === 'function' ? onPanel : () => {}

    const hostLog = {
        info: typeof log.info === 'function' ? log.info : noop,
        warn: typeof log.warn === 'function' ? log.warn : noop,
        error: typeof log.error === 'function' ? log.error : noop,
        debug: typeof log.debug === 'function' ? log.debug : noop
    }

    const isolate = new ivm.Isolate({
        memoryLimit: Math.max(8, memoryLimitMb),
        onCatastrophicError: message => {
            try {
                if (typeof onCatastrophicError === 'function') onCatastrophicError(String(message))
                else hostLog.error('main', 'PLUGIN-SANDBOX', `catastrophic isolate error: ${message}`)
            } catch {}
        }
    })

    let context
    try {
        context = isolate.createContextSync()
        const jail = context.global

        // The ONLY host capability bridged inward: the structured logger. Plain
        // primitives only; no objects, no references to host internals.
        jail.setSync(
            '__log',
            new ivm.Callback(
                (level, source, tag, message) => {
                    const fn = hostLog[level] || hostLog.info
                    try { fn(source, tag, String(message)) } catch {}
                },
                { sync: true }
            )
        )
        // Scoped storage bridge. Values cross as JSON strings; a missing key returns ""
        // (empty) so a legitimately-stored null is not confused with absence. set() may
        // throw host-side (e.g. size cap) — that surfaces as an error inside the isolate.
        jail.setSync(
            '__storageGet',
            new ivm.Callback((key) => {
                try {
                    const value = hostStorage.get(String(key))
                    return value === undefined ? '' : JSON.stringify({ v: value })
                } catch { return '' }
            }, { sync: true })
        )
        jail.setSync(
            '__storageSet',
            new ivm.Callback((key, valueJson) => {
                let parsed
                try { parsed = JSON.parse(String(valueJson)) } catch { parsed = null }
                hostStorage.set(String(key), parsed)
            }, { sync: true })
        )
        jail.setSync('__storageDelete', new ivm.Callback((key) => { try { hostStorage.delete(String(key)) } catch {} }, { sync: true }))
        jail.setSync(
            '__storageKeys',
            new ivm.Callback(() => {
                try { return JSON.stringify(hostStorage.keys() || []) } catch { return '[]' }
            }, { sync: true })
        )
        jail.setSync(
            '__panel',
            new ivm.Callback((json) => {
                let data
                try { data = JSON.parse(String(json)) } catch { data = {} }
                try { hostPanel(data) } catch {}
            }, { sync: true })
        )
        // Brokered network (elevated). Only wired when the host granted hosts, so a plugin
        // with no net permission simply has no __fetchRef and ctx.fetch rejects. Async: the
        // isolate awaits the host request via a Reference returning a promised JSON string.
        if (fetchBroker && typeof fetchBroker.fetchJson === 'function') {
            jail.setSync(
                '__fetchRef',
                new ivm.Reference(async (argsJson) => {
                    return await fetchBroker.fetchJson(String(argsJson))
                })
            )
        }
        jail.setSync('__apiVersion', String(apiVersion))
        jail.setSync('__configJson', JSON.stringify(config == null ? {} : config))
        jail.setSync('__settingsJson', JSON.stringify(settings == null ? {} : settings))
        jail.setSync('__source', source)

        context.evalSync(BOOTSTRAP, { timeout: timeoutMs })
        const meta = JSON.parse(context.evalSync('__loadPlugin()', { timeout: timeoutMs }))
        await context.eval('__register()', { timeout: timeoutMs, promise: true })
        const sinkCount = Number(context.evalSync('__state.sinks.length')) || 0

        let disposed = false
        const assertLive = () => {
            if (disposed || isolate.isDisposed) throw new Error('plugin sandbox has been disposed')
        }

        return {
            name: meta.name,
            version: meta.version,
            hooks: meta.hooks,
            sinkCount,

            /** Deliver a notification to the plugin's registered sinks. */
            async emitNotification(notification) {
                assertLive()
                await context.evalClosure('return __emit($0)', [JSON.stringify(notification)], {
                    arguments: { copy: true },
                    result: { promise: true },
                    timeout: timeoutMs
                })
            },

            /** Invoke a lifecycle hook (onBotInitialized/onAccountStart/onAccountEnd/destroy). */
            async runLifecycle(name, payload) {
                assertLive()
                await context.evalClosure('return __lifecycle($0, $1)', [name, payload ? JSON.stringify(payload) : null], {
                    arguments: { copy: true },
                    result: { promise: true },
                    timeout: timeoutMs
                })
            },

            /** Tear down the isolate and free its memory. */
            dispose() {
                if (disposed) return
                disposed = true
                try { context.release() } catch {}
                try { if (!isolate.isDisposed) isolate.dispose() } catch {}
            }
        }
    } catch (error) {
        try { if (context) context.release() } catch {}
        try { if (!isolate.isDisposed) isolate.dispose() } catch {}
        throw error
    }
}

module.exports = { createPluginSandbox }
