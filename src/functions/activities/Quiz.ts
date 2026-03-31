import { Page } from "rebrowser-playwright";

import { DELAYS, RETRY_LIMITS, TIMEOUTS } from "../../constants";
import { waitForElementSmart } from "../../util/browser/SmartWait";
import { getErrorMessage } from "../../util/core/Utils";
import { Workers } from "../Workers";

export class Quiz extends Workers {
  async doQuiz(page: Page) {
    this.bot.log(this.bot.isMobile, "QUIZ", "Trying to complete quiz");

    try {
      // IMPROVED: Smart wait replaces fixed 2s timeout with adaptive detection
      const startQuizResult = await waitForElementSmart(page, "#rqStartQuiz", {
        initialTimeoutMs: 1000,
        extendedTimeoutMs: TIMEOUTS.MEDIUM_LONG,
        state: "visible",
        logFn: (msg) => this.bot.log(this.bot.isMobile, "QUIZ", msg),
      });

      if (startQuizResult.found) {
        await page.click("#rqStartQuiz");
      } else {
        this.bot.log(
          this.bot.isMobile,
          "QUIZ",
          "Quiz has already been started, trying to finish it",
        );
      }

      await this.bot.utils.wait(TIMEOUTS.MEDIUM_LONG);

      let quizData = await this.bot.browser.func.getQuizData(page);

      // IMPROVED: Smart wait replaces fixed 5s timeout with adaptive detection
      const firstOptionResult = await waitForElementSmart(
        page,
        "#rqAnswerOption0",
        {
          initialTimeoutMs: 2000,
          extendedTimeoutMs: TIMEOUTS.VERY_LONG,
          state: "attached",
          logFn: (msg) => this.bot.log(this.bot.isMobile, "QUIZ", msg),
        },
      );

      if (!firstOptionResult.found) {
        this.bot.log(
          this.bot.isMobile,
          "QUIZ",
          "Quiz options not found - page may not have loaded correctly. Skipping.",
          "warn",
        );
        await page.close();
        return;
      }
      const questionsRemaining =
        quizData.maxQuestions - quizData.CorrectlyAnsweredQuestionCount; // Amount of questions remaining

      // All questions
      for (let question = 0; question < questionsRemaining; question++) {
        if (quizData.numberOfOptions === 8) {
          const answers: string[] = [];

          for (let i = 0; i < quizData.numberOfOptions; i++) {
            // IMPROVED: Smart wait replaces fixed 10s timeout with adaptive 2s+5s detection
            const optionResult = await waitForElementSmart(
              page,
              `#rqAnswerOption${i}`,
              {
                initialTimeoutMs: 2000,
                extendedTimeoutMs: TIMEOUTS.SMART_WAIT_EXTENDED,
                state: "visible",
              },
            );

            if (!optionResult.found || !optionResult.element) {
              this.bot.log(
                this.bot.isMobile,
                "QUIZ",
                `Option ${i} not found - quiz structure may have changed. Skipping remaining options.`,
                "warn",
              );
              break;
            }

            const answerSelector = optionResult.element;

            const answerAttribute = await answerSelector?.evaluate(
              (el: Element) => el.getAttribute("iscorrectoption"),
            );

            if (answerAttribute && answerAttribute.toLowerCase() === "true") {
              answers.push(`#rqAnswerOption${i}`);
            }
          }

          // If no correct answers found, skip this question
          if (answers.length === 0) {
            this.bot.log(
              this.bot.isMobile,
              "QUIZ",
              "No correct answers found for 8-option quiz. Skipping.",
              "warn",
            );
            await page.close();
            return;
          }

          // Click the answers
          for (const answer of answers) {
            // IMPROVED: Smart wait replaces fixed 2s timeout with adaptive detection
            const answerResult = await waitForElementSmart(page, answer, {
              initialTimeoutMs: 1000,
              extendedTimeoutMs: DELAYS.QUIZ_ANSWER_WAIT,
              state: "visible",
            });

            if (!answerResult.found) {
              this.bot.log(
                this.bot.isMobile,
                "QUIZ",
                `Answer element ${answer} not found`,
                "warn",
              );
              continue;
            }

            // Click the answer on page
            await page.click(answer);

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

          // Other type quiz, lightspeed
        } else if ([2, 3, 4].includes(quizData.numberOfOptions)) {
          quizData = await this.bot.browser.func.getQuizData(page); // Refresh Quiz Data
          const correctOption = quizData.correctAnswer;

          let answerClicked = false;

          for (let i = 0; i < quizData.numberOfOptions; i++) {
            // IMPROVED: Smart wait replaces fixed 10s timeout with adaptive detection
            const optionResult = await waitForElementSmart(
              page,
              `#rqAnswerOption${i}`,
              {
                initialTimeoutMs: 2000,
                extendedTimeoutMs: RETRY_LIMITS.QUIZ_ANSWER_TIMEOUT - 2000,
                state: "visible",
              },
            );

            if (!optionResult.found || !optionResult.element) {
              this.bot.log(
                this.bot.isMobile,
                "QUIZ",
                `Option ${i} not found for ${quizData.numberOfOptions}-option quiz. Skipping.`,
                "warn",
              );
              continue;
            }

            const answerSelector = optionResult.element;
            const dataOption = await answerSelector?.evaluate((el: Element) =>
              el.getAttribute("data-option"),
            );

            if (dataOption === correctOption) {
              // Click the answer on page
              await page.click(`#rqAnswerOption${i}`);
              answerClicked = true;

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
              break;
            }
          }

          if (!answerClicked) {
            this.bot.log(
              this.bot.isMobile,
              "QUIZ",
              `Could not find correct answer for ${quizData.numberOfOptions}-option quiz. Skipping.`,
              "warn",
            );
            await page.close();
            return;
          }

          await this.bot.utils.wait(DELAYS.QUIZ_ANSWER_WAIT);
        }
      }

      // Done with
      await this.bot.utils.wait(DELAYS.QUIZ_ANSWER_WAIT);
      await page.close();

      this.bot.log(
        this.bot.isMobile,
        "QUIZ",
        "Completed the quiz successfully",
      );
    } catch (error) {
      await page.close().catch(() => {
        /* Page may already be closed */
      });
      this.bot.log(
        this.bot.isMobile,
        "QUIZ",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }
}
