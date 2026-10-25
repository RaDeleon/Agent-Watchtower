/**
 * A hand-rolled DOM, just big enough to run `clientScript()` under `node:vm`.
 * No jsdom: the repo has zero dependencies, and a stub this small is also a
 * list of exactly which DOM features the client script is allowed to lean on.
 *
 * It parses well-formed markup (quoted attributes, explicit close tags or
 * `/>`), matches compound selectors (`tag`, `.class`, `#id`, `[attr]`,
 * `[attr="v"]`) joined by descendant spaces, and records every text write so a
 * test can prove that something was NOT animated.
 */
import vm from "node:vm";

export class TextNode {
  readonly nodeType = 3;
  parentNode: El | null = null;
  readonly writes: string[] = [];
  #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  get nodeValue(): string {
    return this.#value;
  }
  set nodeValue(v: string) {
    this.writes.push(v);
    this.#value = v;
  }
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "wbr"]);

export class El {
  readonly nodeType = 1;
  readonly tagName: string;
  parentNode: El | null = null;
  childNodes: (El | TextNode)[] = [];
  readonly attrs = new Map<string, string>();
  readonly innerHTMLWrites: string[] = [];
  readonly style: Record<string, string> = {};
  readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  offsetWidth = 0;
  offsetHeight = 0;
  #inner = "";
  /** `template.content`: the template itself is a good enough fragment here. */
  get content(): El {
    return this;
  }
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get children(): El[] {
    return this.childNodes.filter((n): n is El => n instanceof El);
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get hidden(): boolean {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set("hidden", "");
    else this.attrs.delete("hidden");
  }
  get textContent(): string {
    return this.childNodes.map((n) => (n instanceof El ? n.textContent : n.nodeValue)).join("");
  }
  set textContent(v: string) {
    this.childNodes = [];
    this.append(new TextNode(v));
  }
  get innerHTML(): string {
    return this.#inner;
  }
  set innerHTML(html: string) {
    this.innerHTMLWrites.push(html);
    this.#inner = html;
    this.childNodes = [];
    parseInto(this, html);
  }
  /** The parser records an element's inner source without it counting as a write. */
  setSource(inner: string): void {
    this.#inner = inner;
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => { if (!list().includes(c)) this.className = [...list(), c].join(" "); },
      remove: (c: string) => { this.className = list().filter((x) => x !== c).join(" "); },
    };
  }
  get firstElementChild(): El | null {
    return this.children[0] ?? null;
  }
  hasAttribute(n: string): boolean {
    return this.attrs.has(n);
  }
  getAttribute(n: string): string | null {
    return this.attrs.has(n) ? (this.attrs.get(n) as string) : null;
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, String(v));
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }
  append(child: El | TextNode): void {
    if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter((c) => c !== child);
    child.parentNode = this;
    this.childNodes.push(child);
  }
  appendChild(child: El | TextNode): El | TextNode {
    this.append(child);
    return child;
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  matches(sel: string): boolean {
    return sel.split(",").some((s) => matchesChain(this, s.trim().split(/\s+/)));
  }
  querySelectorAll(sel: string): El[] {
    return this.descendants().filter((e) => e.matches(sel));
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel: string): El | null {
    for (let e: El | null = this; e !== null; e = e.parentNode) if (e.tagName !== "#DOCUMENT" && e.matches(sel)) return e;
    return null;
  }
}

function matchesCompound(el: El, compound: string): boolean {
  if (compound === "*") return true;
  const parts = compound.match(/^[a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) ?? [];
  if (parts.join("") !== compound) throw new Error(`dom-stub: unsupported selector ${JSON.stringify(compound)}`);
  return parts.every((p) => {
    if (p.startsWith(".")) return el.classList.contains(p.slice(1));
    if (p.startsWith("#")) return el.getAttribute("id") === p.slice(1);
    if (p.startsWith("[")) {
      const m = /^\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]$/.exec(p);
      if (m === null) throw new Error(`dom-stub: unsupported attribute selector ${p}`);
      const v = el.getAttribute(m[1]);
      return m[2] === undefined && m[3] === undefined ? v !== null : v === (m[2] ?? m[3]);
    }
    return el.tagName === p.toUpperCase();
  });
}

function matchesChain(el: El, chain: string[]): boolean {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  if (chain.length === 1) return true;
  for (let a = el.parentNode; a !== null; a = a.parentNode) {
    if (a.tagName !== "#DOCUMENT" && matchesChain(a, chain.slice(0, -1))) return true;
  }
  return false;
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Parse well-formed markup into `parent`, keeping each element's inner source as its innerHTML. */
function parseInto(parent: El, html: string): void {
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  const stack: { el: El; start: number }[] = [{ el: parent, start: 0 }];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      top.el.append(new TextNode(decode(m[5])));
    } else if (m[1] !== undefined) {
      const done = stack.pop()!;
      if (done.el.tagName !== m[1].toUpperCase()) throw new Error(`dom-stub: </${m[1]}> closes <${done.el.tagName}>`);
      done.el.setSource(html.slice(done.start, m.index));
    } else {
      const el = new El(m[2]);
      for (const a of m[3].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] ?? ""));
      top.el.append(el);
      if (m[4] !== "/" && !VOID.has(m[2].toLowerCase())) stack.push({ el, start: re.lastIndex });
    }
  }
  if (stack.length !== 1) throw new Error("dom-stub: unclosed element");
}

export interface Harness {
  document: El & { documentElement: El; body: El; getElementById(id: string): El | null; createElement(t: string): El };
  html: El;
  window: Record<string, unknown>;
  /** Pending timers, in the order they were set. */
  timers: { fn: () => void; ms: number }[];
  /** Run (and remove) every pending timer whose delay is at most `maxMs`. */
  runTimers(maxMs: number): void;
  frames: ((ts: number) => void)[];
  /** Run the animation frames queued right now at timestamp `ts` (one frame's worth). */
  runFrames(ts: number): void;
}

export interface HarnessOpts {
  body: string;
  storage?: "ok" | "getItem-throws" | "access-throws";
  stored?: Record<string, string>;
  fetch?: (url: string) => Promise<unknown>;
  reducedMotion?: boolean;
}

/** Build a document from `body` markup and run `script` against it. */
export function runClient(script: string, opts: HarnessOpts): Harness {
  const doc = new El("#document") as Harness["document"];
  const html = new El("html");
  html.setAttribute("data-theme", "amber");
  html.setAttribute("data-nav", "pills");
  const body = new El("body");
  html.append(body);
  doc.append(html);
  body.innerHTML = opts.body;
  body.innerHTMLWrites.length = 0;
  Object.assign(doc, {
    documentElement: html,
    body,
    getElementById: (id: string) => doc.querySelector(`#${id}`),
    createElement: (t: string) => new El(t),
  });

  const timers: Harness["timers"] = [];
  const frames: Harness["frames"] = [];
  const stored = new Map(Object.entries(opts.stored ?? {}));
  const goodStorage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  };
  const throwingStorage = {
    getItem: () => { throw new Error("SecurityError: storage blocked"); },
    setItem: () => { throw new Error("SecurityError: storage blocked"); },
  };
  const win: Record<string, unknown> = {
    document: doc,
    innerWidth: 1280,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    requestAnimationFrame: (fn: (ts: number) => void) => { frames.push(fn); return frames.length; },
    matchMedia: (q: string) => ({ matches: q.includes("reduce") ? !!opts.reducedMotion : false }),
    fetch: opts.fetch ?? (() => new Promise(() => {})),
    Promise,
    Math, Number, String, Array, JSON, Date, isFinite, Error,
  };
  if (opts.storage === "access-throws") {
    Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError: storage blocked"); } });
  } else {
    win.localStorage = opts.storage === "getItem-throws" ? throwingStorage : goodStorage;
  }
  win.window = win;
  vm.runInNewContext(script, win);

  return {
    document: doc,
    html,
    window: win,
    timers,
    runTimers(maxMs: number) {
      const due = timers.filter((t) => t.ms <= maxMs);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
    },
    frames,
    runFrames(ts: number) {
      for (const f of frames.splice(0)) f(ts);
    },
  };
}
