#!/usr/bin/env node
/**
 * Microsoft Rewards Bot - Setup & Quick Launcher
 * 
 * SMART BEHAVIOR:
 * 
 * First-time setup (if dist/, accounts.jsonc, or node_modules missing):
 *  1. Creates accounts.jsonc from template
 *  2. Guides user through account configuration
 *  3. Installs dependencies (npm install)
 *  4. Builds TypeScript project (npm run build)
 *  5. Installs Playwright Chromium browser
 *  6. Offers to start the bot immediately
 * 
 * Already configured (all files present):
 *  → Detects complete setup
 *  → Offers to start bot directly (npm start)
 *  → User can choose: Start / Re-run setup / Exit
 * 
 * Usage:
 *   npm run setup          # Interactive setup/launcher
 *   node scripts/installer/setup.mjs
 */

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const SRC_DIR = path.join(PROJECT_ROOT, 'src')

function log(msg) { console.log(msg) }
function warn(msg) { console.warn(msg) }
function error(msg) { console.error(msg) }

function createAccountsFile() {
  const accounts = path.join(SRC_DIR, 'accounts.jsonc')
  const example = path.join(SRC_DIR, 'accounts.example.jsonc')

  if (fs.existsSync(accounts)) {
    log('✓ accounts.jsonc already exists - skipping creation')
    return true
  }

  if (fs.existsSync(example)) {
    log('📝 Creating accounts.jsonc from template...')
    fs.copyFileSync(example, accounts)
    log('✓ Created accounts.jsonc')
    return false
  } else {
    error('❌ Template file accounts.example.jsonc not found!')
    return true
  }
}

async function prompt(question) {
  return await new Promise(resolve => {
    process.stdout.write(question)
    const onData = (data) => {
      const ans = data.toString().trim()
      process.stdin.off('data', onData)
      resolve(ans)
    }
    process.stdin.on('data', onData)
  })
}

async function guideAccountConfiguration() {
  log('\n� ACCOUNT CONFIGURATION')
  log('════════════════════════════════════════════════════════════')
  log('1. Open file: src/accounts.jsonc')
  log('2. Add your Microsoft account credentials:')
  log('   - email: Your Microsoft account email')
  log('   - password: Your account password')
  log('   - totp: (Optional) 2FA secret for automatic authentication')
  log('3. Enable accounts by setting "enabled": true')
  log('4. Save the file')
  log('')
  log('📚 Full guide: docs/accounts.md')
  log('════════════════════════════════════════════════════════════\n')

  for (; ;) {
    const ans = (await prompt('Have you configured your accounts? (yes/no): ')).toLowerCase()
    if (['yes', 'y'].includes(ans)) break
    if (['no', 'n'].includes(ans)) {
      log('\n⏸️  Please configure src/accounts.jsonc and save it, then answer yes.\n')
      continue
    }
    log('Please answer yes or no.')
  }
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    log(`Running: ${cmd} ${args.join(' ')}`)
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
    child.on('exit', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

async function ensureNpmAvailable() {
  try {
    await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['-v'])
  } catch (e) {
    throw new Error('npm not found in PATH. Install Node.js first.')
  }
}

async function performSetup() {
  log('\n🚀 MICROSOFT REWARDS BOT - FIRST-TIME SETUP')
  log('════════════════════════════════════════════════════════════\n')

  // Step 1: Create accounts file
  const accountsExisted = createAccountsFile()

  // Step 2: Guide user through account configuration
  if (!accountsExisted) {
    await guideAccountConfiguration()
  } else {
    log('✓ Using existing accounts.jsonc\n')
  }

  // Step 3: Configuration guidance
  log('\n⚙️  CONFIGURATION (src/config.jsonc)')
  log('════════════════════════════════════════════════════════════')
  log('Key settings you may want to adjust:')
  log('  • browser.headless: false = visible browser, true = background')
  log('  • execution.clusters: Number of parallel accounts (default: 1)')
  log('  • workers: Enable/disable specific tasks')
  log('  • humanization.enabled: Add natural delays (recommended: true)')
  log('  • scheduling.enabled: Automate with OS scheduler')
  log('')
  log('📚 Full configuration guide: docs/getting-started.md')
  log('════════════════════════════════════════════════════════════\n')

  const reviewConfig = (await prompt('Review config.jsonc before continuing? (yes/no): ')).toLowerCase()
  if (['yes', 'y'].includes(reviewConfig)) {
    log('\n⏸️  Setup paused.')
    log('Please review and edit src/config.jsonc, then run: npm run setup\n')
    process.exit(0)
  }

  // Step 4: Install dependencies
  log('\n📦 Installing dependencies...')
  await ensureNpmAvailable()
  await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'])

  // Step 5: Build TypeScript
  log('\n🔨 Building TypeScript project...')
  await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])

  // Step 6: Install Playwright browsers
  await installPlaywrightBrowsers()

  // Final message
  log('\n')
  log('═══════════════════════════════════════════════════════════')
  log('✅ SETUP COMPLETE!')
  log('═══════════════════════════════════════════════════════════')
  log('')
  log('📁 Configuration files:')
  log('   • Accounts: src/accounts.jsonc')
  log('   • Config: src/config.jsonc')
  log('')
  log('📚 Documentation:')
  log('   • Getting started: docs/getting-started.md')
  log('   • Full docs: docs/index.md')
  log('')
  log('🚀 TO START THE BOT:')
  log('   npm start')
  log('')
  log('⏰ FOR AUTOMATED SCHEDULING:')
  log('   See: docs/getting-started.md (Scheduling section)')
  log('═══════════════════════════════════════════════════════════\n')
}

async function installPlaywrightBrowsers() {
  const PLAYWRIGHT_MARKER = path.join(PROJECT_ROOT, '.playwright-chromium-installed')
  // Idempotent: skip if marker exists
  if (fs.existsSync(PLAYWRIGHT_MARKER)) {
    log('Playwright chromium already installed (marker found).')
    return
  }
  log('Ensuring Playwright chromium browser is installed...')
  try {
    await runCommand(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'])
    fs.writeFileSync(PLAYWRIGHT_MARKER, new Date().toISOString())
    log('Playwright chromium install complete.')
  } catch (e) {
    warn('Failed to install Playwright chromium automatically. You can manually run: npx playwright install chromium')
  }
}

/**
 * Check if setup is complete
 * @returns {boolean} True if project is already set up
 */
function isSetupComplete() {
  const distExists = fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'index.js'))
  const accountsExists = fs.existsSync(path.join(SRC_DIR, 'accounts.jsonc'))
  const nodeModulesExists = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules'))

  return distExists && accountsExists && nodeModulesExists
}

/**
 * Launch the bot directly (for already-configured projects)
 */
async function launchBot() {
  log('\n🚀 MICROSOFT REWARDS BOT - QUICK START')
  log('════════════════════════════════════════════════════════════\n')
  log('✓ Project already configured')
  log('✓ Starting bot with npm start...\n')

  try {
    await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'])
  } catch (err) {
    error('\n❌ Failed to start bot: ' + err.message)
    log('\n💡 Try running manually: npm start\n')
    process.exit(1)
  }
}

async function main() {
  if (!fs.existsSync(SRC_DIR)) {
    error('❌ Cannot find src directory at ' + SRC_DIR)
    process.exit(1)
  }
  process.chdir(PROJECT_ROOT)

  // Check if project is already fully set up
  if (isSetupComplete()) {
    log('\n✅ Setup detected as complete!')
    log('   • Build: dist/index.js ✓')
    log('   • Accounts: src/accounts.jsonc ✓')
    log('   • Dependencies: node_modules ✓\n')

    const choice = (await prompt('What would you like to do?\n  [1] Start the bot (npm start)\n  [2] Re-run setup\n  [3] Exit\nChoice (1-3): ')).trim()

    if (choice === '1' || choice === '') {
      await launchBot()
      process.exit(0)
    } else if (choice === '2') {
      log('\n🔄 Re-running full setup...\n')
      // Continue to performSetup below
    } else {
      log('\n👋 Goodbye!\n')
      process.exit(0)
    }
  }

  // Perform full setup
  await performSetup()

  // After setup, ask if user wants to start
  log('\n🎯 Setup complete! Would you like to start the bot now?')
  const startNow = (await prompt('Start bot? (yes/no): ')).toLowerCase()

  if (['yes', 'y'].includes(startNow)) {
    log('\n🚀 Starting bot...\n')
    await launchBot()
  } else {
    log('\n💡 To start the bot later, run: npm start')
    log('💡 Or re-run this script: npm run setup\n')
  }

  // Pause if launched by double-click on Windows
  if (process.platform === 'win32' && process.stdin.isTTY) {
    log('Press Enter to close...')
    await prompt('')
  }

  process.exit(0)
}

// Allow clean Ctrl+C
process.on('SIGINT', () => { console.log('\nInterrupted.'); process.exit(1) })

main().catch(err => {
  error('\nSetup failed: ' + err.message)
  process.exit(1)
})
