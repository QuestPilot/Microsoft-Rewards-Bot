import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import { URLS } from '../../../automation/DashboardSelectors'
import { RewardsSidePanelController, type SwitchSyncResult } from '../../../automation/RewardsSidePanelController'

export type StreakProtectionState = 'enabled' | 'disabled' | 'unknown' | 'unavailable'

export interface StreakProtectionSyncResult {
    desiredEnabled: boolean
    state: StreakProtectionState
    changed: boolean
    reason?: string
}

export class StreakProtectionGate {
    constructor(private readonly bot: MicrosoftRewardsBot) {}

    async sync(page: Page, desiredEnabled: boolean): Promise<StreakProtectionSyncResult> {
        try {
            // The legacy (ASP) dashboard has no Next.js streak panel and no /dashboard
            // SPA route. The free-tier gate can't do anything here — premium Core
            // handles legacy streak protection via the togglestreakasync API instead.
            if (this.bot.dashboardVariant === 'legacy') {
                return { desiredEnabled, state: 'unavailable', changed: false, reason: 'legacy-dashboard' }
            }

            if (!page.url().includes('rewards.bing.com')) {
                await page.goto(URLS.dashboard, { waitUntil: 'domcontentloaded' })
                await this.bot.utils.wait(1000)
            }

            const panel = new RewardsSidePanelController(page)
            const expanded = await panel.expandDisclosure('section#snapshot')
            if (expanded) await this.bot.utils.wait(700)

            const opened = await panel.openFirstCardByImageToken('Fire', 'section#snapshot')
            if (!opened) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'STREAK-PROTECTION',
                    'Streak panel unavailable; unable to synchronize protection'
                )
                return { desiredEnabled, state: 'unavailable', changed: false, reason: 'panel-unavailable' }
            }

            const switchResult = await panel.setFirstSwitchState(desiredEnabled)
            await this.bot.utils.wait(500)
            const collapsed = await panel.collapseFirstCardByImageToken('Fire', 'section#snapshot')
            if (!collapsed) await panel.closePanel()

            return this.toSyncResult(desiredEnabled, switchResult)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.bot.logger.warn(this.bot.isMobile, 'STREAK-PROTECTION', `Sync failed: ${message}`)
            return { desiredEnabled, state: 'unknown', changed: false, reason: message }
        }
    }

    private toSyncResult(desiredEnabled: boolean, result: SwitchSyncResult): StreakProtectionSyncResult {
        if (!result.found) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'STREAK-PROTECTION',
                'Streak protection switch not found in panel'
            )
            return { desiredEnabled, state: 'unavailable', changed: false, reason: 'switch-not-found' }
        }

        if (result.disabled) {
            this.bot.logger.info(
                this.bot.isMobile,
                'STREAK-PROTECTION',
                `Switch is disabled by Microsoft; current state is ${result.before === null ? 'unknown' : result.before ? 'ON' : 'OFF'}`
            )
            return {
                desiredEnabled,
                state: result.before === null ? 'unknown' : result.before ? 'enabled' : 'disabled',
                changed: false,
                reason: 'switch-disabled'
            }
        }

        const state = result.after === null ? 'unknown' : result.after ? 'enabled' : 'disabled'
        this.bot.logger.info(
            this.bot.isMobile,
            'STREAK-PROTECTION',
            `Desired: ${desiredEnabled ? 'ON' : 'OFF'} | Before: ${
                result.before === null ? 'unknown' : result.before ? 'ON' : 'OFF'
            } | After: ${result.after === null ? 'unknown' : result.after ? 'ON' : 'OFF'}`
        )

        return { desiredEnabled, state, changed: result.changed }
    }
}
