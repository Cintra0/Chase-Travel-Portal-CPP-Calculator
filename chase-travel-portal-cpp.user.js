// ==UserScript==
// @name         Chase Travel Portal CPP Calculator
// @namespace    https://chase.com/travel-portal-cpp
// @version      1.2
// @description  Shows cents-per-point values on Chase Travel hotel and flight results when cash and points prices are visible.
// @author       Codex
// @match        https://travel.chase.com/*
// @match        https://*.travel.chase.com/*
// @match        https://travelsecure.chase.com/*
// @match        https://*.travelsecure.chase.com/*
// @match        https://ultimaterewardstravel.chase.com/*
// @match        https://*.ultimaterewardstravel.chase.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    debounceMs: 300,
    goodCpp: 2.0,
    preferTotalPrice: true,
  };

  const STYLE_ID = "codex-chase-portal-cpp-style";
  const BADGE_CLASS = "codex-chase-portal-cpp-badge";
  const KNOWN_BADGE_SELECTOR = [
    ".codex-chase-portal-cpp-badge",
    ".codex-chase-flight-cpp-badge",
    ".codex-chase-cpp-badge",
  ].join(", ");
  const observedRoots = new WeakSet();

  const moneyRegex = /\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/g;
  const pointRegex = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,}|[0-9]+)(?:\s|[^\d$]){0,24}(?:pts?|points)\b/gi;
  const boostCueRegex = /\bpoints?\s*boost\b|was\s+[0-9,]+\s*(?:pts?|points)\b/i;
  const hotelCueRegex = /\b(?:hotel|hotels|nightly average|all-in total|the edit benefits|star|property credit|breakfast)\b/i;
  const flightCueRegex =
    /\b(?:flight|flights|airline|airlines|depart|departure|arrive|arrival|round trip|one way|nonstop|layover|stops?|economy|premium economy|business|first class|main cabin|basic economy|fare)\b/i;

  function styleText() {
    return `
      .${BADGE_CLASS} {
        display: inline-flex;
        align-items: center;
        margin: 6px 0 0;
        padding: 4px 7px;
        border-radius: 6px;
        border: 1px solid rgba(0, 82, 204, 0.25);
        background: #f3f8ff;
        color: #102a43;
        font: 700 12px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 1px 2px rgba(16, 42, 67, 0.08);
        width: fit-content;
        max-width: 100%;
      }
    `;
  }

  function installStyleForRoot(root) {
    if (!root || root.getElementById?.(STYLE_ID) || root.querySelector?.(`#${STYLE_ID}`)) return;

    const doc = root.ownerDocument || document;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = styleText();
    root.appendChild(style);
  }

  function installStyle() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = styleText();
      document.head.appendChild(style);
    }

    for (const doc of scanDocuments()) {
      for (const root of scanRoots(doc)) {
        if (root instanceof ShadowRoot) installStyleForRoot(root);
      }
    }
  }

  function scanDocuments() {
    const docs = [document];

    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument?.body) docs.push(frame.contentDocument);
      } catch {
        // Cross-origin frames cannot be read. Chase's result frame is usually readable.
      }
    }

    return [...new Set(docs)];
  }

  function scanRoots(doc = document) {
    const roots = [];
    const seen = new Set();

    function addRoot(root) {
      if (!root || seen.has(root)) return;
      seen.add(root);
      roots.push(root);

      const elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const element of elements) {
        if (element.shadowRoot) addRoot(element.shadowRoot);
      }
    }

    addRoot(doc.body);
    return roots;
  }

  function isVisible(node) {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    const styles = node.ownerDocument.defaultView.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && styles.visibility !== "hidden" && styles.display !== "none";
  }

  function visibleElements() {
    const elements = [];

    for (const doc of scanDocuments()) {
      for (const root of scanRoots(doc)) {
        for (const node of root.querySelectorAll?.("*") || []) {
          if (isVisible(node) && !node.closest(`${KNOWN_BADGE_SELECTOR}, script, style, noscript`)) {
            elements.push(node);
          }
        }
      }
    }

    return elements;
  }

  function elementOwnText(node) {
    return [...node.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent || "")
      .join(" ")
      .trim();
  }

  function elementText(node) {
    return (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function nearbyAncestorText(node) {
    let current = node.parentElement;
    let text = "";

    for (let depth = 0; current && depth < 5; depth += 1) {
      const nextText = elementText(current);
      if (nextText.length <= 3000) text = `${text} ${nextText}`;
      current = current.parentElement;
    }

    return text;
  }

  function parseMoneyValues(text) {
    const values = [];
    for (const match of text.matchAll(moneyRegex)) {
      const value = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(value) && value > 0) values.push(value);
    }
    return values;
  }

  function parsePointValues(text) {
    const values = [];
    for (const match of text.matchAll(pointRegex)) {
      const value = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(value) && value >= 1000) values.push(value);
    }
    return values;
  }

  function pickCashValue(values, text) {
    if (!values.length) return null;

    if (CONFIG.preferTotalPrice && /total|trip total|stay total|all-in|including taxes|taxes and fees|cash price/i.test(text)) {
      return Math.max(...values);
    }

    return values[0];
  }

  function pickPointValue(values) {
    if (!values.length) return null;
    return Math.min(...values);
  }

  function hasCashAndPoints(text) {
    return text.includes("$") && /(?:pts?|points)\b/i.test(text);
  }

  function hasBoostCue(text) {
    return boostCueRegex.test(text);
  }

  function looksLikePortalPriceBlock(node) {
    const text = elementText(node);
    const rect = node.getBoundingClientRect();

    if (!hasCashAndPoints(text)) return false;
    if (!hasBoostCue(text)) return false;
    if (text.length > 750 || rect.width > 820 || rect.height > 380) return false;
    if (!/\bor\b|points|pts|total|fare|price|was\s+[0-9,]+/i.test(text)) return false;

    const context = `${text} ${nearbyAncestorText(node)}`;
    return hotelCueRegex.test(context) || flightCueRegex.test(context);
  }

  function findPriceBlockFromCash(cashNode) {
    let current = cashNode;

    while (current) {
      if (looksLikePortalPriceBlock(current)) return current;
      current = current.parentElement;
    }

    return null;
  }

  function candidatePriceBlocks() {
    const blocks = new Set();

    for (const node of visibleElements()) {
      const text = elementText(node);
      const ownText = elementOwnText(node);

      if (/^\$\s?[0-9,]+(?:\.[0-9]{2})?$/.test(ownText) || /^\$\s?[0-9,]+(?:\.[0-9]{2})?\b/.test(text)) {
        const block = findPriceBlockFromCash(node);
        if (block) blocks.add(block);
      }

      if (looksLikePortalPriceBlock(node)) blocks.add(node);
    }

    return [...blocks].filter((block, index, candidates) => {
      return !candidates.some((other, otherIndex) => otherIndex !== index && block.contains(other));
    });
  }

  function displayedCpp(cpp) {
    return Number(cpp.toFixed(cpp >= 10 ? 1 : 2));
  }

  function isGoodCpp(cpp) {
    return displayedCpp(cpp) >= CONFIG.goodCpp;
  }

  function scoreColor(cpp) {
    return isGoodCpp(cpp) ? "#067647" : "#8a4b00";
  }

  function formatCpp(cpp) {
    return `${displayedCpp(cpp).toFixed(cpp >= 10 ? 1 : 2)} cpp`;
  }

  function makeBadge(doc, cpp) {
    const badge = doc.createElement("div");
    badge.className = BADGE_CLASS;
    badge.style.borderColor = `${scoreColor(cpp)}55`;
    badge.style.background = isGoodCpp(cpp) ? "#e8f8ef" : "#fff8e1";
    badge.style.color = scoreColor(cpp);
    badge.textContent = formatCpp(cpp);
    return badge;
  }

  function removeDuplicateBadges(block) {
    const badges = [...block.querySelectorAll(KNOWN_BADGE_SELECTOR)];
    for (const badge of badges) {
      badge.remove();
    }
  }

  function annotateBlock(block) {
    const existingBadges = [...block.querySelectorAll(KNOWN_BADGE_SELECTOR)];
    if (existingBadges.length === 1 && existingBadges[0].classList.contains(BADGE_CLASS)) return;
    if (existingBadges.length) {
      removeDuplicateBadges(block);
    }

    const text = elementText(block);
    const cash = pickCashValue(parseMoneyValues(text), text);
    const points = pickPointValue(parsePointValues(text));

    if (!cash || !points) return;

    const cpp = (cash / points) * 100;
    if (!Number.isFinite(cpp) || cpp < 0.2 || cpp > 15) return;
    if (displayedCpp(cpp) <= 1.0) return;

    block.appendChild(makeBadge(block.ownerDocument, cpp));
  }

  function observeDiscoveredRoots() {
    for (const doc of scanDocuments()) {
      for (const root of scanRoots(doc)) {
        if (observedRoots.has(root)) continue;
        observedRoots.add(root);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  function scan() {
    installStyle();
    observeDiscoveredRoots();

    for (const block of candidatePriceBlocks()) {
      annotateBlock(block);
    }
  }

  function debounce(fn, wait) {
    let timeout = null;
    return () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(fn, wait);
    };
  }

  const scheduleScan = debounce(scan, CONFIG.debounceMs);
  const observer = new MutationObserver(scheduleScan);

  scan();
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
})();
