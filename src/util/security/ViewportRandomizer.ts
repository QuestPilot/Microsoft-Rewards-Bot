/**
 * Viewport and Screen Resolution Randomization
 *
 * CRITICAL: Fixed/common viewport sizes are a detection signal
 * Microsoft (2026) fingerprints screen resolution, DPI, and viewport
 *
 * DETECTION VECTORS ADDRESSED:
 * 1. Identical viewport across sessions
 * 2. Unrealistic screen resolutions
 * 3. Mismatched screen/window sizes
 * 4. Common headless browser sizes (1920x1080, etc.)
 * 5. DPI fingerprinting
 */

import { secureRandomBool, secureRandomInt } from "../security/SecureRandom";

export interface ViewportConfig {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

export interface ScreenConfig {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
  pixelDepth: number;
}

/**
 * Common desktop screen resolutions (realistic consumer displays)
 * Avoids datacenter/server resolutions
 */
const DESKTOP_RESOLUTIONS = [
  // 1080p (most common)
  { width: 1920, height: 1080, weight: 40 },
  { width: 1680, height: 1050, weight: 10 },
  { width: 1600, height: 900, weight: 15 },

  // 1440p (QHD)
  { width: 2560, height: 1440, weight: 20 },
  { width: 3440, height: 1440, weight: 5 }, // Ultrawide

  // 4K
  { width: 3840, height: 2160, weight: 8 },

  // Less common but realistic
  { width: 1366, height: 768, weight: 10 },
  { width: 1536, height: 864, weight: 5 },
  { width: 1440, height: 900, weight: 5 },
] as const;

/**
 * Common mobile screen resolutions
 */
const MOBILE_RESOLUTIONS = [
  // iPhone
  { width: 390, height: 844, weight: 20 }, // iPhone 14 Pro
  { width: 393, height: 852, weight: 15 }, // iPhone 14 Pro Max
  { width: 375, height: 812, weight: 15 }, // iPhone 13/12
  { width: 414, height: 896, weight: 10 }, // iPhone 11/XR

  // Android flagships
  { width: 412, height: 915, weight: 15 }, // Pixel 7
  { width: 360, height: 800, weight: 10 }, // Galaxy S21
  { width: 384, height: 854, weight: 10 }, // OnePlus

  // Tablets
  { width: 768, height: 1024, weight: 3 }, // iPad
  { width: 820, height: 1180, weight: 2 }, // iPad Air
] as const;

/**
 * Select weighted random resolution
 */
function selectWeightedResolution<
  T extends { width: number; height: number; weight: number },
>(resolutions: readonly T[]): T {
  const totalWeight = resolutions.reduce((sum, r) => sum + r.weight, 0);
  let random = secureRandomInt(0, totalWeight);

  for (const resolution of resolutions) {
    random -= resolution.weight;
    if (random <= 0) {
      return resolution;
    }
  }

  return resolutions[0] as T;
}

/**
 * Generate realistic viewport configuration
 *
 * CRITICAL: Adds randomization to prevent fingerprinting
 *
 * @param isMobile - Mobile vs desktop context
 * @param persist - Use session-consistent values (recommended)
 * @returns Viewport configuration
 */
export function generateRealisticViewport(
  isMobile: boolean,
  persist: boolean = true,
): ViewportConfig {
  if (isMobile) {
    const base = selectWeightedResolution(MOBILE_RESOLUTIONS);

    // Mobile: add slight variance (±5px) for uniqueness
    const variance = persist ? 0 : secureRandomInt(-5, 5);

    return {
      width: base.width + variance,
      height: base.height + variance,
      deviceScaleFactor: [2, 3][secureRandomInt(0, 1)] as number, // 2x or 3x (common for mobile)
      isMobile: true,
      hasTouch: true,
    };
  } else {
    const base = selectWeightedResolution(DESKTOP_RESOLUTIONS);

    // Desktop: subtract taskbar/chrome (100-120px)
    const chromeHeight = secureRandomInt(100, 120);

    // Add slight randomization (±10px width, for window resize simulation)
    const widthVariance = persist ? 0 : secureRandomInt(-10, 10);

    return {
      width: base.width + widthVariance,
      height: base.height - chromeHeight,
      deviceScaleFactor: secureRandomBool(0.3) ? 1.25 : 1.0, // 30% have scaling
      isMobile: false,
      hasTouch: false,
    };
  }
}

/**
 * Generate realistic screen configuration
 * Must be consistent with viewport
 *
 * @param viewport - Viewport configuration
 * @returns Screen configuration for injection
 */
export function generateRealisticScreen(
  viewport: ViewportConfig,
): ScreenConfig {
  if (viewport.isMobile) {
    // Mobile: screen = viewport (fullscreen)
    return {
      width: viewport.width,
      height: viewport.height,
      availWidth: viewport.width,
      availHeight: viewport.height,
      colorDepth: 24,
      pixelDepth: 24,
    };
  } else {
    // Desktop: screen > viewport (window within screen)
    const base = selectWeightedResolution(DESKTOP_RESOLUTIONS);

    // Ensure screen is at least as large as viewport
    const screenWidth = Math.max(viewport.width, base.width);
    const screenHeight = Math.max(viewport.height + 120, base.height);

    // Available size (minus taskbar ~40px)
    const taskbarHeight = secureRandomInt(38, 48);

    return {
      width: screenWidth,
      height: screenHeight,
      availWidth: screenWidth,
      availHeight: screenHeight - taskbarHeight,
      colorDepth: 24,
      pixelDepth: 24,
    };
  }
}

/**
 * Generate viewport override script for injection
 * CRITICAL: Must run before any page scripts
 *
 * @param viewport - Viewport config
 * @param screen - Screen config
 * @returns JavaScript code to inject
 */
export function getViewportOverrideScript(
  viewport: ViewportConfig,
  screen: ScreenConfig,
): string {
  return `
(function() {
    'use strict';
    
    // Override screen properties
    Object.defineProperty(window.screen, 'width', { get: () => ${screen.width} });
    Object.defineProperty(window.screen, 'height', { get: () => ${screen.height} });
    Object.defineProperty(window.screen, 'availWidth', { get: () => ${screen.availWidth} });
    Object.defineProperty(window.screen, 'availHeight', { get: () => ${screen.availHeight} });
    Object.defineProperty(window.screen, 'colorDepth', { get: () => ${screen.colorDepth} });
    Object.defineProperty(window.screen, 'pixelDepth', { get: () => ${screen.pixelDepth} });
    
    // Override window.outerWidth/outerHeight (window chrome)
    Object.defineProperty(window, 'outerWidth', { get: () => ${viewport.width} });
    Object.defineProperty(window, 'outerHeight', { get: () => ${viewport.height + 120} });
    
    // Override window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', { get: () => ${viewport.deviceScaleFactor} });
    
    // Override matchMedia for screen size queries
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = function(query) {
        const result = originalMatchMedia.call(this, query);
        
        // Override width/height queries
        if (/width/i.test(query)) {
            const widthMatch = query.match(/(min|max)-width\\s*:\\s*(\\d+)/);
            if (widthMatch) {
                const [, type, value] = widthMatch;
                const width = ${viewport.width};
                const matches = type === 'min' ? width >= parseInt(value) : width <= parseInt(value);
                
                return {
                    ...result,
                    matches,
                    media: query
                };
            }
        }
        
        return result;
    };
    
})();
`;
}
