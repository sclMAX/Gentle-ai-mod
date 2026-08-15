import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";

const runnerPath = join(process.cwd(), "package", "gentle-ai", "bin", "run-agy-task.mjs");
const env = { ...process.env, HERDR_SOCKET_PATH: "/tmp/fake.sock" };

test("generic runner validates task kind and prompt", () => {
  const result = spawnSync(process.execPath, [runnerPath, "--task-kind", "review", "--project", "p", "--cwd", process.cwd()], { env });
  assert.equal(result.status, 2);
  assert.match(result.stdout.toString(), /invalid.*task-kind/i);

  const missingPrompt = spawnSync(process.execPath, [runnerPath, "--task-kind", "general", "--project", "p", "--cwd", process.cwd()], { env });
  assert.equal(missingPrompt.status, 2);
  assert.match(missingPrompt.stdout.toString(), /missing.*prompt/i);
});
test("generic runner constructs herdr dry-run with task label and explicit controls", () => {
  const result = spawnSync(process.execPath, [
    runnerPath, "--dry-run", "--task-kind", "writer", "--project", "p", "--cwd", process.cwd(),
    "--prompt", "write $(id)", "--task-label", "writer-docs", "--model", "gemini-3.1-pro-high",
    "--effort", "high", "--timeout", "20m",
  ], { env });
  const output = result.stdout.toString();
  assert.equal(result.status, 0);
  assert.match(output, /Task kind: writer\s+Label: writer-docs/);
  assert.match(output, /gemini-3\.1-pro-high/);
  assert.match(output, /--effort","high/);
  assert.match(output, /Timeout: 20m/);
  assert.match(output, /write \$\(id\)/);
  assert.doesNotMatch(output, /uid=/);
  assert.doesNotMatch(output, /--phase/);
});

test("generic routing returns structured task result through the existing herdr transport", () => {
  const fakeDir = join(process.env.TMPDIR || "/tmp", `fake-herdr-task-${process.pid}`);
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakeHerdr = join(fakeDir, "herdr");
  fs.writeFileSync(fakeHerdr, `#!/bin/bash
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then echo '{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}'; exit 0; fi
if [ "$1" = "agent" ] && [ "$2" = "start" ]; then echo '{"result":{"agent":{"name":"fake-agent"}}}'; exit 0; fi
if [ "$1" = "agent" ] && [ "$2" = "get" ]; then echo '{"result":{"agent":{"agent_status":"done","state_change_seq":1,"revision":1}}}'; exit 0; fi
if [ "$1" = "agent" ] && [ "$2" = "prompt" ]; then
  sentinel=$(printf '%s' "$4" | grep -oE '/[^ ]+agy_result_[0-9]+\\.json' | tail -1)
  printf '%s' '{"status":"success","executive_summary":"ok"}' > "$sentinel"
  exit 0
fi
if [ "$1" = "tab" ] && [ "$2" = "close" ]; then exit 0; fi
exit 1
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [runnerPath, "--task-kind", "explore", "--project", "p", "--cwd", process.cwd(), "--prompt", "inspect"], {
    env: { ...env, PATH: `${fakeDir}:${process.env.PATH}` }, timeout: 30000,
  });
  fs.rmSync(fakeDir, { recursive: true, force: true });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout.toString());
  assert.equal(output.task_kind, "explore");
  assert.equal(output.task_label, "agy-task-explore");
  assert.equal(output.transport, "herdr");
});

test("generic task runner handles stalled prompt reconciliation without duplicate submission", () => {
  const fakeDir = join(process.env.TMPDIR || "/tmp", `fake-herdr-task-stalled-${process.pid}`);
  fs.mkdirSync(fakeDir, { recursive: true });
  const captureFile = join(fakeDir, "capture.txt");
  const stateFile = join(fakeDir, "state.txt");
  fs.writeFileSync(stateFile, "0");
  const fakeHerdr = join(fakeDir, "herdr");
  fs.writeFileSync(fakeHerdr, `#!/bin/bash
echo "CALL:$*" >> "$CAPTURE"
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "tab" ]; then
  if [ "$2" = "create" ]; then echo '{"result":{"tab":{"tab_id":"t-task"},"root_pane":{"pane_id":"p-task"}}}'; exit 0; fi
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
      SENTINEL=$(grep -oE '/[^ ]+agy_result_[0-9]+\\.json' "$CAPTURE" | head -1)
      if [ -n "$SENTINEL" ]; then
        echo '{"status":"success","executive_summary":"task completed after stall","artifacts":[],"next_recommended":"","risks":[]}' > "$SENTINEL"
      fi
      echo '{"result":{"agent":{"agent_status":"done","state_change_seq":3,"revision":2}}}'
      exit 0
    fi
  fi
  if [ "$2" = "prompt" ]; then
    echo "agent_prompt_stalled: 5000ms handshake timeout" >&2
    exit 1
  fi
fi
exit 1
`, { mode: 0o755 });

  const result = spawnSync(process.execPath, [runnerPath, "--task-kind", "writer", "--project", "p", "--cwd", process.cwd(), "--prompt", "write doc"], {
    env: { ...env, PATH: `${fakeDir}:${process.env.PATH}`, CAPTURE: captureFile, STATE: stateFile, GGA_HERDR_POLL_INTERVAL_MS: "30" },
    timeout: 30000,
  });

  const capture = fs.readFileSync(captureFile, "utf8");
  fs.rmSync(fakeDir, { recursive: true, force: true });

  assert.equal(result.status, 0);
  const promptCalls = (capture.match(/CALL:agent prompt/g) || []).length;
  assert.equal(promptCalls, 1, "Expected only 1 prompt call (no duplicate prompt)");
  const output = JSON.parse(result.stdout.toString());
  assert.equal(output.status, "success");
  assert.equal(output.task_kind, "writer");
  assert.equal(output.executive_summary, "task completed after stall");
});
