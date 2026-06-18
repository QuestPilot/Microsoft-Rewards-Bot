import type { Page } from 'patchright'
import { URLS } from './DashboardSelectors'

export interface SidePanelSnapshot {
    panelCount: number
    switchCount: number
    expandedDisclosureCount: number
    progressBarCount: number
    buttonCount: number
}

export interface SwitchSyncResult {
    found: boolean
    disabled: boolean
    before: boolean | null
    after: boolean | null
    changed: boolean
}

export class RewardsSidePanelController {
    constructor(private readonly page: Page) {}

    async snapshot(): Promise<SidePanelSnapshot> {
        return this.page.evaluate(() => {
            const panels = Array.from(
                document.querySelectorAll('[role="dialog"], .react-aria-DisclosurePanel:not([hidden])')
            ).filter(el => {
                const rect = el.getBoundingClientRect()
                const style = window.getComputedStyle(el)
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            })

            return {
                panelCount: panels.length,
                switchCount: document.querySelectorAll('input[role="switch"], button[role="switch"]').length,
                expandedDisclosureCount: document.querySelectorAll('button[aria-expanded="true"]').length,
                progressBarCount: document.querySelectorAll('[role="progressbar"]').length,
                buttonCount: panels.reduce((count, panel) => count + panel.querySelectorAll('button').length, 0)
            }
        })
    }

    async waitForPanel(timeoutMs = 5000): Promise<boolean> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            const snapshot = await this.snapshot().catch(() => null)
            if (snapshot && snapshot.panelCount > 0) return true
            await this.page.waitForTimeout(250).catch(() => undefined)
        }

        return false
    }

    async openFirstCardByImageToken(token: string, scope = 'body'): Promise<boolean> {
        const clicked = await this.page.evaluate(
            ({ token, scope }) => {
                const root = document.querySelector(scope) ?? document.body
                const isVisibleElement = (el: Element): boolean => {
                    const rect = el.getBoundingClientRect()
                    const style = window.getComputedStyle(el)
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
                }
                const tokenLower = token.toLowerCase()
                const matchesToken = (el: Element): boolean =>
                    [
                        el.getAttribute('src'),
                        el.getAttribute('srcset'),
                        el.getAttribute('alt'),
                        el.getAttribute('aria-label'),
                        el.getAttribute('title'),
                        el.textContent
                    ]
                        .filter(Boolean)
                        .join(' ')
                        .toLowerCase()
                        .includes(tokenLower)
                const findTrigger = (el: Element | undefined): HTMLElement | null =>
                    (el?.closest('button[aria-expanded], button[data-rac], a[data-rac]') as HTMLElement | null) ?? null

                const images = Array.from(root.querySelectorAll('img[src], img[srcset], img[alt]'))
                let trigger = findTrigger(images.find(matchesToken))

                if (!trigger) {
                    const candidates = Array.from(
                        root.querySelectorAll<HTMLElement>(
                            'button[aria-expanded]:not([slot="trigger"]), button[data-rac]:not([slot="trigger"]), a[data-rac]'
                        )
                    ).filter(isVisibleElement)
                    trigger =
                        candidates.find(matchesToken) ??
                        candidates.find(el => el.matches('button[aria-expanded="false"]')) ??
                        null
                }

                if (!trigger) return false
                trigger.click()
                return true
            },
            { token, scope }
        )

        return clicked ? this.waitForPanel() : false
    }

    async expandDisclosure(scope: string): Promise<boolean> {
        return this.page.evaluate(scope => {
            const root = document.querySelector(scope)
            const trigger = root?.querySelector<HTMLElement>('button[slot="trigger"][aria-expanded="false"]')
            if (!trigger) return false
            trigger.click()
            return true
        }, scope)
    }

    async collapseFirstCardByImageToken(token: string, scope = 'body'): Promise<boolean> {
        return this.page.evaluate(
            ({ token, scope }) => {
                const root = document.querySelector(scope) ?? document.body
                const tokenLower = token.toLowerCase()
                const matchesToken = (el: Element): boolean =>
                    [
                        el.getAttribute('src'),
                        el.getAttribute('srcset'),
                        el.getAttribute('alt'),
                        el.getAttribute('aria-label'),
                        el.getAttribute('title'),
                        el.textContent
                    ]
                        .filter(Boolean)
                        .join(' ')
                        .toLowerCase()
                        .includes(tokenLower)

                const images = Array.from(root.querySelectorAll('img[src], img[srcset], img[alt]'))
                const image = images.find(matchesToken)
                const trigger =
                    (image?.closest('button[aria-expanded="true"]') as HTMLElement | null) ??
                    root.querySelector<HTMLElement>('button[aria-expanded="true"]:not([slot="trigger"])')
                if (!trigger) return false
                trigger.click()
                return true
            },
            { token, scope }
        )
    }

    async setFirstSwitchState(targetChecked: boolean): Promise<SwitchSyncResult> {
        return this.page.evaluate(targetChecked => {
            const isVisibleElement = (el: Element): boolean => {
                const rect = el.getBoundingClientRect()
                const style = window.getComputedStyle(el)
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            }
            const switches = Array.from(document.querySelectorAll<HTMLInputElement>('input[role="switch"]'))
            const input = switches.find(el => {
                const rect = el.getBoundingClientRect()
                const label = el.closest('label')
                return (
                    (rect.width > 0 && rect.height > 0) ||
                    (label instanceof Element && isVisibleElement(label))
                )
            })

            if (!input) {
                const buttonSwitches = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="switch"]'))
                const button = buttonSwitches.find(isVisibleElement)
                if (!button) {
                    return { found: false, disabled: false, before: null, after: null, changed: false }
                }

                const before = button.getAttribute('aria-checked') === 'true'
                const disabled =
                    button.disabled ||
                    button.getAttribute('aria-disabled') === 'true' ||
                    button.closest('[data-disabled="true"]') !== null
                if (disabled || before === targetChecked) {
                    return { found: true, disabled, before, after: before, changed: false }
                }

                button.click()

                const after = button.getAttribute('aria-checked') === 'true'
                return { found: true, disabled: false, before, after, changed: after !== before }
            }

            const before = input.checked
            const disabled = input.disabled || input.closest('[data-disabled="true"]') !== null
            if (disabled || before === targetChecked) {
                return { found: true, disabled, before, after: before, changed: false }
            }

            const clickable = input.closest('label') as HTMLElement | null
            ;(clickable ?? input).click()

            return { found: true, disabled: false, before, after: input.checked, changed: input.checked !== before }
        }, targetChecked)
    }

    async closePanel(fallbackUrl = URLS.dashboard): Promise<void> {
        const clicked = await this.page.evaluate(() => {
            const isVisibleElement = (el: Element): boolean => {
                const rect = el.getBoundingClientRect()
                const style = window.getComputedStyle(el)
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            }
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
            const closeButton = buttons.find(button => {
                const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('slot') ?? ''}`.toLowerCase()
                return isVisibleElement(button) && (label.includes('close') || label.includes('fermer') || label.includes('cerrar'))
            })
            if (!closeButton) return false
            closeButton.click()
            return true
        })

        if (clicked) {
            await this.page.waitForTimeout(500).catch(() => undefined)
            return
        }

        if (fallbackUrl && !this.page.url().includes('/dashboard')) {
            await this.page.goto(fallbackUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
        }
    }
}
