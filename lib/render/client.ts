/**
 * The one inline client script. Hand-written, no framework, and no network
 * access except Live's existing `/api/live` poll -- which is emitted only when
 * a poll interval is given, so `report` ships a script that fetches nothing.
 *
 * Rendering stays on the server. This only decorates what is already there:
 *
 *  1. Tooltips   a mark shows its text on hover or keyboard focus: an SVG
 *                mark's `<title>` child, or an HTML element's `data-tip`
 *                (the SVG marks carry no `data-tip` copy -- I4). The text
 *                goes in with `textContent`, never as markup. Each chart,
 *                sparkline and composition bar is one tab stop:
 *                focus shows its first mark, and the arrow keys walk the
 *                rest (M3), rather than a tab stop per mark.
 *  2. Count-up   `data-count` numbers animate on first load only, and only
 *                when the attribute is a finite number. A null never counts up
 *                from 0 (spec §4.2, rule 3).
 *  3. Sorting    `table.sortable` headers -- buttons, so Enter and Space
 *                work -- sort rows by each cell's `data-sort`; an empty
 *                `data-sort` (no value) sorts last in both directions. A
 *                `data-text` header compares as text, always, so an id that
 *                happens to be all digits cannot sort as a number (M2).
 *  4. Settings   theme + nav mode, persisted as `wt.theme` / `wt.nav`, with
 *                storage touched only inside `try`.
 *  5. Toggles    a `[data-range-to=k]` button shows the `[data-range=k]` blocks
 *                inside its nearest `[data-ranges]` (else the document) and
 *                hides the rest; `[data-metric-to]` / `[data-metric]` /
 *                `[data-metrics]` work the same way.
 *  6. Live poll  swaps the inner HTML of each `[data-live]` region and touches
 *                nothing else, so the theme and the card that holds a region
 *                (and its running effects) survive every poll.
 *
 * Motion: entrance animations are CSS scoped to `html:not(.settled)`. The
 * script adds `settled` once they have had time to play, and again before any
 * poll swaps content, so a poll can never replay an entrance.
 *
 * `window.wt` exposes the pieces for tests; nothing on the page depends on it.
 */
import { THEMES } from "./theme.ts";

/** How long the entrance animations get before `settled` switches them off. */
export const SETTLE_MS = 1800;

export function clientScript(opts: { pollSeconds?: number } = {}): string {
  const pollMs = opts.pollSeconds === undefined ? 0 : Math.round(opts.pollSeconds * 1000);
  const poll = pollMs > 0
    ? `
  // Live poll: server-rendered regions, swapped in place. One renderer.
  function tick() {
    fetch("/api/live", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j.html === "string") swap(j.html); })
      .catch(function () { /* a failed poll leaves the last good render in place */ })
      .then(function () { w.setTimeout(tick, ${pollMs}); });
  }
  w.setTimeout(tick, ${pollMs});`
    : "";

  return `(function () {
  "use strict";
  var w = window, d = document, root = d.documentElement;
  var THEMES = ${JSON.stringify(THEMES)}, NAVS = ["pills", "sidebar"];
  var wt = (w.wt = {});
  function each(scope, sel, fn) { var l = scope.querySelectorAll(sel); for (var i = 0; i < l.length; i++) fn(l[i], i); }
  function up(el, sel) { return el && el.closest ? el.closest(sel) : null; }

  // Settings. Storage can throw on access itself (Safari private mode,
  // file://), so every touch is inside try and the fallback is amber + pills.
  function settings() {
    var t = null, n = null;
    try { var s = w.localStorage; t = s.getItem("wt.theme"); n = s.getItem("wt.nav"); } catch (e) { t = null; n = null; }
    return { theme: THEMES.indexOf(t) >= 0 ? t : "amber", nav: NAVS.indexOf(n) >= 0 ? n : "pills" };
  }
  function remember(k, v) { try { w.localStorage.setItem(k, v); } catch (e) { /* not persisted; still applied */ } }
  function show(s) {
    root.setAttribute("data-theme", s.theme);
    root.setAttribute("data-nav", s.nav);
    each(d, "[data-set-theme]", function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-set-theme") === s.theme)); });
    each(d, "[data-set-nav]", function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-set-nav") === s.nav)); });
  }
  function current() { return { theme: root.getAttribute("data-theme") || "amber", nav: root.getAttribute("data-nav") || "pills" }; }
  function panel(open) {
    var p = d.getElementById("wt-settings"), g = d.querySelector("[data-settings-toggle]");
    if (!p) return;
    p.hidden = !open;
    if (g) g.setAttribute("aria-expanded", String(open));
  }
  wt.settings = settings;

  // Count-up: only a finite data-count animates. "", "null", "NaN" do not.
  function finite(v) { return v !== null && v.trim() !== "" && isFinite(Number(v)); }
  var raf = w.requestAnimationFrame
    ? function (f) { w.requestAnimationFrame(f); }
    : function (f) { w.setTimeout(function () { f(Date.now()); }, 16); };
  function countUp(el) {
    var v = el.getAttribute("data-count");
    if (!finite(v)) return false;
    var node = null, kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 3) { node = kids[i]; break; }
    if (!node) return false;
    var text = node.nodeValue, m = /-?\\d[\\d,]*(\\.\\d+)?/.exec(text);
    var pre = m ? text.slice(0, m.index) : "", post = m ? text.slice(m.index + m[0].length) : "";
    var target = Number(v), dec = (v.split(".")[1] || "").length, group = !!m && m[0].indexOf(",") >= 0, t0 = null;
    function fmt(x) {
      var s = x.toFixed(dec).split(".");
      if (group) s[0] = s[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
      return pre + s.join(".") + post;
    }
    function step(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / 900);
      node.nodeValue = p < 1 ? fmt(target * (1 - Math.pow(1 - p, 3))) : text;
      if (p < 1) raf(step);
    }
    node.nodeValue = fmt(0);
    raf(step);
    return true;
  }
  wt.countUp = countUp;

  // Sorting. Empty data-sort is no value: last whichever way the column runs.
  function sortKey(row, col, text) {
    var c = row.children[col], v = c ? c.getAttribute("data-sort") : null;
    if (v === null || v === "") return null;
    var n = Number(v);
    return !text && isFinite(n) ? n : v;
  }
  function sortTable(table, col, dir, text) {
    var body = table.querySelector("tbody");
    if (!body) return;
    if (text === undefined) { var h = table.querySelectorAll("thead th")[col]; text = !!h && h.hasAttribute("data-text"); }
    var rows = Array.prototype.slice.call(body.children);
    rows.sort(function (a, b) {
      var x = sortKey(a, col, text), y = sortKey(b, col, text);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      var c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return dir === "desc" ? -c : c;
    });
    for (var i = 0; i < rows.length; i++) body.appendChild(rows[i]);
  }
  wt.sort = sortTable;
  function onSort(th) {
    var table = up(th, "table"), row = th.parentNode, col = Array.prototype.indexOf.call(row.children, th);
    var dir = th.getAttribute("aria-sort") === "descending" ? "asc" : "desc";
    each(row, "th", function (h) { h.removeAttribute("aria-sort"); });
    th.setAttribute("aria-sort", dir === "desc" ? "descending" : "ascending");
    sortTable(table, col, dir);
  }

  // Toggles: range and metric blocks rendered side by side, one shown.
  function flip(btn, kind) {
    var key = btn.getAttribute("data-" + kind + "-to"), scope = up(btn, "[data-" + kind + "s]") || d;
    each(scope, "[data-" + kind + "]", function (el) { el.hidden = el.getAttribute("data-" + kind) !== key; });
    each(scope, "[data-" + kind + "-to]", function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-" + kind + "-to") === key)); });
  }
  wt.flip = flip;

  // Tooltips. A mark's text: data-tip, else its own <title> child.
  var tip = null, GROUPS = "figure.chart svg, svg.spark, .comp";
  function tipText(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.hasAttribute("data-tip")) return el.getAttribute("data-tip");
    var t = el.firstElementChild;
    return t && String(t.tagName).toLowerCase() === "title" ? t.textContent : null;
  }
  function markOf(el) { for (; el && el !== d; el = el.parentNode) if (tipText(el) !== null) return el; return null; }
  function tipAt(el, x, y) {
    if (!tip) { tip = d.createElement("div"); tip.className = "tip"; tip.setAttribute("role", "tooltip"); d.body.appendChild(tip); }
    tip.textContent = tipText(el);
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(x + 14, w.innerWidth - tip.offsetWidth - 8)) + "px";
    tip.style.top = Math.max(8, y - tip.offsetHeight - 10) + "px";
  }
  function tipOff() { if (tip) tip.hidden = true; }
  wt.tipText = tipText;
  d.addEventListener("mouseover", function (e) { var el = markOf(e.target); if (el) tipAt(el, e.clientX, e.clientY); else tipOff(); });
  d.addEventListener("mousemove", function (e) { var el = markOf(e.target); if (el) tipAt(el, e.clientX, e.clientY); });

  // Keyboard: one tab stop per group of marks; arrows walk the marks.
  function marks(g) {
    if (tipText(g) !== null) return [g];
    var out = [];
    each(g, "*", function (el) { if (tipText(el) !== null) out.push(el); });
    return out;
  }
  function focusable(scope) {
    each(scope, GROUPS, function (g) { if (!g.hasAttribute("tabindex") && marks(g).length > 0) g.setAttribute("tabindex", "0"); });
  }
  function showMark(g, k) {
    var m = marks(g);
    if (m.length === 0) return;
    k = (k + m.length) % m.length;
    g.setAttribute("data-at", String(k));
    var r = m[k].getBoundingClientRect();
    tipAt(m[k], r.left + r.width / 2, r.top);
  }
  wt.focusable = focusable;
  wt.showMark = showMark;
  d.addEventListener("focusin", function (e) {
    var t = e.target;
    if (t && t.matches && t.matches(GROUPS)) { showMark(t, Number(t.getAttribute("data-at")) || 0); return; }
    var el = markOf(t);
    if (el) { var r = el.getBoundingClientRect(); tipAt(el, r.left + r.width / 2, r.top); }
  });
  d.addEventListener("focusout", tipOff);

  d.addEventListener("click", function (e) {
    var t = e.target, b, s;
    if ((b = up(t, "[data-set-theme]"))) {
      s = current(); s.theme = b.getAttribute("data-set-theme");
      if (THEMES.indexOf(s.theme) >= 0) { remember("wt.theme", s.theme); show(s); }
      return;
    }
    if ((b = up(t, "[data-set-nav]"))) {
      s = current(); s.nav = b.getAttribute("data-set-nav");
      if (NAVS.indexOf(s.nav) >= 0) { remember("wt.nav", s.nav); show(s); }
      return;
    }
    if ((b = up(t, "[data-settings-toggle]"))) { var p = d.getElementById("wt-settings"); panel(!!p && p.hidden); return; }
    if ((b = up(t, "[data-range-to]"))) { flip(b, "range"); return; }
    if ((b = up(t, "[data-metric-to]"))) { flip(b, "metric"); return; }
    if ((b = up(t, "table.sortable th"))) { onSort(b); return; }
    if (!up(t, "#wt-settings")) panel(false);
  });
  d.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { panel(false); tipOff(); return; }
    var g = e.target, step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step && g && g.matches && g.matches(GROUPS)) { e.preventDefault(); showMark(g, (Number(g.getAttribute("data-at")) || 0) + step); }
  });

  // Motion: count up once, then settle so nothing entrance-y ever replays.
  function settle() { root.classList.add("settled"); }
  function swap(html) {
    settle();
    var live = {};
    each(d, "[data-live]", function (el) { live[el.getAttribute("data-live")] = el; });
    var tpl = d.createElement("template");
    tpl.innerHTML = html;
    each(tpl.content, "[data-live]", function (f) { var cur = live[f.getAttribute("data-live")]; if (cur) cur.innerHTML = f.innerHTML; });
    focusable(d);
  }
  wt.swap = swap;
  var still = !!(w.matchMedia && w.matchMedia("(prefers-reduced-motion: reduce)").matches);
  show(settings());
  focusable(d);
  if (!still) each(d, "[data-count]", countUp);
  w.setTimeout(settle, still ? 0 : ${SETTLE_MS});${poll}
})();`;
}
