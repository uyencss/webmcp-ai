import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const binPath = join(rootDir, "bin/webmcp-ai.mjs");
const orchestrationCandidateDir = fileURLToPath(new URL("../../orchestration", import.meta.url));

test("core package boundary: no orchestration directories or SDK dependencies in core", () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.bundledDependencies, undefined);

  assert.equal(pkg.exports["./orchestration"], undefined);
  assert.equal(pkg.exports["."], "./src/client.mjs");
  assert.equal(pkg.exports["./bin"], "./bin/webmcp-ai.mjs");
  assert.equal(pkg.exports["./errors"], "./src/errors.mjs");
  assert.equal(pkg.exports["./jev"], "./src/jev/cli.mjs");
  assert.equal(pkg.exports["./providers"], "./src/providers/index.mjs");
  assert.equal(pkg.exports["./protocol"], "./src/protocol.mjs");
  assert.equal(pkg.exports["./package.json"], "./package.json");

  assert.equal(existsSync(join(rootDir, "src/orchestration")), false, "src/orchestration must be completely removed from core");
});
test("core package boundary: static import audit reveals zero orchestration or opencode-sdk imports in core src", () => {
  function walk(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(full));
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(full);
    }
    return files;
  }

  const srcFiles = walk(join(rootDir, "src"));
  assert.ok(srcFiles.length > 0, "must find core src files");

  for (const file of srcFiles) {
    const content = readFileSync(file, "utf8");
    assert.doesNotMatch(content, /@opencode-ai\/sdk/, file + " must not reference @opencode-ai/sdk");
    assert.doesNotMatch(content, /from\s+['"][^'"]*orchestration/, file + " must not statically import from orchestration");
    if (!file.endsWith("src/cli.mjs")) {
      assert.doesNotMatch(content, /@gyga-browser\/webmcp-ai-orchestration/, file + " must not reference orchestration package");
    }
  }
});

test("core package boundary: public exports resolve and expose expected symbols", async () => {
  const clientMod = await import(join(rootDir, "src/client.mjs"));
  assert.equal(typeof clientMod.generate, "function");
  assert.equal(typeof clientMod.describeGenerateDryRun, "function");
  assert.equal(typeof clientMod.probeProviders, "function");
  assert.equal(typeof clientMod.listModels, "function");
  assert.equal(typeof clientMod.listAgents, "function");

  const errorsMod = await import(join(rootDir, "src/errors.mjs"));
  assert.equal(typeof errorsMod.AiCliError, "function");
  assert.equal(typeof errorsMod.asAiCliError, "function");

  const providersMod = await import(join(rootDir, "src/providers/index.mjs"));
  assert.equal(typeof providersMod.resolveOpencodeCliDb, "function");
  assert.equal(typeof providersMod.listProviders, "function");
  assert.equal(typeof providersMod.getProvider, "function");
  assert.equal(typeof providersMod.resolveProviderBin, "function");

  const protocolMod = await import(join(rootDir, "src/protocol.mjs"));
  assert.equal(typeof protocolMod.TOOL_PROTOCOL, "string");
  assert.equal(typeof protocolMod.describeTools, "function");
  assert.equal(typeof protocolMod.handleToolCall, "function");

  const jevMod = await import(join(rootDir, "src/jev/cli.mjs"));
  assert.equal(typeof jevMod.runJevCli, "function");
  const jevDoctorMod = await import(join(rootDir, "src/jev/doctor.mjs"));
  assert.equal(typeof jevDoctorMod.jevDoctor, "function");
});

test("transitional CLI compatibility shim: returns ORCHESTRATION_PACKAGE_REQUIRED when package is absent", () => {
  const isolatedDir = mkdtempSync(join(tmpdir(), "webmcp-boundary-absent-"));
  try {
    const jsonRes = spawnSync(process.execPath, [binPath, "orchestration", "capabilities", "--json"], {
      cwd: isolatedDir,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(jsonRes.status, 2);
    assert.equal(jsonRes.stderr, "", "must not emit stack trace");
    const jsonPayload = JSON.parse(jsonRes.stdout);
    assert.equal(jsonPayload.ok, false);
    assert.equal(jsonPayload.error.code, "ORCHESTRATION_PACKAGE_REQUIRED");
    assert.match(jsonPayload.error.message, /@gyga-browser\/webmcp-ai-orchestration/);

    const textRes = spawnSync(process.execPath, [binPath, "orchestration", "capabilities"], {
      cwd: isolatedDir,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(textRes.status, 2);
    assert.match(textRes.stderr, /^ORCHESTRATION_PACKAGE_REQUIRED:/);
    assert.doesNotMatch(textRes.stderr, /at /);
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("transitional CLI compatibility shim: delegates successfully when orchestration package is present", () => {
  if (!existsSync(orchestrationCandidateDir)) {
    return;
  }
  const consumerDir = mkdtempSync(join(tmpdir(), "webmcp-boundary-present-"));
  try {
    writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "consumer-app", type: "module" }));
    const nmScoped = join(consumerDir, "node_modules", "@gyga-browser");
    mkdirSync(nmScoped, { recursive: true });
    symlinkSync(rootDir, join(nmScoped, "webmcp-ai"));
    symlinkSync(orchestrationCandidateDir, join(nmScoped, "webmcp-ai-orchestration"));

    const stateDir = join(consumerDir, "orch-state");
    const res = spawnSync(process.execPath, [binPath, "orchestration", "capabilities", "--json"], {
      cwd: consumerDir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateDir,
        WEBMCP_AI_ALLOW_CWD_COMPANION: "1",
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.protocol, "webmcp.ai-orchestration/v0");
    assert.ok(Array.isArray(payload.adapters));
  } finally {
    rmSync(consumerDir, { recursive: true, force: true });
  }
});

test("core error, protocol, and CLI review branch validation coverage", async () => {
  const { AiCliError, asAiCliError } = await import(join(rootDir, "src/errors.mjs"));
  const errWithDetails = new AiCliError("ERR_WITH_DETAILS", "has details", { details: { reason: "test" } });
  assert.deepEqual(errWithDetails.toJSON(), {
    code: "ERR_WITH_DETAILS",
    message: "has details",
    retryable: false,
    details: { reason: "test" },
  });
  const fromString = asAiCliError("just a string error");
  assert.equal(fromString.code, "INTERNAL_ERROR");
  assert.equal(fromString.message, "just a string error");

  const { handleToolCall } = await import(join(rootDir, "src/protocol.mjs"));
  const reviewForbiddenRes = await handleToolCall({
    protocol: "webmcp-tool-v1",
    requestId: "req_cov_1",
    tool: "ai.review",
    input: { provider: "opencode", prompt: "p", agentMode: "plan" },
  }).catch((e) => e);
  assert.equal(reviewForbiddenRes.code, "INVALID_INPUT");

  const nonStringIntentRes = await handleToolCall({
    protocol: "webmcp-tool-v1",
    requestId: "req_cov_2",
    tool: "ai.generate",
    input: { provider: "opencode", prompt: "p", taskIntent: 123 },
  }).catch((e) => e);
  assert.equal(nonStringIntentRes.code, "INVALID_INPUT");

  // CLI review option validation branches
  const runCli = (args) => spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
  assert.equal(runCli(["review", "--provider", "opencode", "--prompt", "hi", "--agent-mode", "plan", "--json"]).status, 2);
  assert.equal(runCli(["review", "--provider", "opencode", "--prompt", "hi", "--full", "--json"]).status, 2);
  assert.equal(runCli(["review", "--provider", "opencode", "--prompt", "hi", "--stream", "--json"]).status, 2);
  assert.equal(runCli(["review", "--provider", "opencode", "--prompt", "hi", "--stream-to", "stderr", "--json"]).status, 2);
  assert.equal(runCli(["review", "--provider", "opencode", "--prompt", "hi", "--allowed-write-root", "/tmp", "--json"]).status, 2);
  assert.equal(runCli(["review", "--provider", "opencode", "--prompt", "hi", "--store-revisions", '{"rev":"1"}', "--dry-run", "--json"]).status, 0);
  assert.equal(runCli(["review", "--provider", "opencode", "--prompt", "hi", "--store-revisions", "raw-rev-str", "--dry-run", "--json"]).status, 2);
});
