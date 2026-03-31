import { Page } from "rebrowser-playwright";

import { RETRY_LIMITS, TIMEOUTS } from "../../constants";
import { waitForElementSmart } from "../../util/browser/SmartWait";
import { getErrorMessage } from "../../util/core/Utils";
import { Workers } from "../Workers";

export class ABC extends Workers {
  async doABC(page: Page) {
    this.bot.log(this.bot.isMobile, "ABC", "Trying to complete poll");

    try {
      let $ = await this.bot.browser.func.loadInCheerio(page);

      let i;
      for (i = 0; i < RETRY_LIMITS.ABC_MAX && !$("span.rw_icon").length; i++) {
        // IMPROVED: Smart wait replaces fixed 10s timeout with adaptive 2s+5s detection
        const optionsResult = await waitForElementSmart(
          page,
          ".wk_OptionClickClass",
          {
            initialTimeoutMs: 2000,
            extendedTimeoutMs: TIMEOUTS.SMART_WAIT_EXTENDED,
            state: "visible",
            logFn: (msg) => this.bot.log(this.bot.isMobile, "ABC", msg),
          },
        );

        if (!optionsResult.found) {
          this.bot.log(this.bot.isMobile, "ABC", "Options not found", "warn");
          break;
        }

        const answers = $(".wk_OptionClickClass");
        const answer =
          answers[this.bot.utils.randomNumber(0, 2)]?.attribs["id"];

        // IMPROVED: Smart wait for specific answer
        const answerResult = await waitForElementSmart(page, `#${answer}`, {
          initialTimeoutMs: 1000,
          extendedTimeoutMs: TIMEOUTS.DASHBOARD_WAIT - 1000,
          state: "visible",
        });

        if (!answerResult.found) {
          this.bot.log(
            this.bot.isMobile,
            "ABC",
            `Answer ${answer} not found`,
            "warn",
          );
          break;
        }

        await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);
        await page.click(`#${answer}`); // Click answer

        await this.bot.utils.wait(TIMEOUTS.ACTIVITY_PAGE_LOAD);

        // IMPROVED: Smart wait for next button
        const buttonResult = await waitForElementSmart(page, "div.wk_button", {
          initialTimeoutMs: 2000,
          extendedTimeoutMs: TIMEOUTS.SMART_WAIT_EXTENDED,
          state: "visible",
        });

        if (!buttonResult.found) {
          this.bot.log(
            this.bot.isMobile,
            "ABC",
            "Next button not found",
            "warn",
          );
          break;
        }

        await page.click("div.wk_button"); // Click next question button

        page = await this.bot.browser.utils.getLatestTab(page);
        $ = await this.bot.browser.func.loadInCheerio(page);
        await this.bot.utils.wait(TIMEOUTS.MEDIUM);
      }

      await this.bot.utils.wait(TIMEOUTS.ACTIVITY_PAGE_LOAD);
      await page.close();

      if (i === RETRY_LIMITS.ABC_MAX) {
        this.bot.log(
          this.bot.isMobile,
          "ABC",
          `Failed to solve quiz, exceeded max iterations of ${RETRY_LIMITS.ABC_MAX}`,
          "warn",
        );
      } else {
        this.bot.log(
          this.bot.isMobile,
          "ABC",
          "Completed the ABC successfully",
        );
      }
    } catch (error) {
      await page.close().catch(() => {
        /* Page may already be closed */
      });
      this.bot.log(
        this.bot.isMobile,
        "ABC",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }
}
