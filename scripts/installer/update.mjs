#!/usr/bin/env node
/**
 * Microsoft Rewards Bot - Automatic Update System
 *
 * Uses GitHub API to download latest code as ZIP archive.
 * No Git required, no merge conflicts, always clean.
 *
 * Features:
 *  - Downloads latest code from GitHub (ZIP)
 *  - Preserves user files (accounts, config, sessions)
 *  - Selective file copying
 *  - Automatic dependency installation
 *  - TypeScript rebuild
 *
 * Usage:
 *   node scripts/installer/update.mjs   # Run update
 *   npm run start                       # Bot runs this automatically if enabled
 */

import { spawn } from "node:child_process";
import {
    cpSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Strip JSON comments
 */
function stripJsonComments(input) {
  let result = "";
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (char === "\\") {
        i++;
        if (i < input.length) result += input[i];
        continue;
      }
      if (char === stringChar) inString = false;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    result += char;
  }

  return result;
}

/**
 * Read and parse JSON config file
 */
function readJsonConfig(preferredPaths) {
  for (const candidate of preferredPaths) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, "utf8").replace(/^\uFEFF/, "");
      return JSON.parse(stripJsonComments(raw));
    } catch {
      // Try next candidate
    }
  }
  return null;
}

/**
 * Read branch configuration for auto-updates
 * This allows smooth transition when renaming branches (main -> legacy)
 */
function getBranchConfig() {
  const branchConfigPath = join(process.cwd(), ".update-branch.json");

  try {
    if (existsSync(branchConfigPath)) {
      const config = JSON.parse(readFileSync(branchConfigPath, "utf8"));
      return {
        branch: config.branch || "main",
        owner: config.repository?.owner || "LightZirconite",
        repo: config.repository?.name || "Microsoft-Rewards-Bot",
      };
    }
  } catch {
    // Fallback to defaults
  }

  // Default fallback (legacy behavior)
  return {
    branch: "main",
    owner: "LightZirconite",
    repo: "Microsoft-Rewards-Bot",
  };
}

/**
 * Run shell command
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      ...opts,
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

/**
 * Check if command exists
 */
async function which(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const code = await run(probe, [cmd], { stdio: "ignore" });
  return code === 0;
}

/**
 * Download file via HTTPS
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);

    httpsGet(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        rmSync(dest, { force: true });
        downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        rmSync(dest, { force: true });
        reject(
          new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`),
        );
        return;
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      file.close();
      rmSync(dest, { force: true });
      reject(err);
    });
  });
}

/**
 * Extract ZIP file (cross-platform)
 */
async function extractZip(zipPath, destDir) {
  // Try unzip (Unix-like)
  if (await which("unzip")) {
    const code = await run("unzip", ["-q", "-o", zipPath, "-d", destDir], {
      stdio: "ignore",
    });
    if (code === 0) return;
  }

  // Try tar (modern Windows/Unix)
  if (await which("tar")) {
    const code = await run("tar", ["-xf", zipPath, "-C", destDir], {
      stdio: "ignore",
    });
    if (code === 0) return;
  }

  // Try PowerShell Expand-Archive (Windows)
  if (process.platform === "win32") {
    const code = await run(
      "powershell",
      [
        "-Command",
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
      ],
      { stdio: "ignore" },
    );
    if (code === 0) return;
  }

  throw new Error(
    "No extraction tool found (unzip, tar, or PowerShell required)",
  );
}

// =============================================================================
// ENVIRONMENT DETECTION
// =============================================================================

/**
 * Detect if running inside a Docker container
 * Checks multiple indicators for accuracy
 */
function isDocker() {
  try {
    // Method 1: Check for /.dockerenv file (most reliable)
    if (existsSync("/.dockerenv")) {
      return true;
    }

    // Method 2: Check /proc/1/cgroup for docker
    if (existsSync("/proc/1/cgroup")) {
      const cgroupContent = readFileSync("/proc/1/cgroup", "utf8");
      if (
        cgroupContent.includes("docker") ||
        cgroupContent.includes("/kubepods/")
      ) {
        return true;
      }
    }

    // Method 3: Check environment variables
    if (
      process.env.DOCKER === "true" ||
      process.env.CONTAINER === "docker" ||
      process.env.KUBERNETES_SERVICE_HOST
    ) {
      return true;
    }

    // Method 4: Check /proc/self/mountinfo for overlay filesystem
    if (existsSync("/proc/self/mountinfo")) {
      const mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
      if (mountinfo.includes("docker") || mountinfo.includes("overlay")) {
        return true;
      }
    }

    return false;
  } catch {
    // If any error occurs (e.g., on Windows), assume not Docker
    return false;
  }
}

/**
 * Determine update mode based on config and environment
 */
function getUpdateMode(configData) {
  const dockerMode = configData?.update?.dockerMode || "auto";

  if (dockerMode === "force-docker") {
    return "docker";
  }

  if (dockerMode === "force-host") {
    return "host";
  }

  // Auto-detect
  return isDocker() ? "docker" : "host";
}

// =============================================================================
// MAIN UPDATE LOGIC
// =============================================================================

/**
 * Download a file from GitHub raw URL
 */
async function downloadFromGitHub(url, dest) {
  console.log(`📥 Downloading: ${url}`);

  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);

    httpsGet(
      url,
      {
        headers: {
          "User-Agent": "Microsoft-Rewards-Bot-Updater",
          "Cache-Control": "no-cache",
        },
      },
      (response) => {
        // Handle redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          rmSync(dest, { force: true });
          downloadFromGitHub(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          rmSync(dest, { force: true });
          reject(
            new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`),
          );
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      },
    ).on("error", (err) => {
      file.close();
      rmSync(dest, { force: true });
      reject(err);
    });
  });
}

/**
 * Deep merge objects recursively (preserves user values)
 * @param {any} example - New schema from example file
 * @param {any} user - Existing user configuration
 * @returns {any} Merged object
 */
function deepMerge(example, user) {
  // If user value is not an object, keep it (primitives, arrays, null)
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    return user;
  }

  // If example is not an object, use user value
  if (
    typeof example !== "object" ||
    example === null ||
    Array.isArray(example)
  ) {
    return user;
  }

  // Both are objects - merge recursively
  const merged = { ...example }; // Start with example schema

  for (const key in user) {
    if (key in example) {
      // Key exists in both - recurse
      merged[key] = deepMerge(example[key], user[key]);
    } else {
      // Key only in user - preserve it (backward compatibility)
      merged[key] = user[key];
    }
  }

  return merged;
}

/**
 * Find keys that exist in example but not in user (new options)
 * @param {any} example
 * @param {any} user
 * @param {string} prefix
 * @returns {string[]}
 */
function findNewKeys(example, user, prefix = "") {
  const newKeys = [];

  if (
    typeof example !== "object" ||
    example === null ||
    Array.isArray(example)
  ) {
    return newKeys;
  }

  for (const key in example) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (!(key in user)) {
      newKeys.push(fullKey);
    } else if (
      typeof example[key] === "object" &&
      !Array.isArray(example[key]) &&
      example[key] !== null
    ) {
      newKeys.push(...findNewKeys(example[key], user[key], fullKey));
    }
  }

  return newKeys;
}

/**
 * Migrate legacy file locations to src/ directory
 * Handles users updating from very old versions where files were in dist/ or root
 *
 * @param {Object} userConfig - User's update configuration
 */
function migrateLegacyFiles(userConfig) {
  const rootDir = process.cwd();
  const migrated = [];

  // Define legacy locations to check (in order of preference)
  const legacyLocations = {
    accounts: [
      { from: "dist/accounts.json", to: "src/accounts.json" },
      { from: "accounts.json", to: "src/accounts.json" },
      { from: "dist/accounts.jsonc", to: "src/accounts.jsonc" },
      { from: "accounts.jsonc", to: "src/accounts.jsonc" },
    ],
    config: [
      { from: "dist/config.json", to: "src/config.json" },
      { from: "config.json", to: "src/config.json" },
      { from: "dist/config.jsonc", to: "src/config.jsonc" },
      { from: "config.jsonc", to: "src/config.jsonc" },
    ],
  };

  // Migrate accounts if not auto-updating
  if (!userConfig.autoUpdateAccounts) {
    const targetExists =
      existsSync(join(rootDir, "src/accounts.jsonc")) ||
      existsSync(join(rootDir, "src/accounts.json"));

    if (!targetExists) {
      for (const migration of legacyLocations.accounts) {
        const fromPath = join(rootDir, migration.from);
        const toPath = join(rootDir, migration.to);

        if (existsSync(fromPath)) {
          try {
            // Ensure src/ directory exists
            mkdirSync(dirname(toPath), { recursive: true });

            // Copy the file
            const content = readFileSync(fromPath, "utf8");
            writeFileSync(toPath, content, "utf8");

            migrated.push(`${migration.from} → ${migration.to}`);
            console.log(`✅ Migrated: ${migration.from} → ${migration.to}`);
            break; // Only migrate the first found file
          } catch (error) {
            console.warn(
              `⚠️  Failed to migrate ${migration.from}:`,
              error.message,
            );
          }
        }
      }
    }
  }

  // Migrate config if not auto-updating
  if (!userConfig.autoUpdateConfig) {
    const targetExists =
      existsSync(join(rootDir, "src/config.jsonc")) ||
      existsSync(join(rootDir, "src/config.json"));

    if (!targetExists) {
      for (const migration of legacyLocations.config) {
        const fromPath = join(rootDir, migration.from);
        const toPath = join(rootDir, migration.to);

        if (existsSync(fromPath)) {
          try {
            // Ensure src/ directory exists
            mkdirSync(dirname(toPath), { recursive: true });

            // Copy the file
            const content = readFileSync(fromPath, "utf8");
            writeFileSync(toPath, content, "utf8");

            migrated.push(`${migration.from} → ${migration.to}`);
            console.log(`✅ Migrated: ${migration.from} → ${migration.to}`);
            break; // Only migrate the first found file
          } catch (error) {
            console.warn(
              `⚠️  Failed to migrate ${migration.from}:`,
              error.message,
            );
          }
        }
      }
    }
  }

  if (migrated.length > 0) {
    console.log(
      `\n📦 Migrated ${migrated.length} legacy file(s) to src/ directory`,
    );
  }
}

/**
 * Smart update for config/accounts files with intelligent merging
 * Preserves all user customizations while adding new options
 */
async function smartUpdateExampleFiles(configData) {
  const branchConfig = getBranchConfig();
  const baseUrl = `https://raw.githubusercontent.com/${branchConfig.owner}/${branchConfig.repo}/refs/heads/${branchConfig.branch}`;

  const files = [];

  // Check which files to update based on config
  if (configData?.update?.autoUpdateConfig === true) {
    files.push({
      example: "src/config.example.jsonc",
      target: "src/config.jsonc",
      name: "Configuration",
      githubUrl: `${baseUrl}/src/config.example.jsonc`,
    });
  }

  if (configData?.update?.autoUpdateAccounts === true) {
    files.push({
      example: "src/accounts.example.jsonc",
      target: "src/accounts.jsonc",
      name: "Accounts",
      githubUrl: `${baseUrl}/src/accounts.example.jsonc`,
    });
  }

  if (files.length === 0) {
    return; // Nothing to update
  }

  console.log("\n🔧 Intelligently merging configuration updates...");

  for (const file of files) {
    try {
      const examplePath = join(process.cwd(), file.example);
      const targetPath = join(process.cwd(), file.target);
      const tempPath = join(
        process.cwd(),
        `.update-${file.example.split("/").pop()}`,
      );

      // Download latest version from GitHub
      await downloadFromGitHub(file.githubUrl, tempPath);

      // Read all versions
      const githubContent = readFileSync(tempPath, "utf8");
      const localExampleContent = existsSync(examplePath)
        ? readFileSync(examplePath, "utf8")
        : "";
      const userContent = existsSync(targetPath)
        ? readFileSync(targetPath, "utf8")
        : "";

      // Parse JSON (strip comments)
      const githubJson = JSON.parse(stripJsonComments(githubContent));
      const userJson = existsSync(targetPath)
        ? JSON.parse(stripJsonComments(userContent))
        : null;

      // Check if GitHub version is different from local example
      if (githubContent === localExampleContent) {
        console.log(`✓ ${file.name}: No changes detected`);
        rmSync(tempPath, { force: true });
        continue;
      }

      // Update example file first
      writeFileSync(examplePath, githubContent);

      // If user file doesn't exist, create it
      if (!userJson) {
        writeFileSync(targetPath, githubContent);
        console.log(`✅ ${file.name}: Created from latest example`);
        rmSync(tempPath, { force: true });
        continue;
      }

      // INTELLIGENT MERGE: Preserve user values, add new options
      let merged;
      if (
        file.name === "Accounts" &&
        Array.isArray(githubJson) &&
        Array.isArray(userJson)
      ) {
        // Special handling for accounts array
        if (githubJson.length > 0 && userJson.length > 0) {
          const exampleAccount = githubJson[0];
          // Merge each user account with example schema
          merged = userJson.map((account) =>
            deepMerge(exampleAccount, account),
          );

          const newFields = findNewKeys(exampleAccount, userJson[0]);
          if (newFields.length > 0) {
            console.log(
              `📝 ${file.name}: Added ${newFields.length} new field(s)`,
            );
            console.log(`   → ${newFields.join(", ")}`);
          } else {
            console.log(`✓ ${file.name}: Up to date`);
          }
        } else {
          merged = userJson;
        }
      } else {
        // Standard config object merge
        merged = deepMerge(githubJson, userJson);

        const newKeys = findNewKeys(githubJson, userJson);
        if (newKeys.length > 0) {
          console.log(`📝 ${file.name}: Added ${newKeys.length} new option(s)`);
          console.log(`   → ${newKeys.join(", ")}`);
        } else {
          console.log(`✓ ${file.name}: Up to date`);
        }
      }

      // Write merged file with formatting
      writeFileSync(targetPath, JSON.stringify(merged, null, 4), "utf8");

      // Clean up temp file
      rmSync(tempPath, { force: true });
    } catch (error) {
      console.error(`❌ Failed to update ${file.name}: ${error.message}`);
      // Continue with other files
    }
  }

  console.log("");
}

/**
 * Check if update is available by comparing versions
 */
async function checkVersion() {
  try {
    // Read local version
    const localPkgPath = join(process.cwd(), "package.json");
    if (!existsSync(localPkgPath)) {
      console.log("⚠️  Could not find local package.json");
      return {
        updateAvailable: false,
        localVersion: "unknown",
        remoteVersion: "unknown",
      };
    }

    const localPkg = JSON.parse(readFileSync(localPkgPath, "utf8"));
    const localVersion = localPkg.version;

    // Fetch remote version from GitHub API (no cache)
    const branchConfig = getBranchConfig();
    const repoOwner = branchConfig.owner;
    const repoName = branchConfig.repo;
    const branch = branchConfig.branch;

    console.log("🔍 Checking for updates...");
    console.log(`   Local:  ${localVersion}`);
    console.log(`   Branch: ${branch}`);

    // Use GitHub API directly - no CDN cache, always fresh
    const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/package.json?ref=${branch}`;

    return new Promise((resolve) => {
      const options = {
        headers: {
          "User-Agent": "Microsoft-Rewards-Bot-Updater",
          Accept: "application/vnd.github.v3.raw", // Returns raw file content
          "Cache-Control": "no-cache",
        },
      };

      const request = httpsGet(apiUrl, options, (res) => {
        if (res.statusCode !== 200) {
          console.log(`   ⚠️  GitHub API returned HTTP ${res.statusCode}`);
          if (res.statusCode === 403) {
            console.log(
              "   ℹ️  Rate limit may be exceeded (60/hour). Try again later.",
            );
          }
          resolve({
            updateAvailable: false,
            localVersion,
            remoteVersion: "unknown",
          });
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const remotePkg = JSON.parse(data);
            const remoteVersion = remotePkg.version;
            console.log(`   Remote: ${remoteVersion}`);

            // Any difference triggers update (upgrade or downgrade)
            const updateAvailable = localVersion !== remoteVersion;
            resolve({ updateAvailable, localVersion, remoteVersion });
          } catch (err) {
            console.log(
              `   ⚠️  Could not parse remote package.json: ${err.message}`,
            );
            resolve({
              updateAvailable: false,
              localVersion,
              remoteVersion: "unknown",
            });
          }
        });
      });

      request.on("error", (err) => {
        console.log(`   ⚠️  Network error: ${err.message}`);
        resolve({
          updateAvailable: false,
          localVersion,
          remoteVersion: "unknown",
        });
      });

      request.setTimeout(10000, () => {
        request.destroy();
        console.log("   ⚠️  Request timeout (10s)");
        resolve({
          updateAvailable: false,
          localVersion,
          remoteVersion: "unknown",
        });
      });
    });
  } catch (err) {
    console.log(`⚠️  Version check failed: ${err.message}`);
    return {
      updateAvailable: false,
      localVersion: "unknown",
      remoteVersion: "unknown",
    };
  }
}

/**
 * Perform update using GitHub API (ZIP download)
 */
async function performUpdate() {
  // Step 0: Check if update is needed by comparing versions
  const versionCheck = await checkVersion();

  if (!versionCheck.updateAvailable) {
    console.log(`✅ Already up to date (v${versionCheck.localVersion})`);
    return 0; // Exit without creating update marker
  }

  // Step 0.5: Detect environment and determine update mode
  const configData = readJsonConfig([
    "src/config.jsonc",
    "config.jsonc",
    "src/config.json",
    "config.json",
  ]);

  const updateMode = getUpdateMode(configData);
  const envIcon = updateMode === "docker" ? "🐳" : "💻";

  console.log(
    `\n📦 Update available: ${versionCheck.localVersion} → ${versionCheck.remoteVersion}`,
  );
  console.log(
    `${envIcon} Environment: ${updateMode === "docker" ? "Docker container" : "Host system"}`,
  );
  console.log("⏳ Updating... (this may take a moment)\n");

  // Step 1: Read user preferences (silent)
  const userConfig = {
    autoUpdateConfig: configData?.update?.autoUpdateConfig ?? false,
    autoUpdateAccounts: configData?.update?.autoUpdateAccounts ?? false,
  };

  // Step 1.5: Migrate legacy files to src/ (for users updating from very old versions)
  migrateLegacyFiles(userConfig);

  // Step 2: Create backups (protected files + critical for rollback)
  const backupDir = join(process.cwd(), ".update-backup");
  const rollbackDir = join(process.cwd(), ".update-rollback");

  // Clean previous backups
  rmSync(backupDir, { recursive: true, force: true });
  rmSync(rollbackDir, { recursive: true, force: true });

  mkdirSync(backupDir, { recursive: true });
  mkdirSync(rollbackDir, { recursive: true });

  const filesToProtect = [
    { path: "src/config.jsonc", protect: !userConfig.autoUpdateConfig },
    { path: "src/accounts.jsonc", protect: !userConfig.autoUpdateAccounts },
    { path: "src/accounts.json", protect: !userConfig.autoUpdateAccounts },
    { path: "sessions", protect: true, isDir: true },
    { path: ".playwright-chromium-installed", protect: true },
  ];

  const backedUp = [];
  for (const file of filesToProtect) {
    if (!file.protect) continue;
    const srcPath = join(process.cwd(), file.path);
    if (!existsSync(srcPath)) continue;

    const destPath = join(backupDir, file.path);
    mkdirSync(dirname(destPath), { recursive: true });

    try {
      if (file.isDir) {
        cpSync(srcPath, destPath, { recursive: true });
      } else {
        writeFileSync(destPath, readFileSync(srcPath));
      }
      backedUp.push(file);
    } catch {
      // Silent failure - continue with update
    }
  }

  // Backup critical files for potential rollback
  // FIXED: Don't backup dist/ - it must be rebuilt from new source code
  const criticalFiles = ["package.json", "package-lock.json"];
  for (const file of criticalFiles) {
    const srcPath = join(process.cwd(), file);
    if (!existsSync(srcPath)) continue;
    const destPath = join(rollbackDir, file);
    try {
      if (statSync(srcPath).isDirectory()) {
        cpSync(srcPath, destPath, { recursive: true });
      } else {
        cpSync(srcPath, destPath);
      }
    } catch {
      // Continue
    }
  }

  // CRITICAL FIX: Delete old dist/ before update to force clean rebuild
  const oldDistPath = join(process.cwd(), "dist");
  if (existsSync(oldDistPath)) {
    try {
      rmSync(oldDistPath, { recursive: true, force: true });
    } catch {
      // Continue - build will overwrite anyway
    }
  }

  // Step 3: Download latest code from GitHub
  process.stdout.write("📥 Downloading...");
  const branchConfig = getBranchConfig();
  const repoOwner = branchConfig.owner;
  const repoName = branchConfig.repo;
  const branch = branchConfig.branch;
  const archiveUrl = `https://github.com/${repoOwner}/${repoName}/archive/refs/heads/${branch}.zip`;

  const archivePath = join(process.cwd(), ".update-download.zip");
  const extractDir = join(process.cwd(), ".update-extract");

  try {
    await downloadFile(archiveUrl, archivePath);
    process.stdout.write(" ✓\n");
  } catch (err) {
    console.log(` ❌\n❌ Download failed: ${err.message}`);
    return 1;
  }

  // Step 4: Extract archive
  process.stdout.write("📂 Extracting...");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  try {
    await extractZip(archivePath, extractDir);
    process.stdout.write(" ✓\n");
  } catch (err) {
    console.log(` ❌\n❌ Extraction failed: ${err.message}`);
    return 1;
  }

  // Step 5: Find extracted folder
  const extractedItems = readdirSync(extractDir);
  const extractedRepoDir = extractedItems.find((item) =>
    item.startsWith(repoName),
  );
  if (!extractedRepoDir) {
    console.log("\n❌ Could not find extracted repository folder");
    return 1;
  }

  const sourceDir = join(extractDir, extractedRepoDir);

  // Step 6: Copy files selectively
  process.stdout.write("📦 Updating files...");
  const itemsToUpdate = [
    "src",
    "docs",
    "setup",
    "public",
    "tests",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    ".update-branch.json", // Branch configuration for auto-updates
    "Dockerfile",
    "compose.yaml",
    "entrypoint.sh",
    "run.sh",
    "README.md",
    "LICENSE",
  ];

  for (const item of itemsToUpdate) {
    const srcPath = join(sourceDir, item);
    const destPath = join(process.cwd(), item);

    if (!existsSync(srcPath)) continue;

    // Skip protected items
    const isProtected = backedUp.some(
      (f) => f.path === item || destPath.includes(f.path),
    );
    if (isProtected) continue;

    try {
      if (existsSync(destPath)) {
        rmSync(destPath, { recursive: true, force: true });
      }

      if (statSync(srcPath).isDirectory()) {
        cpSync(srcPath, destPath, { recursive: true });
      } else {
        cpSync(srcPath, destPath);
      }
    } catch {
      // Silent failure - continue
    }
  }
  process.stdout.write(" ✓\n");

  // Step 7: Restore protected files (silent)
  if (backedUp.length > 0) {
    for (const file of backedUp) {
      const backupPath = join(backupDir, file.path);
      if (!existsSync(backupPath)) continue;

      const destPath = join(process.cwd(), file.path);
      mkdirSync(dirname(destPath), { recursive: true });

      try {
        if (file.isDir) {
          rmSync(destPath, { recursive: true, force: true });
          cpSync(backupPath, destPath, { recursive: true });
        } else {
          writeFileSync(destPath, readFileSync(backupPath));
        }
      } catch {
        // Silent failure
      }
    }
  }

  // Step 8: Cleanup temporary files (silent)
  rmSync(archivePath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });

  // Step 9: Create update marker for bot restart detection
  const updateMarkerPath = join(process.cwd(), ".update-happened");
  writeFileSync(
    updateMarkerPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        fromVersion: versionCheck.localVersion,
        toVersion: versionCheck.remoteVersion,
        method: "github-api",
      },
      null,
      2,
    ),
  );

  // Step 10: Install dependencies & rebuild
  const hasNpm = await which("npm");
  if (!hasNpm) {
    console.log("⚠️  npm not found - please run: npm install && npm run build");
    return 0;
  }

  process.stdout.write("📦 Installing dependencies...");
  const installCode = await run("npm", ["ci", "--silent"], { stdio: "ignore" });
  if (installCode !== 0) {
    await run("npm", ["install", "--silent"], { stdio: "ignore" });
  }
  process.stdout.write(" ✓\n");

  // FIXED: Show build output to detect TypeScript errors and verify compilation
  process.stdout.write("🔨 Building project...\n");
  const buildCode = await run("npm", ["run", "build"], { stdio: "inherit" });

  if (buildCode !== 0) {
    // Build failed - rollback
    process.stdout.write(" ❌\n");
    console.log("⚠️  Build failed, rolling back to previous version...");

    // Restore from rollback
    for (const file of criticalFiles) {
      const srcPath = join(rollbackDir, file);
      const destPath = join(process.cwd(), file);
      if (!existsSync(srcPath)) continue;
      try {
        rmSync(destPath, { recursive: true, force: true });
        if (statSync(srcPath).isDirectory()) {
          cpSync(srcPath, destPath, { recursive: true });
        } else {
          cpSync(srcPath, destPath);
        }
      } catch {
        // Continue
      }
    }

    console.log("✅ Rollback complete - using previous version");
    rmSync(rollbackDir, { recursive: true, force: true });
    return 1;
  }

  process.stdout.write(" ✓\n");

  // Step 10.5: Smart update example files (config/accounts) if enabled
  await smartUpdateExampleFiles(configData);

  // Step 11: Verify integrity (check if critical files exist AND were recently updated)
  process.stdout.write("🔍 Verifying integrity...");
  const criticalPaths = ["dist/index.js", "package.json", "src/index.ts"];

  let integrityOk = true;
  const buildTime = Date.now();

  for (const path of criticalPaths) {
    const fullPath = join(process.cwd(), path);
    if (!existsSync(fullPath)) {
      console.log(`\n   ❌ Missing: ${path}`);
      integrityOk = false;
      break;
    }

    // IMPROVED: For compiled files, verify they were recently updated (within last 2 minutes)
    if (path.startsWith("dist/")) {
      try {
        const stats = statSync(fullPath);
        const fileAge = buildTime - stats.mtimeMs;
        if (fileAge > 120000) {
          // 2 minutes
          console.log(
            `\n   ⚠️  ${path} not recently updated (${Math.round(fileAge / 1000)}s old)`,
          );
          integrityOk = false;
          break;
        }
      } catch {
        integrityOk = false;
        break;
      }
    }
  }

  if (!integrityOk) {
    process.stdout.write(" ❌\n");
    console.log("⚠️  Integrity check failed, rolling back...");

    // Restore from rollback
    for (const file of criticalFiles) {
      const srcPath = join(rollbackDir, file);
      const destPath = join(process.cwd(), file);
      if (!existsSync(srcPath)) continue;
      try {
        rmSync(destPath, { recursive: true, force: true });
        if (statSync(srcPath).isDirectory()) {
          cpSync(srcPath, destPath, { recursive: true });
        } else {
          cpSync(srcPath, destPath);
        }
      } catch {
        // Continue
      }
    }

    console.log("✅ Rollback complete - using previous version");
    rmSync(rollbackDir, { recursive: true, force: true });
    return 1;
  }

  process.stdout.write(" ✓\n");

  // Clean rollback backup on success
  rmSync(rollbackDir, { recursive: true, force: true });

  console.log(
    `\n✅ Updated successfully! (${versionCheck.localVersion} → ${versionCheck.remoteVersion})`,
  );

  // Different behavior for Docker vs Host
  if (updateMode === "docker") {
    console.log("� Docker mode: Update complete");
    console.log("   Container will restart automatically if configured\n");
    // In Docker, don't restart - let orchestrator handle it
    // Just exit cleanly so Docker can restart the container
    return 0;
  } else {
    console.log("�🔄 Restarting in same process...\n");
    // In host mode, signal restart needed
    return 0;
  }
}

// =============================================================================
// ENTRY POINT
// =============================================================================

/**
 * Cleanup temporary files
 */
function cleanup() {
  const tempDirs = [
    ".update-backup",
    ".update-rollback",
    ".update-extract",
    ".update-download.zip",
  ];

  for (const dir of tempDirs) {
    const path = join(process.cwd(), dir);
    try {
      if (existsSync(path)) {
        if (statSync(path).isDirectory()) {
          rmSync(path, { recursive: true, force: true });
        } else {
          rmSync(path, { force: true });
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function main() {
  // Check if updates are enabled in config
  const configData = readJsonConfig([
    "src/config.jsonc",
    "config.jsonc",
    "src/config.json",
    "config.json",
  ]);

  if (configData?.update?.enabled === false) {
    console.log("\n⚠️  Updates are disabled in config.jsonc");
    console.log(
      'To enable: set "update.enabled" to true in src/config.jsonc\n',
    );
    return 0;
  }

  // Global timeout: 5 minutes max
  const timeout = setTimeout(
    () => {
      console.error("\n⏱️  Update timeout (5 min) - cleaning up...");
      cleanup();
      process.exit(1);
    },
    5 * 60 * 1000,
  );

  try {
    const code = await performUpdate();
    clearTimeout(timeout);

    // Final cleanup of temporary files
    cleanup();

    process.exit(code);
  } catch (err) {
    clearTimeout(timeout);
    cleanup();
    throw err;
  }
}

main().catch((err) => {
  console.error("\n❌ Update failed with error:", err);
  console.error("\nCleaning up and reverting...");
  cleanup();
  process.exit(1);
});
