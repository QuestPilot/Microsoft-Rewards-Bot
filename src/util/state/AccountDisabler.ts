import * as fs from "fs";
import * as path from "path";
import { stripJsonComments } from "../core/JsoncParser";
import { getErrorMessage } from "../core/Utils";
import { log } from "../notifications/Logger";

/**
 * Disable a banned account in accounts.jsonc by setting enabled=false and adding a comment
 * @param email Account email to disable
 * @param reason Ban reason (e.g., 'Account suspended by Microsoft')
 */
export async function disableBannedAccount(
  email: string,
  reason: string,
): Promise<void> {
  try {
    // Find accounts.jsonc file
    const candidates = [
      path.join(process.cwd(), "src", "accounts.jsonc"),
      path.join(process.cwd(), "accounts.jsonc"),
      path.join(__dirname, "../../src", "accounts.jsonc"),
      path.join(__dirname, "../../", "accounts.jsonc"),
    ];

    let accountsFilePath: string | null = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        accountsFilePath = candidate;
        break;
      }
    }

    if (!accountsFilePath) {
      throw new Error("accounts.jsonc file not found");
    }

    // Read current content
    const rawContent = fs.readFileSync(accountsFilePath, "utf-8");

    // Parse accounts (support both array and object with accounts property)
    const cleaned = stripJsonComments(rawContent);
    const parsed = JSON.parse(cleaned);
    const accountsArray = Array.isArray(parsed) ? parsed : parsed.accounts;

    if (!Array.isArray(accountsArray)) {
      throw new Error("Invalid accounts.jsonc structure");
    }

    // Find the account
    const accountIndex = accountsArray.findIndex(
      (acc: unknown) =>
        acc !== null &&
        typeof acc === "object" &&
        "email" in acc &&
        (acc as { email: string }).email === email,
    );
    if (accountIndex === -1) {
      throw new Error(`Account ${email} not found in accounts.jsonc`);
    }

    // Check if already disabled
    if (accountsArray[accountIndex].enabled === false) {
      log(
        false,
        "ACCOUNT-BAN",
        `Account ${email} is already disabled`,
        "warn",
        "yellow",
      );
      return;
    }

    // Disable the account
    accountsArray[accountIndex].enabled = false;

    // Rebuild the file with comments
    const timestamp = new Date().toISOString().split("T")[0];
    const banComment = `// BANNED ${timestamp}: ${reason}`;

    // Convert back to JSON with formatting
    let newContent: string;
    if (Array.isArray(parsed)) {
      // Array format
      newContent = "[\n";
      accountsArray.forEach((acc: unknown, idx: number) => {
        if (idx === accountIndex) {
          newContent += `  ${banComment}\n`;
        }
        newContent +=
          "  " + JSON.stringify(acc, null, 2).split("\n").join("\n  ");
        if (idx < accountsArray.length - 1) {
          newContent += ",";
        }
        newContent += "\n";
      });
      newContent += "]\n";
    } else {
      // Object format with accounts property
      const updatedParsed = { ...parsed, accounts: accountsArray };
      const jsonStr = JSON.stringify(updatedParsed, null, 2);

      // Insert comment before the banned account
      const lines = jsonStr.split("\n");
      const emailPattern = `"email": "${email}"`;
      const emailLineIndex = lines.findIndex((line) =>
        line.includes(emailPattern),
      );

      if (emailLineIndex > 0) {
        // Find the start of this account object (opening brace)
        let accountStartIndex = emailLineIndex;
        for (let i = emailLineIndex; i >= 0; i--) {
          const line = lines[i];
          if (line && line.trim().startsWith("{")) {
            accountStartIndex = i;
            break;
          }
        }

        // Insert comment before the account object
        const targetLine = lines[accountStartIndex];
        const indent = (targetLine && targetLine.match(/^\s*/)?.[0]) || "    ";
        lines.splice(accountStartIndex, 0, `${indent}${banComment}`);
      }

      newContent = lines.join("\n") + "\n";
    }

    // Write back to file
    fs.writeFileSync(accountsFilePath, newContent, "utf-8");

    log(
      false,
      "ACCOUNT-BAN",
      `✓ Disabled account ${email} in ${accountsFilePath}`,
      "log",
      "green",
    );
  } catch (error) {
    throw new Error(
      `Failed to disable banned account ${email}: ${getErrorMessage(error)}`,
    );
  }
}
