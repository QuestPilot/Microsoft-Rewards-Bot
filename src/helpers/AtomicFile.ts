import fs from 'fs'
import path from 'path'

function tempPathFor(filePath: string): string {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    return path.join(dir, `.${base}.${suffix}.tmp`)
}

export async function writeFileAtomic(
    filePath: string,
    data: string | Buffer,
    encoding: BufferEncoding = 'utf8',
    mode = 0o600
): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    const tempPath = tempPathFor(filePath)
    const handle = await fs.promises.open(tempPath, 'w', mode)

    try {
        if (Buffer.isBuffer(data)) {
            await handle.writeFile(data)
        } else {
            await handle.writeFile(data, encoding)
        }
        await handle.sync()
    } finally {
        await handle.close()
    }

    try {
        await fs.promises.rename(tempPath, filePath)
    } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
        throw error
    }
}

export async function writeJsonAtomic(filePath: string, value: unknown, spaces = 2, mode = 0o600): Promise<void> {
    await writeFileAtomic(filePath, `${JSON.stringify(value, null, spaces)}\n`, 'utf8', mode)
}
