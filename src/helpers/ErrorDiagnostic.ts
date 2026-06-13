import fs from 'fs/promises'
import path from 'path'
import type { Page } from 'patchright'
import { writeFileAtomic } from './AtomicFile'
import { errorDir } from './DataManager'

export async function errorDiagnostic(page: Page, error: Error, logFn?: (msg: string) => void): Promise<void> {
    const log = logFn ?? ((msg: string) => console.log(msg))

    try {
        if (!page || page.isClosed()) {
            return
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const outputDir = errorDir(timestamp)

        const errorLog = `Name: ${error.name}
Message: ${error.message}
Timestamp: ${new Date().toISOString()}
---------------------------------------------------
Stack Trace:
${error.stack || 'No stack trace available'}`.trim()

        const [htmlContent, screenshotBuffer] = await Promise.all([
            page.content(),
            page.screenshot({ fullPage: true, type: 'png' })
        ])

        await fs.mkdir(outputDir, { recursive: true })

        await Promise.all([
            writeFileAtomic(path.join(outputDir, 'dump.html'), htmlContent),
            writeFileAtomic(path.join(outputDir, 'screenshot.png'), screenshotBuffer),
            writeFileAtomic(path.join(outputDir, 'error.txt'), errorLog)
        ])

        log(`Diagnostics saved to: ${outputDir}`)
    } catch (diagError) {
        log(`Unable to create error diagnostics: ${diagError instanceof Error ? diagError.message : String(diagError)}`)
    }
}
