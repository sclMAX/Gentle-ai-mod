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

test("stalled prompt reads the pane for account verification before startup timeout", () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-pane-"));
  const captureFile = join(fakeDir, "capture.txt");
  const fakeHerdr = join(fakeDir, "herdr");
  writeFileSync(fakeHerdr, `#!/bin/bash
echo "CALL:$*" >> "$CAPTURE"
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then echo '{"result":{"tab":{"tab_id":"t-pane"},"root_pane":{"pane_id":"p-pane"}}}'; exit 0; fi
if [ "$1" = "agent" ]; then
  if [ "$2" = "start" ]; then echo '{"result":{"agent":{"name":"fake-agent"}}}'; exit 0; fi
  if [ "$2" = "get" ]; then echo '{"result":{"agent":{"agent_status":"idle"}}}'; exit 0; fi
  if [ "$2" = "prompt" ]; then echo "agent_prompt_stalled" >&2; exit 1; fi
  if [ "$2" = "read" ]; then
    echo "Verifying your account..."
    echo "We're finishing verifying your account eligibility."
    echo "This usually takes a moment. Please try again shortly."
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
    GGA_HERDR_VERIFY_RETRY_MS: "1",
    GGA_HERDR_MAX_VERIFY_ATTEMPTS: "1",
    GGA_HERDR_STARTUP_TIMEOUT_MS: "80",
    GGA_HERDR_POLL_INTERVAL_MS: "20",
  };
  const result = spawnSync(process.execPath, [
    runnerPath, "--phase", "explore", "--change", "test", "--project", "p", "--cwd", process.cwd()
  ], { env, timeout: 30000 });

  const capture = readFileSync(captureFile, "utf8");
  rmSync(fakeDir, { recursive: true, force: true });

  assert.strictEqual(result.status, 4);
  assert.strictEqual((capture.match(/CALL:agent prompt/g) || []).length, 1);
  assert.strictEqual((capture.match(/CALL:agent read/g) || []).length, 1);
  const out = JSON.parse(result.stdout.toString());
  assert.strictEqual(out.error_class, "unavailable");
  assert.strictEqual(out.stall_reason, "account_verification");
  assert.doesNotMatch(result.stdout.toString(), /We're finishing|Try again shortly/i);
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

test("apply runs in the main worktree - never creates/removes a herdr worktree", () => {
  // Fake `herdr` that records every invocation and completes a prompt by
  // writing the sentinel file it extracts from the prompt text.
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-"));
  const captureFile = join(fakeDir, "capture.txt");
  const fakeHerdr = join(fakeDir, "herdr");
  writeFileSync(fakeHerdr, `#!/bin/bash
echo "CALL:$*" >> "$CAPTURE"
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then echo '{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}'; exit 0; fi
if [ "$1" = "agent" ]; then
  if [ "$2" = "start" ]; then echo '{"result":{"agent":{"name":"fake-agent"}}}'; exit 0; fi
  if [ "$2" = "get" ]; then echo '{"result":{"agent":{"agent_status":"done","state_change_seq":1,"revision":1}}}'; exit 0; fi
  if [ "$2" = "prompt" ]; then
    SENTINEL=$(echo "$4" | grep -oE '/[^ ]+agy_result_[0-9]+\\.json' | tail -1)
    echo '{"status":"success","executive_summary":"ok","artifacts":["x"],"next_recommended":"","risks":[],"skill_resolution":"paths-injected","worker":"agy","phase":"apply","project":"p","change_name":"c","error_class":null}' > "$SENTINEL"
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
    runnerPath, "--phase", "apply", "--change", "c", "--project", "p", "--cwd", process.cwd()
  ], { env, timeout: 30000 });

  const capture = readFileSync(captureFile, "utf8");
  rmSync(fakeDir, { recursive: true, force: true });

  assert.strictEqual(result.status, 0);
  assert.doesNotMatch(capture, /worktree/);
  assert.match(capture, /tab create .*--cwd/);
});

test("stalled prompt followed by eventual completion does not create a duplicate prompt or tab", () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-stalled-"));
  const captureFile = join(fakeDir, "capture.txt");
  const stateFile = join(fakeDir, "state.txt");
  const fakeHerdr = join(fakeDir, "herdr");
  writeFileSync(stateFile, "0");
  writeFileSync(fakeHerdr, `#!/bin/bash
echo "CALL:$*" >> "$CAPTURE"
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then
  if [ "$2" = "create" ]; then echo '{"result":{"tab":{"tab_id":"t-stalled"},"root_pane":{"pane_id":"p-stalled"}}}'; exit 0; fi
  if [ "$2" = "close" ]; then exit 0; fi
fi
if [ "$1" = "agent" ]; then
  if [ "$2" = "start" ]; then echo '{"result":{"agent":{"name":"fake-agent"}}}'; exit 0; fi
  if [ "$2" = "get" ]; then
    COUNT=$(cat "$STATE")
    COUNT=$((COUNT + 1))
    echo "$COUNT" > "$STATE"
    if [ "$COUNT" -eq 1 ]; then
      echo '{"result":{"agent":{"agent_status":"idle","state_change_seq":1,"revision":1}}}'
      exit 0
    elif [ "$COUNT" -eq 2 ]; then
      echo '{"result":{"agent":{"agent_status":"working","state_change_seq":2,"revision":1}}}'
      exit 0
    else
      # Agent finished: write the sentinel file extracted from the prompt
      SENTINEL=$(grep -oE '/[^ ]+agy_result_[0-9]+\\.json' "$CAPTURE" | head -1)
      if [ -n "$SENTINEL" ]; then
        echo '{"status":"success","executive_summary":"completed after stall","artifacts":["fix.js"],"next_recommended":"","risks":[],"worker":"agy","phase":"explore","project":"p","change_name":"c","error_class":null}' > "$SENTINEL"
      fi
      echo '{"result":{"agent":{"agent_status":"done","state_change_seq":3,"revision":2}}}'
      exit 0
    fi
  fi
  if [ "$2" = "prompt" ]; then
    # Simulate 5-second wait handshake stall from herdr
    echo "agent_prompt_stalled: no state change observed within 5000ms" >&2
    exit 1
  fi
fi
exit 1
`, { mode: 0o755 });

  const env = {
    ...process.env,
    HERDR_SOCKET_PATH: "/tmp/fake.sock",
    PATH: fakeDir + ":" + process.env.PATH,
    CAPTURE: captureFile,
    STATE: stateFile,
    GGA_HERDR_POLL_INTERVAL_MS: "30",
  };

  const result = spawnSync(process.execPath, [
    runnerPath, "--phase", "explore", "--change", "c", "--project", "p", "--cwd", process.cwd()
  ], { env, timeout: 30000 });

  const capture = readFileSync(captureFile, "utf8");
  rmSync(fakeDir, { recursive: true, force: true });

  assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);

  // Verify exactly 1 tab create and exactly 1 agent prompt (no duplicate tab or prompt)
  const tabCreates = (capture.match(/CALL:tab create/g) || []).length;
  const promptCalls = (capture.match(/CALL:agent prompt/g) || []).length;
  const tabCloses = (capture.match(/CALL:tab close/g) || []).length;

  assert.strictEqual(tabCreates, 1, `Expected exactly 1 tab create, got ${tabCreates}`);
  assert.strictEqual(promptCalls, 1, `Expected exactly 1 agent prompt call, got ${promptCalls}`);
  assert.strictEqual(tabCloses, 1, `Expected exactly 1 tab close call, got ${tabCloses}`);

  const out = JSON.parse(result.stdout.toString());
  assert.strictEqual(out.status, "success");
  assert.strictEqual(out.executive_summary, "completed after stall");
  assert.strictEqual(out.worker, "agy");
  assert.strictEqual(out.transport, "herdr");
});

test("true terminal failure (agent crash) exits with useful structured error and cleans up tab", () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-crash-"));
  const captureFile = join(fakeDir, "capture.txt");
  const fakeHerdr = join(fakeDir, "herdr");
  writeFileSync(fakeHerdr, `#!/bin/bash
echo "CALL:$*" >> "$CAPTURE"
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then
  if [ "$2" = "create" ]; then echo '{"result":{"tab":{"tab_id":"t-crash"},"root_pane":{"pane_id":"p-crash"}}}'; exit 0; fi
  if [ "$2" = "close" ]; then exit 0; fi
fi
if [ "$1" = "agent" ]; then
  if [ "$2" = "start" ]; then echo '{"result":{"agent":{"name":"fake-agent"}}}'; exit 0; fi
  if [ "$2" = "get" ]; then echo '{"result":{"agent":{"agent_status":"crashed"}}}'; exit 0; fi
  if [ "$2" = "prompt" ]; then
    echo "agent_prompt_stalled: agent crashed during prompt" >&2
    exit 1
  fi
fi
exit 1
`, { mode: 0o755 });

  const env = {
    ...process.env,
    HERDR_SOCKET_PATH: "/tmp/fake.sock",
    PATH: fakeDir + ":" + process.env.PATH,
    CAPTURE: captureFile,
    GGA_HERDR_POLL_INTERVAL_MS: "30",
  };

  const result = spawnSync(process.execPath, [
    runnerPath, "--phase", "explore", "--change", "c", "--project", "p", "--cwd", process.cwd()
  ], { env, timeout: 30000 });

  const capture = readFileSync(captureFile, "utf8");
  rmSync(fakeDir, { recursive: true, force: true });

  assert.strictEqual(result.status, 4);
  const tabCloses = (capture.match(/CALL:tab close/g) || []).length;
  assert.strictEqual(tabCloses, 1, `Expected tab close to be called for cleanup on crash`);

  const out = JSON.parse(result.stdout.toString());
  assert.strictEqual(out.status, "failed");
  assert.strictEqual(out.error_class, "unavailable");
  assert.match(out.message, /crashed|terminal dead state/);
});

test("startup timeout when agent stays idle and never starts exits with stalled error and cleans up tab", () => {
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-herdr-timeout-"));
  const captureFile = join(fakeDir, "capture.txt");
  const fakeHerdr = join(fakeDir, "herdr");
  writeFileSync(fakeHerdr, `#!/bin/bash
echo "CALL:$*" >> "$CAPTURE"
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then
  if [ "$2" = "create" ]; then echo '{"result":{"tab":{"tab_id":"t-timeout"},"root_pane":{"pane_id":"p-timeout"}}}'; exit 0; fi
  if [ "$2" = "close" ]; then exit 0; fi
fi
if [ "$1" = "agent" ]; then
  if [ "$2" = "start" ]; then echo '{"result":{"agent":{"name":"fake-agent"}}}'; exit 0; fi
  if [ "$2" = "get" ]; then echo '{"result":{"agent":{"agent_status":"idle","state_change_seq":1,"revision":1}}}'; exit 0; fi
  if [ "$2" = "prompt" ]; then
    echo "agent_prompt_stalled" >&2
    exit 1
  fi
fi
exit 1
`, { mode: 0o755 });

  const env = {
    ...process.env,
    HERDR_SOCKET_PATH: "/tmp/fake.sock",
    PATH: fakeDir + ":" + process.env.PATH,
    CAPTURE: captureFile,
    GGA_HERDR_POLL_INTERVAL_MS: "20",
    GGA_HERDR_STARTUP_TIMEOUT_MS: "80",
  };

  const result = spawnSync(process.execPath, [
    runnerPath, "--phase", "explore", "--change", "c", "--project", "p", "--cwd", process.cwd()
  ], { env, timeout: 30000 });

  const capture = readFileSync(captureFile, "utf8");
  rmSync(fakeDir, { recursive: true, force: true });

  assert.strictEqual(result.status, 8);
  const tabCloses = (capture.match(/CALL:tab close/g) || []).length;
  assert.strictEqual(tabCloses, 1, `Expected tab close to be called for cleanup on timeout`);

  const out = JSON.parse(result.stdout.toString());
  assert.strictEqual(out.status, "failed");
  assert.strictEqual(out.error_class, "stalled");
  assert.strictEqual(out.stall_reason, "startup_timeout");
});
