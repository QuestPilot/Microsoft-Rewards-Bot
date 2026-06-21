import type { MicrosoftRewardsBot } from '../../index'
import type { DashboardActions } from './DashboardActions'
import { LegacyDashboardActions } from './legacy/LegacyDashboardActions'
import { NextDashboardActions } from './next/NextDashboardActions'

/**
 * The SINGLE place the dashboard variant is switched. Tasks reach the active
 * strategy through `bot.dashboard` (which calls this), never by branching
 * themselves.
 *
 * To remove legacy support: delete the `legacy/` folder, the import below, and the
 * legacy branch here (collapse to `return new NextDashboardActions(bot)`).
 */
export function getDashboardActions(bot: MicrosoftRewardsBot): DashboardActions {
    return bot.dashboardVariant === 'legacy'
        ? new LegacyDashboardActions(bot)
        : new NextDashboardActions(bot)
}
