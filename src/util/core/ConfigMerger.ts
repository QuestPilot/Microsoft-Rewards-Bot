import fs from "fs";
import path from "path";
import { stripJsonComments } from "./JsoncParser";
import { getErrorMessage } from "./Utils";

/**
 * Smart configuration file merger
 *
 * Intelligently merges new options from example files into user files
 * without overwriting existing user data (passwords, custom values, etc.)
 *
 * Key features:
 * - Preserves all user values
 * - Adds new options from example files
 * - Removes deprecated options
 * - Maintains JSON formatting and comments
 * - Handles nested objects recursively
 */
export class ConfigMerger {
  /**
   * Deep merge two objects recursively
   * Priority: userValue > exampleValue (preserves user data)
   *
   * @param example - New schema from example file
   * @param user - Existing user configuration
   * @returns Merged object with all new keys and preserved user values
   */
  private static deepMerge(example: unknown, user: unknown): unknown {
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
    const merged: Record<string, unknown> = {
      ...(example as Record<string, unknown>),
    }; // Start with example schema

    for (const key in user) {
      if (key in example) {
        // Key exists in both - recurse
        merged[key] = this.deepMerge(
          (example as Record<string, unknown>)[key],
          (user as Record<string, unknown>)[key],
        );
      } else {
        // Key only in user - preserve it (backward compatibility)
        // But log it as potentially deprecated
        merged[key] = (user as Record<string, unknown>)[key];
      }
    }

    // All new keys from example are already in merged
    return merged;
  }

  /**
   * Merge example file into user file intelligently
   *
   * @param examplePath - Path to .example.jsonc file
   * @param userPath - Path to user's .jsonc file
   * @returns Object with merge results
   */
  public static mergeConfigFile(
    examplePath: string,
    userPath: string,
  ): { success: boolean; message: string; changes: string[] } {
    const changes: string[] = [];

    try {
      // Read files
      if (!fs.existsSync(examplePath)) {
        return {
          success: false,
          message: `Example file not found: ${examplePath}`,
          changes: [],
        };
      }

      if (!fs.existsSync(userPath)) {
        // User file doesn't exist - simple copy
        fs.copyFileSync(examplePath, userPath);
        return {
          success: true,
          message: "Created new user file from example",
          changes: ["File created"],
        };
      }

      // Parse both files
      const exampleContent = fs.readFileSync(examplePath, "utf8");
      const userContent = fs.readFileSync(userPath, "utf8");

      const exampleJson = JSON.parse(stripJsonComments(exampleContent));
      const userJson = JSON.parse(stripJsonComments(userContent));

      // Detect if they're identical (no merge needed)
      if (JSON.stringify(exampleJson) === JSON.stringify(userJson)) {
        return {
          success: true,
          message: "No changes needed - files are identical",
          changes: [],
        };
      }

      // Merge configurations
      const merged = this.deepMerge(exampleJson, userJson);

      // Detect what changed
      const newKeys = this.findNewKeys(exampleJson, userJson);
      const preservedKeys = this.findPreservedUserKeys(userJson, exampleJson);

      if (newKeys.length > 0) {
        changes.push(
          `Added ${newKeys.length} new option(s): ${newKeys.join(", ")}`,
        );
      }

      if (preservedKeys.length > 0) {
        changes.push(`Preserved ${preservedKeys.length} user value(s)`);
      }

      // Write merged file with nice formatting
      const mergedContent = JSON.stringify(merged, null, 4);
      fs.writeFileSync(userPath, mergedContent, "utf8");

      return {
        success: true,
        message: "Configuration merged successfully",
        changes,
      };
    } catch (error) {
      return {
        success: false,
        message: `Merge failed: ${getErrorMessage(error)}`,
        changes: [],
      };
    }
  }

  /**
   * Find keys that exist in example but not in user (new options)
   */
  private static findNewKeys(
    example: unknown,
    user: unknown,
    prefix = "",
  ): string[] {
    const newKeys: string[] = [];

    if (
      typeof example !== "object" ||
      example === null ||
      Array.isArray(example)
    ) {
      return newKeys;
    }

    if (typeof user !== "object" || user === null || Array.isArray(user)) {
      return newKeys;
    }

    const exampleObj = example as Record<string, unknown>;
    const userObj = user as Record<string, unknown>;

    for (const key in exampleObj) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (!(key in userObj)) {
        newKeys.push(fullKey);
      } else if (
        typeof exampleObj[key] === "object" &&
        !Array.isArray(exampleObj[key])
      ) {
        newKeys.push(
          ...this.findNewKeys(exampleObj[key], userObj[key], fullKey),
        );
      }
    }

    return newKeys;
  }

  /**
   * Find keys that exist in user but not in example (custom/deprecated)
   */
  private static findPreservedUserKeys(
    user: unknown,
    example: unknown,
    prefix = "",
  ): string[] {
    const preserved: string[] = [];

    if (typeof user !== "object" || user === null || Array.isArray(user)) {
      return preserved;
    }

    if (
      typeof example !== "object" ||
      example === null ||
      Array.isArray(example)
    ) {
      return preserved;
    }

    const userObj = user as Record<string, unknown>;
    const exampleObj = example as Record<string, unknown>;

    for (const key in userObj) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      // Check if value is different from example default
      if (key in exampleObj) {
        const userVal = userObj[key];
        const exampleVal = exampleObj[key];

        if (typeof userVal === "object" && !Array.isArray(userVal)) {
          preserved.push(
            ...this.findPreservedUserKeys(userVal, exampleVal, fullKey),
          );
        } else if (JSON.stringify(userVal) !== JSON.stringify(exampleVal)) {
          preserved.push(fullKey);
        }
      }
    }

    return preserved;
  }

  /**
   * Merge accounts file (special handling for account arrays)
   */
  public static mergeAccountsFile(
    examplePath: string,
    userPath: string,
  ): { success: boolean; message: string; changes: string[] } {
    const changes: string[] = [];

    try {
      if (!fs.existsSync(examplePath)) {
        return {
          success: false,
          message: `Example file not found: ${examplePath}`,
          changes: [],
        };
      }

      if (!fs.existsSync(userPath)) {
        // User file doesn't exist - simple copy
        fs.copyFileSync(examplePath, userPath);
        return {
          success: true,
          message: "Created new accounts file from example",
          changes: ["File created"],
        };
      }

      // Parse both files
      const exampleContent = fs.readFileSync(examplePath, "utf8");
      const userContent = fs.readFileSync(userPath, "utf8");

      const exampleJson = JSON.parse(stripJsonComments(exampleContent));
      const userJson = JSON.parse(stripJsonComments(userContent));

      // For accounts, we just preserve the user array
      // But update the schema if there are new fields in individual accounts
      if (Array.isArray(exampleJson) && Array.isArray(userJson)) {
        // Check if example account structure has new fields
        if (exampleJson.length > 0 && userJson.length > 0) {
          const exampleAccount = exampleJson[0];
          const userAccount = userJson[0];

          // Merge each user account with example schema
          const mergedAccounts = userJson.map((account: unknown) => {
            return this.deepMerge(exampleAccount, account);
          });

          const newFields = this.findNewKeys(exampleAccount, userAccount);
          if (newFields.length > 0) {
            changes.push(
              `Added ${newFields.length} new field(s) to accounts: ${newFields.join(", ")}`,
            );

            // Write updated accounts
            const mergedContent = JSON.stringify(mergedAccounts, null, 4);
            fs.writeFileSync(userPath, mergedContent, "utf8");

            changes.push(`Updated ${mergedAccounts.length} account(s)`);
          } else {
            changes.push("No changes needed");
          }
        } else {
          changes.push("No changes needed");
        }
      }

      return {
        success: true,
        message: "Accounts merged successfully",
        changes,
      };
    } catch (error) {
      return {
        success: false,
        message: `Merge failed: ${getErrorMessage(error)}`,
        changes: [],
      };
    }
  }

  /**
   * Perform smart merge for both config and accounts
   */
  public static mergeAllConfigFiles(): void {
    console.log("\n🔄 Checking for configuration updates...\n");

    const rootDir = process.cwd();

    // Merge config.jsonc
    const configResult = this.mergeConfigFile(
      path.join(rootDir, "src/config.example.jsonc"),
      path.join(rootDir, "src/config.jsonc"),
    );

    if (configResult.success && configResult.changes.length > 0) {
      console.log("📝 Configuration file:");
      configResult.changes.forEach((change) => console.log(`   ✓ ${change}`));
    } else if (configResult.success) {
      console.log("✓ Configuration file: Up to date");
    } else {
      console.log(`⚠️  Configuration file: ${configResult.message}`);
    }

    // Merge accounts.jsonc
    const accountsResult = this.mergeAccountsFile(
      path.join(rootDir, "src/accounts.example.jsonc"),
      path.join(rootDir, "src/accounts.jsonc"),
    );

    if (accountsResult.success && accountsResult.changes.length > 0) {
      console.log("\n📝 Accounts file:");
      accountsResult.changes.forEach((change) => console.log(`   ✓ ${change}`));
    } else if (accountsResult.success) {
      console.log("✓ Accounts file: Up to date");
    } else {
      console.log(`⚠️  Accounts file: ${accountsResult.message}`);
    }

    console.log("");
  }
}
