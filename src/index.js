import { getTree, matchKeyword } from "./tree.js";
import { renderNode, renderLangSelect, resolveLines } from "./render.js";
import { extractWaEvents, sendWaRendered } from "./wa.js";
import { extractFbEvents, sendFbRendered, setupMessengerProfile } from "./fb.js";
import {
  getHandoffState,
  clearHandoffState,
  enterHandoff,
  handlePendingIdleNotice,
  handleAdminEcho
} from "./handoff.js";
import { verifySignature, isDuplicate, hasBengali, parsePayload } from "./util.js";

/**
 * Sends a plain text message followed by the root menu node.
 */
async function sendTextThenRoot(platform, env, userId, lang, textLines) {
  const t = getTree();
  const text = resolveLines(textLines, lang, t, null, platform);
  const rootMsg = renderNode(t, "root", lang, "", platform);
  if (platform === "wa") {
    await sendWaRendered(env, userId, { text, choices: [] });
    await sendWaRendered(env, userId, rootMsg);
  } else {
    await sendFbRendered(env, userId, { text, choices: [] });
    await sendFbRendered(env, userId, rootMsg);
  }
}

/**
 * Routes a single normalized platform event.
 */
async function handleEvent(ev, env) {
  const t = getTree();

  if (ev.kind === "admin_echo") {
    await handleAdminEcho(env, t, ev.platform, ev.userId);
    return;
  }

  if (ev.msgId && isDuplicate(ev.msgId)) {
    return;
  }

  const stateRow = await getHandoffState(env, t, ev.platform, ev.userId);

  // 1. Handle button / quick_reply / list_reply payloads (served in all states)
  if (ev.kind === "payload") {
    const { lang: rawLang, target, from } = parsePayload(ev.payload);
    const lang = rawLang || stateRow?.lang || (hasBengali(ev.userName) ? "bn" : "bn");

    if (target === "@lang" || target === "@start") {
      const msg = renderLangSelect(t, ev.platform);
      if (ev.platform === "wa") await sendWaRendered(env, ev.userId, msg);
      else await sendFbRendered(env, ev.userId, msg);
      return;
    }

    if (target === "@bot") {
      if (stateRow) {
        await clearHandoffState(env, ev.platform, ev.userId);
      }
      await sendTextThenRoot(
        ev.platform,
        env,
        ev.userId,
        lang,
        t.handoff.messages.back_to_menu
      );
      return;
    }

    if (target.startsWith("@")) {
      const reason = target.slice(1);
      if (t.handoff?.reasons?.[reason]) {
        await enterHandoff(env, t, {
          platform: ev.platform,
          userId: ev.userId,
          userName: ev.userName,
          reason,
          lang,
          fromNode: from
        });
        return;
      }
    }

    const nodeId = t.nodes[target] ? target : "root";
    const rendered = renderNode(t, nodeId, lang, from, ev.platform);
    if (ev.platform === "wa") await sendWaRendered(env, ev.userId, rendered);
    else await sendFbRendered(env, ev.userId, rendered);
    return;
  }

  // 2. If in PENDING or ACTIVE state, suppress bot responses except for "menu" or idle notice
  if (stateRow) {
    if (ev.kind === "text") {
      const kw = matchKeyword(t, ev.text);
      if (kw === "menu") {
        const lang = stateRow.lang || (hasBengali(ev.text) ? "bn" : "en");
        await clearHandoffState(env, ev.platform, ev.userId);
        await sendTextThenRoot(
          ev.platform,
          env,
          ev.userId,
          lang,
          t.handoff.messages.back_to_menu
        );
        return;
      }
    }
    if (stateRow.state === "PENDING") {
      await handlePendingIdleNotice(env, t, ev.platform, ev.userId, stateRow);
    }
    return;
  }

  // 3. BOT state: handle incoming media
  if (ev.kind === "media") {
    const lang = hasBengali(ev.userName) ? "bn" : "bn";
    await enterHandoff(env, t, {
      platform: ev.platform,
      userId: ev.userId,
      userName: ev.userName,
      reason: "media",
      lang,
      isMediaTrigger: true
    });
    return;
  }

  // 4. BOT state: handle free text
  if (ev.kind === "text") {
    const kw = matchKeyword(t, ev.text);
    const isBn = hasBengali(ev.text);

    if (kw === "agent") {
      const lang = isBn ? "bn" : "en";
      await enterHandoff(env, t, {
        platform: ev.platform,
        userId: ev.userId,
        userName: ev.userName,
        reason: "agent",
        lang
      });
      return;
    }

    if (kw === "menu" || kw === "greeting") {
      if (isBn) {
        const rootMsg = renderNode(t, "root", "bn", "", ev.platform);
        if (ev.platform === "wa") await sendWaRendered(env, ev.userId, rootMsg);
        else await sendFbRendered(env, ev.userId, rootMsg);
      } else {
        const langMsg = renderLangSelect(t, ev.platform);
        if (ev.platform === "wa") await sendWaRendered(env, ev.userId, langMsg);
        else await sendFbRendered(env, ev.userId, langMsg);
      }
      return;
    }

    if (isBn) {
      await sendTextThenRoot(ev.platform, env, ev.userId, "bn", t.system.fallback);
    } else {
      const langMsg = renderLangSelect(t, ev.platform);
      if (ev.platform === "wa") await sendWaRendered(env, ev.userId, langMsg);
      else await sendFbRendered(env, ev.userId, langMsg);
    }
  }
}

/**
 * Processes the parsed webhook body asynchronously inside waitUntil.
 */
async function processWebhookBody(body, env) {
  let events = [];
  if (body?.object === "whatsapp_business_account") {
    events = extractWaEvents(body, env);
  } else if (body?.object === "page") {
    events = extractFbEvents(body);
  } else {
    return;
  }

  for (const ev of events) {
    try {
      await handleEvent(ev, env);
    } catch (err) {
      console.error("Event processing error:", err?.message || "Unknown error");
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Webhook verification handshake
    if (request.method === "GET" && url.pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token && token === env.VERIFY_TOKEN) {
        return new Response(challenge || "", {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // Webhook event receiver
    if (request.method === "POST" && url.pathname === "/webhook") {
      const rawBody = await request.text();
      const signature = request.headers.get("X-Hub-Signature-256") || "";
      const valid = await verifySignature(rawBody, signature, env.META_APP_SECRET);

      if (!valid) {
        return new Response("Unauthorized", { status: 401 });
      }

      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      ctx.waitUntil(processWebhookBody(parsed, env));
      return new Response("OK", { status: 200 });
    }

    // Optional Messenger profile setup route
    if (request.method === "POST" && url.pathname === "/admin/setup-messenger") {
      const adminKey = request.headers.get("X-Admin-Key");
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      const result = await setupMessengerProfile(env);
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
