import { Page } from "rebrowser-playwright";

import { TIMEOUTS } from "../../constants";
import { getErrorMessage } from "../../util/core/Utils";
import { Workers } from "../Workers";

export class UrlReward extends Workers {
  async doUrlReward(page: Page) {
    this.bot.log(
      this.bot.isMobile,
      "URL-REWARD",
      "Trying to complete UrlReward",
    );

    try {
      await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);

      await page.close();

      this.bot.log(
        this.bot.isMobile,
        "URL-REWARD",
        "Completed the UrlReward successfully",
      );
    } catch (error) {
      await page.close().catch(() => {
        /* Page may already be closed */
      });
      this.bot.log(
        this.bot.isMobile,
        "URL-REWARD",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }
}
