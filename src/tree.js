import rawTree from "./tree.json";

let compiledTree = null;

/**
 * Expands product_template and products into tree.nodes once per isolate,
 * and precomputes lowercase keyword Sets for O(1) matching.
 */
export function getTree() {
  if (compiledTree) {
    return compiledTree;
  }

  const nodes = { ...(rawTree.nodes || {}) };
  const template = rawTree.product_template;
  const products = rawTree.products || {};

  if (template && products) {
    const sections = template.sections || {};
    const sectionKeys = ["details", "price", "size", "color"];

    for (const productKey of Object.keys(products)) {
      const menuNodeId = `p.${productKey}`;

      // Build menu options for p.<K>
      const menuOptions = (template.options || []).map((opt) => {
        if (opt.section) {
          return {
            to: `p.${productKey}.${opt.section}`,
            label: opt.label
          };
        }
        return { ...opt };
      });

      nodes[menuNodeId] = {
        text: template.menu_text,
        options: menuOptions,
        nav: template.nav,
        productKey
      };

      // Build section answer nodes p.<K>.<section>
      for (const secKey of sectionKeys) {
        const secDef = sections[secKey];
        if (!secDef) continue;

        const secNodeId = `p.${productKey}.${secKey}`;
        const secOptions = [];

        if (secDef.cta_order) {
          secOptions.push({
            handoff: "order",
            label: rawTree.ui?.order
          });
        }

        if (Array.isArray(secDef.options)) {
          for (const o of secDef.options) {
            if (o.section) {
              secOptions.push({
                to: `p.${productKey}.${o.section}`,
                label: o.label
              });
            } else {
              secOptions.push({ ...o });
            }
          }
        }

        nodes[secNodeId] = {
          text: secDef.text,
          options: secOptions,
          nav: secDef.nav,
          productKey
        };
      }
    }
  }

  // Precompute keyword lookup tables
  const kwMap = {
    menu: new Set(),
    greeting: new Set(),
    agent: new Set()
  };

  const rawKeywords = rawTree.system?.keywords || {};
  for (const type of ["menu", "greeting", "agent"]) {
    const list = rawKeywords[type];
    if (Array.isArray(list)) {
      for (const word of list) {
        if (typeof word === "string") {
          kwMap[type].add(word.trim().toLowerCase());
        }
      }
    }
  }

  compiledTree = {
    ...rawTree,
    nodes,
    _kwMap: kwMap
  };

  return compiledTree;
}

/**
 * Matches trimmed input text case-insensitively against system.keywords.
 * Returns "menu" | "greeting" | "agent" | null.
 */
export function matchKeyword(tree, text) {
  if (typeof text !== "string") return null;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const { _kwMap } = tree;
  if (_kwMap.agent.has(normalized)) return "agent";
  if (_kwMap.menu.has(normalized)) return "menu";
  if (_kwMap.greeting.has(normalized)) return "greeting";
  return null;
}

/**
 * Extracts product key from a node ID like "p.hoodie" or "p.hoodie.price".
 */
export function getProductKeyFromNodeId(tree, nodeId) {
  if (!nodeId || typeof nodeId !== "string") return null;
  if (tree.nodes[nodeId]?.productKey) {
    return tree.nodes[nodeId].productKey;
  }
  if (nodeId.startsWith("p.")) {
    const parts = nodeId.split(".");
    if (parts[1] && tree.products?.[parts[1]]) {
      return parts[1];
    }
  }
  return null;
}
