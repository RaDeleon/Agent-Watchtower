import { describe, expect, it } from "vitest";
import { SETTLE_MS, clientScript } from "@/lib/render/client";
import { El, TextNode, runClient } from "./helpers/dom-stub.ts";

const script = clientScript({ pollSeconds: 5 });

/** The first text node of the element with this id. */
function text(h: ReturnType<typeof runClient>, id: string): TextNode {
  const el = h.document.getElementById(id);
  const node = el?.childNodes.find((n): n is TextNode => n instanceof TextNode);
  if (!node) throw new Error(`no text node in #${id}`);
  return node;
}

describe("clientScript", () => {
  // (a) Spec §4.4 budget.
  it("stays within 12 KB unminified", () => {
    expect(script.length).toBeLessThanOrEqual(12 * 1024);
  });

  // (b) The only network access the dashboard has is Live's poll.
  it("contains exactly one fetch, and it is /api/live", () => {
    const calls = [...script.matchAll(/fetch\(/g)];
    expect(calls).toHaveLength(1);
    expect([...script.matchAll(/fetch\(\s*"([^"]*)"/g)].map((m) => m[1])).toEqual(["/api/live"]);
  });

  // `report` is a file: without a poll interval there is no poller at all.
  it("emits no fetch and no /api/ path without a poll interval", () => {
    const s = clientScript({});
    expect(s).not.toContain("fetch(");
    expect(s).not.toContain("/api/");
  });

  it("touches storage only inside try", () => {
    // Every line that reads or writes localStorage is a try line.
    const touches = script.split("\n").filter((l) => l.includes("localStorage"));
    expect(touches.length).toBeGreaterThanOrEqual(2);
    for (const l of touches) expect(l, l.trim()).toMatch(/\btry\s*\{/);
  });
});

// (c) Review Focus 1: a browser with storage blocked renders amber + pills and
// throws nothing -- both when getItem throws and when merely touching
// window.localStorage does (Safari private mode, file://).
describe("settings with storage blocked", () => {
  for (const storage of ["getItem-throws", "access-throws"] as const) {
    it(`falls back to amber + pills when ${storage}`, () => {
      let h!: ReturnType<typeof runClient>;
      expect(() => {
        h = runClient(script, { body: "<main></main>", storage, stored: { "wt.theme": "bills" } });
      }).not.toThrow();
      const read = (h.window.wt as { settings: () => unknown }).settings;
      expect(read()).toEqual({ theme: "amber", nav: "pills" });
      expect(h.html.getAttribute("data-theme")).toBe("amber");
      expect(h.html.getAttribute("data-nav")).toBe("pills");
    });
  }

  it("applies a stored choice, and ignores a value that is not a theme", () => {
    const ok = runClient(script, { body: "<main></main>", stored: { "wt.theme": "raptors", "wt.nav": "sidebar" } });
    expect(ok.html.getAttribute("data-theme")).toBe("raptors");
    expect(ok.html.getAttribute("data-nav")).toBe("sidebar");
    const bad = runClient(script, { body: "<main></main>", stored: { "wt.theme": "\"><script>", "wt.nav": "x" } });
    expect(bad.html.getAttribute("data-theme")).toBe("amber");
    expect(bad.html.getAttribute("data-nav")).toBe("pills");
  });
});

// (d) Guard 5: count-up animates only a finite data-count. A null rendered as
// "" or "null" must never count up from 0.
describe("count-up", () => {
  const body =
    '<div id="real" class="big" data-count="3.00">$3.00</div>' +
    '<div id="blank" class="big" data-count="">—</div>' +
    '<div id="nul" class="big" data-count="null">—</div>';

  it("animates a finite value and skips '' and 'null'", () => {
    const h = runClient(script, { body });
    expect(text(h, "real").writes.length).toBeGreaterThan(0);
    expect(text(h, "blank").writes).toEqual([]);
    expect(text(h, "nul").writes).toEqual([]);
    h.runFrames(0);
    h.runFrames(10_000);
    // The animation always lands on the server's own text.
    expect(text(h, "real").nodeValue).toBe("$3.00");
    expect(text(h, "blank").writes).toEqual([]);
    expect(text(h, "nul").writes).toEqual([]);
  });

  it("keeps prefix, suffix and grouping, and starts from 0", () => {
    const h = runClient(script, { body: '<b id="k" data-count="1234.5">1,234.5k</b>' });
    expect(text(h, "k").writes[0]).toBe("0.0k");
    h.runFrames(0);
    h.runFrames(450);
    expect(text(h, "k").nodeValue).toMatch(/^1,\d{3}\.\dk$/);
    h.runFrames(10_000);
    expect(text(h, "k").nodeValue).toBe("1,234.5k");
  });

  it("does not animate at all under reduced motion", () => {
    const h = runClient(script, { body, reducedMotion: true });
    expect(text(h, "real").writes).toEqual([]);
  });
});

// (e) Motion rule 1: after the entrances have played, `settled` is set.
describe("settling", () => {
  it("adds html.settled after init", () => {
    const h = runClient(script, { body: "<main></main>" });
    h.runTimers(SETTLE_MS);
    expect(h.html.classList.contains("settled")).toBe(true);
  });

  it("settles at once under reduced motion", () => {
    const h = runClient(script, { body: "<main></main>", reducedMotion: true });
    h.runTimers(0);
    expect(h.html.classList.contains("settled")).toBe(true);
  });
});

// Review Focus 4: the poll swaps [data-live] regions and nothing else. The
// theme survives, the card holding a region is the same element afterwards,
// and the document is settled before any content lands in it.
describe("the Live poll", () => {
  const page =
    '<div id="live-root">' +
    '<section class="c hero" id="card"><h2>Current session</h2><div data-live="session">old session</div></section>' +
    '<section class="c"><h2>Recent events</h2><div data-live="events">old events</div></section>' +
    '<p id="static">not live</p></div>';
  const fresh =
    '<section class="c hero"><h2>Current session</h2><div data-live="session">new <b>session</b></div></section>' +
    '<section class="c"><h2>Recent events</h2><div data-live="events">new events</div></section>' +
    '<p>replaced?</p>';

  it("replaces only [data-live] regions, inside html.settled, keeping the theme", async () => {
    let calls: string[] = [];
    const h = runClient(script, {
      body: page,
      stored: { "wt.theme": "giants" },
      fetch: (url) => {
        calls.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ html: fresh }) });
      },
    });
    const card = h.document.getElementById("card")!;
    const root = h.document.getElementById("live-root")!;
    expect(h.html.classList.contains("settled")).toBe(false);

    h.runTimers(5000); // the settle timer and the first poll
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toEqual(["/api/live"]);
    const region = (k: string) => h.document.querySelector(`[data-live="${k}"]`)!;
    expect(region("session").innerHTML).toBe("new <b>session</b>");
    expect(region("events").innerHTML).toBe("new events");
    // Nothing but the regions was written.
    expect(root.innerHTMLWrites).toEqual([]);
    expect(card.innerHTMLWrites).toEqual([]);
    expect(h.document.body.innerHTMLWrites).toEqual([]);
    expect(h.document.getElementById("card")).toBe(card);
    expect(h.document.getElementById("static")!.textContent).toBe("not live");
    // Settled before the swap, and the theme is untouched.
    expect(h.html.classList.contains("settled")).toBe(true);
    expect(h.html.getAttribute("data-theme")).toBe("giants");
    // And it polls again.
    expect(h.timers.map((t) => t.ms)).toContain(5000);
    calls = [];
  });

  it("settles before swapping even when the poll beats the settle timer", () => {
    const h = runClient(clientScript({ pollSeconds: 1 }), { body: page });
    const swap = (h.window.wt as { swap: (html: string) => void }).swap;
    expect(h.html.classList.contains("settled")).toBe(false);
    swap(fresh);
    expect(h.html.classList.contains("settled")).toBe(true);
  });

  it("leaves the last good render in place when the poll fails", async () => {
    const h = runClient(script, { body: page, fetch: () => Promise.reject(new Error("offline")) });
    h.runTimers(5000);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.document.querySelector('[data-live="session"]')!.innerHTML).toBe("old session");
    expect(h.timers.map((t) => t.ms)).toContain(5000);
  });
});

describe("settings panel and toggles", () => {
  const click = (h: ReturnType<typeof runClient>, target: El) =>
    h.document.listeners.click.forEach((fn) => fn({ target }));

  it("switches and persists theme and nav from the popover", () => {
    const body =
      '<button id="gear" data-settings-toggle="" aria-expanded="false">s</button>' +
      '<div id="wt-settings" hidden=""><button id="t" data-set-theme="claude">Claude</button>' +
      '<button id="n" data-set-nav="sidebar">Sidebar</button></div>';
    const stored: Record<string, string> = {};
    const h = runClient(script, { body, stored });
    const panel = h.document.getElementById("wt-settings")!;
    click(h, h.document.getElementById("gear")!);
    expect(panel.hidden).toBe(false);
    click(h, h.document.getElementById("t")!);
    click(h, h.document.getElementById("n")!);
    expect(h.html.getAttribute("data-theme")).toBe("claude");
    expect(h.html.getAttribute("data-nav")).toBe("sidebar");
    expect(h.document.getElementById("t")!.getAttribute("aria-pressed")).toBe("true");
    click(h, h.document.body);
    expect(panel.hidden).toBe(true);
  });

  it("still switches theme with storage blocked, just without persisting", () => {
    const h = runClient(script, { body: '<button id="t" data-set-theme="bills">b</button>', storage: "access-throws" });
    expect(() => click(h, h.document.getElementById("t")!)).not.toThrow();
    expect(h.html.getAttribute("data-theme")).toBe("bills");
  });

  it("toggles range blocks within their group", () => {
    const body =
      '<div data-ranges=""><button id="r7" data-range-to="7d">7d</button><button data-range-to="30d">30d</button>' +
      '<div id="b7" data-range="7d" hidden="">a</div><div id="b30" data-range="30d">b</div></div>';
    const h = runClient(script, { body });
    click(h, h.document.getElementById("r7")!);
    expect(h.document.getElementById("b7")!.hidden).toBe(false);
    expect(h.document.getElementById("b30")!.hidden).toBe(true);
    expect(h.document.getElementById("r7")!.getAttribute("aria-pressed")).toBe("true");
  });
});

// Sorting (spec §4.4): a header click sorts by each cell's data-sort, and an
// empty data-sort -- no value, e.g. a session with no cost reading -- sorts
// last in BOTH directions, never as a 0.
describe("sortable tables", () => {
  const click = (h: ReturnType<typeof runClient>, target: El) =>
    h.document.listeners.click.forEach((fn) => fn({ target }));
  const body =
    '<table class="sortable"><thead><tr><th id="name">name</th><th id="cost">cost</th></tr></thead><tbody>' +
    '<tr><td data-sort="b">b</td><td data-sort="2.5">$2.50</td></tr>' +
    '<tr><td data-sort="n1">n1</td><td data-sort="">—</td></tr>' +
    '<tr><td data-sort="a">a</td><td data-sort="10">$10.00</td></tr>' +
    '<tr><td data-sort="z">z</td><td data-sort="0">$0.00</td></tr>' +
    '<tr><td data-sort="">?</td><td data-sort="">—</td></tr>' +
    "</tbody></table>";
  const order = (h: ReturnType<typeof runClient>) =>
    h.document.querySelector("tbody")!.children.map((tr) => tr.children[0].textContent);

  it("sorts numbers descending then ascending, with no-value rows last both ways", () => {
    const h = runClient(script, { body });
    const th = h.document.getElementById("cost")!;
    click(h, th);
    expect(th.getAttribute("aria-sort")).toBe("descending");
    expect(order(h).slice(0, 3)).toEqual(["a", "b", "z"]);
    expect(order(h).slice(3).sort()).toEqual(["?", "n1"]);
    click(h, th);
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    expect(order(h).slice(0, 3)).toEqual(["z", "b", "a"]);
    expect(order(h).slice(3).sort()).toEqual(["?", "n1"]);
  });

  it("sorts text, an empty value last", () => {
    const h = runClient(script, { body });
    click(h, h.document.getElementById("name")!);
    expect(order(h)).toEqual(["z", "n1", "b", "a", "?"]);
    click(h, h.document.getElementById("name")!);
    expect(order(h)).toEqual(["a", "b", "n1", "z", "?"]);
  });
});

// M2: a column of ids is text, even when an id looks like a number. Without
// data-text, "2e5" sorted as 200000 and "10" after "9".
describe("sortable tables: a text column of numeric-looking ids", () => {
  const click = (h: ReturnType<typeof runClient>, target: El) =>
    h.document.listeners.click.forEach((fn) => fn({ target }));
  const body =
    '<table class="sortable"><thead><tr><th data-text id="sid"><button type="button" class="th-sort" id="sb">session</button></th></tr></thead><tbody>' +
    '<tr><td data-sort="9">9</td></tr><tr><td data-sort="2e5">2e5</td></tr><tr><td data-sort="10">10</td></tr>' +
    "</tbody></table>";
  const order = (h: ReturnType<typeof runClient>) =>
    h.document.querySelector("tbody")!.children.map((tr) => tr.children[0].textContent);

  it("sorts the ids as strings, from a click on the header's button", () => {
    const h = runClient(script, { body });
    click(h, h.document.getElementById("sb")!); // the button, as Enter or Space would
    expect(h.document.getElementById("sid")!.getAttribute("aria-sort")).toBe("descending");
    expect(order(h)).toEqual(["9", "2e5", "10"]);
    click(h, h.document.getElementById("sb")!);
    expect(order(h)).toEqual(["10", "2e5", "9"]);
  });
});

// I4 + M3: a mark's tooltip is its own <title> (there is no data-tip copy), and
// every group of marks is one tab stop whose arrow keys walk the marks.
describe("tooltips from <title>, and the keyboard", () => {
  const body =
    '<figure class="chart"><svg id="g" viewBox="0 0 10 10"><line class="axis"/>' +
    '<rect class="hit" id="m0"><title>a: 1</title></rect><rect class="hit" id="m1"><title>b: 2</title></rect></svg></figure>' +
    '<figure class="chart"><svg id="empty" viewBox="0 0 10 10"><line class="axis"/></svg></figure>';
  const tipEl = (h: ReturnType<typeof runClient>) => h.document.querySelector(".tip");
  const key = (h: ReturnType<typeof runClient>, target: El, k: string) =>
    h.document.listeners.keydown.forEach((fn) => fn({ target, key: k, preventDefault() {} }));

  it("reads a mark's text from its <title>, and has none for an element without one", () => {
    const h = runClient(script, { body });
    const tipText = (h.window.wt as { tipText: (el: El) => string | null }).tipText;
    expect(tipText(h.document.getElementById("m1")!)).toBe("b: 2");
    expect(tipText(h.document.getElementById("g")!)).toBeNull();
    h.document.listeners.mouseover.forEach((fn) => fn({ target: h.document.getElementById("m0")!.children[0], clientX: 5, clientY: 5 }));
    expect(tipEl(h)!.textContent).toBe("a: 1");
    expect(tipEl(h)!.hidden).toBe(false);
  });

  it("makes a group with marks one tab stop, and leaves a group with none alone", () => {
    const h = runClient(script, { body });
    expect(h.document.getElementById("g")!.getAttribute("tabindex")).toBe("0");
    expect(h.document.getElementById("empty")!.getAttribute("tabindex")).toBeNull();
  });

  it("shows the first mark on focus, walks with the arrows, wraps, and hides on Escape", () => {
    const h = runClient(script, { body });
    const g = h.document.getElementById("g")!;
    h.document.listeners.focusin.forEach((fn) => fn({ target: g }));
    expect(tipEl(h)!.textContent).toBe("a: 1");
    key(h, g, "ArrowRight");
    expect(tipEl(h)!.textContent).toBe("b: 2");
    key(h, g, "ArrowRight");
    expect(tipEl(h)!.textContent).toBe("a: 1");
    key(h, g, "ArrowLeft");
    expect(tipEl(h)!.textContent).toBe("b: 2");
    key(h, g, "Escape");
    expect(tipEl(h)!.hidden).toBe(true);
  });
});
