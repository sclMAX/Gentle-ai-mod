import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

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
