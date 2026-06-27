import { BrowserContext } from 'patchright'
import { dataPath } from './DataManager'
import { promises as fs } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { Account } from '../types/Account'

export class AvatarFetcher {
    private static getMetaPath(): string {
        return dataPath('avatars', 'meta.json')
    }

    public static getAvatarPath(email: string): string {
        const hash = createHash('sha256').update(email.toLowerCase()).digest('hex').substring(0, 16)
        return dataPath('avatars', `${hash}.jpg`)
    }

    private static async getAvatarMeta(): Promise<Record<string, number>> {
        try {
            return JSON.parse(await fs.readFile(this.getMetaPath(), 'utf8'))
        } catch {
            return {}
        }
    }

    private static async saveAvatarMeta(meta: Record<string, number>): Promise<void> {
        await fs.mkdir(dataPath('avatars'), { recursive: true })
        await fs.writeFile(this.getMetaPath(), JSON.stringify(meta, null, 2), 'utf8')
    }

    static async fetchAvatarIfNeeded(context: BrowserContext, account: Account): Promise<void> {
        const meta = await this.getAvatarMeta()
        const now = Date.now()
        const email = account.email.toLowerCase()
        const lastCheck = meta[email]

        // Only check once every 30 days
        if (lastCheck && now - lastCheck < 30 * 24 * 60 * 60 * 1000) {
            return
        }

        // Fire and forget in the background so we don't block the bot
        this.runFetchAvatar(context, email).catch(() => {}).finally(async () => {
            // Update the check timestamp whether we succeeded or failed
            const freshMeta = await this.getAvatarMeta()
            freshMeta[email] = Date.now()
            await this.saveAvatarMeta(freshMeta)
        })
    }

    private static async runFetchAvatar(context: BrowserContext, email: string): Promise<void> {
        const page = await context.newPage()
        try {
            await page.goto('https://account.microsoft.com/profile/', { waitUntil: 'domcontentloaded', timeout: 30000 })
            const imgLocator = page.locator('img.fui-Avatar__image')
            await imgLocator.waitFor({ state: 'attached', timeout: 15000 })
            const src = await imgLocator.getAttribute('src')
            if (!src || !src.startsWith('blob:')) return

            const base64Data = await page.evaluate(async (arg) => {
                try {
                    const res = await fetch(arg.url)
                    const blob = await res.blob()
                    return await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader()
                        reader.onloadend = () => {
                            const b64 = reader.result as string
                            resolve(b64.split(',')[1] || '')
                        }
                        reader.onerror = reject
                        reader.readAsDataURL(blob)
                    })
                } catch (e) {
                    return null
                }
            }, { url: src as string })

            if (base64Data) {
                const buffer = Buffer.from(base64Data, 'base64')
                const outPath = this.getAvatarPath(email)
                await fs.mkdir(path.dirname(outPath), { recursive: true })
                await fs.writeFile(outPath, buffer)
            }
        } finally {
            await page.close().catch(() => {})
        }
    }
}
