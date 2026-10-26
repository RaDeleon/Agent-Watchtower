/**
 * The Watchtower crest: a tower inside a heraldic shield, on a 64-unit grid.
 * One drawing has three uses. The favicon is always amber, so a tab
 * keeps its icon whichever theme is active. The mark beside the wordmark takes
 * the active theme's colours through classes that layout.ts styles. And the
 * logo, banner and social preview under docs/assets/ draw the same paths, which
 * tests/brand.test.ts holds them to. Like every renderer but theme.ts, this file
 * carries no colour of its own.
 */
import { LIFT, TOKENS } from "./theme.ts";

/** The parts, back to front. The shield is stroked; the rest are filled. */
export const CREST = {
  shield: "M32 4 56 11.5V30c0 15.5-10 25.5-24 30.5C18 55.5 8 45.5 8 30V11.5z",
  /** Battlements and body in one outline, so no seam shows where they meet. */
  tower: "M19 27V14h5.5v4.5h4.75V14h5.5v4.5h4.75V14H45v13h-3l1.5 23h-23L22 27z",
  /** The beacon and the window. */
  lights: "M29.75 22.75a2.25 2.25 0 1 0 4.5 0a2.25 2.25 0 1 0-4.5 0zM28.5 34a3.5 3.5 0 0 1 7 0v4a3.5 3.5 0 0 1-7 0z",
  door: "M27.5 50v-4a4.5 4.5 0 0 1 9 0v4z",
} as const;

/** Heavy enough to hold the shield's outline at 16 px. */
const SHIELD_EDGE = `stroke-width="4.5" stroke-linejoin="round"`;

export interface CrestPaint {
  mark: string;
  light: string;
  ground: string;
}

/** The mark beside the wordmark. Each class takes the active theme's colour (layout.ts). */
export function crestMark(): string {
  return `<svg class="crest" viewBox="0 0 64 64" aria-hidden="true">` +
    `<path class="cr-shield" ${SHIELD_EDGE} d="${CREST.shield}"/>` +
    `<path class="cr-mark" d="${CREST.tower}"/>` +
    `<path class="cr-light" d="${CREST.lights}"/>` +
    `<path class="cr-ground" d="${CREST.door}"/></svg>`;
}

/** The crest as a document of its own, in one fixed palette. */
export function crestSvg(p: CrestPaint): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<path fill="${p.ground}" stroke="${p.mark}" ${SHIELD_EDGE} d="${CREST.shield}"/>` +
    `<path fill="${p.mark}" d="${CREST.tower}"/>` +
    `<path fill="${p.light}" d="${CREST.lights}"/>` +
    `<path fill="${p.ground}" d="${CREST.door}"/></svg>`;
}

/** Amber, the default theme, whichever theme is active. */
export const AMBER: CrestPaint = { mark: LIFT.amber.mark, light: TOKENS.amber.label, ground: TOKENS.amber.bg };

/**
 * The favicon, inline: the report is one self-contained file and `serve` has
 * no static route, so neither could point at an icon file.
 */
export const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(crestSvg(AMBER))}`;
