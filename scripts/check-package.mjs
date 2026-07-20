import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
});
const [{ files }] = JSON.parse(output);
const paths = files.map(({ path }) => path).sort();
const included = new Set(paths);

const required = [
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  "dist/claude/daemon.js",
  "dist/claude/inject-session-id.js",
  "dist/claude/shutdown.js",
  "dist/claude/speak-hook.js",
  "dist/pi/index.js",
  "dist/services/moonshine-sidecar.py",
  "hooks/hooks.json",
  "pi/index.js",
  "services/moonshine-sidecar.py",
  "skills/converse/SKILL.md",
  "skills/converse/statusline-line.sh",
  "CHANGELOG.md",
  "CLAUDE.md",
  "LICENSE",
  "README.md",
  ...readdirSync(new URL("../", import.meta.url))
    .filter((path) => /^config(?:\..+)?\.json$/.test(path)),
];

const allowed = (path) =>
  path === "package.json"
  || path === "CHANGELOG.md"
  || path === "CLAUDE.md"
  || path === "LICENSE"
  || path === "README.md"
  || /^config(?:\..+)?\.json$/.test(path)
  || path.startsWith(".claude-plugin/")
  || path.startsWith("dist/")
  || path === "hooks/hooks.json"
  || path === "pi/index.js"
  || /^services\/[^/]+\.py$/.test(path)
  || (path.startsWith("skills/") && (path.endsWith(".md") || path.endsWith(".sh")));

const privateArtifact = (path) =>
  path.includes("__pycache__")
  || path.endsWith(".pyc")
  || [".beads/", ".pi/", ".pi-subagents/", ".claude/"].some((prefix) => path.startsWith(prefix))
  || /(?:^|\/)pi-session-.*\.html$/.test(path);

const missing = required.filter((path) => !included.has(path));
const unexpected = paths.filter((path) => !allowed(path) || privateArtifact(path));
if (missing.length || unexpected.length) {
  if (missing.length) console.error(`Missing required package files:\n${missing.join("\n")}`);
  if (unexpected.length) console.error(`Unexpected package files:\n${unexpected.join("\n")}`);
  process.exit(1);
}

console.log(`Package contents verified: ${paths.length} files, no workspace-private paths.`);
