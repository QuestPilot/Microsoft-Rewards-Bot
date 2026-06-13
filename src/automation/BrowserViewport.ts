export const DESKTOP_BROWSER_VIEWPORT = {
    width: 1440,
    height: 900
} as const

export const DESKTOP_BROWSER_WINDOW_ARG = `--window-size=${DESKTOP_BROWSER_VIEWPORT.width},${DESKTOP_BROWSER_VIEWPORT.height}`
