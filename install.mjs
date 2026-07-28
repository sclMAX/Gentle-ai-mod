#!/usr/bin/env node
/**
 * Gentle-ai-mod installer — Windows + Linux
 *
 * Installs:
 *   ~/.config/gentle-ai/                 (workers.yaml + bin runners + schemas)
 *   ~/.config/opencode/skills/sdd-worker-bridge/
 *   optional: Antigravity skills mirror
 *   patches gentle-orchestrator prompt in opencode.json (backup first)
 *   optional: honest forecast rules into sdd-tasks SKILL.md
 *
 * Usage:
 *   node install.mjs
 *   node install.mjs --dry-run
 *   node install.mjs --no-patch
 *   node install.mjs --no-antigravity
 *   node install.mjs --force
 *   node install.mjs --check
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
  accessSync,
  constants,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
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
const CHECK = args.has("--check");
const HELP = args.has("--help") || args.has("-h");

if (HELP) {
  console.log(`Gentle-ai-mod installer

Usage: node install.mjs [options]

Options:
  --check           Health check only (no writes); exit 0 if healthy enough
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

  const schemasSrc = join(PKG, "gentle-ai", "schemas");
  if (existsSync(schemasSrc)) {
    copyTree(schemasSrc, join(destRoot, "schemas"));
  } else {
    log("WARN: package/gentle-ai/schemas missing — skip schema install");
  }

  // small local readme
  const readme = join(destRoot, "README.md");
  const body = `# gentle-ai (installed by Gentle-ai-mod)

- workers.yaml — SDD worker bridge policy
- bin/run-agy-phase.mjs — launch one SDD phase via agy (v1.2: json-schema default)
- bin/patch-orchestrator-worker-bridge.mjs — re-apply orchestrator prompt patch
- schemas/sdd-phase-result.schema.json — default phase result contract for --json-schema

Re-run installer from the repo after upgrades:
  node install.mjs
  node install.mjs --check

Runner flags (v1.2):
  --output-format json|stream-json
  --json-schema default|none|<path>
  --no-json-schema
  --stream-progress

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

/**
 * Replace ### Review Workload Forecast Rules … next ### heading
 * with improved content from package patch file.
 */
function patchSddTasksForecast() {
  const skillPath = homeConfig("opencode", "skills", "sdd-tasks", "SKILL.md");
  const patchPath = join(PKG, "opencode", "skills-patches", "sdd-tasks-forecast.md");

  if (!existsSync(skillPath)) {
    log("WARN: sdd-tasks SKILL.md not found — skip forecast patch");
    return;
  }
  if (!existsSync(patchPath)) {
    log("WARN: sdd-tasks-forecast.md patch missing — skip forecast patch");
    return;
  }

  const original = readFileSync(skillPath, "utf8");
  const startRe = /^### Review Workload Forecast Rules\s*$/m;
  const startMatch = original.match(startRe);
  if (!startMatch) {
    log("WARN: Review Workload Forecast Rules section missing in sdd-tasks — skip");
    return;
  }

  const startIdx = startMatch.index;
  const afterStart = original.slice(startIdx + startMatch[0].length);
  // next ### heading at same level (not ####)
  const nextHeading = afterStart.match(/\n### [^\n#]/);
  let endIdx;
  if (nextHeading) {
    endIdx = startIdx + startMatch[0].length + nextHeading.index + 1; // keep the \n before next ###
  } else {
    endIdx = original.length;
  }

  let patchBody = readFileSync(patchPath, "utf8").trimEnd() + "\n\n";
  // Ensure patch starts with the heading
  if (!patchBody.startsWith("### Review Workload Forecast Rules")) {
    patchBody = "### Review Workload Forecast Rules\n\n" + patchBody;
  }

  // Also upgrade the template table at top of tasks artifact if present
  let next = original.slice(0, startIdx) + patchBody + original.slice(endIdx);
  next = upgradeTasksTemplateTable(next);

  if (next === original) {
    log("sdd-tasks forecast: already up to date");
    return;
  }

  if (DRY) {
    log(`[dry-run] patch forecast rules in ${skillPath}`);
    return;
  }

  const bak = backupFile(skillPath);
  writeFileSync(skillPath, next, "utf8");
  log(`patched sdd-tasks forecast rules${bak ? ` (backup ${bak})` : ""}`);
}

function upgradeTasksTemplateTable(src) {
  const oldTable = `| Field | Value |
|-------|-------|
| Estimated changed lines | <rough estimate or range> |
| 400-line budget risk | Low / Medium / High |
| Chained PRs recommended | Yes / No |
| Suggested split | <single PR or PR 1 → PR 2 → PR 3> |
| Delivery strategy | <ask-on-risk / auto-chain / single-pr / exception-ok> |
| Chain strategy | <stacked-to-main / feature-branch-chain / size-exception / pending> |`;

  const newTable = `| Field | Value |
|-------|-------|
| Estimated changed lines | <low-high range, e.g. 180-320> |
| Estimate method | <signals used: file counts, new/edit, tests, wiring> |
| Confidence | Low / Medium / High |
| Files touched (approx) | <N prod + M test + K config/docs> |
| Test lines share | <approx % or lines> |
| Generated/vendor lines excluded from budget? | Yes/No + note |
| 400-line budget risk | Low / Medium / High |
| Chained PRs recommended | Yes / No |
| Suggested split | <single PR or PR 1 → PR 2 → PR 3> |
| Delivery strategy | <ask-on-risk / auto-chain / single-pr / exception-ok> |
| Chain strategy | <stacked-to-main / feature-branch-chain / size-exception / pending> |`;

  if (src.includes(oldTable)) {
    return src.replace(oldTable, newTable);
  }
  // Already patched or custom — leave alone
  if (src.includes("Estimate method") && src.includes("Generated/vendor lines excluded")) {
    return src;
  }
  return src;
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

function pass(msg) {
  log(`PASS  ${msg}`);
}
function fail(msg) {
  log(`FAIL  ${msg}`);
}
function warn(msg) {
  log(`WARN  ${msg}`);
}

function runCheck() {
  log("=== Gentle-ai-mod --check ===");
  let critical = 0;
  let warnings = 0;

  // node version
  const major = Number(String(process.versions.node).split(".")[0]);
  if (major >= 18) pass(`node v${process.versions.node} (>=18)`);
  else {
    fail(`node v${process.versions.node} (need >=18)`);
    critical++;
  }

  // package/ when run from mod repo
  const looksLikeRepo =
    existsSync(join(ROOT, "package", "gentle-ai")) ||
    existsSync(join(ROOT, "install.mjs"));
  if (looksLikeRepo) {
    if (existsSync(PKG) && existsSync(join(PKG, "gentle-ai"))) {
      pass(`package/ present at ${PKG}`);
    } else {
      fail("package/ missing next to install.mjs");
      critical++;
    }
  } else {
    warn("not run from Gentle-ai-mod repo (package/ check skipped)");
    warnings++;
  }

  // workers.yaml
  const workers = homeConfig("gentle-ai", "workers.yaml");
  if (existsSync(workers)) pass(`workers.yaml: ${workers}`);
  else {
    fail(`workers.yaml missing: ${workers}`);
    critical++;
  }

  // runner
  const runner = homeConfig("gentle-ai", "bin", "run-agy-phase.mjs");
  if (existsSync(runner)) {
    let execOk = false;
    try {
      accessSync(runner, constants.R_OK);
      execOk = true;
      if (platform() !== "win32") {
        try {
          accessSync(runner, constants.X_OK);
        } catch {
          warn("runner exists but not executable bit (node can still run it)");
          warnings++;
        }
      }
    } catch {
      execOk = false;
    }
    if (execOk) {
      const head = readFileSync(runner, "utf8").slice(0, 2500);
      if (/v1\.2|json-schema/i.test(head)) {
        pass(`runner v1.2 marker: ${runner}`);
      } else {
        fail(`runner present but missing v1.2/json-schema marker: ${runner}`);
        critical++;
      }
    } else {
      fail(`runner not readable: ${runner}`);
      critical++;
    }
  } else {
    fail(`runner missing: ${runner}`);
    critical++;
  }

  // schema
  const schema = homeConfig(
    "gentle-ai",
    "schemas",
    "sdd-phase-result.schema.json"
  );
  if (existsSync(schema)) pass(`schema: ${schema}`);
  else {
    warn(`schema missing (pre-1.2 install?): ${schema}`);
    warnings++;
  }

  // skill
  const skill = homeConfig("opencode", "skills", "sdd-worker-bridge", "SKILL.md");
  if (existsSync(skill)) pass(`sdd-worker-bridge: ${skill}`);
  else {
    fail(`sdd-worker-bridge missing: ${skill}`);
    critical++;
  }

  // agy
  const agy = which("agy");
  if (agy) {
    const ver = spawnSync("agy", ["--version"], { encoding: "utf8" });
    const v = ((ver.stdout || ver.stderr || "").trim().split(/\r?\n/)[0] || "").trim();
    pass(`agy on PATH: ${agy}${v ? ` (${v})` : ""}`);
  } else {
    warn("agy not on PATH");
    warnings++;
  }

  // gentle-ai CLI optional
  const gentle = which("gentle-ai");
  if (gentle) pass(`gentle-ai on PATH: ${gentle}`);
  else {
    warn("gentle-ai not on PATH");
    warnings++;
  }

  // engram
  const engram = which("engram");
  if (engram) pass(`engram on PATH: ${engram}`);
  else {
    warn("engram not on PATH");
    warnings++;
  }

  // opencode.json
  const oc = homeConfig("opencode", "opencode.json");
  if (existsSync(oc)) pass(`opencode.json: ${oc}`);
  else {
    fail(`opencode.json missing: ${oc}`);
    critical++;
  }

  // orchestrator patch marker
  let markerFound = false;
  if (existsSync(oc)) {
    try {
      const raw = readFileSync(oc, "utf8");
      if (
        /sdd-worker-bridge|Worker Bridge|Workers:|worker_policy|run-agy-phase/i.test(
          raw
        )
      ) {
        markerFound = true;
      }
    } catch {
      /* ignore */
    }
  }
  // also check agent prompt files if present
  if (!markerFound) {
    const agentCandidates = [
      homeConfig("opencode", "agent", "gentle-orchestrator.md"),
      homeConfig("opencode", "agents", "gentle-orchestrator.md"),
    ];
    for (const p of agentCandidates) {
      if (!existsSync(p)) continue;
      try {
        const t = readFileSync(p, "utf8");
        if (/sdd-worker-bridge|Worker Bridge|Workers:/i.test(t)) {
          markerFound = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (markerFound) pass("orchestrator worker-bridge marker found");
  else {
    warn("orchestrator patch marker not found (Workers / sdd-worker-bridge)");
    warnings++;
  }

  // runner dry-run smoke
  if (existsSync(runner)) {
    const smokeCwd = existsSync(ROOT) ? ROOT : tmpdir();
    const r = spawnSync(
      process.execPath,
      [
        runner,
        "--dry-run",
        "--phase",
        "explore",
        "--change",
        "install-check",
        "--project",
        "smoke",
        "--cwd",
        smokeCwd,
      ],
      { encoding: "utf8" }
    );
    if (r.status === 0 || r.status === 3) {
      pass(`runner dry-run smoke exit ${r.status}`);
    } else {
      fail(`runner dry-run smoke exit ${r.status}`);
      if (r.stderr) log((r.stderr || "").slice(0, 400));
      if (r.stdout) log((r.stdout || "").slice(0, 400));
      critical++;
    }
  } else {
    warn("runner dry-run skipped (runner missing)");
    warnings++;
  }

  log("");
  log(
    critical === 0
      ? `=== check OK (${warnings} warning(s)) ===`
      : `=== check FAILED (${critical} critical, ${warnings} warning(s)) ===`
  );
  process.exit(critical === 0 ? 0 : 1);
}

function main() {
  if (CHECK) {
    runCheck();
    return;
  }

  log("=== Gentle-ai-mod install ===");
  log(`source: ${ROOT}`);
  log(`home:   ${homedir()}`);
  if (!existsSync(PKG)) throw new Error(`package/ missing next to install.mjs`);

  checkPrereqs();
  installGentleAi();
  installOpenCodeSkill();
  installAntigravitySkill();
  patchSddTasksForecast();
  runPatch();
  smoke();

  log("");
  log("=== Done ===");
  log("Next steps:");
  log("  1. Restart OpenCode (required to load orchestrator prompt + skill)");
  log("  2. Start an SDD session — preflight should show Workers tab");
  log("  3. Optional project override: <repo>/.atl/sdd-workers.yaml");
  log("  4. Health: node install.mjs --check");
  if (DRY) log("(dry-run: no files were written)");
}

try {
  main();
} catch (err) {
  console.error("INSTALL FAILED:", err?.message || err);
  process.exit(1);
}
