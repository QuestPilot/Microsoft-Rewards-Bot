import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import { getErrorMessage, promptInput } from './AuthUtils'

export class RecoveryStrategy {
    private readonly textInputSelector = '[data-testid="proof-confirmation"]'
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5

    constructor(private bot: MicrosoftRewardsBot) {}

    /** Mask a recovery email before logging (PII). e.g. jo***@example.com */
    private maskEmail(email: string): string {
        const at = email.indexOf('@')
        if (at < 0) return '***'
        const user = email.slice(0, at)
        const visible = Math.min(2, user.length)
        return `${user.slice(0, visible)}***${email.slice(at)}`
    }

    private async fillEmail(page: Page, email: string): Promise<boolean> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', `Attempting to fill email: ${this.maskEmail(email)}`)

            const visibleInput = await page
                .waitForSelector(this.textInputSelector, { state: 'visible', timeout: 500 })
                .catch(() => null)

            if (visibleInput) {
                for (const char of email) {
                    await page.keyboard.type(char, {
                        delay:
                            Math.random() < 0.15
                                ? Math.floor(Math.random() * 100) + 100
                                : Math.floor(Math.random() * 40) + 35
                    })
                }
                await page.keyboard.press('Enter')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Successfully filled email input field')
                return true
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `Email input field not found with selector: ${this.textInputSelector}`
            )
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `Failed to fill email input: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async handle(page: Page, recoveryEmail: string): Promise<void> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Email recovery authentication flow initiated')

            if (recoveryEmail) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Using provided recovery email: ${this.maskEmail(recoveryEmail)}`
                )

                const filled = await this.fillEmail(page, recoveryEmail)
                if (!filled) {
                    throw new Error('Email input field not found')
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Waiting for page response')
                await this.bot.utils.wait(500)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', 'Network idle timeout reached')
                })

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    throw new Error(`Email verification failed: ${errorMessage}`)
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Email authentication completed successfully')
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                'No recovery email provided, will prompt user for input'
            )

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Starting attempt ${attempt}/${this.maxManualAttempts}`
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Prompting user for email input (timeout: ${this.maxManualSeconds}s)`
                )

                const email = await promptInput({
                    question: `Recovery email (waiting ${this.maxManualSeconds}s): `,
                    timeoutSeconds: this.maxManualSeconds,
                    validate: email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
                })

                if (!email) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `No or invalid email input received (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: no input received')
                    }
                    continue
                }

                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Invalid email format received (attempt ${attempt}/${this.maxManualAttempts}) | length=${email.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: invalid format')
                    }
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', `Valid email received from user: ${this.maskEmail(email)}`)

                const filled = await this.fillEmail(page, email)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Failed to fill email input field (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Email input field not found after maximum attempts')
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Waiting for page response')
                await this.bot.utils.wait(500)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', 'Network idle timeout reached')
                })

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Error from page: "${errorMessage}" (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Maximum attempts reached. Last error: ${errorMessage}`)
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Clearing input field for retry')
                    const inputToClear = await page.$(this.textInputSelector).catch(() => null)
                    if (inputToClear) {
                        await inputToClear.click()
                        await page.keyboard.press('Control+A')
                        await page.keyboard.press('Backspace')
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Input field cleared')
                    } else {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN-RECOVERY', 'Could not find input field to clear')
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Email authentication completed successfully')
                return
            }

            throw new Error(`Email input failed after ${this.maxManualAttempts} attempts`)
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'LOGIN-RECOVERY', `Fatal error: ${errorMsg}`)
            throw error
        }
    }
}
