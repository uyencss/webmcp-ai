---
title: WebMCP AI CLI - E7-G2 Current-Head Closure Receipt
type: receipt
status: blocked
created: 2026-09-05
updated: 2026-09-05
---

# WebMCP AI CLI - E7-G2 Current-Head Closure Receipt

## Scope and decision

This is a bounded current-head evidence receipt for the WebMCP AI CLI managed-host
E7-G2 lane. It is intentionally not a full-plan receipt.

The scoped E7-G2 gate has a PASSING BOUNDED RESULT: the managed-host suite,
Darwin primitive probe, generated Seatbelt launch, packaged supervisor FD3 broker
round trip, geometry/TOCTOU/hardlink negatives, broker allow-list negatives, and
secret/environment boundary negatives all passed at the exact owner current HEAD
listed below. This is isolated component evidence; it is not an independent final
acceptance and does not promote the owner repository.

The receipt remains status: blocked because the broader package npm test is red
for two non-managed-host checks. Those failures are recorded exactly below; they
are not hidden or reclassified as E7-G2 failures.

## Baseline and write boundary

- Owner package repository: /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-ai-cli
- Owner pre-write HEAD: 2c7ac00b724ccee8015db26611085f5fb0a05036
- Owner pre-write tree: 398c3fd90895ba2c92f899582c1db3a702c66948
- Owner pre-write git status --short --branch: ## main...origin/main [ahead 20] with no file entries; clean working tree.
- Candidate worktree: /Users/ttcenter/.codex/worktrees/69e5/candidates/e7-g2-current-head-closure-luna-max-20260905
- Candidate branch: codex/e7-g2-current-head-closure-luna-max-20260905
- Candidate creation: git -C /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-ai-cli worktree add -b codex/e7-g2-current-head-closure-luna-max-20260905 /Users/ttcenter/.codex/worktrees/69e5/candidates/e7-g2-current-head-closure-luna-max-20260905 HEAD
- Candidate was created from the exact owner HEAD above. All tests, probes, writing, staging, and commit for this receipt ran in this candidate. The owner, source files, tests, package metadata, and outer control-plane docs were not modified.
- Exact candidate write-set: this new file only: docs/2026-09-e7-g2-current-head-closure.md.

## Evidence run before writing

All commands below were run in the candidate before this file was created.

### Managed-host gate

Command:

~~~text
node --test tests/managed-host/*.test.mjs
~~~

Result: exit 0; tests 71, pass 71, fail 0, cancelled 0, skipped 0, todo 0;
duration 2904.978917 ms.

The passing output includes the following E7-G2 proof points:

- G2 host isolation config is explicit and never silently falls back to G1
- installed packaged supervisor-entry performs a real FD3 webmcp.echo round trip
- Seatbelt launch spec strips authority and rejects unavailable primitives without ambient spawn
- actual managed supervisor launch binds Seatbelt owned-process to hidden mediated broker FD 3
- actual managed lifecycle rejects pre-existing hardlink before child spawn
- supervisor final geometry re-proof rejects a TOCTOU workspace swap before lifecycle launch
- G2 launch boundary denies a hardlink inserted after the final workspace scan
- G2 launch boundary rejects a hardlink swapped into an allow-listed filename
- broker socket is hidden after FD handoff and rejects unlisted tools without exposing authority
- owned-process launch does not let runtime instrumentation mutate a frozen environment
- two-pass: secret-bearing context never crosses boundary

### Full package suite

Command:

~~~text
npm test
~~~

Result: exit 1; tests 655, pass 653, fail 2, cancelled 0, skipped 0, todo 0;
duration 46031.290833 ms.

The two failures were:

1. R8: packed AI CLI carries its runtime SDK for offline consumers
   (tests/orchestration-package-closure.test.mjs:141, assertion at line 161).
   The observed npm pack --json manifest reported bundled: [], entryCount: 79,
   and no node_modules/@opencode-ai/sdk/package.json; therefore the test's
   bundled-SDK assertion failed.
2. opencode-server adapter surfaces typed negatives and honest probe reports
   (tests/orchestration-recovery-security.test.mjs:1184, assertion at line 1246).
   The candidate has no installed node_modules; a direct import probe returned
   ERR_MODULE_NOT_FOUND for @opencode-ai/sdk. The adapter consequently reported
   sdkAvailable: false and available: false, so the test's available === true
   assertion failed.

These are a typed package-dependency/full-suite blocker. No source or test repair
was authorized in this bounded receipt lane.

### Package closure

Command:

~~~text
npm run test:package-closure
~~~

Result: exit 0; JSON ok: true, version 0.3.0-alpha.0, tarballFiles: 79,
violations: [], hermetic.userConfigScoped: true, hermetic.cacheScoped: true,
hermetic.prefixScoped: true, hermetic.homeRepurposed: false, and
rangeDiffCheck.ok: true with no violations. All 25/25 reported closure checks
were ok: true, including isolated pack/install, installed entrypoints, fixture
public lifecycle, asset presence, kill-switch behavior, and range diff-check.
The passing package-closure script does not erase the two failures in the broader
npm test result.

### Syntax and whitespace checks

Command:

~~~text
for file in src/orchestration/managed-host/*.mjs src/orchestration/public-adapters.mjs src/orchestration/adapters/owned-process.mjs src/orchestration/supervisor-entry.mjs; do node --check "$file"; done
~~~

Result: exit 0; 9 managed-host-related JavaScript modules checked.

Command:

~~~text
git diff --check
~~~

Result: exit 0.

No docs/lint command was run: this package has no docs or documentation-lint
script in package.json; the package-local docs/ receipt path is also outside
the outer repository documentation-convention scope.

## Darwin Seatbelt and broker proof

The source contract at src/orchestration/managed-host/host-isolation.mjs binds:

- host-isolation schema: webmcp-managed-host-isolation/1
- mode: darwin-seatbelt-broker
- primitive identifier: darwin-seatbelt-sandbox-exec
- executable primitive: /usr/bin/sandbox-exec
- launch boundary: seatbelt-file-literal-snapshot-v1
- broker protocol: webmcp-managed-broker/1
- broker implementation: coordinator-owned-webmcp-v1
- inherited broker FD: 3
- coordinator-owned mediated tool allow-list: exactly webmcp.echo
- unlisted-tool denial: UNLISTED_MCP_TOOL_DENIED

Darwin probe command:

~~~text
node --input-type=module -e "import { probeHostIsolation, assertHostIsolationPrimitive, DARWIN_SANDBOX_EXEC_PATH } from './src/orchestration/managed-host/host-isolation.mjs'; const probe = probeHostIsolation({ platform: 'darwin', sandboxExecPath: DARWIN_SANDBOX_EXEC_PATH }); const asserted = assertHostIsolationPrimitive({ platform: 'darwin', sandboxExecPath: DARWIN_SANDBOX_EXEC_PATH }); console.log(JSON.stringify({ probe, asserted }));"
~~~

Result: exit 0; both probe and asserted returned available:true,
platform:"darwin", executable:"/usr/bin/sandbox-exec", and
primitive:"darwin-seatbelt-sandbox-exec".

Generated real Seatbelt launch command/proof probe:

~~~text
node --input-type=module -e "import { spawnSync } from 'node:child_process'; import { buildSeatbeltLaunchSpec } from './src/orchestration/managed-host/host-isolation.mjs'; const workspace = process.cwd(); const spec = buildSeatbeltLaunchSpec({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: workspace, workspace, allowedReadRoots: [workspace], allowedWriteRoots: [workspace], protectedPaths: [], baseEnv: { LANG: 'C' } }); const run = spawnSync(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); console.log(JSON.stringify({ status: run.status, signal: run.signal, error: run.error?.code ?? null, primitive: spec.proof.primitive, command: spec.command, mode: spec.proof.mode, brokerFd: spec.proof.brokerFd, launchBoundary: spec.proof.launchBoundary, stderr: run.stderr ?? '' })); if (run.error || run.status !== 0) process.exit(1);"
~~~

Result: exit 0; status:0, signal:null, error:null, command
/usr/bin/sandbox-exec, primitive darwin-seatbelt-sandbox-exec, mode
darwin-seatbelt-broker, broker FD 3, launch boundary
seatbelt-file-literal-snapshot-v1, and empty stderr.

Packaged-path command:

~~~text
node --test --test-name-pattern='installed packaged supervisor-entry|Seatbelt launch spec strips authority' tests/managed-host/managed-lifecycle-g2.test.mjs
~~~

Result: exit 0; tests 2, pass 2, fail 0, skipped 0. The packaged
supervisor's worker used inherited FD3 and returned the exact mediated response:

~~~json
{
  "protocol": "webmcp-managed-broker/1",
  "requestId": "req_packaged_fd3_echo",
  "ok": true,
  "result": { "echoed": "packaged-fd3-echo" }
}
~~~

The full managed-host output also records passing hardlink, final-geometry
TOCTOU, post-scan hardlink, allow-listed-name hardlink swap, unlisted broker
tool, frozen environment, and secret-bearing-context negatives. These are the
evidence boundary for E7-G2; they do not claim a generic filesystem sandbox,
provider supervision, or production safety beyond the tested contract.

## Explicit non-claims and open gates

- E7-G2: bounded current-head managed-host evidence is passing as described;
  independent final acceptance is not claimed by this worker receipt.
- E8-full: OPEN / NOT ACCEPTED.
- E9-full: OPEN / NOT ACCEPTED.
- Broad P4: OPEN / NOT ACCEPTED.
- Z6: OPEN; no E8-full completion is inferred.
- Z7: OPEN; no Z6 completion is inferred.
- Provider runtime/live provider readiness: NOT PROVEN. No real provider was
  invoked for this receipt; tests used local fixtures and contract probes.
- Production: NO-GO.
- Owner promotion: NOT DONE. This commit is isolated to the candidate receipt.

## Commit boundary

The only staged and committed path is:

~~~text
docs/2026-09-e7-g2-current-head-closure.md
~~~

The exact scoped commit sequence is:

~~~text
git add -- docs/2026-09-e7-g2-current-head-closure.md
git commit --only -m "docs(ai-cli): record E7-G2 current-head closure" -- docs/2026-09-e7-g2-current-head-closure.md
~~~

Final candidate commit/tree/status and this file's SHA-256 are reported outside
this receipt after the commit. The receipt does not self-embed its own hash.
