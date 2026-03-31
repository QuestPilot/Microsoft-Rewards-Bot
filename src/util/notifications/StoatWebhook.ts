import axios from "axios";
import { STOAT } from "../../constants";
import { getErrorMessage } from "../core/Utils";

/**
 * Stoat/Revolt embed structure
 * Stoat uses Revolt-compatible webhook format:
 * - `colour` (hex string) instead of Discord's `color` (number)
 * - `type: "Text"` required on embeds
 * - `avatar` instead of Discord's `avatar_url`
 * - No `fields` support in embeds (inline fields as description text)
 */
interface StoatEmbed {
  type: "Text";
  title?: string;
  description?: string;
  colour?: string; // Hex color string, e.g. "#FF0000"
}

interface StoatWebhookPayload {
  content?: string;
  username?: string;
  avatar?: string; // Stoat uses `avatar`, not `avatar_url`
  embeds?: StoatEmbed[];
}

/**
 * Convert a Discord-style numeric color (0xFF0000) to a Stoat hex string ("#FF0000")
 */
export function discordColorToStoat(color: number): string {
  return `#${color.toString(16).padStart(6, "0").toUpperCase()}`;
}

/**
 * Convert Discord-style fields into a description string
 * Stoat/Revolt embeds don't support Discord-style field objects,
 * so we render them as formatted text within the description.
 */
function fieldsToDescription(
  fields: Array<{ name: string; value: string }>,
): string {
  return fields.map((f) => `**${f.name}:** ${f.value}`).join("\n");
}

/**
 * Send a webhook notification to a Stoat/Revolt server
 *
 * @param url - Full Stoat webhook URL (e.g. https://stoat.chat/api/webhooks/{id}/{token})
 * @param title - Embed title
 * @param description - Embed description (Markdown supported)
 * @param fields - Optional Discord-style fields (converted to description text)
 * @param color - Optional color as Discord-style number (converted to hex string)
 */
export async function sendStoatWebhook(
  url: string,
  title: string,
  description: string,
  fields?: Array<{ name: string; value: string }>,
  color?: number,
): Promise<void> {
  // Build description with fields appended
  let fullDescription = description;
  if (fields && fields.length > 0) {
    fullDescription += "\n\n" + fieldsToDescription(fields);
  }

  const embed: StoatEmbed = {
    type: "Text",
    title,
    description: fullDescription,
  };

  if (color !== undefined) {
    embed.colour = discordColorToStoat(color);
  }

  const payload: StoatWebhookPayload = {
    username: STOAT.WEBHOOK_USERNAME,
    avatar: STOAT.AVATAR_URL,
    embeds: [embed],
  };

  const maxAttempts = 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: STOAT.WEBHOOK_TIMEOUT,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(
    `Stoat webhook failed after ${maxAttempts} attempts: ${getErrorMessage(lastError)}`,
  );
}

/**
 * Send a live log batch to a Stoat/Revolt webhook
 * Used by Logger.ts for streaming log messages
 *
 * @param url - Full Stoat webhook URL
 * @param content - Pre-formatted log content
 * @param color - Optional Discord-style color number (converted to hex)
 */
export async function sendStoatLogBatch(
  url: string,
  content: string,
  color?: number,
): Promise<void> {
  const embed: StoatEmbed = {
    type: "Text",
    description: `\`\`\`\n${content}\n\`\`\``,
  };

  if (color !== undefined) {
    embed.colour = discordColorToStoat(color);
  }

  const payload: StoatWebhookPayload = {
    username: STOAT.WEBHOOK_USERNAME,
    avatar: STOAT.AVATAR_URL,
    embeds: [embed],
  };

  await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: STOAT.WEBHOOK_TIMEOUT,
  });
}
