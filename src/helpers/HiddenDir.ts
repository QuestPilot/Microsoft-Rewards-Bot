import { spawn } from 'child_process'

/**
 * Best-effort, purely cosmetic: mark a directory as OS-hidden so the bot's
 * internal state (data/, sessions/, .tools/) doesn't clutter Explorer/Finder for
 * its non-technical audience. Only Windows (attrib) and macOS (chflags) have a
 * hidden-attribute mechanism that works WITHOUT renaming the folder — renaming
 * (e.g. data -> .data) was deliberately ruled out because it would silently
 * orphan every existing user's saved sessions/stats on their next update. Linux
 * has no attribute-based hidden mechanism independent of the leading-dot naming
 * convention, so this is a no-op there — the folder stays visible, unchanged
 * from before. Never throws, never blocks: this must never affect the run.
 */
export function markDirHidden(dirPath: string): void {
    try {
        if (process.platform === 'win32') {
            spawn('attrib', ['+h', dirPath], { stdio: 'ignore', windowsHide: true }).unref()
        } else if (process.platform === 'darwin') {
            spawn('chflags', ['hidden', dirPath], { stdio: 'ignore' }).unref()
        }
    } catch {
        // Cosmetic only — never let this affect the bot's actual operation.
    }
}
