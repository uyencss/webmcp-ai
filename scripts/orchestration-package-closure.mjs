#!/usr/bin/env node
// Hermetic package-closure verifier for @gyga-browser/webmcp-ai.
//
// Proves, without touching ambient npm configuration or the user HOME:
//   1. `npm pack --json` (shell:false, isolated env) emits a tarball whose
//      manifest covers every published contract surface.
//   2. The tarball never ships private material (tests, dotfiles, state).
//   3. package.json / package-lock.json / CHANGELOG.md agree on one version
//      and the packaged runtime guide keeps its {{PACKAGE_VERSION}} seam.
//   4. The kill switch stays stable without spawning supervisors.
//   5. CLEAN INSTALL: the packed tarball installs into an isolated consumer
//      project using NPM_CONFIG_USERCONFIG/CACHE/PREFIX scoped to a temp root
//      (HOME is never repurposed), the public entrypoints import through bare
//      specifiers from the consumer dir, the packaged CLI answers, and a
//      supervisor assembled FROM THE INSTALLED FILES completes one fixture-
//      backed public dispatch end to end through the operation table.
//   6. schemas/skills/scripts assets exist after installation; any missing
//      artifact fails closure with exit 1.
//
// Exit code 0 prints a JSON receipt; any violation prints violations and
// exits 1. Run via `npm run test:package-closure`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
export const OWNER_BASE_COMMIT = '47bfccee8f5d6b1c944908cfb9903d87a4b6014b';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isolatedTemp(name) {
  return mkdtempSync(join(tmpdir(), `webmcp-ai-closure-${name}-`));
}

/**
 * Pure manifest audit: every published contract surface must be present in
 * the packed file list. Removing ANY required orchestration module, schema,
 * skill or reference asset fails closure.
 */
export function auditShippedPaths(shippedPaths, schemasDir) {
  const shipped = shippedPaths instanceof Set ? shippedPaths : new Set(shippedPaths);
  const violations = [];
  const requiredPaths = [
    'bin/webmcp-ai.mjs',
    'src/cli.mjs',
    'src/orchestration/client.mjs',
    'src/orchestration/supervisor-entry.mjs',
    'src/orchestration/guide.mjs',
    'scripts/orchestration-hook.mjs',
    'scripts/install-agent.mjs',
    'skills/webmcp-ai-cli/SKILL.md',
    'skills/webmcp-ai-cli/agents/openai.yaml',
    'skills/webmcp-ai-cli/references/cli-subagent-orchestration.md',
    'skills/webmcp-ai-cli/references/orchestration-runtime.md',
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
  ];
  if (existsSync(schemasDir)) {
    for (const schemaName of readdirSync(schemasDir)) {
      requiredPaths.push(`src/orchestration/schemas/${schemaName}`);
    }
  }
  for (const required of requiredPaths) {
    if (!shipped.has(required)) violations.push(`tarball is missing required path: ${required}`);
  }
  const forbiddenPrefixes = ['tests/', 'node_modules/', '.github/', '.git'];
  for (const shippedPath of shipped) {
    if (forbiddenPrefixes.some((prefix) => shippedPath === prefix || shippedPath.startsWith(prefix))) {
      violations.push(`tarball must not ship private path: ${shippedPath}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Parse `git diff --check` output into a typed verdict. */
export function evaluateRangeDiffCheck(output) {
  const violations = String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: violations.length === 0, violations };
}

/**
 * Whether the owner-base..HEAD range check can run in THIS checkout. Shallow
 * CI clones do not contain historical SHAs; the one-time gate must never
 * break the permanent publish lifecycle.
 */
export function rangeCheckApplies(repoRoot, baseSha = OWNER_BASE_COMMIT) {
  const probe = spawnSync('git', ['cat-file', '-e', `${baseSha}^{commit}`], {
    cwd: repoRoot,
    shell: false,
    encoding: 'utf8',
  });
  return probe.status === 0;
}

function scopedNpmEnv({ emptyNpmrc, cacheDir, prefixDir }) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    // HOME is deliberately NOT overridden: npm scoping happens exclusively
    // through task-specific config/cache/prefix variables.
    NPM_CONFIG_USERCONFIG: emptyNpmrc,
    NPM_CONFIG_CACHE: cacheDir,
    NPM_CONFIG_PREFIX: prefixDir,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_REGISTRY: process.env.WEBMCP_CLOSURE_REGISTRY ?? 'https://registry.npmjs.org/',
  };
}

/**
 * Full closure pipeline. Returns a structured receipt; never throws for
 * expected verification failures.
 */
export async function runPackageClosure({
  repoRoot = defaultRoot,
  consumerDir = null,
  ownerBaseRange = `${OWNER_BASE_COMMIT}..HEAD`,
} = {}) {
  const violations = [];
  const checks = [];
  const requireCondition = (condition, message) => {
    checks.push({ check: message, ok: condition === true });
    if (condition !== true) violations.push(message);
    return condition === true;
  };

  // ---- 1+2: hermetic npm pack and tarball manifest audit --------------------

  const packDir = isolatedTemp('pack');
  const emptyNpmrc = join(isolatedTemp('npmrc'), 'empty.npmrc');
  writeFileSync(emptyNpmrc, '');
  const cacheDir = isolatedTemp('cache');
  const prefixDir = isolatedTemp('prefix');

  const packResult = spawnSync('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: repoRoot,
    shell: false,
    encoding: 'utf8',
    env: scopedNpmEnv({ emptyNpmrc, cacheDir, prefixDir }),
  });

  requireCondition(packResult.status === 0, 'npm pack --json exits successfully under an isolated environment');
  if (packResult.status !== 0) {
    violations.push(`npm pack stderr: ${String(packResult.stderr).slice(0, 800)}`);
  }

  let packed = null;
  try {
    packed = JSON.parse(packResult.stdout);
  } catch {
    packed = null;
  }
  requireCondition(Array.isArray(packed) && packed.length === 1, 'npm pack reports exactly one package');
  const tarball = packed?.[0];
  const tarballPath = tarball ? join(packDir, tarball.filename) : null;
  requireCondition(tarballPath !== null && existsSync(tarballPath), 'packed tarball exists on disk in the isolated destination');

  const shippedPaths = new Set((tarball?.files ?? []).map((entry) => entry.path));
  const manifestAudit = auditShippedPaths(shippedPaths, join(repoRoot, 'src/orchestration/schemas'));
  for (const violation of manifestAudit.violations) violations.push(violation);
  checks.push({ check: 'tarball manifest covers every required contract surface', ok: manifestAudit.ok });
  checks.push({ check: 'tarball excludes tests/, node_modules/ and dot-directories', ok: !manifestAudit.violations.some((v) => v.includes('must not ship private path')) });

  // ---- 3: version + guide seam consistency ----------------------------------

  const packageJson = readJson(join(repoRoot, 'package.json'));
  const lockJson = readJson(join(repoRoot, 'package-lock.json'));
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const runtimeGuide = readFileSync(
    join(repoRoot, 'skills/webmcp-ai-cli/references/orchestration-runtime.md'),
    'utf8',
  );

  requireCondition(packageJson.version === lockJson.version, 'package.json and package-lock.json share one version');
  requireCondition(packageJson.version === lockJson.packages[''].version, 'lockfile root package records the same version');
  requireCondition(/^\d+\.\d+\.\d+/.test(packageJson.version), 'version is a valid semver string');
  requireCondition(changelog.includes(`## ${packageJson.version}`), 'CHANGELOG.md has an entry for the released version');
  requireCondition(runtimeGuide.includes('{{PACKAGE_VERSION}}'), 'runtime guide keeps its {{PACKAGE_VERSION}} substitution seam');
  requireCondition(typeof packageJson.scripts['test:package-closure'] === 'string', 'npm run test:package-closure is wired to this verifier');
  requireCondition(
    String(packageJson.scripts.prepublishOnly ?? '').includes('test:package-closure')
    || String(packageJson.scripts.prepublishOnly ?? '').includes('orchestration-package-closure'),
    'prepublishOnly runs the package closure gate',
  );

  // ---- 5: clean install into an isolated consumer project -------------------

  const consumerRoot = consumerDir ?? isolatedTemp('consumer');
  const pkgScopedCache = isolatedTemp('install-cache');
  const pkgScopedPrefix = isolatedTemp('install-prefix');
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({ name: 'closure-consumer', private: true, version: '0.0.0' }, null, 1)}\n`);

  const installStatus = (() => {
    if (!tarballPath) return -1;
    const run = spawnSync('npm', ['install', tarballPath, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: consumerRoot,
      shell: false,
      encoding: 'utf8',
      timeout: 240_000,
      env: scopedNpmEnv({ emptyNpmrc, cacheDir: pkgScopedCache, prefixDir: pkgScopedPrefix }),
    });
    if (run.status !== 0) {
      violations.push(`clean install failed: ${String(run.stderr).slice(-800)}`);
    }
    return run.status;
  })();
  requireCondition(installStatus === 0, 'clean install of the packed tarball succeeds in an isolated consumer project');

  const installedPkgDir = join(consumerRoot, 'node_modules', packageJson.name);

  // Public entrypoints import through bare specifiers from the consumer dir.
  const importProbe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    [
      "const entry = await import('@gyga-browser/webmcp-ai');",
      "const orchestration = await import('@gyga-browser/webmcp-ai/orchestration');",
      "const protocol = await import('@gyga-browser/webmcp-ai/protocol');",
      "const ok = typeof entry === 'object' && typeof orchestration.getOrchestrationCapabilities === 'function' && protocol !== null;",
      "console.log(JSON.stringify({ ok, imported: ['.', './orchestration', './protocol'] }));",
    ].join('\n'),
  ], {
    cwd: consumerRoot,
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  let importPayload = null;
  try {
    importPayload = JSON.parse(importProbe.stdout);
  } catch {
    importPayload = null;
  }
  requireCondition(importProbe.status === 0 && importPayload?.ok === true, 'installed public entrypoints import through bare specifiers');

  // The packaged CLI answers from the INSTALLED artifact.
  const cliRun = spawnSync(process.execPath, [join(installedPkgDir, 'bin/webmcp-ai.mjs'), 'orchestration', 'capabilities', '--json'], {
    cwd: consumerRoot,
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      WEBMCP_AI_ORCHESTRATION_STATE_DIR: join(consumerRoot, 'cli-state'),
    },
  });
  let cliPayload = null;
  try {
    cliPayload = JSON.parse(cliRun.stdout);
  } catch {
    cliPayload = null;
  }
  requireCondition(cliRun.status === 0 && cliPayload?.ok === true && Array.isArray(cliPayload?.adapters), 'installed CLI answers orchestration capabilities');

  // A supervisor assembled FROM THE INSTALLED FILES completes one fixture
  // dispatch through the PUBLIC operation table.
  const workerScript = join(consumerRoot, 'closure-worker.mjs');
  writeFileSync(workerScript, [
    '#!/usr/bin/env node',
    "process.stderr.write('hello-from-stderr\\n', () => {",
    "  process.stdout.write('hello-from-stdout\\n', () => process.exit(0));",
    '});',
    '',
  ].join('\n'));

  const lifecycleDriver = [
    "const base = process.env.WEBMCP_CLOSURE_PKG_DIR;",
    "const stateRoot = process.env.WEBMCP_CLOSURE_STATE;",
    "const worker = process.env.WEBMCP_CLOSURE_WORKER;",
    "const { createOwnedProcessAdapter } = await import(base + '/src/orchestration/adapters/owned-process.mjs');",
    "const pa = await import(base + '/src/orchestration/public-adapters.mjs');",
    "const supMod = await import(base + '/src/orchestration/supervisor.mjs');",
    "const pathsMod = await import(base + '/src/orchestration/paths.mjs');",
    "const authMod = await import(base + '/src/orchestration/authority.mjs');",
    "const ipcMod = await import(base + '/src/orchestration/ipc.mjs');",
    "const constantsMod = await import(base + '/src/orchestration/constants.mjs');",
    "const fs = await import('node:fs');",
    "const path = await import('node:path');",
    "const workspace = path.join(stateRoot, 'ws');",
    "fs.mkdirSync(workspace, { recursive: true });",
    "const coordinationId = 'coord_w7' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);",
    "const env = { ...process.env, WEBMCP_AI_ORCHESTRATION_STATE_DIR: stateRoot };",
    "const roots = pathsMod.resolveOrchestrationRoots({ env });",
    "const inner = createOwnedProcessAdapter({ stateDir: path.join(stateRoot, 'op-state') });",
    "const config = pa.createTrustedCoordinatorConfig({",
    "  stateDir: path.join(stateRoot, 'trusted'),",
    "  allowFixtureDispatch: true,",
    "  ownedProcessCommand: { command: process.execPath, args: [worker], env: {} },",
    "});",
    "const adapter = pa.asPublicAdapter(inner, pa.createPublicLifecycle('owned-process', inner, config));",
    "const sup = await supMod.createSupervisor({ env, mode: 'create', coordinationId, adapters: [adapter], trustedCoordinatorConfig: { allowFixtureDispatch: true } });",
    "const call = async (operation, input) => ipcMod.requestIpc(",
    "  ipcMod.deriveEndpoint({ ipcRoot: path.join(roots.stateRoot, 'ipc'), coordinationId }),",
    "  { protocol: constantsMod.ORCHESTRATION_PROTOCOL, requestId: 'req_' + Math.random().toString(36).slice(2, 8), coordinationId, fenceEpoch: sup.__store.state.fenceEpoch, capability: authMod.readClientCapability({ coordinationDir: path.join(roots.stateRoot, 'coordinations', coordinationId) }), operation, input },",
    "  { timeoutMs: 20_000 },",
    ");",
    "const created = await call('task.create', { packet: { objective: 'closure lifecycle', workspace, allowedReadRoots: [workspace], allowedWriteRoots: [] } });",
    "if (!created.ok) throw new Error('task.create failed: ' + JSON.stringify(created.error));",
    "const taskId = created.result.taskId;",
    "const started = await call('dispatch.start', { taskId, adapterId: 'owned-process' });",
    "if (!started.ok) throw new Error('dispatch.start failed: ' + JSON.stringify(started.error));",
    "const dispatchId = started.result.dispatchId;",
    "const seen = new Set(); let cursor = 0; const deadline = Date.now() + 25_000;",
    "for (;;) {",
    "  const wait = await call('delivery.wait', { afterSequence: cursor, timeoutMs: 2_000 });",
    "  if (!wait.ok) break;",
    "  for (const delivery of wait.result.deliveries ?? []) { seen.add(delivery.type); cursor = Math.max(cursor, delivery.sequence); }",
    "  if (seen.has('worker_done') && seen.has('cleanup_recorded')) break;",
    "  if (Date.now() > deadline) break;",
    "}",
    "const inspect = await call('coordination.inspect', {});",
    "const state = inspect.ok ? inspect.result.dispatches[dispatchId].state : null;",
    "const taskState = inspect.ok ? inspect.result.tasks[taskId].state : null;",
    "await sup.stop();",
    "const ok = seen.has('worker_started') && seen.has('progress') && seen.has('worker_done') && seen.has('cleanup_recorded') && state === 'settled' && taskState === 'awaiting_acceptance';",
    "console.log(JSON.stringify({ ok, seen: [...seen].sort(), state, taskState }));",
  ].join('\n');

  // macOS socket sun_path is capped at 104 bytes: keep the lifecycle state
  // root under a SHORT temp prefix so the derived IPC socket stays valid.
  const lifecycleStateRoot = mkdtempSync(join(tmpdir(), 'w7st-'));
  const lifecycleRun = spawnSync(process.execPath, ['--input-type=module', '-e', lifecycleDriver], {
    cwd: consumerRoot,
    shell: false,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      WEBMCP_CLOSURE_PKG_DIR: installedPkgDir,
      WEBMCP_CLOSURE_STATE: lifecycleStateRoot,
      WEBMCP_CLOSURE_WORKER: workerScript,
    },
  });
  let lifecyclePayload = null;
  try {
    lifecyclePayload = JSON.parse(lifecycleRun.stdout.trim().split('\n').pop());
  } catch {
    lifecyclePayload = null;
  }
  if (!requireCondition(lifecycleRun.status === 0 && lifecyclePayload?.ok === true, 'installed supervisor completes a fixture-backed public dispatch lifecycle')) {
    violations.push(`lifecycle driver output: ${String(lifecycleRun.stdout).slice(-400)} ${String(lifecycleRun.stderr).slice(-400)}`);
  }

  // ---- 6: assets exist after installation ------------------------------------

  const installedSchemas = join(installedPkgDir, 'src/orchestration/schemas');
  const repoSchemas = join(repoRoot, 'src/orchestration/schemas');
  const installedSchemaNames = existsSync(installedSchemas) ? readdirSync(installedSchemas) : [];
  const repoSchemaNames = existsSync(repoSchemas) ? readdirSync(repoSchemas) : [];
  const assetsOk = existsSync(installedPkgDir)
    && installedSchemaNames.length === repoSchemaNames.length
    && installedSchemaNames.every((name) => existsSync(join(installedSchemas, name)))
    && existsSync(join(installedPkgDir, 'skills/webmcp-ai-cli/SKILL.md'))
    && existsSync(join(installedPkgDir, 'skills/webmcp-ai-cli/references/orchestration-runtime.md'))
    && existsSync(join(installedPkgDir, 'scripts/orchestration-hook.mjs'))
    && Boolean(statSync(join(installedPkgDir, 'bin/webmcp-ai.mjs')).mode & 0o111);
  requireCondition(Boolean(assetsOk), 'schemas, skills and scripts assets exist after installation');

  // ---- 4: kill switch stability without spawning supervisors -----------------

  const disabledStateDir = join(isolatedTemp('state'), 'orchestration');
  const cliEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    WEBMCP_AI_ORCHESTRATION_DISABLED: '1',
    WEBMCP_AI_ORCHESTRATION_STATE_DIR: disabledStateDir,
  };

  const runDisabled = (args, { input } = {}) => spawnSync(process.execPath, [join(repoRoot, 'bin/webmcp-ai.mjs'), ...args], {
    cwd: repoRoot,
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    env: cliEnv,
    input,
  });

  const capabilitiesRun = runDisabled(['orchestration', 'capabilities', '--json']);
  requireCondition(capabilitiesRun.status === 0, 'kill switch keeps `orchestration capabilities` usable');
  let capabilitiesPayload = null;
  try {
    capabilitiesPayload = JSON.parse(capabilitiesRun.stdout);
  } catch {
    capabilitiesPayload = null;
  }
  requireCondition(capabilitiesPayload?.ok === true, '`orchestration capabilities --json` answers ok:true while disabled');
  requireCondition(capabilitiesPayload?.enabled === false, 'capabilities report enabled:false under the kill switch');
  requireCondition(capabilitiesPayload?.adapters !== undefined, 'capabilities expose the adapter maturity surface');

  const createRun = runDisabled(['orchestration', 'create', '--input-json', '-', '--json'], { input: '{}' });
  requireCondition(createRun.status !== 0, '`orchestration create` refuses to mutate while disabled');
  let createPayload = null;
  try {
    createPayload = JSON.parse(createRun.stdout);
  } catch {
    createPayload = null;
  }
  requireCondition(createPayload?.error?.code === 'ORCHESTRATION_DISABLED', 'mutation refusal uses ORCHESTRATION_DISABLED');
  requireCondition(!existsSync(disabledStateDir), 'no orchestration state directory is created while disabled');

  // ---- owner-base..HEAD range diff check --------------------------------------
  // One-time remediation gate: it applies only when the owner-base SHA exists
  // locally. Shallow CI checkouts skip it instead of failing npm publish.
  let rangeVerdict = { ok: true, violations: [], skipped: false };
  if (rangeCheckApplies(repoRoot, OWNER_BASE_COMMIT)) {
    const rangeDiff = spawnSync('git', ['diff', '--check', ownerBaseRange], {
      cwd: repoRoot,
      shell: false,
      encoding: 'utf8',
      timeout: 30_000,
    });
    rangeVerdict = evaluateRangeDiffCheck(`${rangeDiff.stdout}${rangeDiff.stderr}`);
  } else {
    rangeVerdict.skipped = true;
  }
  checks.push({
    check: 'owner-base..HEAD range diff-check is clean',
    ok: rangeVerdict.ok,
    ...(rangeVerdict.skipped ? { note: 'skipped: owner base not present in this checkout' } : {}),
  });
  if (!rangeVerdict.ok) violations.push(...rangeVerdict.violations.map((v) => `range diff-check: ${v}`));

  // ---- cleanup ------------------------------------------------------------------

  rmSync(packDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(prefixDir, { recursive: true, force: true });
  rmSync(pkgScopedCache, { recursive: true, force: true });
  rmSync(pkgScopedPrefix, { recursive: true, force: true });
  rmSync(join(emptyNpmrc, '..'), { recursive: true, force: true });
  rmSync(lifecycleStateRoot, { recursive: true, force: true });
  rmSync(join(disabledStateDir, '..'), { recursive: true, force: true });
  if (!consumerDir) rmSync(consumerRoot, { recursive: true, force: true });

  const ok = violations.length === 0;
  return {
    ok,
    version: packageJson.version,
    tarballFiles: shippedPaths.size,
    checks,
    violations,
    hermetic: {
      userConfigScoped: true,
      cacheScoped: true,
      prefixScoped: true,
      homeRepurposed: false,
    },
    rangeDiffCheck: rangeVerdict,
  };
}

// ---- CLI wrapper ----------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPackageClosure()
    .then((receipt) => {
      if (!receipt.ok) {
        console.error(JSON.stringify({ ok: false, violations: receipt.violations }, null, 2));
        process.exit(1);
      }
      console.log(JSON.stringify(receipt, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, violations: [`closure harness crashed: ${String(error?.stack ?? error).slice(0, 900)}`] }, null, 2));
      process.exit(1);
    });
}
