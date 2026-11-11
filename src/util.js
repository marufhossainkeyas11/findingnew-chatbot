const recentMsgIds = new Set();
const MAX_RECENT_IDS = 500;

/**
 * Best-effort module-level duplicate message protection (capped at 500 IDs).
 */
export function isDuplicate(msgId) {
  if (!msgId) return false;
  if (recentMsgIds.has(msgId)) return true;

  if (recentMsgIds.size >= MAX_RECENT_IDS) {
    const oldest = recentMsgIds.values().next().value;
    recentMsgIds.delete(oldest);
  }
  recentMsgIds.add(msgId);
  return false;
}

/**
 * Detects whether a string contains any Bengali Unicode character [\u0980-\u09FF].
 */
export function hasBengali(str) {
  if (typeof str !== "string") return false;
  return /[\u0980-\u09FF]/.test(str);
}

/**
 * Safely clips a string by Unicode code points using Array.from and logs a warning.
 */
export function clipText(str, maxLen, context = "label") {
  const s = String(str ?? "");
  const chars = Array.from(s);
  if (chars.length <= maxLen) return s;

  const clipped = chars.slice(0, maxLen).join("");
  console.warn(`Clipped ${context} from ${chars.length} to ${maxLen} code points`);
  return clipped;
}

/**
 * Strips WhatsApp *bold* asterisks for Facebook Messenger text rendering.
 */
export function stripAsterisks(str) {
  if (typeof str !== "string") return "";
  return str.replace(/\*/g, "");
}

/**
 * Splits long text into chunks <= maxLen code points along line boundaries.
 */
export function splitTextByLines(text, maxLen = 2000) {
  if (!text) return [];
  if (Array.from(text).length <= maxLen) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (Array.from(candidate).length <= maxLen) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (Array.from(line).length <= maxLen) {
        current = line;
      } else {
        const chars = Array.from(line);
        for (let i = 0; i < chars.length; i += maxLen) {
          chunks.push(chars.slice(i, i + maxLen).join(""));
        }
        current = "";
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Parses a button payload of format "lang|target|from".
 */
export function parsePayload(payloadStr) {
  const parts = String(payloadStr ?? "").split("|");
  return {
    lang: parts[0] || "",
    target: parts[1] || "root",
    from: parts[2] || ""
  };
}

/**
 * Verifies Meta X-Hub-Signature-256 header using Web Crypto HMAC-SHA256 and constant-time comparison.
 */
export async function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expectedHex = signatureHeader.slice(7).toLowerCase();
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const sigArray = new Uint8Array(sigBuffer);
  let computedHex = "";
  for (let i = 0; i < sigArray.length; i++) {
    computedHex += sigArray[i].toString(16).padStart(2, "0");
  }

  if (computedHex.length !== expectedHex.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Checks if current time in `timeZone` falls within `hours` ({ open: "HH:MM", close: "HH:MM" }).
 */
export function isWithinBusinessHours(hours, timeZone = "Asia/Dhaka") {
  if (!hours?.open || !hours?.close) return true;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const nowMins = (hh === 24 ? 0 : hh) * 60 + mm;

  const [openH, openM] = hours.open.split(":").map(Number);
  const [closeH, closeM] = hours.close.split(":").map(Number);
  const openMins = openH * 60 + openM;
  const closeMins = closeH * 60 + closeM;

  if (openMins <= closeMins) {
    return nowMins >= openMins && nowMins < closeMins;
  }
  return nowMins >= openMins || nowMins < closeMins;
}

/**
 * Formats current timestamp in the configured timezone for admin notifications.
 */
export function formatTimeInTz(timeZone = "Asia/Dhaka") {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(new Date());
}
