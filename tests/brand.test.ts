/**
 * The crest (lib/render/brand.ts): the favicon on every page, the mark beside
 * the wordmark, and the committed logo are one drawing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CREST } from "@/lib/render/brand";
import { LAYOUT_CSS, page } from "@/lib/render/layout";
import { LIFT, TOKENS } from "@/lib/render/theme";
import { cssRules } from "./helpers/css.ts";

const ROOT = path.resolve(__dirname, "..");
const shell = () => page({ title: "x", active: "/", body: "" });

describe("the crest", () => {
  it("is every page's favicon, in TheOne amber whatever the theme", () => {
    const links = shell().match(/<link rel="icon"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    const href = links[0]?.match(/href="([^"]*)"/)?.[1] ?? "";
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
    const svg = decodeURIComponent(href.slice("data:image/svg+xml,".length));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64">/);
    for (const d of Object.values(CREST)) expect(svg).toContain(`d="${d}"`);
    expect(svg).toContain(LIFT.amber.mark);
    expect(svg).toContain(TOKENS.amber.label);
    expect(svg).not.toContain("var(");
  });

  it("sits before the wordmark in the active theme's colours", () => {
    const brand = shell().match(/<span class="brand">([\s\S]*?)<\/span>/)?.[1] ?? "";
    expect(brand).toMatch(/^<svg class="crest"[\s\S]*<\/svg>WATCHTOWER$/);
    // No colour is written into the mark: each part's class takes a theme variable.
    expect(brand).not.toMatch(/\s(fill|stroke)="/);
    const classes = [...new Set([...brand.matchAll(/class="(cr-[a-z]+)"/g)].map((m) => m[1]))];
    expect(classes).toHaveLength(4);
    const { rules } = cssRules(LAYOUT_CSS);
    for (const c of classes) {
      const body = rules.filter((r) => r.selector.split(",").some((s) => s.trim() === `.${c}`)).map((r) => r.body).join(";");
      expect(`${c} { ${body} }`).toMatch(/fill:\s*var\(--(mark|label|bg)\)/);
    }
  });

  it("is the drawing in the committed logo, banner and social preview", () => {
    for (const f of ["watchtower-mark.svg", "watchtower-banner.svg", "watchtower-social.svg"]) {
      const svg = readFileSync(path.join(ROOT, "docs/assets", f), "utf8");
      for (const d of Object.values(CREST)) expect(`${f}: ${svg.includes(`d="${d}"`)}`).toBe(`${f}: true`);
    }
  });
});
