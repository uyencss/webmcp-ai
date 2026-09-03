import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { AiCliError } from './errors.mjs';

export const VALID_ACCESS_PROFILES = new Set([
  'provider-default',
  'compose-only',
  'review-readonly',
  'bounded-edit',
  'gateway-tool',
  'full',
]);

const LEGACY_TOOL_POLICY_MAP = {
  'provider-default': 'provider-default',
  'compose-only': 'compose-only',
};

function digestString(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function digestArray(arr) {
  const sorted = [...(arr || [])].sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function digestObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return digestString('');
  const sortedKeys = Object.keys(obj).sort();
  const normalized = {};
  for (const k of sortedKeys) normalized[k] = obj[k];
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function normalizeAccessProfile(value, legacyToolPolicy) {
  let raw = null;
  if (value != null) raw = String(value).trim();
  else if (legacyToolPolicy != null) raw = String(legacyToolPolicy).trim();
  else raw = 'provider-default';
  if (!raw) throw new AiCliError('INVALID_INPUT', 'accessProfile must be a non-empty string', { exitCode: 2 });
  if (!VALID_ACCESS_PROFILES.has(raw)) {
    throw new AiCliError('INVALID_INPUT', `accessProfile must be one of ${[...VALID_ACCESS_PROFILES].join(', ')}`, { exitCode: 2, details: { accessProfile: raw } });
  }
  if (legacyToolPolicy != null && value != null) {
    const legacyMapped = LEGACY_TOOL_POLICY_MAP[String(legacyToolPolicy).trim()];
    if (legacyMapped && legacyMapped !== raw) {
      throw new AiCliError('INVALID_INPUT', 'accessProfile and toolPolicy conflict', { exitCode: 2, details: { accessProfile: raw, toolPolicy: legacyToolPolicy } });
    }
  }
  return raw;
}

// Broad filesystem roots that would grant overly wide access if used as a boundary.
// Approved boundary is: any absolute canonical path that is NOT one of these
// broad roots, is not a symlink ancestor, and is explicitly declared. This is
// the single explicit approved boundary for workspace and external roots.
const BROAD_ROOTS = new Set([
  '/', '/**', '/Users', '/home', '/tmp', '/var', '/etc', '/opt', '/usr', '/private', '/System', '/Library',
]);

export function canonicalizePath(rawValue, label) {
  if (typeof rawValue !== 'string') {
    throw new AiCliError('INVALID_INPUT', `${label} must be a string`, { exitCode: 2, details: { label, value: rawValue } });
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new AiCliError('INVALID_INPUT', `${label} must be a non-empty absolute path`, { exitCode: 2, details: { label } });
  }
  if (trimmed.includes('\0')) {
    throw new AiCliError('INVALID_INPUT', `${label} must not contain null bytes`, { exitCode: 2, details: { label } });
  }
  if (!isAbsolute(trimmed)) {
    throw new AiCliError('INVALID_INPUT', `${label} must be absolute`, { exitCode: 2, details: { label, value: trimmed } });
  }
  const segs = trimmed.split('/').filter(Boolean);
  if (segs.includes('..')) {
    throw new AiCliError('INVALID_INPUT', `${label} must not contain .. segments`, { exitCode: 2, details: { label, value: trimmed } });
  }
  let normalized = normalize(trimmed);
  if (normalized.includes('..')) {
    throw new AiCliError('INVALID_INPUT', `${label} must not contain .. escapes`, { exitCode: 2, details: { label } });
  }
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  // Reject broad filesystem roots that would widen the declared boundary.
  if (BROAD_ROOTS.has(normalized)) {
    throw new AiCliError('INVALID_INPUT', `${label} must not be a broad filesystem root`, { exitCode: 2, details: { label, value: normalized } });
  }
  // Also reject if normalized is exactly a top-level directory like /foo where foo is single segment and not under tmp/home? Keep broad check above.
  // Additional safety: reject '/' with wildcard variants
  if (normalized === '/**' || normalized === '**' || normalized === '/*') {
    throw new AiCliError('INVALID_INPUT', `${label} must not be a broad wildcard`, { exitCode: 2, details: { label } });
  }
  // Reject symlinked existing ancestors – walk each prefix that exists.
  // On macOS, /var and /tmp are conventional symlinks to /private/* and must not cause blanket rejection.
  // We use lstatSync (not stat) so we do NOT follow symlinks; a symlink ancestor fails closed.
  // TOCTOU limitation: Between validation and provider use, a missing tail component could be
  // replaced with a symlink (or a hard-link alias could be created). Node's path APIs cannot
  // close this without an fd-based broker (openat + O_NOFOLLOW). We document this limitation
  // and prefer fail-closed validation of all existing ancestors.
  const SYSTEM_SYMLINK_ALLOWLIST = new Set(['/var', '/tmp', '/etc']);
  const parts = normalized.split('/').filter(Boolean);
  let cur = '/';
  if (existsSync(cur)) {
    try {
      if (lstatSync(cur).isSymbolicLink() && !SYSTEM_SYMLINK_ALLOWLIST.has(cur)) {
        throw new AiCliError('INVALID_INPUT', `${label} ancestor is a symlink: ${cur}`, { exitCode: 2, details: { label } });
      }
    } catch (e) {
      if (e instanceof AiCliError) throw e;
    }
  }
  let prefix = '';
  for (const part of parts) {
    prefix = prefix + '/' + part;
    if (SYSTEM_SYMLINK_ALLOWLIST.has(prefix)) continue;
    if (existsSync(prefix)) {
      try {
        if (lstatSync(prefix).isSymbolicLink()) {
          throw new AiCliError('INVALID_INPUT', `${label} ancestor is a symlink: ${prefix}`, { exitCode: 2, details: { label, path: prefix } });
        }
      } catch (e) {
        if (e instanceof AiCliError) throw e;
      }
    } else {
      // Missing tail: we have validated all existing ancestors are not symlinks.
      // The remaining suffix does not exist yet, so we cannot prove it is not a symlink.
      // This is the TOCTOU window documented above; we fail closed on existing ancestors
      // and do not claim hard-link or post-validation race protection.
      // Continue without further checks for non-existent tail.
      // To avoid false guarantee, we break after first missing component? We still need to
      // ensure no '..' etc – already done. We just stop symlink checks for missing tail.
      // But we continue loop to handle that the full path normalization already done.
      // We break early to avoid unnecessary existsSync on deeper missing components.
      // However we continue to allow deeper missing components to be created later.
      // We do not follow symlinks in any existing ancestor (proven above).
      // Documented limitation: hard-links and post-validation symlink races are not prevented by this wrapper.
    }
  }
  if (!SYSTEM_SYMLINK_ALLOWLIST.has(normalized) && existsSync(normalized)) {
    try {
      if (lstatSync(normalized).isSymbolicLink()) {
        throw new AiCliError('INVALID_INPUT', `${label} is a symlink: ${normalized}`, { exitCode: 2, details: { label } });
      }
    } catch (e) {
      if (e instanceof AiCliError) throw e;
    }
  }
  return normalized;
}

function ensureArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new AiCliError('INVALID_INPUT', `${label} must be an array`, { exitCode: 2, details: { label } });
  }
  return value;
}

function validateProjectId(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new AiCliError('INVALID_INPUT', 'projectId must be a string', { exitCode: 2 });
  }
  const trimmed = value.trim();
  if (!trimmed) throw new AiCliError('INVALID_INPUT', 'projectId must be non-empty if provided', { exitCode: 2 });
  if (trimmed.includes('\0')) throw new AiCliError('INVALID_INPUT', 'projectId contains null byte', { exitCode: 2 });
  return trimmed;
}

function validateStoreRevisions(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AiCliError('INVALID_INPUT', 'storeRevisions must be an object', { exitCode: 2 });
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k !== 'string' || !k.trim()) throw new AiCliError('INVALID_INPUT', 'storeRevisions keys must be non-empty strings', { exitCode: 2 });
    if (typeof v !== 'string' || !v.trim()) throw new AiCliError('INVALID_INPUT', 'storeRevisions values must be non-empty strings', { exitCode: 2 });
    out[k.trim()] = v.trim();
  }
  return out;
}

function isDescendantOrEqual(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent + '/');
}

function checkNoOverlappingRoots(roots, label) {
  // Reject overlapping/ambiguous roots that would widen access: if one root is ancestor of another
  // (strict), they overlap. For write roots this would indicate ambiguous declaration.
  // We allow workspace to be ancestor of read roots (workspace covering descendant), so caller
  // should not include this check for finalReadRoots; we check only the user-provided sets.
  const sorted = [...roots].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (isDescendantOrEqual(sorted[j], sorted[i])) {
        throw new AiCliError('INVALID_INPUT', `${label} contains overlapping roots: ${sorted[i]} and ${sorted[j]}`, { exitCode: 2, details: { label } });
      }
      if (isDescendantOrEqual(sorted[i], sorted[j])) {
        throw new AiCliError('INVALID_INPUT', `${label} contains overlapping roots: ${sorted[j]} and ${sorted[i]}`, { exitCode: 2, details: { label } });
      }
    }
  }
}

export function validateCapabilityRequest(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AiCliError('INVALID_INPUT', 'input must be an object', { exitCode: 2 });
  }
  const accessProfile = normalizeAccessProfile(input.accessProfile ?? input.toolPolicy, input.toolPolicy != null && input.accessProfile == null ? input.toolPolicy : undefined);
  if (accessProfile === 'gateway-tool') {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', 'gateway-tool requires a validated local Gateway broker capability', {
      exitCode: 2,
      details: { capability: 'accessProfile', accessProfile },
    });
  }
  if (accessProfile === 'full' && input.toolPolicy === 'compose-only') {
    throw new AiCliError('INVALID_INPUT', 'full and compose-only conflict; full uses the given workspace', { exitCode: 2 });
  }

  let workspace = null;
  const rawWorkspace = input.workspace;
  if (accessProfile === 'compose-only') {
    if (rawWorkspace != null) {
      // compose-only must use disposable empty workspace; explicit workspace is incompatible
      const supplied = String(rawWorkspace).trim();
      if (supplied) {
        throw new AiCliError('INVALID_INPUT', 'compose-only must not supply an explicit workspace; it uses a disposable empty workspace', { exitCode: 2, details: { workspace: supplied, accessProfile } });
      }
    }
    workspace = null;
  } else {
    const wsRaw = rawWorkspace != null ? String(rawWorkspace) : process.cwd();
    workspace = canonicalizePath(wsRaw, 'workspace');
    if (!existsSync(workspace)) {
      throw new AiCliError('INVALID_INPUT', 'workspace must exist', { exitCode: 2, details: { workspace } });
    }
    try {
      if (!lstatSync(workspace).isDirectory()) {
        throw new AiCliError('INVALID_INPUT', 'workspace must be a directory', { exitCode: 2, details: { workspace } });
      }
    } catch (e) {
      if (e instanceof AiCliError) throw e;
      throw new AiCliError('INVALID_INPUT', 'workspace must be a directory', { exitCode: 2 });
    }
  }

  const rawRead = ensureArray(input.allowedReadRoots, 'allowedReadRoots');
  const rawWrite = ensureArray(input.allowedWriteRoots, 'allowedWriteRoots');
  const rawProtected = ensureArray(input.protectedPaths, 'protectedPaths');

  const allowedReadRoots = rawRead.map((p, i) => canonicalizePath(String(p), `allowedReadRoots[${i}]`));
  const allowedWriteRoots = rawWrite.map((p, i) => canonicalizePath(String(p), `allowedWriteRoots[${i}]`));
  const protectedPaths = rawProtected.map((p, i) => canonicalizePath(String(p), `protectedPaths[${i}]`));

  const dedupeSorted = (arr) => [...new Set(arr)].sort();
  const readRootsDeduped = dedupeSorted(allowedReadRoots);
  const writeRootsDeduped = dedupeSorted(allowedWriteRoots);
  const protectedDeduped = dedupeSorted(protectedPaths);

  // Full passthrough (opt-in via --full / accessProfile: 'full'): only the
  // workspace existence check above applies. Declared roots are canonicalized
  // but no ancestor/inside/overlap boundary is enforced, so a single flag is
  // enough to run like the native CLI in any environment (incl. sandbox).
  if (accessProfile === 'full') {
    const projectIdFull = validateProjectId(input.projectId);
    const storeRevisionsFull = validateStoreRevisions(input.storeRevisions);
    let finalReadRootsFull = readRootsDeduped;
    if (workspace && !finalReadRootsFull.includes(workspace)) {
      finalReadRootsFull = dedupeSorted([...finalReadRootsFull, workspace]);
    }
    return {
      accessProfile,
      workspace,
      allowedReadRoots: finalReadRootsFull,
      allowedWriteRoots: writeRootsDeduped,
      protectedPaths: protectedDeduped,
      projectId: projectIdFull,
      storeRevisions: storeRevisionsFull,
    };
  }

  // Reject overlapping/ambiguous roots that would widen access (user-provided sets)
  if (readRootsDeduped.length > 1) checkNoOverlappingRoots(readRootsDeduped, 'allowedReadRoots');
  if (writeRootsDeduped.length > 1) checkNoOverlappingRoots(writeRootsDeduped, 'allowedWriteRoots');
  if (protectedDeduped.length > 1) checkNoOverlappingRoots(protectedDeduped, 'protectedPaths');

  let finalReadRoots = readRootsDeduped;
  if (workspace) {
    if (!finalReadRoots.includes(workspace)) {
      finalReadRoots = dedupeSorted([...finalReadRoots, workspace]);
    }
    // Ensure workspace does not get widened by an ancestor read root (broadening)
    for (const rr of readRootsDeduped) {
      if (isDescendantOrEqual(workspace, rr) && rr !== workspace) {
        throw new AiCliError('INVALID_INPUT', `allowedReadRoots must not be ancestor of workspace (would widen boundary): ${rr}`, { exitCode: 2, details: { readRoot: rr, workspace } });
      }
    }
    for (const wr of writeRootsDeduped) {
      if (!isDescendantOrEqual(wr, workspace)) {
        throw new AiCliError('INVALID_INPUT', `allowedWriteRoots must be inside workspace: ${wr}`, { exitCode: 2, details: { writeRoot: wr, workspace } });
      }
    }
    for (const pp of protectedDeduped) {
      // Protected paths must be inside workspace (and typically inside a write root) – if outside workspace fail closed
      if (!isDescendantOrEqual(pp, workspace)) {
        throw new AiCliError('INVALID_INPUT', `protectedPaths must be inside workspace: ${pp}`, { exitCode: 2, details: { protectedPath: pp } });
      }
    }
    // Additional overlapping check: protected path inside write root is allowed, but write root must not be inside protected (would be ambiguous)
    for (const wr of writeRootsDeduped) {
      for (const pp of protectedDeduped) {
        if (isDescendantOrEqual(wr, pp) && wr !== pp) {
          // writeRoot is inside protected – ambiguous, would make write root fully protected
          throw new AiCliError('INVALID_INPUT', `allowedWriteRoots must not be inside protectedPaths: ${wr} inside ${pp}`, { exitCode: 2 });
        }
      }
    }
  } else {
    // compose-only with no workspace: no read/write/protected should be supplied? If supplied, we already rejected workspace,
    // but read/write roots for compose-only should be rejected as they imply capability
    if (readRootsDeduped.length > 0 || writeRootsDeduped.length > 0 || protectedDeduped.length > 0) {
      throw new AiCliError('INVALID_INPUT', 'compose-only must not declare workspace roots; it uses an isolated disposable workspace', { exitCode: 2 });
    }
  }

  if (accessProfile === 'bounded-edit' && writeRootsDeduped.length === 0) {
    throw new AiCliError('INVALID_INPUT', 'bounded-edit requires at least one allowedWriteRoots entry', { exitCode: 2 });
  }

  const projectId = validateProjectId(input.projectId);
  const storeRevisions = validateStoreRevisions(input.storeRevisions);

  if (input.gatewayCapabilityHandle != null || input.gatewayHandle != null || input.mcpConfig != null) {
    if (accessProfile !== 'gateway-tool' && accessProfile !== 'full') {
      throw new AiCliError('INVALID_INPUT', 'gateway capability handle is not allowed for this profile', { exitCode: 2 });
    }
  }

  return {
    accessProfile,
    workspace,
    allowedReadRoots: finalReadRoots,
    allowedWriteRoots: writeRootsDeduped,
    protectedPaths: protectedDeduped,
    projectId,
    storeRevisions,
  };
}

export function isReadAllowed(targetPath, workspace, allowedReadRoots) {
  const canonical = canonicalizePath(String(targetPath), 'target');
  if (workspace && isDescendantOrEqual(canonical, workspace)) return true;
  return (allowedReadRoots || []).some((root) => isDescendantOrEqual(canonical, root));
}

export function isWriteAllowed(targetPath, allowedWriteRoots, protectedPaths) {
  const canonical = canonicalizePath(String(targetPath), 'target');
  const inProtected = (protectedPaths || []).some((p) => isDescendantOrEqual(canonical, p));
  if (inProtected) return false;
  if (!allowedWriteRoots || allowedWriteRoots.length === 0) return false;
  return allowedWriteRoots.some((root) => isDescendantOrEqual(canonical, root));
}

// Child environment allowlist – explicit, minimal, safe.
// We retain only provider runtime essentials and fake-provider fixtures required by tests.
// Private keys, credentials, browser/profile tokens, Runner signing material, machine identity,
// arbitrary WEBMCP_* authority variables, and inherited MCP/config selectors are excluded.
// OpenCode's explicit private config values cannot be overridden by ambient values because
// the caller merges private env with precedence over ambient after filtering.
const SAFE_EXACT = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP', 'TMP_DIR',
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LANGUAGE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'AGY_BIN', 'CLAUDE_BIN', 'CODEX_BIN', 'OPENCODE_BIN', 'OPENCODE_DB',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS',
  'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'OPENCODE_DISABLE_AUTOUPDATE',
  'NODE_ENV',
]);

const SAFE_PREFIXES = ['FAKE_', 'XDG_', 'LC_'];

export function buildSafeChildEnv(inputEnv = {}, invocationEnv = {}) {
  const safe = {};
  const filterOne = (source) => {
    for (const [k, v] of Object.entries(source || {})) {
      if (v === undefined) continue;
      if (SAFE_EXACT.has(k)) {
        safe[k] = v;
        continue;
      }
      if (SAFE_PREFIXES.some((p) => k.startsWith(p))) {
        safe[k] = v;
        continue;
      }
      // All other keys (secrets, WEBMCP_*, credentials, machine identity) are dropped.
    }
  };
  // Filter ambient input first, then private invocation env with same allowlist.
  // Private env wins on collision but cannot introduce disallowed keys.
  filterOne(inputEnv);
  // Invocation env is filtered through same allowlist, but private values take precedence.
  const privateSafe = {};
  for (const [k, v] of Object.entries(invocationEnv || {})) {
    if (v === undefined) continue;
    if (SAFE_EXACT.has(k) || SAFE_PREFIXES.some((p) => k.startsWith(p))) {
      privateSafe[k] = v;
    }
    // Disallow secrets even from invocation – private config must not contain them.
  }
  for (const [k, v] of Object.entries(privateSafe)) {
    safe[k] = v;
  }
  return safe;
}

// Full-mode child environment boundary — explicit and auditable.
// `--full` is native-CLI parity for provider operation: everything passes
// through EXCEPT WebMCP authority/capability material. The denied boundary is:
//   (a) the entire `WEBMCP_` namespace — signing/permit/gateway/runner/vault
//       authority (WEBMCP_SIGNING_KEY, WEBMCP_PRIVATE_KEY,
//       WEBMCP_PERMIT_PRIVATE_KEY, WEBMCP_GATEWAY_TOKEN, WEBMCP_RUNNER_SECRET,
//       WEBMCP_VAULT_KEY[_FILE], WEBMCP_VAULT_NEW_KEY[_FILE]) plus arbitrary
//       worker, hook, callback, orchestration, closure and state selectors
//       (e.g. WEBMCP_AI_WORKER_CAPABILITY_FILE, WEBMCP_AI_CALLBACK_CAPABILITY,
//       WEBMCP_AI_ORCHESTRATION_STATE_DIR, WEBMCP_AI_HOOK_*, WEBMCP_CLOSURE_*,
//       WEBMCP_FAKE_*, and any future WEBMCP_* key); and
//   (b) the named server/Vault authority variables OPENCODE_SERVER_PASSWORD,
//       VAULT_TOKEN, VAULT_ADDR.
// Provider credentials needed for native CLI operation (e.g. ANTHROPIC_API_KEY,
// OPENAI_API_KEY, other provider API keys, keychain-backed config, *_BIN
// overrides, FAKE_ fixtures) remain ambient. We deliberately do NOT deny every
// *TOKEN/*KEY — a broad token/key rule would break provider-neutral native CLI
// authentication. Known authority keys stay listed explicitly in
// FULL_DENY_EXACT for auditability; the WEBMCP_ prefix covers arbitrary and
// future selectors in that namespace. Secrets must still never enter prompt
// text, model context, or receipts.
export const FULL_DENY_EXACT = new Set([
  'WEBMCP_SIGNING_KEY',
  'WEBMCP_PRIVATE_KEY',
  'WEBMCP_PERMIT_PRIVATE_KEY',
  'WEBMCP_GATEWAY_TOKEN',
  'WEBMCP_RUNNER_SECRET',
  'WEBMCP_VAULT_KEY',
  'WEBMCP_VAULT_KEY_FILE',
  'WEBMCP_VAULT_NEW_KEY',
  'WEBMCP_VAULT_NEW_KEY_FILE',
  'OPENCODE_SERVER_PASSWORD',
  'VAULT_TOKEN',
  'VAULT_ADDR',
]);

export const FULL_DENY_PREFIXES = Object.freeze(['WEBMCP_']);

export function isFullChildEnvDenied(key) {
  if (typeof key !== 'string' || !key) return false;
  if (FULL_DENY_EXACT.has(key)) return true;
  return FULL_DENY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function buildFullChildEnv(inputEnv = {}, invocationEnv = {}) {
  const full = {};
  for (const [k, v] of Object.entries(inputEnv || {})) {
    if (v === undefined) continue;
    if (isFullChildEnvDenied(k)) continue;
    full[k] = v;
  }
  for (const [k, v] of Object.entries(invocationEnv || {})) {
    if (v === undefined) continue;
    if (isFullChildEnvDenied(k)) continue;
    full[k] = v;
  }
  return full;
}

export function computeCapabilityDigests({ workspace, allowedReadRoots, allowedWriteRoots, protectedPaths, projectId, storeRevisions, accessProfile }) {
  const workspaceDigest = workspace ? digestString(workspace) : digestString('');
  const readRootsDigest = digestArray(allowedReadRoots);
  const writeRootsDigest = digestArray(allowedWriteRoots);
  const protectedPathsDigest = digestArray(protectedPaths);
  const projectDigest = projectId ? digestString(projectId) : digestString('');
  const storeRevisionsDigest = storeRevisions ? digestObject(storeRevisions) : digestString('');
  const profileDigest = accessProfile ? digestString(accessProfile) : digestString('');
  return {
    accessProfile,
    workspaceDigest: workspaceDigest.slice(0, 16),
    readRootsDigest: readRootsDigest.slice(0, 16),
    writeRootsDigest: writeRootsDigest.slice(0, 16),
    protectedPathsDigest: protectedPathsDigest.slice(0, 16),
    projectDigest: projectDigest.slice(0, 16),
    storeRevisionsDigest: storeRevisionsDigest.slice(0, 16),
    profileDigest: profileDigest.slice(0, 16),
  };
}

// Translate a canonical absolute root inside `workspace` into the
// workspace-relative OpenCode permission patterns for a child launched with
// `--dir <workspace>`. Returns exact + descendant rules (e.g. `src` and
// `src/**`); a root equal to the workspace itself maps to `**` (the whole
// relative tree). Callers guarantee inside-workspace placement upstream.
export function toOpenCodeRelativePatterns(absoluteRoot, workspace) {
  if (!workspace || absoluteRoot === workspace) return ['**'];
  const rel = relative(workspace, absoluteRoot);
  return [rel, `${rel}/**`];
}

export function buildOpenCodeConfig({ accessProfile, workspace, allowedReadRoots, allowedWriteRoots, protectedPaths }) {
  if (accessProfile === 'gateway-tool') {
    throw new AiCliError('UNSUPPORTED_CAPABILITY', 'gateway-tool requires a validated local Gateway broker capability', {
      exitCode: 2,
      details: { capability: 'accessProfile', accessProfile },
    });
  }
  let permission;
  switch (accessProfile) {
    case 'compose-only':
      permission = { '*': 'deny' };
      break;
    case 'provider-default':
    case 'review-readonly':
      permission = {
        '*': 'deny',
        read: 'allow',
        grep: 'allow',
        glob: 'allow',
        lsp: 'allow',
        edit: 'deny',
        write: 'deny',
        bash: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
      };
      break;
    case 'full': {
      // Full passthrough fallback (v1): allow everything. The opencode
      // provider bypasses generated config entirely when full, so this branch
      // only exists so direct buildOpenCodeConfig('full') callers don't crash.
      permission = { '*': 'allow' };
      break;
    }
    case 'bounded-edit': {
      // Bounded edit: edit/write allowed only inside declared write roots, with protected denies overriding.
      // OpenCode is launched with `--dir <workspace>` and its permission matcher
      // receives workspace-RELATIVE tool paths (e.g. `src/capabilities.mjs`, as seen
      // in the `permission=edit pattern=src/...` deny log). Absolute keys never
      // match, so every declared root inside the workspace is translated to its
      // relative form before becoming a rule. Roots outside the workspace are
      // rejected upstream, so `relative()` here cannot escape (no `..` output).
      const editObj = { '*': 'deny' };
      const writeObj = { '*': 'deny' };
      for (const wr of (allowedWriteRoots || [])) {
        for (const pattern of toOpenCodeRelativePatterns(wr, workspace)) {
          editObj[pattern] = 'allow';
          writeObj[pattern] = 'allow';
        }
      }
      // Protected paths override even inside write roots
      for (const pp of (protectedPaths || [])) {
        for (const pattern of toOpenCodeRelativePatterns(pp, workspace)) {
          editObj[pattern] = 'deny';
          writeObj[pattern] = 'deny';
        }
      }
      permission = {
        '*': 'deny',
        read: 'allow',
        grep: 'allow',
        glob: 'allow',
        lsp: 'allow',
        edit: editObj,
        write: writeObj,
        bash: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
      };
      break;
    }
    default:
      throw new AiCliError('INVALID_INPUT', `Unknown accessProfile: ${accessProfile}`, { exitCode: 2 });
  }

  // external_directory: exact declared roots plus descendant rules, never global /**
  const roots = [];
  if (workspace) roots.push(workspace);
  if (allowedReadRoots) roots.push(...allowedReadRoots);
  if (accessProfile === 'bounded-edit' && allowedWriteRoots) roots.push(...allowedWriteRoots);
  const uniqueRoots = [...new Set(roots)].sort();
  const external_directory = [];
  for (const r of uniqueRoots) {
    external_directory.push(r);
    const descendant = r === '/' ? null : `${r}/**`;
    if (descendant) external_directory.push(descendant);
  }
  const dedupedExternal = [...new Set(external_directory)].sort().filter((v) => v !== '/**' && v !== '**' && v !== '/*' && v !== '/');

  if (dedupedExternal.includes('/**') || dedupedExternal.includes('**')) {
    throw new AiCliError('INTERNAL_ERROR', 'external_directory contains global wildcard', { exitCode: 1 });
  }

  // Explicit isolated config surface: no inherited MCP, empty plugin/instruction.
  // This prevents the operator's ~/.config/opencode mcp (cua-driver, webmcp) from leaking.
  const config = {
    permission,
    external_directory: dedupedExternal,
    share: 'disabled',
    autoupdate: false,
    // Explicitly disable MDNS/cors and empty plugin surface unless a validated broker exists
    mdns: false,
    cors: [],
    plugin: [],
    mcp: {},
    // instruction surface empty – no inherited instructions
    instructions: [],
  };
  return config;
}
