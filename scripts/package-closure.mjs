#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
export const OWNER_BASE_COMMIT = "29eed4d18f7797dfd24bf9e6aa2ce1f314d57f0e";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isolatedTemp(name) {
  return mkdtempSync(join(tmpdir(), `webmcp-ai-core-closure-${name}-`));
}

export function auditShippedPaths(shippedPaths, bundledPackages = []) {
  const shipped = shippedPaths instanceof Set ? shippedPaths : new Set(shippedPaths);
  const bundled = new Set(bundledPackages);
  const violations = [];
  const requiredPaths = [
    "bin/webmcp-ai.mjs",
    "bin/webmcp-jev.mjs",
    "src/cli.mjs",
    "src/client.mjs",
    "src/capabilities.mjs",
    "src/errors.mjs",
    "src/events.mjs",
    "src/jev/cli.mjs",
    "src/jev/doctor.mjs",
    "src/jev/answers.mjs",
    "src/jev/circuit.mjs",
    "src/jev/client.mjs",
    "src/jev/fallback.mjs",
    "src/jev/redact.mjs",
    "src/jev/schemas.mjs",
    "src/jev/transport.mjs",
    "src/process-runner.mjs",
    "src/protocol.mjs",
    "src/providers/agy.mjs",
    "src/providers/claude.mjs",
    "src/providers/codex.mjs",
    "src/providers/index.mjs",
    "src/providers/opencode.mjs",
    "src/review-result.mjs",
    "src/review.mjs",
    "src/task-intent.mjs",
    "scripts/install-agent.mjs",
    "skills/webmcp-ai-cli/SKILL.md",
    "skills/webmcp-ai-cli/agents/openai.yaml",
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
  ];
  for (const required of requiredPaths) {
    if (!shipped.has(required)) violations.push(`tarball is missing required path: ${required}`);
  }
  const forbiddenPrefixes = ["tests/", ".github/", ".git", "src/orchestration/"];
  const packageNameForBundledPath = (shippedPath) => {
    if (!shippedPath.startsWith("node_modules/")) return null;
    const segments = shippedPath.split("/");
    if (segments[1]?.startsWith("@")) return segments.slice(1, 3).join("/");
    return segments[1] ?? null;
  };
  for (const shippedPath of shipped) {
    const isUndeclaredNodeModule = shippedPath.startsWith("node_modules/")
      && !bundled.has(packageNameForBundledPath(shippedPath));
    if (isUndeclaredNodeModule || forbiddenPrefixes.some((prefix) => shippedPath === prefix || shippedPath.startsWith(prefix))) {
      violations.push(`tarball must not ship private/unbundled path: ${shippedPath}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

export function evaluateRangeDiffCheck(output) {
  const violations = String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: violations.length === 0, violations };
}

export function rangeCheckApplies(repoRoot, baseSha = OWNER_BASE_COMMIT) {
  const probe = spawnSync("git", ["cat-file", "-e", `${baseSha}^{commit}`], {
    cwd: repoRoot,
    shell: false,
    encoding: "utf8",
  });
  return probe.status === 0;
}

function scopedNpmEnv({ emptyNpmrc, cacheDir, prefixDir }) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    NPM_CONFIG_USERCONFIG: emptyNpmrc,
    NPM_CONFIG_CACHE: cacheDir,
    NPM_CONFIG_PREFIX: prefixDir,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_REGISTRY: process.env.WEBMCP_CLOSURE_REGISTRY ?? "https://registry.npmjs.org/",
  };
}

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

  const packDir = isolatedTemp("pack");
  const emptyNpmrc = join(isolatedTemp("npmrc"), "empty.npmrc");
  writeFileSync(emptyNpmrc, "");
  const cacheDir = isolatedTemp("cache");
  const prefixDir = isolatedTemp("prefix");

  const packResult = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: repoRoot,
    shell: false,
    encoding: "utf8",
    env: scopedNpmEnv({ emptyNpmrc, cacheDir, prefixDir }),
  });

  requireCondition(packResult.status === 0, "npm pack --json exits successfully under an isolated environment");
  if (packResult.status !== 0) {
    violations.push(`npm pack stderr: ${String(packResult.stderr).slice(0, 800)}`);
  }

  let packed = null;
  try {
    packed = JSON.parse(packResult.stdout);
  } catch {
    packed = null;
  }
  requireCondition(Array.isArray(packed) && packed.length === 1, "npm pack reports exactly one package");
  const tarball = packed?.[0];
  const tarballPath = tarball ? join(packDir, tarball.filename) : null;
  requireCondition(tarballPath !== null && existsSync(tarballPath), "packed tarball exists on disk in the isolated destination");

  const shippedPaths = new Set((tarball?.files ?? []).map((entry) => entry.path));
  const manifestAudit = auditShippedPaths(shippedPaths, tarball?.bundled ?? []);
  for (const violation of manifestAudit.violations) violations.push(violation);
  checks.push({ check: "tarball manifest covers every required contract surface", ok: manifestAudit.ok });
  checks.push({ check: "tarball excludes tests/, src/orchestration/, and unbundled packages", ok: !manifestAudit.violations.some((v) => v.includes("must not ship private")) });

  const packageJson = readJson(join(repoRoot, "package.json"));
  const lockJson = readJson(join(repoRoot, "package-lock.json"));
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");

  requireCondition(packageJson.version === lockJson.version, "package.json and package-lock.json share one version");
  requireCondition(packageJson.version === lockJson.packages[""].version, "lockfile root package records the same version");
  requireCondition(/^\d+\.\d+\.\d+/.test(packageJson.version), "version is a valid semver string");
  requireCondition(changelog.includes(`## ${packageJson.version}`) || changelog.includes("## Unreleased"), "CHANGELOG.md records the release line");
  requireCondition(typeof packageJson.scripts["test:package-closure"] === "string", "npm run test:package-closure is wired to this verifier");
  requireCondition(
    String(packageJson.scripts.prepublishOnly ?? "").includes("test:package-closure")
    || String(packageJson.scripts.prepublishOnly ?? "").includes("package-closure"),
    "prepublishOnly runs the package closure gate",
  );

  const consumerRoot = consumerDir ?? isolatedTemp("consumer");
  const pkgScopedCache = isolatedTemp("install-cache");
  const pkgScopedPrefix = isolatedTemp("install-prefix");
  writeFileSync(join(consumerRoot, "package.json"), `${JSON.stringify({ name: "closure-consumer", private: true, version: "0.0.0" }, null, 1)}\n`);

  const installStatus = (() => {
    if (!tarballPath) return -1;
    const run = spawnSync("npm", ["install", tarballPath, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: consumerRoot,
      shell: false,
      encoding: "utf8",
      timeout: 240_000,
      env: scopedNpmEnv({ emptyNpmrc, cacheDir: pkgScopedCache, prefixDir: pkgScopedPrefix }),
    });
    if (run.status !== 0) {
      violations.push(`clean install failed: ${String(run.stderr).slice(-800)}`);
    }
    return run.status;
  })();
  requireCondition(installStatus === 0, "clean install of the packed tarball succeeds in an isolated consumer project");

  const installedPkgDir = join(consumerRoot, "node_modules", packageJson.name);

  // Public entrypoints import through bare specifiers
  const importProbe = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    [
      "const core = await import('@gyga-browser/webmcp-ai');",
      "const errors = await import('@gyga-browser/webmcp-ai/errors');",
      "const providers = await import('@gyga-browser/webmcp-ai/providers');",
      "const protocol = await import('@gyga-browser/webmcp-ai/protocol');",
      "const jev = await import('@gyga-browser/webmcp-ai/jev');",
      "let orchMissing = false;",
      "try { await import('@gyga-browser/webmcp-ai/orchestration'); } catch (e) { orchMissing = e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }",
      "const ok = typeof core.generate === 'function' && typeof errors.AiCliError === 'function' && typeof providers.getProvider === 'function' && typeof protocol.describeTools === 'function' && typeof jev.runJevCli === 'function' && orchMissing;",
      "console.log(JSON.stringify({ ok, imported: ['.', './errors', './providers', './protocol', './jev'], orchRemoved: orchMissing }));",
    ].join("\n"),
  ], {
    cwd: consumerRoot,
    shell: false,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let importPayload = null;
  try {
    importPayload = JSON.parse(importProbe.stdout);
  } catch {
    importPayload = null;
  }
  requireCondition(importProbe.status === 0 && importPayload?.ok === true, "installed public entrypoints import through bare specifiers and ./orchestration is absent");

  // CLI answers doctor, providers list, and typed orchestration shim
  const doctorRun = spawnSync(process.execPath, [join(installedPkgDir, "bin/webmcp-ai.mjs"), "doctor", "--json"], {
    cwd: consumerRoot,
    shell: false,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let doctorPayload = null;
  try { doctorPayload = JSON.parse(doctorRun.stdout); } catch {}
  requireCondition(doctorRun.status === 0 && doctorPayload?.ok === true, "installed CLI answers doctor");

  // Installed Jev surface answers doctor with the provider group unprobed
  const jevDoctorRun = spawnSync(process.execPath, [join(installedPkgDir, "bin/webmcp-jev.mjs"), "doctor", "--json"], {
    cwd: consumerRoot,
    shell: false,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let jevDoctorPayload = null;
  try { jevDoctorPayload = JSON.parse(jevDoctorRun.stdout); } catch {}
  requireCondition(
    jevDoctorRun.status === 0 && jevDoctorPayload?.ok === true && jevDoctorPayload?.provider?.authenticated === "not-probed",
    "installed webmcp-jev answers doctor --json with provider unprobed",
  );

  const shimRun = spawnSync(process.execPath, [join(installedPkgDir, "bin/webmcp-ai.mjs"), "orchestration", "capabilities", "--json"], {
    cwd: consumerRoot,
    shell: false,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let shimPayload = null;
  try { shimPayload = JSON.parse(shimRun.stdout); } catch {}
  requireCondition(
    shimRun.status === 2 && shimPayload?.ok === false && shimPayload?.error?.code === "ORCHESTRATION_PACKAGE_REQUIRED",
    "installed CLI returns typed ORCHESTRATION_PACKAGE_REQUIRED when orchestration package is absent",
  );

  let rangeVerdict = { ok: true, violations: [], skipped: false };
  if (rangeCheckApplies(repoRoot, OWNER_BASE_COMMIT)) {
    const rangeDiff = spawnSync("git", ["diff", "--check", ownerBaseRange], {
      cwd: repoRoot,
      shell: false,
      encoding: "utf8",
      timeout: 30_000,
    });
    rangeVerdict = evaluateRangeDiffCheck(`${rangeDiff.stdout}${rangeDiff.stderr}`);
  } else {
    rangeVerdict.skipped = true;
  }
  checks.push({
    check: rangeVerdict.skipped ? "owner-base range check skipped (no local owner-base commit)" : "owner-base..HEAD range diff-check is clean",
    ok: rangeVerdict.ok,
  });
  for (const violation of rangeVerdict.violations) violations.push(`range diff-check: ${violation}`);

  const report = {
    ok: violations.length === 0,
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

  if (!report.ok) {
    console.error("package closure: violations found:");
    for (const violation of report.violations) console.error(`  - ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPackageClosure().catch((err) => {
    console.error("package closure: unhandled error:", err);
    process.exit(1);
  });
}
