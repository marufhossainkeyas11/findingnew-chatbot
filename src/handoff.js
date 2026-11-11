import { getProductKeyFromNodeId } from "./tree.js";
import { resolveLines, resolveLabel } from "./render.js";
import { sendWaRendered, sendWaText } from "./wa.js";
import { sendFbRendered } from "./fb.js";
import { isWithinBusinessHours, formatTimeInTz } from "./util.js";

function makeKey(platform, userId) {
  return `${platform}:${userId}`;
}

/**
 * Reads handoff row for user and lazily deletes expired rows.
 * One D1 read per incoming user message.
 */
export async function getHandoffState(env, tree, platform, userId) {
  const key = makeKey(platform, userId);
  const row = await env.DB.prepare(
    "SELECT key, state, reason, lang, since, touched, last_notice FROM handoff WHERE key = ?"
  )
    .bind(key)
    .first();

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  const pendingTtl = (tree.handoff?.ttl_hours?.pending ?? 12) * 3600;
  const activeTtl = (tree.handoff?.ttl_hours?.active ?? 24) * 3600;

  const isExpired =
    (row.state === "PENDING" && now - row.since >= pendingTtl) ||
    (row.state === "ACTIVE" && now - row.touched >= activeTtl);

  if (isExpired) {
    await env.DB.prepare("DELETE FROM handoff WHERE key = ?").bind(key).run();
    return null;
  }

  return row;
}

/**
 * Deletes the handoff row when returning to BOT mode.
 */
export async function clearHandoffState(env, platform, userId) {
  const key = makeKey(platform, userId);
  await env.DB.prepare("DELETE FROM handoff WHERE key = ?").bind(key).run();
}

/**
 * Enters PENDING handoff state, replies with composite handoff message + @bot button,
 * and pings Telegram if configured.
 */
export async function enterHandoff(
  env,
  tree,
  { platform, userId, userName, reason, lang, fromNode = "", isMediaTrigger = false }
) {
  const key = makeKey(platform, userId);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO handoff (key, state, reason, lang, since, touched, last_notice)
     VALUES (?, 'PENDING', ?, ?, ?, ?, 0)
     ON CONFLICT(key) DO UPDATE SET
       state = 'PENDING',
       reason = excluded.reason,
       lang = excluded.lang,
       since = excluded.since,
       touched = excluded.touched,
       last_notice = 0`
  )
    .bind(key, reason, lang, now, now)
    .run();

  const productKey = getProductKeyFromNodeId(tree, fromNode);
  const hm = tree.handoff?.messages || {};
  const reasonDef = tree.handoff?.reasons?.[reason] || {};

  const parts = [];

  const ackText = resolveLines(hm.ack, lang, tree, productKey, platform);
  if (ackText) parts.push(ackText);

  let promptText = "";
  if (isMediaTrigger) {
    promptText = resolveLines(tree.system?.media_received, lang, tree, productKey, platform);
  } else if (reasonDef.prompt) {
    promptText = resolveLines(reasonDef.prompt, lang, tree, productKey, platform);
  }
  if (promptText) parts.push(promptText);

  const tz = tree.meta?.timezone || "Asia/Dhaka";
  const inHours = isWithinBusinessHours(tree.config?.hours, tz);
  const hoursBlock = inHours ? hm.in_hours : hm.out_of_hours;
  const hoursText = resolveLines(hoursBlock, lang, tree, productKey, platform);
  if (hoursText) parts.push(hoursText);

  if (platform === "wa" && hm.wa_direct?.enabled) {
    const waDirectText = resolveLines(hm.wa_direct, lang, tree, productKey, platform);
    if (waDirectText) parts.push(waDirectText);
  }

  const returnHintText = resolveLines(hm.return_hint, lang, tree, productKey, platform);
  if (returnHintText) parts.push(returnHintText);

  const fullText = parts.join("\n\n");
  const toBotLabel = resolveLabel(tree.ui?.to_bot, lang, platform) || "Menu";
  const buttonChoice = [{ payload: `${lang}|@bot|`, label: toBotLabel }];

  if (platform === "wa") {
    if (Array.from(fullText).length > 1024 && promptText) {
      await sendWaText(env, userId, promptText);
      const shortParts = [ackText, hoursText];
      if (hm.wa_direct?.enabled) {
        const wd = resolveLines(hm.wa_direct, lang, tree, productKey, platform);
        if (wd) shortParts.push(wd);
      }
      if (returnHintText) shortParts.push(returnHintText);
      await sendWaRendered(env, userId, {
        text: shortParts.filter(Boolean).join("\n\n"),
        choices: buttonChoice,
        lang
      });
    } else {
      await sendWaRendered(env, userId, {
        text: fullText,
        choices: buttonChoice,
        lang
      });
    }
  } else {
    if (Array.from(fullText).length > 2000 && promptText) {
      await sendFbRendered(env, userId, { text: promptText, choices: [] });
      const shortParts = [ackText, hoursText, returnHintText].filter(Boolean);
      await sendFbRendered(env, userId, {
        text: shortParts.join("\n\n"),
        choices: buttonChoice
      });
    } else {
      await sendFbRendered(env, userId, {
        text: fullText,
        choices: buttonChoice
      });
    }
  }

  await notifyTelegramAdmin(env, tree, {
    platform,
    userId,
    userName: userName || "Customer",
    reason: reasonDef.admin || reason
  });
}

/**
 * Sends wait_notice once if PENDING state has been idle for >= wait_notice_after_min.
 */
export async function handlePendingIdleNotice(env, tree, platform, userId, row) {
  const waitMin = tree.handoff?.wait_notice_after_min ?? 30;
  const now = Math.floor(Date.now() / 1000);
  const baseline = Math.max(row.since || 0, row.last_notice || 0);

  if (row.last_notice === 0 && now - baseline >= waitMin * 60) {
    const key = makeKey(platform, userId);
    await env.DB.prepare("UPDATE handoff SET last_notice = ? WHERE key = ?")
      .bind(now, key)
      .run();

    const lang = row.lang || "bn";
    const noticeText = resolveLines(
      tree.handoff?.messages?.wait_notice,
      lang,
      tree,
      null,
      platform
    );
    if (!noticeText) return;

    if (platform === "wa") {
      await sendWaText(env, userId, noticeText);
    } else {
      await sendFbRendered(env, userId, { text: noticeText, choices: [] });
    }
  }
}

/**
 * Transitions chat to ACTIVE on admin echo, throttling D1 touched writes to once per 30 mins.
 */
export async function handleAdminEcho(env, tree, platform, userId) {
  const key = makeKey(platform, userId);
  const now = Math.floor(Date.now() / 1000);
  const existing = await getHandoffState(env, tree, platform, userId);

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO handoff (key, state, reason, lang, since, touched, last_notice)
       VALUES (?, 'ACTIVE', 'agent', 'bn', ?, ?, 0)`
    )
      .bind(key, now, now)
      .run();
    return;
  }

  if (existing.state !== "ACTIVE" || now - (existing.touched || 0) >= 1800) {
    await env.DB.prepare(
      "UPDATE handoff SET state = 'ACTIVE', touched = ? WHERE key = ?"
    )
      .bind(now, key)
      .run();
  }
}

/**
 * Sends admin handoff notification to Telegram if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID exist.
 */
async function notifyTelegramAdmin(env, tree, { platform, userId, userName, reason }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const tz = tree.meta?.timezone || "Asia/Dhaka";
  const timeStr = formatTimeInTz(tz);
  const platformLabel = platform === "wa" ? "WhatsApp" : "Messenger";

  const noticeText = resolveLines(
    tree.handoff?.admin_notice || [],
    "bn",
    tree,
    null,
    "wa",
    {
      platform: platformLabel,
      name: userName,
      user_id: userId,
      reason,
      time: timeStr
    }
  );

  if (!noticeText) return;

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: noticeText
    })
  });

  if (!res.ok) {
    console.error(`Telegram API error: HTTP ${res.status}`);
  }
}
