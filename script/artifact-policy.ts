// Names of local and generated artifacts that must never be committed: usage
// databases, transcripts, logs, live configuration and local agent state. The
// pre-commit secret check (script/check-secrets.ts --staged) rejects any staged
// path that matches, before it scans contents, including files force-added past
// .gitignore. Watchtower's real data lives outside the repository
// (~/.theone/claude-code-usage.sqlite, ~/.claude/projects/**/*.jsonl); these
// rules keep a copy of it from being committed by accident.

const LOCAL_DIRECTORIES = new Set([
  "logs", "debug-logs", "debug-output", "outputs", "artifacts", "test-results",
  "test-output", "coverage", "screenshots", "recordings", "traces", ".audit",
  ".local", "local-data", "node_modules", ".tools", "dist",
  ".claude", ".codex", ".hermes", ".theone", ".openviking", ".atlas", ".private",
  ".superpowers",
]);

const LOCAL_PATTERNS = [
  "*.log", "*.log.*", "*.jsonl", "*.ndjson", "*.har", "*.trace",
  "*.db", "*.db-*", "*.sqlite", "*.sqlite-*", "*.sqlite3", "*.sqlite3-*",
  "*.bak", "*.backup", "*.orig", "*.gitleaks.json", ".schema-v*",
  "screenshot*.png", "screenshot*.jpg", "Screenshot *.png",
];

// Live configuration files (Claude Code's settings, Codex's auth, OpenViking's
// client config and Watchtower's own; the .example file is the template), and
// SESSION.md, the local handoff log, which carries live data and machine paths.
const PRIVATE_NAMES = new Set([
  "settings.json", "settings.local.json", "auth.json", "ovcli.conf", "ov.conf",
  "watchtower.config.json", "SESSION.md",
]);

const PRIVATE_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

/** fnmatch-style match of one path segment: `*` is any run, everything else literal. */
function matches(segment: string, pattern: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  return re.test(segment);
}

/** True when a repository-relative POSIX path names a private or generated artifact. */
export function isPrivateArtifact(posixPath: string): boolean {
  const parts = posixPath.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return false;
  if (parts.some((p) => LOCAL_DIRECTORIES.has(p))) return true;
  if (parts.some((p) => LOCAL_PATTERNS.some((pat) => matches(p, pat)))) return true;
  if (["tmp", "temp"].includes(parts[0])) return true;
  const name = parts[parts.length - 1];
  if (PRIVATE_NAMES.has(name)) return true;
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") return true;
  return PRIVATE_SUFFIXES.some((s) => name.endsWith(s));
}
