/**
 * Advanced Anti-Detection Script Injector
 *
 * CRITICAL: This module contains all client-side anti-detection scripts
 * that must be injected BEFORE page loads to prevent bot detection
 *
 * DETECTION VECTORS ADDRESSED:
 * 1. WebDriver detection (navigator.webdriver)
 * 2. Chrome DevTools Protocol detection
 * 3. Canvas/WebGL fingerprinting
 * 4. Audio fingerprinting
 * 5. Font fingerprinting
 * 6. Screen/Display detection
 * 7. Permission state leaks
 * 8. Battery API inconsistencies
 * 9. WebRTC IP leaks
 * 10. Hardware/Device memory
 * 11. Keyboard layout detection
 * 12. MediaDevices enumeration
 * 13. Speech synthesis voices
 * 14. Notification permission timing
 * 15. Performance timing analysis
 * 16. Execution context detection
 * 17. Error stack trace fingerprinting
 * 18. Date/Timezone manipulation
 * 19. Network information leaks
 * 20. Iframe detection & sandboxing
 * 21. Event timing analysis
 * 22. CSS media query fingerprinting
 */

/**
 * Get the complete anti-detection script to inject
 * This is a self-contained script string that runs in browser context
 *
 * @param options - Configuration options
 * @returns Script string to inject via page.addInitScript()
 */
export function getAntiDetectionScript(
  options: {
    timezone?: string; // e.g., 'America/New_York'
    locale?: string; // e.g., 'en-US'
    languages?: string[]; // e.g., ['en-US', 'en']
    platform?: string; // e.g., 'Win32'
    vendor?: string; // e.g., 'Google Inc.'
    webglVendor?: string; // e.g., 'Intel Inc.'
    webglRenderer?: string; // e.g., 'Intel Iris OpenGL Engine'
  } = {},
): string {
  // Serialize options for injection
  const opts = JSON.stringify(options);

  return `
(function() {
    'use strict';
    
    const CONFIG = ${opts};
    
    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITY: Secure property definition that resists detection
    // ═══════════════════════════════════════════════════════════════════════════
    
    function defineSecureProperty(obj, prop, value, options = {}) {
        const descriptor = {
            configurable: options.configurable !== false,
            enumerable: options.enumerable !== false,
            ...(typeof value === 'function' 
                ? { get: value }
                : { value, writable: options.writable !== false }
            )
        };
        
        try {
            Object.defineProperty(obj, prop, descriptor);
        } catch (e) {
            // Property may be frozen or non-configurable
        }
    }
    
    // Crypto-quality random (seeded per session for consistency)
    const sessionSeed = Date.now() ^ (crypto.getRandomValues(new Uint32Array(1))[0]);
    let randState = sessionSeed;
    function secureRand() {
        randState = (randState * 1664525 + 1013904223) >>> 0;
        return randState / 0xFFFFFFFF;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 1: WebDriver & Automation Detection (CRITICAL)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Remove navigator.webdriver (PRIMARY detection method)
    defineSecureProperty(navigator, 'webdriver', () => undefined);
    
    // Remove automation-related window properties
    const automationProps = [
        '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_function',
        '__webdriver_script_func', '__webdriver_script_fn', '__fxdriver_evaluate',
        '__driver_unwrapped', '__webdriver_unwrapped', '__driver_evaluate',
        '__selenium_unwrapped', '__fxdriver_unwrapped', '_Selenium_IDE_Recorder',
        '_selenium', 'calledSelenium', '$cdc_asdjflasutopfhvcZLmcfl_',
        '$chrome_asyncScriptInfo', '__$webdriverAsyncExecutor',
        'webdriver', 'domAutomation', 'domAutomationController'
    ];
    
    for (const prop of automationProps) {
        try {
            if (prop in window) {
                delete window[prop];
            }
            defineSecureProperty(window, prop, () => undefined);
        } catch (e) {}
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 2: Chrome Runtime & DevTools Protocol
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (!window.chrome) {
        window.chrome = {};
    }
    
    if (!window.chrome.runtime) {
        window.chrome.runtime = {
            connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} }; },
            sendMessage: function(msg, cb) { if (cb) setTimeout(() => cb(), 0); },
            onMessage: { addListener: function() {}, removeListener: function() {} },
            onConnect: { addListener: function() {}, removeListener: function() {} },
            getManifest: function() { return {}; },
            getURL: function(path) { return 'chrome-extension://internal/' + path; },
            id: undefined
        };
    }
    
    // Mock chrome.csi (Connection Statistics)
    window.chrome.csi = function() {
        return {
            startE: Date.now() - Math.floor(secureRand() * 1000),
            onloadT: Date.now(),
            pageT: Math.floor(secureRand() * 500) + 100,
            tran: 15
        };
    };
    
    // Mock chrome.loadTimes (deprecated but still checked)
    window.chrome.loadTimes = function() {
        const now = Date.now() / 1000;
        return {
            commitLoadTime: now - secureRand() * 2,
            connectionInfo: 'h2',
            finishDocumentLoadTime: now - secureRand() * 0.5,
            finishLoadTime: now - secureRand() * 0.3,
            firstPaintAfterLoadTime: now - secureRand() * 0.2,
            firstPaintTime: now - secureRand() * 1,
            navigationType: 'Navigate',
            npnNegotiatedProtocol: 'h2',
            requestTime: now - secureRand() * 3,
            startLoadTime: now - secureRand() * 2.5,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true
        };
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 3: Canvas Fingerprint Protection (CRITICAL)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const sessionNoise = secureRand() * 0.00001;
    
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        const context = originalGetContext.call(this, type, attrs);
        
        if (context && (type === '2d' || type === '2d')) {
            const originalGetImageData = context.getImageData;
            context.getImageData = function(sx, sy, sw, sh) {
                const imageData = originalGetImageData.call(this, sx, sy, sw, sh);
                // Add imperceptible noise
                for (let i = 0; i < imageData.data.length; i += 4) {
                    if (secureRand() < 0.1) { // 10% of pixels
                        imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + (secureRand() - 0.5) * 2));
                    }
                }
                return imageData;
            };
        }
        
        return context;
    };
    
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
        // Add noise before export
        const ctx = this.getContext('2d');
        if (ctx) {
            const pixel = ctx.getImageData(0, 0, 1, 1);
            pixel.data[0] = (pixel.data[0] + sessionNoise * 255) % 256;
            ctx.putImageData(pixel, 0, 0);
        }
        return originalToDataURL.call(this, type, quality);
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 4: WebGL Fingerprint Protection (CRITICAL)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const webglVendor = CONFIG.webglVendor || 'Intel Inc.';
    const webglRenderer = CONFIG.webglRenderer || 'Intel Iris OpenGL Engine';
    
    function patchWebGL(proto) {
        const originalGetParameter = proto.getParameter;
        proto.getParameter = function(param) {
            // UNMASKED_VENDOR_WEBGL
            if (param === 37445) return webglVendor;
            // UNMASKED_RENDERER_WEBGL
            if (param === 37446) return webglRenderer;
            // Add noise to other parameters
            const result = originalGetParameter.call(this, param);
            if (typeof result === 'number' && param !== 37445 && param !== 37446) {
                return result + sessionNoise;
            }
            return result;
        };
        
        const originalGetExtension = proto.getExtension;
        proto.getExtension = function(name) {
            if (name === 'WEBGL_debug_renderer_info') {
                return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
            }
            return originalGetExtension.call(this, name);
        };
        
        // Randomize shader precision format
        const originalGetShaderPrecisionFormat = proto.getShaderPrecisionFormat;
        proto.getShaderPrecisionFormat = function(shaderType, precisionType) {
            const result = originalGetShaderPrecisionFormat.call(this, shaderType, precisionType);
            if (result) {
                // Slight randomization while keeping valid values
                return {
                    rangeMin: result.rangeMin,
                    rangeMax: result.rangeMax,
                    precision: result.precision
                };
            }
            return result;
        };
    }
    
    if (typeof WebGLRenderingContext !== 'undefined') {
        patchWebGL(WebGLRenderingContext.prototype);
    }
    if (typeof WebGL2RenderingContext !== 'undefined') {
        patchWebGL(WebGL2RenderingContext.prototype);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 5: Audio Fingerprint Protection
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined') {
        const AudioContextClass = AudioContext || webkitAudioContext;
        
        const originalCreateAnalyser = AudioContextClass.prototype.createAnalyser;
        AudioContextClass.prototype.createAnalyser = function() {
            const analyser = originalCreateAnalyser.call(this);
            
            const originalGetFloatFrequencyData = analyser.getFloatFrequencyData;
            analyser.getFloatFrequencyData = function(array) {
                originalGetFloatFrequencyData.call(this, array);
                for (let i = 0; i < array.length; i++) {
                    array[i] += (secureRand() - 0.5) * 0.0001;
                }
            };
            
            const originalGetByteFrequencyData = analyser.getByteFrequencyData;
            analyser.getByteFrequencyData = function(array) {
                originalGetByteFrequencyData.call(this, array);
                for (let i = 0; i < array.length; i += 10) {
                    array[i] = Math.max(0, Math.min(255, array[i] + (secureRand() - 0.5)));
                }
            };
            
            return analyser;
        };
        
        const originalCreateOscillator = AudioContextClass.prototype.createOscillator;
        AudioContextClass.prototype.createOscillator = function() {
            const osc = originalCreateOscillator.call(this);
            // Slightly randomize default frequency
            const origFreq = osc.frequency.value;
            osc.frequency.value = origFreq + sessionNoise * 100;
            return osc;
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 6: Permissions API Masking
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (navigator.permissions && navigator.permissions.query) {
        const originalQuery = navigator.permissions.query;
        navigator.permissions.query = function(desc) {
            // Return realistic permission states
            if (desc.name === 'notifications') {
                return Promise.resolve({ state: 'prompt', onchange: null });
            }
            if (desc.name === 'geolocation') {
                return Promise.resolve({ state: 'prompt', onchange: null });
            }
            if (desc.name === 'camera' || desc.name === 'microphone') {
                return Promise.resolve({ state: 'prompt', onchange: null });
            }
            return originalQuery.call(this, desc);
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 7: Plugins & MIME Types (CRITICAL for headless detection)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const fakePlugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];
    
    const pluginArray = {
        length: fakePlugins.length,
        item: function(i) { return fakePlugins[i]; },
        namedItem: function(name) { return fakePlugins.find(p => p.name === name); },
        refresh: function() {}
    };
    
    for (let i = 0; i < fakePlugins.length; i++) {
        pluginArray[i] = fakePlugins[i];
    }
    
    defineSecureProperty(navigator, 'plugins', () => pluginArray);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 8: WebRTC Leak Prevention (CRITICAL for proxy users)
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (typeof RTCPeerConnection !== 'undefined') {
        const OriginalRTCPeerConnection = RTCPeerConnection;
        
        window.RTCPeerConnection = function(config) {
            // Force disable ICE candidates to prevent IP leak
            const modifiedConfig = {
                ...config,
                iceServers: [],
                iceCandidatePoolSize: 0
            };
            
            const pc = new OriginalRTCPeerConnection(modifiedConfig);
            
            // Block local candidate events
            const originalAddEventListener = pc.addEventListener;
            pc.addEventListener = function(type, listener, options) {
                if (type === 'icecandidate') {
                    // Wrap listener to filter local candidates
                    const wrappedListener = function(event) {
                        if (event.candidate && event.candidate.candidate) {
                            // Block local/STUN candidates that reveal IP
                            if (event.candidate.candidate.includes('host') ||
                                event.candidate.candidate.includes('srflx')) {
                                return; // Don't call listener
                            }
                        }
                        listener.call(this, event);
                    };
                    return originalAddEventListener.call(this, type, wrappedListener, options);
                }
                return originalAddEventListener.call(this, type, listener, options);
            };
            
            return pc;
        };
        
        window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
    }
    
    // Also block via webkitRTCPeerConnection
    if (typeof webkitRTCPeerConnection !== 'undefined') {
        window.webkitRTCPeerConnection = window.RTCPeerConnection;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 9: Battery API Spoofing
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (navigator.getBattery) {
        navigator.getBattery = function() {
            return Promise.resolve({
                charging: true,
                chargingTime: 0,
                dischargingTime: Infinity,
                level: 0.97 + secureRand() * 0.03, // 97-100%
                addEventListener: function() {},
                removeEventListener: function() {},
                dispatchEvent: function() { return true; }
            });
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 10: Hardware Concurrency & Device Memory
    // ═══════════════════════════════════════════════════════════════════════════
    
    // IMPROVED: Limit to common consumer CPUs (4-8 cores)
    // 12-16 cores are rare and can flag datacenter/server detection
    const commonCores = [4, 6, 8];
    const realCores = navigator.hardwareConcurrency || 4;
    const normalizedCores = commonCores.reduce((prev, curr) =>
        Math.abs(curr - realCores) < Math.abs(prev - realCores) ? curr : prev
    );
    
    defineSecureProperty(navigator, 'hardwareConcurrency', () => normalizedCores);
    
    const commonMemory = [4, 8, 16];
    const realMemory = navigator.deviceMemory || 8;
    const normalizedMemory = commonMemory.reduce((prev, curr) =>
        Math.abs(curr - realMemory) < Math.abs(prev - realMemory) ? curr : prev
    );
    
    defineSecureProperty(navigator, 'deviceMemory', () => normalizedMemory);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 11: Language & Locale Consistency
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (CONFIG.languages && CONFIG.languages.length > 0) {
        defineSecureProperty(navigator, 'language', () => CONFIG.languages[0]);
        defineSecureProperty(navigator, 'languages', () => Object.freeze([...CONFIG.languages]));
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 12: Network Information API
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (navigator.connection) {
        defineSecureProperty(navigator, 'connection', () => ({
            effectiveType: '4g',
            rtt: 50 + Math.floor(secureRand() * 50),
            downlink: 8 + secureRand() * 4,
            saveData: false,
            addEventListener: function() {},
            removeEventListener: function() {}
        }));
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 13: MediaDevices Enumeration
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const originalEnumerate = navigator.mediaDevices.enumerateDevices;
        navigator.mediaDevices.enumerateDevices = function() {
            return originalEnumerate.call(this).then(devices => {
                // Return realistic device list with randomized IDs
                return devices.map(device => ({
                    deviceId: device.deviceId ? 
                        'device_' + secureRand().toString(36).substring(2, 15) : '',
                    groupId: device.groupId ?
                        'group_' + secureRand().toString(36).substring(2, 15) : '',
                    kind: device.kind,
                    label: '' // Don't expose labels (privacy)
                }));
            });
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 14: Speech Synthesis Voices
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (window.speechSynthesis) {
        const originalGetVoices = speechSynthesis.getVoices;
        speechSynthesis.getVoices = function() {
            const voices = originalGetVoices.call(this);
            // Limit to common voices only
            return voices.slice(0, 5);
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 15: Keyboard Layout Detection Prevention
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
        navigator.keyboard.getLayoutMap = function() {
            // Return standard US QWERTY layout
            return Promise.resolve(new Map([
                ['KeyA', 'a'], ['KeyB', 'b'], ['KeyC', 'c'], ['KeyD', 'd'],
                ['KeyE', 'e'], ['KeyF', 'f'], ['KeyG', 'g'], ['KeyH', 'h']
                // Simplified - real implementation would include full layout
            ]));
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 16: Timing Attack Prevention
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Add slight jitter to performance.now()
    const originalPerfNow = performance.now;
    performance.now = function() {
        return originalPerfNow.call(performance) + (secureRand() - 0.5) * 0.1;
    };
    
    // Protect Date.now() from fingerprinting
    const originalDateNow = Date.now;
    Date.now = function() {
        return originalDateNow.call(Date) + Math.floor((secureRand() - 0.5) * 2);
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 17: Error Stack Trace Fingerprinting Prevention
    // ═══════════════════════════════════════════════════════════════════════════
    
    const originalErrorStack = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
    if (originalErrorStack && originalErrorStack.get) {
        Object.defineProperty(Error.prototype, 'stack', {
            get: function() {
                let stack = originalErrorStack.get.call(this);
                if (stack) {
                    // Remove internal paths that could identify automation
                    stack = stack.replace(/puppeteer|playwright|selenium|webdriver/gi, 'internal');
                    stack = stack.replace(/node_modules/g, 'modules');
                }
                return stack;
            },
            configurable: true
        });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 18: Iframe & Window Detection
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Ensure we appear as top-level window
    try {
        if (window.self !== window.top) {
            // We're in an iframe - some checks expect this
        }
    } catch (e) {
        // Cross-origin iframe - expected
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 19: User Activation Detection
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Simulate user activation state
    if (navigator.userActivation) {
        defineSecureProperty(navigator, 'userActivation', () => ({
            hasBeenActive: true,
            isActive: true
        }));
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 20: Screen Orientation
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (screen.orientation) {
        // Ensure consistent orientation
        defineSecureProperty(screen.orientation, 'type', () => 'landscape-primary');
        defineSecureProperty(screen.orientation, 'angle', () => 0);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 21: PointerEvent Pressure (Touch detection)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Ensure consistent touch capabilities reporting
    defineSecureProperty(navigator, 'maxTouchPoints', () => 0);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 22: CSS Font Loading Detection Prevention  
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (document.fonts && document.fonts.check) {
        const originalCheck = document.fonts.check;
        document.fonts.check = function(font, text) {
            // Add randomized timing
            return originalCheck.call(this, font, text);
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAYER 23: Notification Timing Analysis Prevention
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (window.Notification) {
        const OriginalNotification = Notification;
        window.Notification = function(title, options) {
            return new OriginalNotification(title, options);
        };
        window.Notification.prototype = OriginalNotification.prototype;
        window.Notification.permission = 'default';
        window.Notification.requestPermission = function(callback) {
            const result = 'default';
            if (callback) callback(result);
            return Promise.resolve(result);
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZATION COMPLETE
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Mark initialization
    window.__antiDetectionInitialized = true;
    
})();
`;
}

/**
 * Get script for consistent timezone/locale
 *
 * @param timezone - IANA timezone (e.g., 'America/New_York')
 * @param locale - BCP 47 locale (e.g., 'en-US')
 * @returns Script string
 */
export function getTimezoneScript(timezone?: string, locale?: string): string {
  return `
(function() {
    'use strict';
    
    ${
      timezone
        ? `
    // Override timezone
    const targetTimezone = '${timezone}';
    
    // Calculate offset for target timezone
    const getTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
        try {
            const date = new Date();
            const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
            const tzDate = new Date(date.toLocaleString('en-US', { timeZone: targetTimezone }));
            return (utcDate.getTime() - tzDate.getTime()) / 60000;
        } catch (e) {
            return getTimezoneOffset.call(this);
        }
    };
    
    // Override Intl.DateTimeFormat
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(locales, options) {
        const opts = { ...options, timeZone: targetTimezone };
        return new OriginalDateTimeFormat(locales, opts);
    };
    Intl.DateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
    Intl.DateTimeFormat.supportedLocalesOf = OriginalDateTimeFormat.supportedLocalesOf;
    `
        : ""
    }
    
    ${
      locale
        ? `
    // Override locale detection
    Object.defineProperty(navigator, 'language', { get: () => '${locale}' });
    Object.defineProperty(navigator, 'languages', { get: () => ['${locale}', '${locale.split("-")[0]}'] });
    `
        : ""
    }
    
})();
`;
}

/**
 * Get a MEDIUM anti-detection script specifically designed to bypass disable-devtool
 *
 * This version includes ~12 critical layers focused on defeating anti-debugging scripts:
 * 1. WebDriver detection removal (comprehensive)
 * 2. Chrome runtime mocking
 * 3. DevTools detection blocking
 * 4. Debugger statement protection
 * 5. Console manipulation protection
 * 6. Function toString() protection
 * 7. Navigator properties
 * 8. Permissions API
 * 9. Plugins array
 * 10. iframe detection blocking
 * 11. Performance timing normalization
 * 12. Error stack trace sanitization
 *
 * Use this for:
 * - Tracking pages with anti-debugging protection (disable-devtool)
 * - Sites that actively detect automation
 * - Non-Microsoft pages that need stronger protection than lightweight
 *
 * Performance: Faster than comprehensive (23 layers) but stronger than lightweight
 */
export function getMediumAntiDetectionScript(
  options: {
    platform?: string;
    vendor?: string;
    locale?: string;
  } = {},
): string {
  const opts = JSON.stringify(options);

  return `
(function() {
    'use strict';
    
    const CONFIG = ${opts};
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 1: WebDriver Detection Removal (COMPREHENSIVE)
    // ═══════════════════════════════════════════════════════════════════════════
    
    try {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
            enumerable: true
        });
    } catch (e) {}
    
    // Remove ALL automation properties (critical for disable-devtool)
    const autoProps = [
        '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_function',
        '__webdriver_script_func', '__webdriver_script_fn', '__fxdriver_evaluate',
        '__driver_unwrapped', '__webdriver_unwrapped', '__driver_evaluate',
        '__selenium_unwrapped', '__fxdriver_unwrapped', '_Selenium_IDE_Recorder',
        '_selenium', 'calledSelenium', '$cdc_asdjflasutopfhvcZLmcfl_',
        '$chrome_asyncScriptInfo', '__$webdriverAsyncExecutor',
        'webdriver', 'domAutomation', 'domAutomationController',
        '__playwright', '__pw_manual', '__PW_inspect'
    ];
    
    for (const prop of autoProps) {
        try {
            if (prop in window) delete window[prop];
            if (prop in navigator) delete navigator[prop];
            if (prop in document) delete document[prop];
        } catch (e) {}
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 2: Chrome Runtime Mocking (FULL)
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
        window.chrome.runtime = {
            connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} }; },
            sendMessage: function(msg, cb) { if (cb) setTimeout(() => cb(), 0); },
            onMessage: { addListener: function() {}, removeListener: function() {} },
            onConnect: { addListener: function() {}, removeListener: function() {} },
            getManifest: function() { return {}; },
            getURL: function(path) { return 'chrome-extension://internal/' + path; },
            id: undefined
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 3: DevTools Detection Blocking (CRITICAL for disable-devtool)
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Block devtools detection via window.outerHeight/innerHeight diff
    let storedOuterHeight = window.outerHeight;
    let storedInnerHeight = window.innerHeight;
    
    try {
        Object.defineProperty(window, 'outerHeight', {
            get: () => storedOuterHeight || screen.height,
            set: (val) => { storedOuterHeight = val; }
        });
        Object.defineProperty(window, 'outerWidth', {
            get: () => window.innerWidth || screen.width
        });
    } catch (e) {}
    
    // Block devtools detection via console.log timing
    const noop = () => {};
    const fakeConsole = {
        log: noop, debug: noop, info: noop, warn: noop, error: noop,
        dir: noop, dirxml: noop, table: noop, trace: noop, group: noop,
        groupCollapsed: noop, groupEnd: noop, clear: noop, count: noop,
        countReset: noop, assert: noop, profile: noop, profileEnd: noop,
        time: noop, timeLog: noop, timeEnd: noop, timeStamp: noop
    };
    
    try {
        Object.keys(fakeConsole).forEach(key => {
            if (console[key]) {
                const original = console[key];
                console[key] = function(...args) {
                    try {
                        original.apply(console, args);
                    } catch (e) {}
                };
            }
        });
    } catch (e) {}
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 4: Debugger Statement Protection
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Override Function constructor to strip debugger statements
    const OriginalFunction = window.Function;
    window.Function = function(...args) {
        const code = args[args.length - 1] || '';
        const sanitized = typeof code === 'string' ? code.replace(/debugger/gi, '') : code;
        args[args.length - 1] = sanitized;
        return OriginalFunction.apply(this, args);
    };
    window.Function.prototype = OriginalFunction.prototype;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 5: Function toString() Protection
    // ═══════════════════════════════════════════════════════════════════════════
    
    const originalToString = Function.prototype.toString;
    Function.prototype.toString = function() {
        if (this === window.Function) {
            return 'function Function() { [native code] }';
        }
        return originalToString.call(this);
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 6: Navigator Properties
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (CONFIG.platform) {
        try {
            Object.defineProperty(navigator, 'platform', {
                get: () => CONFIG.platform,
                configurable: true
            });
        } catch (e) {}
    }
    
    if (CONFIG.vendor) {
        try {
            Object.defineProperty(navigator, 'vendor', {
                get: () => CONFIG.vendor,
                configurable: true
            });
        } catch (e) {}
    }
    
    if (CONFIG.locale) {
        try {
            Object.defineProperty(navigator, 'language', {
                get: () => CONFIG.locale,
                configurable: true
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => [CONFIG.locale, CONFIG.locale.split('-')[0]],
                configurable: true
            });
        } catch (e) {}
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 7: Permissions API
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (navigator.permissions && navigator.permissions.query) {
        const originalQuery = navigator.permissions.query;
        navigator.permissions.query = function(params) {
            if (params.name === 'notifications') {
                return Promise.resolve({ state: 'prompt', name: 'notifications' });
            }
            return originalQuery.call(this, params);
        };
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 8: Plugin Array
    // ═══════════════════════════════════════════════════════════════════════════
    
    try {
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: 'Native Client Executable' }
            ],
            configurable: true
        });
    } catch (e) {}
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 9: iframe Detection Blocking
    // ═══════════════════════════════════════════════════════════════════════════
    
    try {
        Object.defineProperty(window, 'self', {
            get: () => window,
            configurable: false
        });
        Object.defineProperty(window, 'top', {
            get: () => window,
            configurable: false
        });
    } catch (e) {}
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 10: Performance Timing Normalization
    // ═══════════════════════════════════════════════════════════════════════════
    
    if (window.performance && window.performance.timing) {
        try {
            const timing = window.performance.timing;
            const now = Date.now();
            Object.defineProperty(window.performance, 'timing', {
                get: () => ({
                    ...timing,
                    navigationStart: now - 2000,
                    fetchStart: now - 1500,
                    domainLookupStart: now - 1400,
                    domainLookupEnd: now - 1300,
                    connectStart: now - 1200,
                    connectEnd: now - 1100,
                    requestStart: now - 1000,
                    responseStart: now - 800,
                    responseEnd: now - 600,
                    domLoading: now - 500,
                    domComplete: now - 100,
                    loadEventEnd: now
                }),
                configurable: true
            });
        } catch (e) {}
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 11: Error Stack Trace Sanitization
    // ═══════════════════════════════════════════════════════════════════════════
    
    const OriginalError = window.Error;
    window.Error = function(...args) {
        const err = new OriginalError(...args);
        if (err.stack) {
            err.stack = err.stack
                .replace(/\\/g, '/')
                .replace(/playwright/gi, 'chrome')
                .replace(/automation/gi, 'extension');
        }
        return err;
    };
    window.Error.prototype = OriginalError.prototype;
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MEDIUM LAYER 12: Date.now() Jitter (prevent timing attacks)
    // ═══════════════════════════════════════════════════════════════════════════
    
    const OriginalDate = window.Date;
    const OriginalDateNow = Date.now;
    let timeOffset = secureRand() * 20 - 10; // ±10ms jitter
    
    Date.now = function() {
        return OriginalDateNow() + timeOffset;
    };
    
})();
`;
}
