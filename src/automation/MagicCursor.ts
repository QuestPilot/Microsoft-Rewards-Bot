/**
 * Persistent "magic cursor" overlay — the BOT's own visible, lively cursor.
 *
 * Injected via `context.addInitScript`, so it runs at document-start on EVERY
 * page and EVERY navigation, for any browser channel.
 *
 * Behaviour:
 *   - It does NOT follow the user's physical mouse. It is driven exclusively by
 *     the bot, which calls `window.__mgcMoveTo(x, y, click)` before each click
 *     (see AutomationUtils.moveMagicCursorTo).
 *   - When it travels to a target it LEANS toward the direction of travel (so it
 *     visibly orients itself toward the button), then straightens back to the
 *     default up-left arrow as it lands and clicks.
 *   - When the bot navigates by URL (no click), the cursor stays alive: a gentle
 *     idle float, a "youpi" bounce on every page change, and — when idle for a
 *     while — fun stunts: a full loop-the-loop, a wiggle, or wandering off to a
 *     random spot with a smooth glide.
 *
 * Structure (3 layers so transforms never fight each other):
 *   #__mgc__        → OUTER: screen position (translate) + glide transition
 *     #__mgc_rot__  → ROTATOR: lean/orientation toward travel direction
 *       #__mgc_inner__ → INNER: float / bounce / loop / wiggle / press
 *
 * 100% cosmetic: `pointer-events: none`, never calls `preventDefault`, fully
 * wrapped in try/catch. It can never interfere with the actual clicks.
 */
export function installMagicCursor(): void {
    try {
        // Only the top frame — avoids one cursor per iframe.
        if (window.self !== window.top) return

        const STYLE_ID = '__mgc_style__'
        const CURSOR_ID = '__mgc__'
        const ROT_ID = '__mgc_rot__'
        const INNER_ID = '__mgc_inner__'

        const w = window as unknown as {
            __mgcInstalled?: boolean
            __mgcX?: number
            __mgcY?: number
            __mgcLastActive?: number
            __mgcMoveTo?: (x: number, y: number, click?: boolean) => void
        }

        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

        // Lean angle (deg) for travelling from (fromX,fromY) to (toX,toY).
        // 0 = straight up; positive = leaning right. Capped so it always still
        // reads as a cursor (never upside-down).
        function leanFor(fromX: number, fromY: number, toX: number, toY: number): number {
            const dx = toX - fromX
            const dy = toY - fromY
            if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return 0
            const deg = (Math.atan2(dx, -dy) * 180) / Math.PI
            return clamp(deg, -72, 72)
        }

        function injectStyle(): void {
            if (document.getElementById(STYLE_ID)) return
            const head = document.head || document.documentElement
            if (!head) return
            const s = document.createElement('style')
            s.id = STYLE_ID
            s.textContent = `
                #${CURSOR_ID} {
                    position: fixed; top: 0; left: 0;
                    width: 23px; height: 28px; margin: 0; padding: 0;
                    z-index: 2147483647; pointer-events: none; will-change: transform;
                    transform: translate(-120px, -120px);
                    transition: transform 0.5s cubic-bezier(0.33, 0.12, 0.18, 1);
                }
                #${ROT_ID} {
                    width: 100%; height: 100%;
                    transform-origin: 28% 22%;
                    transform: rotate(0deg);
                    transition: transform 0.28s ease;
                }
                #${INNER_ID} {
                    width: 100%; height: 100%;
                    transform-origin: 28% 22%;
                    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45));
                    animation: __mgc_float__ 2.6s ease-in-out infinite;
                }
                #${INNER_ID} svg { display: block; width: 100%; height: 100%; }
                #${INNER_ID}.__mgc_bounce__ { animation: __mgc_bounce__ 0.65s ease-out; }
                #${INNER_ID}.__mgc_wiggle__ { animation: __mgc_wiggle__ 0.8s ease-in-out; }
                #${INNER_ID}.__mgc_loop__   { animation: __mgc_loop__ 1.05s ease-in-out; }
                #${INNER_ID}.__mgc_press__  { animation: none; transform: scale(0.76); }

                @keyframes __mgc_float__ {
                    0%, 100% { transform: translateY(0); }
                    50%      { transform: translateY(-3.5px); }
                }
                @keyframes __mgc_bounce__ {
                    0%   { transform: translateY(0)     scale(1); }
                    28%  { transform: translateY(-12px) scale(1.13); }
                    52%  { transform: translateY(0)     scale(0.92); }
                    72%  { transform: translateY(-5px)  scale(1.04); }
                    100% { transform: translateY(0)     scale(1); }
                }
                @keyframes __mgc_wiggle__ {
                    0%, 100% { transform: rotate(0deg)   translateY(0); }
                    20%      { transform: rotate(-13deg) translateY(-2px); }
                    45%      { transform: rotate(11deg)  translateY(-3px); }
                    70%      { transform: rotate(-6deg)  translateY(-1px); }
                }
                /* Loop-the-loop, like a car taking a vertical loop. */
                @keyframes __mgc_loop__ {
                    0%   { transform: translate(0,0)       rotate(0deg); }
                    20%  { transform: translate(11px,-13px) rotate(150deg); }
                    40%  { transform: translate(0,-26px)    rotate(300deg); }
                    58%  { transform: translate(-13px,-17px) rotate(430deg); }
                    76%  { transform: translate(-7px,-2px)   rotate(580deg); }
                    100% { transform: translate(0,0)        rotate(720deg); }
                }
                @keyframes __mgc_ripple__ {
                    0%   { transform: scale(0);   opacity: 0.55; }
                    100% { transform: scale(4.5); opacity: 0;    }
                }
            `
            head.appendChild(s)
        }

        function cursorSvg(): string {
            // Small, rounded, tail-less pointer: black fill with a white outline.
            return `<svg width="18" height="22" viewBox="0 0 18 22" xmlns="http://www.w3.org/2000/svg">
                <path d="M3.4 2.6 L3.4 16.6 L7.6 12.8 L12.4 12.8 Z"
                      fill="#000000"
                      stroke="#ffffff" stroke-width="2.1"
                      stroke-linejoin="round" stroke-linecap="round"
                      paint-order="stroke"/>
            </svg>`
        }

        const el = () => document.getElementById(CURSOR_ID) as HTMLDivElement | null
        const rot = () => document.getElementById(ROT_ID) as HTMLDivElement | null
        const inner = () => document.getElementById(INNER_ID) as HTMLDivElement | null

        function setPos(x: number, y: number): void {
            w.__mgcX = x
            w.__mgcY = y
            const e = el()
            if (e) e.style.transform = `translate(${x}px, ${y}px)`
        }

        function setLean(deg: number): void {
            const r = rot()
            if (r) r.style.transform = `rotate(${deg}deg)`
        }

        function playOnce(cls: string): void {
            const i = inner()
            if (!i) return
            i.classList.remove(cls)
            void i.getBoundingClientRect() // force reflow so it can restart
            i.classList.add(cls)
            const clear = () => i.classList.remove(cls)
            i.addEventListener('animationend', clear, { once: true })
            setTimeout(clear, 1300)
        }

        function injectCursor(bounce: boolean): void {
            if (document.getElementById(CURSOR_ID)) return
            if (!document.body) return
            const outer = document.createElement('div')
            outer.id = CURSOR_ID
            outer.setAttribute('aria-hidden', 'true')
            const rotator = document.createElement('div')
            rotator.id = ROT_ID
            const innerEl = document.createElement('div')
            innerEl.id = INNER_ID
            innerEl.innerHTML = cursorSvg()
            rotator.appendChild(innerEl)
            outer.appendChild(rotator)
            const x = w.__mgcX ?? (window.innerWidth || 800) / 2
            const y = w.__mgcY ?? (window.innerHeight || 600) / 2
            outer.style.transform = `translate(${x}px, ${y}px)`
            document.body.appendChild(outer)
            if (bounce) setTimeout(() => playOnce('__mgc_bounce__'), 90)
        }

        function clickRipple(x: number, y: number): void {
            if (!document.body) return
            const ripple = document.createElement('div')
            ripple.style.cssText = `
                position: fixed; left: ${x - 9}px; top: ${y - 9}px;
                width: 18px; height: 18px; border-radius: 50%;
                background: rgba(0,0,0,0.28);
                box-shadow: 0 0 0 1.5px rgba(255,255,255,0.55) inset;
                z-index: 2147483646; pointer-events: none;
                animation: __mgc_ripple__ 0.5s ease-out forwards;`
            document.body.appendChild(ripple)
            setTimeout(() => ripple.remove(), 550)
        }

        // ── Public API the bot calls before each click ───────────────────────
        w.__mgcMoveTo = (x: number, y: number, click?: boolean): void => {
            w.__mgcLastActive = Date.now()
            const fromX = w.__mgcX ?? x
            const fromY = w.__mgcY ?? y

            // Orient toward the target, glide there, then straighten + click.
            setLean(leanFor(fromX, fromY, x, y))
            setPos(x, y)

            setTimeout(() => {
                setLean(0) // back to the default up-left arrow as it lands
                if (click) {
                    const i = inner()
                    if (i) i.classList.add('__mgc_press__')
                    clickRipple(x, y)
                    setTimeout(() => {
                        const j = inner()
                        if (j) j.classList.remove('__mgc_press__')
                    }, 150)
                }
            }, 470)
        }

        // ── Idle life: stunts when the bot is busy navigating without clicking ─
        function wander(): void {
            if (!el()) return
            const margin = 90
            const vw = window.innerWidth || 800
            const vh = window.innerHeight || 600
            const x = margin + Math.random() * Math.max(1, vw - 2 * margin)
            const y = margin + Math.random() * Math.max(1, vh - 2 * margin)
            const fromX = w.__mgcX ?? x
            const fromY = w.__mgcY ?? y
            setLean(leanFor(fromX, fromY, x, y))
            setPos(x, y)
            setTimeout(() => setLean(0), 560)
        }

        function idleTick(): void {
            if (!document.getElementById(STYLE_ID)) injectStyle()
            if (!el()) {
                injectCursor(true)
                return
            }
            const idleFor = Date.now() - (w.__mgcLastActive || 0)
            if (idleFor < 4500) return
            const roll = Math.random()
            if (roll < 0.34) playOnce('__mgc_loop__')
            else if (roll < 0.6) playOnce('__mgc_wiggle__')
            else wander()
            // Space stunts out: require another full idle gap before the next one.
            w.__mgcLastActive = Date.now()
        }

        function boot(bounce: boolean): void {
            injectStyle()
            injectCursor(bounce)
        }

        if (document.body) boot(true)
        else document.addEventListener('DOMContentLoaded', () => boot(true))

        setInterval(idleTick, 2200)

        // ── Show click ripple for every real bot click ────────────────────────
        // When Playwright fires any click (ghostClick, locator.click, btn.click…)
        // a mousedown fires in the page. We play the ripple at the exact click
        // site and the press-scale on the cursor — wherever it currently is.
        // We do NOT move the cursor here: ghostClick's __mgcMoveTo() already
        // glided it to the target 650 ms earlier. Moving on mousedown would cause
        // a jarring jump. We also do NOT listen to mousemove: this cursor is the
        // bot's cursor only, not the user's physical mouse.
        document.addEventListener(
            'mousedown',
            (ev: MouseEvent) => {
                try {
                    w.__mgcLastActive = Date.now()
                    const i = inner()
                    if (i) i.classList.add('__mgc_press__')
                    clickRipple(ev.clientX, ev.clientY)
                    setTimeout(() => {
                        const j = inner()
                        if (j) j.classList.remove('__mgc_press__')
                    }, 150)
                } catch {
                    /* cosmetic only */
                }
            },
            true
        )

        w.__mgcInstalled = true
    } catch {
        // Cosmetic only — never let the cursor break a real run.
    }
}
