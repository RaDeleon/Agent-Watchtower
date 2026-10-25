import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A CLAUDE_DIR whose skills/ holds the two install shapes spec 4.3 tells apart
 * (Stage 7): a pack that links each of its skills in, as gstack does, and a
 * skill installed on its own.
 *   skills/fxpack/fx-linked/SKILL.md      the pack's copy
 *   skills/fx-linked/SKILL.md  ->  ../fxpack/fx-linked/SKILL.md
 *   skills/fx-plain/SKILL.md              a plain folder
 *   skills/fx-plain/nested/SKILL.md       nothing links into it: fx-plain stays (no pack)
 *   skills/fxpack/SKILL.md                the pack's own router, a plain file
 *   skills/fxpack/fx-abs/SKILL.md         the pack's copy
 *   skills/fx-abs/SKILL.md  ->  <absolute>/skills/fxpack/fx-abs/SKILL.md   (as gstack installs)
 */
export function skillsHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "wt-skills-home-"));
  const sk = path.join(home, "skills");
  mkdirSync(path.join(sk, "fxpack", "fx-linked"), { recursive: true });
  writeFileSync(path.join(sk, "fxpack", "fx-linked", "SKILL.md"), "---\nname: fx-linked\n---\n");
  mkdirSync(path.join(sk, "fx-linked"));
  symlinkSync("../fxpack/fx-linked/SKILL.md", path.join(sk, "fx-linked", "SKILL.md"));
  mkdirSync(path.join(sk, "fx-plain"));
  writeFileSync(path.join(sk, "fx-plain", "SKILL.md"), "---\nname: fx-plain\n---\n");
  mkdirSync(path.join(sk, "fx-plain", "nested"));
  writeFileSync(path.join(sk, "fx-plain", "nested", "SKILL.md"), "---\nname: nested\n---\n");
  writeFileSync(path.join(sk, "fxpack", "SKILL.md"), "---\nname: fxpack\n---\n");
  mkdirSync(path.join(sk, "fxpack", "fx-abs"));
  writeFileSync(path.join(sk, "fxpack", "fx-abs", "SKILL.md"), "---\nname: fx-abs\n---\n");
  mkdirSync(path.join(sk, "fx-abs"));
  symlinkSync(path.join(sk, "fxpack", "fx-abs", "SKILL.md"), path.join(sk, "fx-abs", "SKILL.md"));
  return home;
}
