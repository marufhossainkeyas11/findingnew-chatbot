import { clipText } from "./util.js";

const SHORT_BODY = {
  bn: "নিচ থেকে বেছে নিন 👇",
  en: "Choose below 👇"
};

const MEDIA_TYPES = new Set([
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location"
]);

/**
 * Extracts normalized events from a WhatsApp Cloud API webhook payload.
 */
export function extractWaEvents(body, env) {
  const events = [];
  const entries = body?.entry;
  if (!Array.isArray(entries)) return events;

  const coexistence = env.WA_COEXISTENCE === "1";

  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const val = change?.value;
      if (!val) continue;

      // Coexistence mode: treat smb_message_echoes as admin echoes
      if (coexistence && Array.isArray(val.smb_message_echoes)) {
        for (const echo of val.smb_message_echoes) {
          if (echo?.to) {
            events.push({
              platform: "wa",
              kind: "admin_echo",
              userId: String(echo.to),
              msgId: echo.id || null
            });
          }
        }
      }

      // Ignore delivery/read statuses
      if (!Array.isArray(val.messages)) continue;

      const contactName = val.contacts?.[0]?.profile?.name || "Customer";

      for (const msg of val.messages) {
        if (!msg || !msg.from) continue;
        const userId = String(msg.from);
        const msgId = msg.id || null;
        const type = msg.type;

        if (type === "reaction" || type === "unsupported") {
          continue;
        }

        if (type === "text" && msg.text?.body !== undefined) {
          events.push({
            platform: "wa",
            kind: "text",
            userId,
            userName: contactName,
            text: String(msg.text.body),
            msgId
          });
        } else if (type === "interactive") {
          const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
          if (reply?.id) {
            events.push({
              platform: "wa",
              kind: "payload",
              userId,
              userName: contactName,
              payload: String(reply.id),
              msgId
            });
          }
        } else if (MEDIA_TYPES.has(type)) {
          events.push({
            platform: "wa",
            kind: "media",
            userId,
            userName: contactName,
            msgId
          });
        }
      }
    }
  }

  return events;
}

/**
 * Low-level helper to POST a message object to WhatsApp Cloud API.
 */
async function postWaMessage(env, payload) {
  const version = env.GRAPH_VERSION || "v21.0";
  const url = `https://graph.facebook.com/${version}/${env.WA_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    console.error(`WhatsApp API error: HTTP ${res.status}`);
  }
}

/**
 * Sends a plain text message on WhatsApp (splitting safely if > 4096 chars).
 */
export async function sendWaText(env, to, text) {
  if (!text) return;
  await postWaMessage(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: clipText(text, 4096, "wa.text.body") }
  });
}

/**
 * Renders and sends a message with 0..10 choices on WhatsApp.
 * - 0 choices: plain text message
 * - 1..3 choices: interactive "button" (button title <= 20 chars)
 * - 4..10 choices: interactive "list" (row title <= 24 chars, button <= 20 chars)
 * - Body > 1024 chars: sends full text first, then interactive message with short prompt.
 */
export async function sendWaRendered(env, to, { text, choices = [], lang = "bn" }) {
  if (!choices || choices.length === 0) {
    await sendWaText(env, to, text);
    return;
  }

  let interactiveBody = text || (SHORT_BODY[lang] || SHORT_BODY.bn);
  const codePointLen = Array.from(interactiveBody).length;

  if (codePointLen > 1024) {
    await sendWaText(env, to, interactiveBody);
    interactiveBody = SHORT_BODY[lang] || SHORT_BODY.bn;
  }

  const cappedChoices = choices.slice(0, 10);

  if (cappedChoices.length <= 3) {
    const buttons = cappedChoices.map((c) => ({
      type: "reply",
      reply: {
        id: c.payload,
        title: clipText(c.label, 20, "wa.button.title")
      }
    }));

    await postWaMessage(env, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: interactiveBody },
        action: { buttons }
      }
    });
  } else {
    const listButtonLabel = clipText(
      lang === "en" ? "Menu ☰" : "মেনু ☰",
      20,
      "wa.list.button"
    );

    const rows = cappedChoices.map((c) => ({
      id: c.payload,
      title: clipText(c.label, 24, "wa.list.row.title")
    }));

    await postWaMessage(env, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: interactiveBody },
        action: {
          button: listButtonLabel,
          sections: [{ rows }]
        }
      }
    });
  }
}
