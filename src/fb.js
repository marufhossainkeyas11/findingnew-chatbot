import { clipText, splitTextByLines } from "./util.js";

/**
 * Extracts normalized events from a Facebook Messenger webhook payload.
 */
export function extractFbEvents(body) {
  const events = [];
  const entries = body?.entry;
  if (!Array.isArray(entries)) return events;

  for (const entry of entries) {
    const messaging = entry?.messaging;
    if (!Array.isArray(messaging)) continue;

    for (const ev of messaging) {
      if (!ev) continue;

      // Ignore delivery and read receipts
      if (ev.delivery || ev.read) continue;

      // Handle echoes: distinguish bot echoes from Page admin echoes
      if (ev.message?.is_echo) {
        if (ev.message.metadata !== "bot" && ev.recipient?.id) {
          events.push({
            platform: "fb",
            kind: "admin_echo",
            userId: String(ev.recipient.id),
            msgId: ev.message.mid || null
          });
        }
        continue;
      }

      const senderId = ev.sender?.id ? String(ev.sender.id) : null;
      if (!senderId) continue;

      if (ev.postback?.payload) {
        events.push({
          platform: "fb",
          kind: "payload",
          userId: senderId,
          userName: "Customer",
          payload: String(ev.postback.payload),
          msgId: ev.postback.mid || null
        });
        continue;
      }

      if (ev.message) {
        const msgId = ev.message.mid || null;

        if (ev.message.quick_reply?.payload) {
          events.push({
            platform: "fb",
            kind: "payload",
            userId: senderId,
            userName: "Customer",
            payload: String(ev.message.quick_reply.payload),
            msgId
          });
        } else if (Array.isArray(ev.message.attachments) && ev.message.attachments.length > 0) {
          events.push({
            platform: "fb",
            kind: "media",
            userId: senderId,
            userName: "Customer",
            msgId
          });
        } else if (typeof ev.message.text === "string") {
          events.push({
            platform: "fb",
            kind: "text",
            userId: senderId,
            userName: "Customer",
            text: ev.message.text,
            msgId
          });
        }
      }
    }
  }

  return events;
}

/**
 * Low-level helper to POST a message to the Messenger Send API.
 * Always sets metadata: "bot" so echoes from the bot can be ignored.
 */
async function postFbMessage(env, recipientId, messageObj) {
  const version = env.GRAPH_VERSION || "v21.0";
  const url = `https://graph.facebook.com/${version}/me/messages?access_token=${encodeURIComponent(
    env.FB_PAGE_TOKEN
  )}`;

  const payload = {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: {
      ...messageObj,
      metadata: "bot"
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    console.error(`Messenger Send API error: HTTP ${res.status}`);
  }
}

/**
 * Sends a rendered response on Messenger:
 * - Splits text on line boundaries if > 2000 chars.
 * - Attaches quick_replies (max 13, title <= 20 chars) to the LAST chunk.
 * - Puts metadata: "bot" on every message sent.
 */
export async function sendFbRendered(env, recipientId, { text, choices = [] }) {
  const chunks = splitTextByLines(text || "", 2000);
  if (chunks.length === 0) return;

  const quickReplies =
    choices && choices.length > 0
      ? choices.slice(0, 13).map((c) => ({
          content_type: "text",
          title: clipText(c.label, 20, "fb.quick_reply.title"),
          payload: c.payload
        }))
      : null;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const msg = { text: chunks[i] };
    if (isLast && quickReplies && quickReplies.length > 0) {
      msg.quick_replies = quickReplies;
    }
    await postFbMessage(env, recipientId, msg);
  }
}

/**
 * Configures Messenger get_started payload and persistent_menu.
 */
export async function setupMessengerProfile(env) {
  const version = env.GRAPH_VERSION || "v21.0";
  const url = `https://graph.facebook.com/${version}/me/messenger_profile?access_token=${encodeURIComponent(
    env.FB_PAGE_TOKEN
  )}`;

  const body = {
    get_started: { payload: "|@start|" },
    persistent_menu: [
      {
        locale: "default",
        composer_input_disabled: false,
        call_to_actions: [
          {
            type: "postback",
            title: "মেনু / Menu",
            payload: "|@start|"
          }
        ]
      }
    ]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
