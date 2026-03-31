type BanStatus = { status: boolean; reason: string };

// IMPROVED: Expanded ban detection patterns for better early warning
const BAN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /suspend|suspended|suspension/i, reason: "account suspended" },
  {
    re: /locked|lockout|serviceabuse|abuse/i,
    reason: "locked or service abuse detected",
  },
  {
    re: /unusual.*activity|unusual activity/i,
    reason: "unusual activity prompts",
  },
  {
    re: /verify.*identity|identity.*verification/i,
    reason: "identity verification required",
  },
  {
    re: /captcha|recaptcha|hcaptcha/i,
    reason: "CAPTCHA challenge detected (potential bot detection)",
  },
  {
    re: /blocked|block|restriction|restricted/i,
    reason: "access restricted or blocked",
  },
  {
    re: /security.*code|verification.*code|two.*factor/i,
    reason: "unexpected 2FA prompt (suspicious activity)",
  },
  {
    re: /rate.*limit|too.*many.*requests|slow.*down/i,
    reason: "rate limiting detected",
  },
  {
    re: /temporarily.*unavailable|service.*unavailable/i,
    reason: "service temporarily unavailable (may be IP ban)",
  },
  {
    re: /automated.*request|bot.*detected|automated.*access/i,
    reason: "automated access detected",
  },
  {
    re: /failed to find activities|activities not found/i,
    reason:
      "activities unavailable (possible account restriction or regional issue)",
  },
];

export function detectBanReason(input: unknown): BanStatus {
  const s = input instanceof Error ? input.message || "" : String(input || "");

  // FIXED: Exclude transient HTTP 400 errors (Microsoft's known issue, not a ban)
  // These are temporary server-side issues that resolve with a page reload
  if (
    /HTTP.*400|HTTP ERROR 400|page isn't working|page is not working/i.test(
      s,
    ) &&
    !/persists after retries/i.test(s)
  ) {
    // HTTP 400 without "persists" = transient issue, not a ban
    return { status: false, reason: "" };
  }

  for (const p of BAN_PATTERNS) {
    if (p.re.test(s)) return { status: true, reason: p.reason };
  }
  return { status: false, reason: "" };
}
