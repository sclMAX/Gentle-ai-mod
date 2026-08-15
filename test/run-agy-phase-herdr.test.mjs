import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const runnerPath = join(process.cwd(), "package", "gentle-ai", "bin", "run-agy-phase-herdr.mjs");

test("HERDR_ENV validation - missing HERDR_SOCKET_PATH returns exit code 6", () => {
  const result = spawnSync(process.execPath, [
    runnerPath, "--phase", "explore", "--change", "test", "--project", "p", "--cwd", process.cwd()
  ], { env: { ...process.env, HERDR_SOCKET_PATH: undefined } });

  assert.strictEqual(result.status, 6);
});

test("HERDR_ENV validation - invalid socket path returns exit code 6", () => {
  const result = spawnSync(process.execPath, [
    runnerPath, "--phase", "explore", "--change", "test", "--project", "p", "--cwd", process.cwd()
  ], { env: { ...process.env, HERDR_SOCKET_PATH: "relative/path/to.sock" } });

  assert.strictEqual(result.status, 6);
});

test("prompt-file security avoids shell interpolation", () => {
  const result = spawnSync(process.execPath, [
    runnerPath, "--dry-run", "--phase", "explore", "--change", "test", "--project", "p", "--cwd", process.cwd(), "--prompt", "$(id)"
  ], { env: { ...process.env, HERDR_SOCKET_PATH: "/tmp/fake.sock" } });
  
  const out = result.stdout.toString();
  assert.match(out, /\$\(id\)/);
  assert.doesNotMatch(out, /uid=/);
});

test("cwd validation and path.resolve() prevents escapes", () => {
  const result = spawnSync(process.execPath, [
    runnerPath, "--dry-run", "--phase", "explore", "--change", "test", "--project", "p", "--cwd", "../../"
  ], { env: { ...process.env, HERDR_SOCKET_PATH: "/tmp/fake.sock" } });
  
  assert.strictEqual(result.status, 2);
  const out = result.stdout.toString() + result.stderr.toString();
  assert.match(out, /cwd validation failed|under repo root/i);
});

test("account verification notice retries with backoff then dies unavailable (exit 4)", () => {
  // Fake `herdr` that always answers with the account-verification notice.
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
  const fakeHerdr = join(fakeDir, "herdr");
  writeFileSync(fakeHerdr, `#!/bin/bash
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then echo '{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}'; exit 0; fi
if [ "$1" = "agent" ]; then
  if [ "$2" = "start" ]; then echo '{"result":{"agent":{"name":"fake-agent"}}}'; exit 0; fi
  if [ "$2" = "get" ]; then echo '{"result":{"agent":{"agent_status":"idle"}}}'; exit 0; fi
  if [ "$2" = "prompt" ]; then
    echo "Verifying your account..."
    echo "  ⎿  We're finishing verifying your account eligibility."
    echo "     This usually takes a moment. Please try again shortly."
    exit 0
  fi
fi
exit 1
`, { mode: 0o755 });
  const env = { ...process.env, HERDR_SOCKET_PATH: "/tmp/fake.sock", PATH: fakeDir + ":" + process.env.PATH, GGA_HERDR_VERIFY_RETRY_MS: "1", GGA_HERDR_MAX_VERIFY_ATTEMPTS: "1" };
  const result = spawnSync(process.execPath, [
    runnerPath, "--phase", "explore", "--change", "test", "--project", "p", "--cwd", process.cwd()
  ], { env, timeout: 30000 });

  rmSync(fakeDir, { recursive: true, force: true });

  assert.strictEqual(result.status, 4);
  const out = result.stdout.toString() + result.stderr.toString();
  assert.match(out, /account_verification/);
  assert.match(out, /unavailable/);
  assert.doesNotMatch(out, /contract/);
});

test("model/effort/timeout are forwarded to agy agent start and prompt", () => {
  // Fake `herdr` that records every invocation and completes a prompt by
  // writing the sentinel file it extracts from the prompt text.
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
  const captureFile = join(fakeDir, "capture.txt");
  const fakeHerdr = join(fakeDir, "herdr");
  writeFileSync(fakeHerdr, `#!/bin/bash
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then echo '{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}'; exit 0; fi
if [ "$1" = "agent" ]; then
  if [ "$2" = "start" ]; then
    echo "START:$*" >> "$CAPTURE"
    echo '{"result":{"agent":{"name":"fake-agent"}}}'; exit 0
  fi
  if [ "$2" = "get" ]; then echo '{"result":{"agent":{"agent_status":"done","state_change_seq":1,"revision":1}}}'; exit 0; fi
  if [ "$2" = "prompt" ]; then
    echo "PROMPT:$*" >> "$CAPTURE"
    SENTINEL=$(echo "$4" | grep -oE '/[^ ]+agy_result_[0-9]+\\.json' | tail -1)
    echo '{"status":"success","executive_summary":"ok","artifacts":["x"],"next_recommended":"","risks":[],"skill_resolution":"paths-injected","worker":"agy","phase":"explore","project":"p","change_name":"c","error_class":null}' > "$SENTINEL"
    exit 0
  fi
fi
exit 1
`, { mode: 0o755 });
  const env = {
    ...process.env,
    HERDR_SOCKET_PATH: "/tmp/fake.sock",
    PATH: fakeDir + ":" + process.env.PATH,
    CAPTURE: captureFile,
  };
  const result = spawnSync(process.execPath, [
    runnerPath, "--phase", "explore", "--change", "c", "--project", "p", "--cwd", process.cwd(),
    "--model", "gemini-3.1-pro-high", "--effort", "high", "--timeout", "20m"
  ], { env, timeout: 30000 });

  const capture = readFileSync(captureFile, "utf8");
  rmSync(fakeDir, { recursive: true, force: true });

  assert.strictEqual(result.status, 0);
  assert.match(capture, /START:.*--model gemini-3\.1-pro-high --effort high/);
  assert.match(capture, /PROMPT:agent prompt/);
  assert.match(capture, /--wait --timeout 1200000/);
  const out = result.stdout.toString();
  assert.match(out, /"model": "gemini-3\.1-pro-high"/);
  assert.match(out, /"prompt_timeout_ms": 1200000/);
});
