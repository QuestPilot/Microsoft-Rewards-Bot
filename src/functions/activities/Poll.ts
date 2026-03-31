import { Page } from "rebrowser-playwright";

import { TIMEOUTS } from "../../constants";
import { waitForElementSmart } from "../../util/browser/SmartWait";
import { getErrorMessage } from "../../util/core/Utils";
import { Workers } from "../Workers";

export class Poll extends Workers {
  async doPoll(page: Page) {
    this.bot.log(this.bot.isMobile, "POLL", "Trying to complete poll");

    try {
      const buttonId = `#btoption${Math.floor(this.bot.utils.randomNumber(0, 1))}`;

      // IMPROVED: Smart wait replaces fixed 10s timeout with adaptive 2s+5s detection
      const buttonResult = await waitForElementSmart(page, buttonId, {
        initialTimeoutMs: 2000,
        extendedTimeoutMs: TIMEOUTS.SMART_WAIT_EXTENDED,
        state: "visible",
        logFn: (msg) => this.bot.log(this.bot.isMobile, "POLL", msg),
      });

      if (!buttonResult.found) {
        this.bot.log(
          this.bot.isMobile,
          "POLL",
          `Could not find poll button: ${buttonId}`,
          "warn",
        );
        await page.close();
        return;
      }

      await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);
      await page.click(buttonId);

      await this.bot.utils.wait(TIMEOUTS.ACTIVITY_PAGE_LOAD);
      await page.close();

      this.bot.log(
        this.bot.isMobile,
        "POLL",
        "Completed the poll successfully",
      );
    } catch (error) {
      await page.close().catch(() => {
        /* Page may already be closed */
      });
      this.bot.log(
        this.bot.isMobile,
        "POLL",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }
}
