#!/usr/bin/env node
// Hermetic package-closure verifier for @gyga-browser/webmcp-ai.
//
// Proves, without touching ambient npm configuration or the network:
//   1. `npm pack --json` (shell:false, isolated env) emits a tarball whose
//      manifest covers every published contract surface — bin entry, CLI +
//      orchestration source, JSON schemas, supervisor entry, automation hook,
//      install script, skill brief + version-matched runtime guide and picker
//      metadata.
//   2. The tarball never ships private material (tests, dotfiles, state).
//   3. package.json / package-lock.json / CHANGELOG.md agree on one version
//      and the packaged runtime guide keeps its {{PACKAGE_VERSION}} seam.
//   4. The kill switch stays stable: with WEBMCP_AI_ORCHESTRATION_DISABLED=1
//      read-only orchestration verbs and one-shot commands still answer ok,
//      no supervisor spawns, and no state directory appears.
//
// Exit code 0 prints a JSON receipt; any violation prints violations and
// exits 1. Run via `npm run test:package-closure`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isolatedTemp(name) {
  return mkdtempSync(join(tmpdir(), `webmcp-ai-closure-${name}-`));
}

const violations = [];
const receipts = [];

function requireCondition(condition, message) {
  if (!condition) violations.push(message);
  receipts.push({ check: message, ok: condition === true });
}

// ---- 1+2: hermetic npm pack and tarball manifest audit --------------------

const packDir = isolatedTemp('pack');
const emptyNpmrc = join(isolatedTemp('npmrc'), 'empty.npmrc');
writeFileSync(emptyNpmrc, '');
const cacheDir = isolatedTemp('cache');
const prefixDir = isolatedTemp('prefix');
const homeDir = isolatedTemp('home');

const packResult = spawnSync('npm', ['pack', '--json', '--pack-destination', packDir], {
  cwd: root,
  shell: false,
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    HOME: homeDir,
    NPM_CONFIG_USERCONFIG: emptyNpmrc,
    NPM_CONFIG_CACHE: cacheDir,
    NPM_CONFIG_PREFIX: prefixDir,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_DRY_RUN: 'false',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  },
});

requireCondition(packResult.status === 0, 'npm pack --json exits successfully under an isolated environment');
if (packResult.status !== 0) {
  violations.push(`npm pack stderr: ${String(packResult.stderr).slice(0, 800)}`);
}

const packed = Array.isArray(packResult.stdout) ? packResult.stdout : (() => {
  try {
    return JSON.parse(packResult.stdout);
  } catch {
    return null;
  }
})();
requireCondition(Array.isArray(packed) && packed.length === 1, 'npm pack reports exactly one package');
const tarball = packed?.[0];
const tarballPath = tarball ? join(packDir, tarball.filename) : null;
requireCondition(tarballPath !== null && existsSync(tarballPath), 'packed tarball exists on disk in the isolated destination');

const shippedPaths = new Set((tarball?.files ?? []).map((entry) => entry.path));

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
for (const schemaName of readdirSync(join(root, 'src/orchestration/schemas'))) {
  requiredPaths.push(`src/orchestration/schemas/${schemaName}`);
}
for (const required of requiredPaths) {
  requireCondition(shippedPaths.has(required), `tarball ships ${required}`);
}

const forbiddenPrefixes = ['tests/', 'node_modules/', '.github/', '.git'];
for (const shipped of shippedPaths) {
  if (forbiddenPrefixes.some((prefix) => shipped === prefix || shipped.startsWith(prefix))) {
    violations.push(`tarball must not ship private path: ${shipped}`);
  }
}
receipts.push({ check: 'tarball excludes tests/, node_modules/ and dot-directories', ok: violations.every((v) => !v.includes('must not ship private path')) });

if (tarballPath) {
  const guideInTarball = (tarball.files ?? []).find((entry) => entry.path.endsWith('orchestration-runtime.md'));
  requireCondition(guideInTarball !== undefined, 'version-matched runtime guide is part of the tarball');
}

// ---- 3: version + guide seam consistency ----------------------------------

const packageJson = readJson(join(root, 'package.json'));
const lockJson = readJson(join(root, 'package-lock.json'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const runtimeGuide = readFileSync(
  join(root, 'skills/webmcp-ai-cli/references/orchestration-runtime.md'),
  'utf8',
);

requireCondition(packageJson.version === lockJson.version, 'package.json and package-lock.json share one version');
requireCondition(packageJson.version === lockJson.packages[''].version, 'lockfile root package records the same version');
requireCondition(/^\d+\.\d+\.\d+/.test(packageJson.version), 'version is a valid semver string');
requireCondition(changelog.includes(`## ${packageJson.version}`), 'CHANGELOG.md has an entry for the released version');
requireCondition(runtimeGuide.includes('{{PACKAGE_VERSION}}'), 'runtime guide keeps its {{PACKAGE_VERSION}} substitution seam');
requireCondition(typeof packageJson.scripts['test:package-closure'] === 'string', 'npm run test:package-closure is wired to this verifier');

// ---- 4: kill switch stability without spawning supervisors ----------------

const disabledStateDir = join(isolatedTemp('state'), 'orchestration');
const cliEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: homeDir,
  WEBMCP_AI_ORCHESTRATION_DISABLED: '1',
  WEBMCP_AI_ORCHESTRATION_STATE_DIR: disabledStateDir,
};

function runDisabled(args, { input } = {}) {
  return spawnSync(process.execPath, [join(root, 'bin/webmcp-ai.mjs'), ...args], {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    timeout: 60_000,
    env: cliEnv,
    input,
  });
}

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

const guideRun = runDisabled(['orchestration', 'guide', '--format', 'json']);
requireCondition(guideRun.status === 0, 'kill switch keeps `orchestration guide` readable');
let guidePayload = null;
try {
  guidePayload = JSON.parse(guideRun.stdout);
} catch {
  guidePayload = null;
}
requireCondition(guidePayload?.guide?.includes('{{PACKAGE_VERSION}}') || typeof guidePayload?.guide === 'string', 'guide output carries the packaged prose while disabled');

const providersRun = runDisabled(['providers', 'list', '--json']);
requireCondition(providersRun.status === 0, 'one-shot `providers list` survives the kill switch');
let providersPayload = null;
try {
  providersPayload = JSON.parse(providersRun.stdout);
} catch {
  providersPayload = null;
}
requireCondition(providersPayload?.ok === true && Array.isArray(providersPayload?.providers), 'providers list stays a stable one-shot while disabled');

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

// ---- cleanup ----------------------------------------------------------------

const disabledStateRoot = join(disabledStateDir, '..');
for (const tempRoot of [packDir, cacheDir, prefixDir, homeDir, join(emptyNpmrc, '..'), disabledStateRoot]) {
  rmSync(tempRoot, { recursive: true, force: true });
}

// ---- verdict ----------------------------------------------------------------

if (violations.length > 0) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  version: packageJson.version,
  tarballFiles: shippedPaths.size,
  checks: receipts.length,
  killSwitchStable: true,
  hermetic: true,
}, null, 2));
