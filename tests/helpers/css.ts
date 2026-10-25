/**
 * A deliberately small CSS walker for the motion guards: enough to split a
 * stylesheet into leaf rules (selector + declarations, with the at-rules they
 * sit inside) and to list the `@keyframes` it defines. It is not a CSS parser;
 * it only has to be right about the stylesheets this repo emits, which have no
 * braces inside strings or comments.
 */
export interface Rule {
  selector: string;
  body: string;
  /** Enclosing at-rule preludes, outermost first, e.g. ["@media (min-width: 900px)"]. */
  at: string[];
}

export function cssRules(css: string): { rules: Rule[]; keyframes: string[] } {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const keyframes: string[] = [];
  const walk = (text: string, at: string[]) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) return;
      const semi = text.indexOf(";", i);
      // A statement at-rule such as `@import x;` has no block.
      if (semi !== -1 && semi < open && text.slice(i, semi).trim().startsWith("@")) {
        i = semi + 1;
        continue;
      }
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const inner = text.slice(open + 1, j - 1);
      if (prelude.startsWith("@keyframes")) {
        keyframes.push(prelude.replace("@keyframes", "").trim());
      } else if (prelude.startsWith("@media") || prelude.startsWith("@supports")) {
        walk(inner, [...at, prelude]);
      } else if (prelude.startsWith("@")) {
        // @property and friends: no selectors inside.
      } else {
        rules.push({ selector: prelude, body: inner, at });
      }
      i = j;
    }
  };
  walk(src, []);
  return { rules, keyframes };
}

/** Animation names a declaration block applies (via `animation` or `animation-name`). */
export function animationNames(body: string, known: string[]): string[] {
  const out: string[] = [];
  for (const decl of body.split(";")) {
    const m = /^\s*animation(-name)?\s*:(.*)$/s.exec(decl);
    if (m === null) continue;
    for (const word of m[2].split(/[\s,]+/)) if (known.includes(word)) out.push(word);
  }
  return out;
}
