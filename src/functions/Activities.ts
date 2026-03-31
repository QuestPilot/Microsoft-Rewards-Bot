import { Page } from "rebrowser-playwright";

import { MicrosoftRewardsBot } from "../index";

import { ABC } from "./activities/ABC";
import { DailyCheckIn } from "./activities/DailyCheckIn";
import { Poll } from "./activities/Poll";
import { Quiz } from "./activities/Quiz";
import { ReadToEarn } from "./activities/ReadToEarn";
import { Search } from "./activities/Search";
import { SearchOnBing } from "./activities/SearchOnBing";
import { ThisOrThat } from "./activities/ThisOrThat";
import { UrlReward } from "./activities/UrlReward";

import {
    DashboardData,
    MorePromotion,
    PromotionalItem,
} from "../interface/DashboardData";

type ActivityKind =
  | { type: "poll" }
  | { type: "abc" }
  | { type: "thisOrThat" }
  | { type: "quiz" }
  | { type: "urlReward" }
  | { type: "searchOnBing" }
  | { type: "unsupported" };

export class Activities {
  private bot: MicrosoftRewardsBot;

  constructor(bot: MicrosoftRewardsBot) {
    this.bot = bot;
  }

  // Centralized dispatcher for activities from dashboard/punchcards
  /**
   * Execute a promotional activity (quiz, poll, search-on-bing, etc.)
   *
   * Automatically detects activity type and delegates to specialized handler:
   * - quiz → Quiz handler
   * - abc → ABC (drag-and-drop) handler
   * - thisorthat → This or That handler
   * - poll → Poll handler
   * - urlreward → URL reward handler
   *
   * @param page Playwright page for activity execution
   * @param activity Activity metadata from dashboard data
   * @returns Promise resolving when activity is complete
   * @throws {Error} If activity type is unsupported or execution fails
   *
   * @example
   * await activities.run(page, dailySetActivity)
   */
  async run(
    page: Page,
    activity: MorePromotion | PromotionalItem,
  ): Promise<void> {
    const kind = this.classifyActivity(activity);
    try {
      switch (kind.type) {
        case "poll":
          await this.doPoll(page);
          break;
        case "abc":
          await this.doABC(page);
          break;
        case "thisOrThat":
          await this.doThisOrThat(page);
          break;
        case "quiz":
          await this.doQuiz(page);
          break;
        case "searchOnBing":
          await this.doSearchOnBing(page, activity);
          break;
        case "urlReward":
          await this.doUrlReward(page);
          break;
        case "unsupported":
          this.bot.log(
            this.bot.isMobile,
            "ACTIVITY",
            `Skipped activity "${activity.title}" | Reason: Unsupported type: "${(activity as { promotionType?: string }).promotionType || "unknown"}"`,
            "warn",
          );
          break;
        default: {
          // Exhaustiveness check - TypeScript ensures all ActivityKind types are handled
          const _exhaustive: never = kind;
          this.bot.log(
            this.bot.isMobile,
            "ACTIVITY",
            `Unexpected activity kind for "${activity.title}"`,
            "error",
          );
          return _exhaustive;
        }
      }
    } catch (e) {
      this.bot.log(
        this.bot.isMobile,
        "ACTIVITY",
        `Dispatcher error for "${activity.title}": ${e instanceof Error ? e.message : e}`,
        "error",
      );
    }
  }

  public getTypeLabel(activity: MorePromotion | PromotionalItem): string {
    const k = this.classifyActivity(activity);
    switch (k.type) {
      case "poll":
        return "Poll";
      case "abc":
        return "ABC";
      case "thisOrThat":
        return "ThisOrThat";
      case "quiz":
        return "Quiz";
      case "searchOnBing":
        return "SearchOnBing";
      case "urlReward":
        return "UrlReward";
      default:
        return "Unsupported";
    }
  }

  private classifyActivity(
    activity: MorePromotion | PromotionalItem,
  ): ActivityKind {
    const type = (activity.promotionType || "").toLowerCase();
    if (type === "quiz") {
      // Distinguish Poll/ABC/ThisOrThat vs general quiz using current heuristics
      const max = activity.pointProgressMax;
      const url = (activity.destinationUrl || "").toLowerCase();
      if (max === 10) {
        if (url.includes("pollscenarioid")) return { type: "poll" };
        return { type: "abc" };
      }
      if (max === 50) return { type: "thisOrThat" };
      return { type: "quiz" };
    }
    if (type === "urlreward") {
      const name = (activity.name || "").toLowerCase();
      if (name.includes("exploreonbing")) return { type: "searchOnBing" };
      return { type: "urlReward" };
    }
    return { type: "unsupported" };
  }

  doSearch = async (page: Page, data: DashboardData): Promise<void> => {
    const search = new Search(this.bot);
    await search.doSearch(page, data);
  };

  doABC = async (page: Page): Promise<void> => {
    const abc = new ABC(this.bot);
    await abc.doABC(page);
  };

  doPoll = async (page: Page): Promise<void> => {
    const poll = new Poll(this.bot);
    await poll.doPoll(page);
  };

  doThisOrThat = async (page: Page): Promise<void> => {
    const thisOrThat = new ThisOrThat(this.bot);
    await thisOrThat.doThisOrThat(page);
  };

  doQuiz = async (page: Page): Promise<void> => {
    const quiz = new Quiz(this.bot);
    await quiz.doQuiz(page);
  };

  doUrlReward = async (page: Page): Promise<void> => {
    const urlReward = new UrlReward(this.bot);
    await urlReward.doUrlReward(page);
  };

  doSearchOnBing = async (
    page: Page,
    activity: MorePromotion | PromotionalItem,
  ): Promise<void> => {
    const searchOnBing = new SearchOnBing(this.bot);
    await searchOnBing.doSearchOnBing(page, activity);
  };

  doReadToEarn = async (
    accessToken: string,
    data: DashboardData,
  ): Promise<void> => {
    const readToEarn = new ReadToEarn(this.bot);
    await readToEarn.doReadToEarn(accessToken, data);
  };

  doDailyCheckIn = async (
    accessToken: string,
    data: DashboardData,
  ): Promise<void> => {
    const dailyCheckIn = new DailyCheckIn(this.bot);
    await dailyCheckIn.doDailyCheckIn(accessToken, data);
  };
}
