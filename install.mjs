#!/usr/bin/env node
/**
 * Gentle-ai-mod installer — Windows + Linux
 *
 * Installs:
 *   ~/.config/gentle-ai/                 (workers.yaml + bin runners)
 *   ~/.config/opencode/skills/sdd-worker-bridge/
 *   optional: Antigravity skills mirror
 *   patches gentle-orchestrator prompt in opencode.json (backup first)
 *
 * Usage:
 *   node install.mjs
 *   node install.mjs --dry-run
 *   node install.mjs --no-patch
 *   node install.mjs --no-antigravity
 *   node install.mjs --force
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PKG = join(ROOT, "package");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const NO_PATCH = args.has("--no-patch");
const NO_AGY_SKILL = args.has("--no-antigravity");
const FORCE = args.has("--force");
const HELP = args.has("--help") || args.has("-h");

if (HELP) {
  console.log(`Gentle-ai-mod installer

Usage: node install.mjs [options]

Options:
  --dry-run         Show actions without writing
  --no-patch        Do not patch opencode.json orchestrator prompt
  --no-antigravity  Skip Antigravity skills mirror
  --force           Overwrite existing managed files without keeping .bak beside each file
  -h, --help        Show help
`);
  process.exit(0);
}

function log(msg) {
  console.log(msg);
}

function homeConfig(...parts) {
  return join(homedir(), ".config", ...parts);
}

function ensureDir(p) {
  if (DRY) {
    log(`[dry-run] mkdir ${p}`);
    return;
  }
  mkdirSync(p, { recursive: true });
}

function backupFile(dest) {
  if (!existsSync(dest)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${dest}.bak-${stamp}`;
  if (DRY) {
    log(`[dry-run] backup ${dest} -> ${bak}`);
    return bak;
  }
  copyFileSync(dest, bak);
  return bak;
}

function copyFile(src, dest) {
  if (!existsSync(src)) throw new Error(`Missing package file: ${src}`);
  ensureDir(dirname(dest));
  if (existsSync(dest) && !FORCE) {
    backupFile(dest);
  } else if (existsSync(dest) && FORCE) {
    backupFile(dest);
  }
  if (DRY) {
    log(`[dry-run] copy ${src} -> ${dest}`);
    return;
  }
  copyFileSync(src, dest);
  log(`installed ${dest}`);
}

function copyTree(src, dest) {
  if (!existsSync(src)) throw new Error(`Missing package dir: ${src}`);
  ensureDir(dest);
  if (DRY) {
    log(`[dry-run] copyTree ${src} -> ${dest}`);
    return;
  }
  cpSync(src, dest, { recursive: true, force: true });
  log(`installed tree ${dest}`);
}

function which(cmd) {
  const isWin = platform() === "win32";
  const r = spawnSync(isWin ? "where" : "which", [cmd], {
    encoding: "utf8",
    shell: false,
  });
  if (r.status !== 0) return null;
  const line = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return line || null;
}

function chmodX(p) {
  if (platform() === "win32" || DRY || !existsSync(p)) return;
  try {
    chmodSync(p, 0o755);
  } catch {
    /* ignore */
  }
}

function checkPrereqs() {
  const nodeOk = process.versions.node;
  log(`node: v${nodeOk} (${platform()})`);
  const agy = which("agy");
  log(agy ? `agy: ${agy}` : "agy: NOT on PATH (optional until you use Antigravity worker)");
  const engram = which("engram");
  log(engram ? `engram: ${engram}` : "engram: NOT on PATH (needed for shared memory)");
  const oc = homeConfig("opencode", "opencode.json");
  log(existsSync(oc) ? `opencode.json: ${oc}` : "opencode.json: missing (patch will skip)");
}

function installGentleAi() {
  const destRoot = homeConfig("gentle-ai");
  ensureDir(join(destRoot, "bin"));
  copyFile(join(PKG, "gentle-ai", "workers.yaml"), join(destRoot, "workers.yaml"));
  copyFile(
    join(PKG, "gentle-ai", "bin", "run-agy-phase.mjs"),
    join(destRoot, "bin", "run-agy-phase.mjs")
  );
  copyFile(
    join(PKG, "gentle-ai", "bin", "patch-orchestrator-worker-bridge.mjs"),
    join(destRoot, "bin", "patch-orchestrator-worker-bridge.mjs")
  );

  // small local readme
  const readme = join(destRoot, "README.md");
  const body = `# gentle-ai (installed by Gentle-ai-mod)

- workers.yaml — SDD worker bridge policy
- bin/run-agy-phase.mjs — launch one SDD phase via agy
- bin/patch-orchestrator-worker-bridge.mjs — re-apply orchestrator prompt patch

Re-run installer from the repo after upgrades:
  node install.mjs

Restart OpenCode after install/patch.
`;
  if (DRY) log(`[dry-run] write ${readme}`);
  else {
    writeFileSync(readme, body, "utf8");
    log(`installed ${readme}`);
  }

  chmodX(join(destRoot, "bin", "run-agy-phase.mjs"));
  chmodX(join(destRoot, "bin", "patch-orchestrator-worker-bridge.mjs"));
}

function installOpenCodeSkill() {
  const dest = homeConfig("opencode", "skills", "sdd-worker-bridge");
  // backup existing skill tree lightly
  if (existsSync(dest) && !DRY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bak = `${dest}.bak-${stamp}`;
    try {
      renameSync(dest, bak);
      log(`backed up skill -> ${bak}`);
    } catch {
      copyTree(dest, bak);
    }
  }
  copyTree(join(PKG, "opencode", "skills", "sdd-worker-bridge"), dest);
}

function installAntigravitySkill() {
  if (NO_AGY_SKILL) {
    log("skip antigravity skill (--no-antigravity)");
    return;
  }
  const candidates = [
    join(homedir(), ".gemini", "antigravity-cli", "skills", "sdd-worker-bridge"),
    join(homedir(), ".antigravity-cli", "skills", "sdd-worker-bridge"),
  ];
  // install into first existing parent skills dir, else default gemini path
  let dest = candidates[0];
  for (const c of candidates) {
    const parent = dirname(c);
    if (existsSync(dirname(parent)) || existsSync(parent)) {
      dest = c;
      break;
    }
  }
  if (existsSync(dirname(dirname(dest))) || DRY) {
    if (existsSync(dest) && !DRY) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        renameSync(dest, `${dest}.bak-${stamp}`);
      } catch {
        /* ignore */
      }
    }
    copyTree(join(PKG, "antigravity", "skills", "sdd-worker-bridge"), dest);
  } else {
    log(`skip antigravity skill (no antigravity skills parent found)`);
  }
}

function runPatch() {
  if (NO_PATCH) {
    log("skip orchestrator patch (--no-patch)");
    return;
  }
  const oc = homeConfig("opencode", "opencode.json");
  if (!existsSync(oc)) {
    log("skip patch: opencode.json not found");
    return;
  }
  const patcher = homeConfig("gentle-ai", "bin", "patch-orchestrator-worker-bridge.mjs");
  const fallback = join(PKG, "gentle-ai", "bin", "patch-orchestrator-worker-bridge.mjs");
  const script = existsSync(patcher) && !DRY ? patcher : fallback;

  if (DRY) {
    log(`[dry-run] node ${script}`);
    return;
  }
  log(`patching orchestrator via ${script}`);
  const r = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`patch failed with exit ${r.status}`);
  }
}

function smoke() {
  if (DRY) return;
  const runner = homeConfig("gentle-ai", "bin", "run-agy-phase.mjs");
  if (!existsSync(runner)) return;
  const r = spawnSync(
    process.execPath,
    [
      runner,
      "--dry-run",
      "--phase",
      "explore",
      "--change",
      "install-smoke",
      "--project",
      "smoke",
      "--cwd",
      process.cwd(),
    ],
    { encoding: "utf8" }
  );
  if (r.status === 0 || r.status === 3) {
    // 3 = agy missing — still OK for install smoke of runner parse
    log(`runner smoke: exit ${r.status} (0=ok, 3=agy missing but runner works)`);
  } else {
    log(`runner smoke: unexpected exit ${r.status}`);
    if (r.stdout) log(r.stdout.slice(0, 500));
    if (r.stderr) log(r.stderr.slice(0, 500));
  }
}

function main() {
  log("=== Gentle-ai-mod install ===");
  log(`source: ${ROOT}`);
  log(`home:   ${homedir()}`);
  if (!existsSync(PKG)) throw new Error(`package/ missing next to install.mjs`);

  checkPrereqs();
  installGentleAi();
  installOpenCodeSkill();
  installAntigravitySkill();
  runPatch();
  smoke();

  log("");
  log("=== Done ===");
  log("Next steps:");
  log("  1. Restart OpenCode (required to load orchestrator prompt + skill)");
  log("  2. Start an SDD session — preflight should show Workers tab");
  log("  3. Optional project override: <repo>/.atl/sdd-workers.yaml");
  if (DRY) log("(dry-run: no files were written)");
}

try {
  main();
} catch (err) {
  console.error("INSTALL FAILED:", err?.message || err);
  process.exit(1);
}
