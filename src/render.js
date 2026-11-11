import { getProductKeyFromNodeId } from "./tree.js";
import { stripAsterisks } from "./util.js";

/**
 * Picks localized value from {bn, en} object or returns raw value.
 */
export function pickLang(val, lang) {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    if (lang in val) return val[lang];
    if ("bn" in val) return val.bn;
    if ("en" in val) return val.en;
  }
  return val;
}

/**
 * Resolves a single placeholder expression like "c.delivery_dhaka" or "p.name".
 */
function lookupToken(expr, lang, tree, productKey, extraVars) {
  const trimmed = expr.trim();
  if (extraVars && trimmed in extraVars) {
    return extraVars[trimmed];
  }
  if (trimmed.startsWith("c.")) {
    const key = trimmed.slice(2);
    const raw = tree.config?.[key];
    return pickLang(raw, lang);
  }
  if (trimmed.startsWith("p.")) {
    if (!productKey || !tree.products?.[productKey]) return undefined;
    const key = trimmed.slice(2);
    const raw = tree.products[productKey]?.[key];
    return pickLang(raw, lang);
  }
  return undefined;
}

/**
 * Resolves a single template line into zero, one, or multiple lines.
 * - Drops the line if any placeholder resolves to null, undefined, or "".
 * - Expands array values in place across lines.
 */
function resolveSingleLine(line, lang, tree, productKey, extraVars) {
  if (typeof line !== "string") return [];
  if (line === "") return [""];

  const regex = /\{\{([^}]+)\}\}/g;
  if (!regex.test(line)) {
    return [line];
  }

  let currentLines = [line];
  regex.lastIndex = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    const fullToken = match[0];
    const expr = match[1];
    const resolved = lookupToken(expr, lang, tree, productKey, extraVars);

    if (resolved === undefined || resolved === null || resolved === "") {
      return [];
    }

    if (Array.isArray(resolved)) {
      const expanded = [];
      for (const item of resolved) {
        const itemVal = pickLang(item, lang);
        if (itemVal === undefined || itemVal === null || itemVal === "") continue;
        expanded.push(String(itemVal));
      }
      if (expanded.length === 0) return [];

      const nextLines = [];
      for (const cur of currentLines) {
        for (const rep of expanded) {
          nextLines.push(cur.replace(fullToken, rep));
        }
      }
      currentLines = nextLines;
    } else {
      const strVal = String(resolved);
      currentLines = currentLines.map((cur) => cur.replace(fullToken, strVal));
    }
  }

  return currentLines;
}

/**
 * Resolves a localized text block ({bn:[], en:[]} or string[]) into a single string.
 * Strips *bold* asterisks when rendering for Messenger ("fb").
 */
export function resolveLines(textObj, lang, tree, productKey = null, platform = "wa", extraVars = null) {
  if (!textObj) return "";
  const lines = Array.isArray(textObj) ? textObj : pickLang(textObj, lang);
  if (!Array.isArray(lines)) {
    const str = typeof lines === "string" ? lines : "";
    return platform === "fb" ? stripAsterisks(str) : str;
  }

  const out = [];
  for (const rawLine of lines) {
    const resolved = resolveSingleLine(rawLine, lang, tree, productKey, extraVars);
    for (const l of resolved) {
      out.push(l);
    }
  }

  const joined = out.join("\n");
  return platform === "fb" ? stripAsterisks(joined) : joined;
}

/**
 * Resolves a single label object ({bn, en} or string) into a localized string.
 */
export function resolveLabel(labelObj, lang, platform = "wa") {
  const val = pickLang(labelObj, lang);
  if (val === undefined || val === null) return "";
  const str = Array.isArray(val) ? val.join(" ") : String(val);
  return platform === "fb" ? stripAsterisks(str) : str;
}

/**
 * Renders a menu or answer node into { text, choices: [{ payload, label }] }.
 */
export function renderNode(tree, nodeId, lang, fromNodeId = "", platform = "wa") {
  const actualId = tree.nodes[nodeId] ? nodeId : "root";
  const node = tree.nodes[actualId];
  const productKey =
    getProductKeyFromNodeId(tree, actualId) || getProductKeyFromNodeId(tree, fromNodeId);

  const text = resolveLines(node.text, lang, tree, productKey, platform);
  const choices = [];

  if (Array.isArray(node.options)) {
    for (const opt of node.options) {
      const label = resolveLabel(opt.label, lang, platform);
      if (!label) continue;

      if (opt.to) {
        choices.push({ payload: `${lang}|${opt.to}|${actualId}`, label });
      } else if (opt.handoff) {
        choices.push({ payload: `${lang}|@${opt.handoff}|${actualId}`, label });
      } else if (opt.action === "lang") {
        choices.push({ payload: `${lang}|@lang|`, label });
      }
    }
  }

  const navList = node.nav ?? tree.ui?.default_nav ?? [];
  for (const navName of navList) {
    const navLabel = resolveLabel(tree.ui?.[navName], lang, platform);
    if (!navLabel) continue;

    if (navName === "back") {
      const backTarget = fromNodeId || "root";
      choices.push({ payload: `${lang}|${backTarget}|`, label: navLabel });
    } else if (navName === "root") {
      choices.push({ payload: `${lang}|root|`, label: navLabel });
    } else if (navName === "agent") {
      choices.push({ payload: `${lang}|@agent|${actualId}`, label: navLabel });
    }
  }

  return { text, choices, lang };
}

/**
 * Renders the system.lang_select screen.
 */
export function renderLangSelect(tree, platform = "wa") {
  const sysLang = tree.system?.lang_select || {};
  const text = resolveLines(sysLang.text || [], "bn", tree, null, platform);
  const choices = (sysLang.buttons || []).map((btn) => ({
    payload: `${btn.lang}|root|`,
    label: resolveLabel(btn.label, btn.lang, platform)
  }));
  return { text, choices, lang: "bn" };
}
