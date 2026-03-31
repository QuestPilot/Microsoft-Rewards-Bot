import { Page } from "rebrowser-playwright";

import { DELAYS } from "../../constants";
import { waitForElementSmart } from "../../util/browser/SmartWait";
import { getErrorMessage } from "../../util/core/Utils";
import { Workers } from "../Workers";

export class ThisOrThat extends Workers {
  async doThisOrThat(page: Page) {
    this.bot.log(
      this.bot.isMobile,
      "THIS-OR-THAT",
      "Trying to complete ThisOrThat",
    );

    try {
      // IMPROVED: Smart wait replaces fixed 2s timeout with adaptive detection
      const startQuizResult = await waitForElementSmart(page, "#rqStartQuiz", {
        initialTimeoutMs: 1000,
        extendedTimeoutMs: DELAYS.THIS_OR_THAT_START,
        state: "visible",
        logFn: (msg) => this.bot.log(this.bot.isMobile, "THIS-OR-THAT", msg),
      });

      if (startQuizResult.found) {
        await page.click("#rqStartQuiz");
      } else {
        this.bot.log(
          this.bot.isMobile,
          "THIS-OR-THAT",
          "ThisOrThat has already been started, trying to finish it",
        );
      }

      await this.bot.utils.wait(DELAYS.THIS_OR_THAT_START);

      // Solving
      const quizData = await this.bot.browser.func.getQuizData(page);
      const questionsRemaining =
        quizData.maxQuestions - (quizData.currentQuestionNumber - 1); // Amount of questions remaining

      for (let question = 0; question < questionsRemaining; question++) {
        // Since there's no solving logic yet, randomly guess to complete
        const buttonId = `#rqAnswerOption${Math.floor(this.bot.utils.randomNumber(0, 1))}`;
        await page.click(buttonId);

        const refreshSuccess =
          await this.bot.browser.func.waitForQuizRefresh(page);
        if (!refreshSuccess) {
          await page.close();
          this.bot.log(
            this.bot.isMobile,
            "QUIZ",
            "An error occurred, refresh was unsuccessful",
            "error",
          );
          return;
        }
      }

      this.bot.log(
        this.bot.isMobile,
        "THIS-OR-THAT",
        "Completed the ThisOrThat successfully",
      );
    } catch (error) {
      await page.close().catch(() => {
        /* Page may already be closed */
      });
      this.bot.log(
        this.bot.isMobile,
        "THIS-OR-THAT",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }
}
