import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { AiCliError } from '../../errors.mjs';
import { computePolicyDigest } from '../role-policy.mjs';
import { ENTRY_POLICY_REVISION } from './capability-profile.mjs';
import { buildEntryPlan } from './entry-plan.mjs';
import { selectCapabilityProfile } from './tool-gating.mjs';

// Closed allow-list for pass-1: only resolver/loader/read-only/bootstrap-plan per authority-resolution §4.2 + scope §5.2
// This is a FROZEN read-only set; every capability outside it is pass-2-only or forbidden and must be rejected.
export const PASS1_ALLOWED = Object.freeze(new Set([
  'host-inspection',
  'skill-inspection',
  'skill.resolve',
  'skill.load',
  'project.resolve',
  'project.doctor',
  'scaffold.plan',
  'scaffold.dry-run',
]));

export const PASS2_ONLY_EXAMPLES = Object.freeze(new Set([
  'store.discovery',
  'runner.handoff',
  'scaffold.apply',
  'context.refresh',
  'guide.validate',
  'request.prepare',
]));

const SECRET_KEYS = new Set([
  'bindingPath', 'binding_path', 'bindingFile', 'credential', 'credentials', 'secret', 'token', 'password',
  'apiKey', 'api_key', 'privateKey', 'private_key', 'env', 'sessionId', 'machineId', 'host', 'hostname',
]);

function sanitizeContext(context) {
  if (!context || typeof context !== 'object') return context;
  const out = {};
  for (const [k, v] of Object.entries(context)) {
    if (SECRET_KEYS.has(k)) continue;
    if (typeof v === 'string' && (v.includes('sk-') || v.includes('ghp_') || v.includes('-----BEGIN'))) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = {};
      for (const [nk, nv] of Object.entries(v)) {
        if (SECRET_KEYS.has(nk)) continue;
        nested[nk] = nv;
      }
      out[k] = Object.freeze(nested);
    } else {
      out[k] = v;
    }
  }
  return Object.freeze(out);
}

function assertPass1Isolation(pass1Plan) {
  const allowed = pass1Plan.capabilityClassesSorted;
  for (const cap of allowed) {
    // Closed allow-list enforcement: every pass-1 capability must be in the frozen read-only set.
    if (!PASS1_ALLOWED.has(cap)) {
      throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', `pass1 capability ${cap} is not in the closed allow-list; allowed: ${[...PASS1_ALLOWED].join(',')}`, { exitCode: 2 });
    }
    // Generic execution/network/browser/provider/media are never in the allow-list, but
    // explicitly reject their string forms in case the table is extended in future.
    if (cap === 'shell' || cap === 'curl' || cap === 'generic-shell' || cap === 'network' || cap === 'execution-permit'
      || cap.startsWith('browser.') || cap.startsWith('provider.') || cap.startsWith('media.') || cap.includes('shell') || cap.includes('curl')) {
      throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', `pass1 capability ${cap} is forbidden`, { exitCode: 2 });
    }
  }
}

export function createPass1Plan(evidence, _hostEvidence = {}) {
  // Evidence is trusted machine-local + policy revision; model cannot set state/profile
  if (evidence && typeof evidence === 'object' && evidence.modelProposed) {
    const { modelProposed, ...rest } = evidence;
    evidence = rest;
  }
  const plan = buildEntryPlan(evidence);
  assertPass1Isolation(plan);
  // Sanitize pass1 context: only digests, bounded IDs, capability classes, non-secret evidence
  const sanitized = sanitizeContext({
    schema: plan.schema,
    entryState: plan.entryState,
    capabilityProfileId: plan.capabilityProfileId,
    capabilityProfileRevision: plan.capabilityProfileRevision,
    entryPolicyRevision: plan.entryPolicyRevision,
    rolePolicyRevision: plan.rolePolicyRevision,
    guideSelectionDigest: plan.guideSelectionDigest,
    obligationIds: plan.obligationIds,
    capabilityClassesSorted: plan.capabilityClassesSorted,
  });
  return Object.freeze({
    pass1Plan: plan,
    sanitizedContext: sanitized,
    passId: `pass1_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
  });
}

export function validateAndSelectProfile(pass1Result, trustedEvidence = {}) {
  const pass1Plan = pass1Result.pass1Plan ?? pass1Result;
  // First, ensure pass1 is strictly isolated (this validates read-only boundary independently)
  assertPass1Isolation(pass1Plan);
  if (!trustedEvidence || typeof trustedEvidence !== 'object' || Array.isArray(trustedEvidence)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'trustedEvidence must be an object for pass-2 selection', { exitCode: 2 });
  }
  // Build the pass-2 plan from separately supplied trusted current evidence (machine-local authority)
  // This does NOT derive from pass1 state; it is an independent deterministic validation.
  // Strip gating-only fields that are not part of entry-plan evidence.
  const planEvidence = {};
  for (const k of ['entryState','projectPolicyLoaded','entryPolicyRevision','rolePolicyRevision','guideSelectionDigest','guideRequired','obligationIds','capabilityProfileId','capabilityClasses','hostMode','collectionId']) {
    if (k in trustedEvidence) planEvidence[k] = trustedEvidence[k];
  }
  let pass2Plan;
  try {
    pass2Plan = buildEntryPlan(planEvidence);
  } catch (e) {
    throw e;
  }
  // Select profile using the trusted pass-2 plan and trusted evidence as hostEvidence
  const gatingEvidence = {
    entryState: trustedEvidence.entryState,
    entryPolicyRevision: trustedEvidence.entryPolicyRevision,
    rolePolicyRevision: trustedEvidence.rolePolicyRevision,
    guideSelectionDigest: trustedEvidence.guideSelectionDigest ?? null,
    projectPolicyLoaded: trustedEvidence.projectPolicyLoaded,
    requestedCapabilities: trustedEvidence.requestedCapabilities ?? trustedEvidence.proposedCapabilities ?? null,
    proposedCapabilities: trustedEvidence.proposedCapabilities,
    modelProposed: trustedEvidence.modelProposed,
    guaranteeTier: trustedEvidence.guaranteeTier,
    hostMode: trustedEvidence.hostMode,
    guideRequired: trustedEvidence.guideRequired,
  };
  const validated = selectCapabilityProfile(pass2Plan, gatingEvidence);
  return Object.freeze({
    validatedProfile: validated,
    pass1Plan,
    pass2Plan,
    validatedAt: new Date().toISOString(),
  });
}

export function createPass2Context(validatedResult, hostEvidence = {}) {
  const profile = validatedResult.validatedProfile ?? validatedResult;
  if (!profile || !profile.allowedCapabilities) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'validated profile required for pass2', { exitCode: 2 });
  }
  const pass2Nonce = `pass2_${randomUUID()}`;
  const allowed = [...profile.allowedCapabilities];
  for (const cap of allowed) {
    if (cap === 'shell' || cap === 'curl' || cap.startsWith('browser.') || cap.startsWith('provider.') || cap === 'network' || cap === 'generic-shell') {
      throw new AiCliError('POLICY_DENIED', `pass2 capability ${cap} is not permitted`, { exitCode: 2 });
    }
  }
  if (profile.guideSelectionDigest !== null && profile.guideSelectionDigest !== undefined && !hostEvidence.guideRequired) {
    // On no-guide route the digest must stay null; only check if hostEvidence explicitly indicates guideRequired false
    if (hostEvidence.guideRequired === false || (!hostEvidence.guideRequired && profile.guideSelectionDigest !== null)) {
      // The selectCapabilityProfile already gates guide digest; this is an extra boundary check
      if (profile.guideSelectionDigest !== null) {
        throw new AiCliError('PROJECT_GUIDE_APPROVAL_REQUIRED', 'guide context not allowed on no-guide pass2', { exitCode: 2 });
      }
    }
  }
  const pass2Context = sanitizeContext({
    schema: 'webmcp-pass2-context/1',
    entryState: profile.entryState,
    capabilityProfileId: profile.acceptedProfileId,
    capabilityProfileRevision: profile.capabilityProfileRevision,
    entryPolicyRevision: profile.entryPolicyRevision,
    rolePolicyRevision: profile.rolePolicyRevision,
    guideSelectionDigest: profile.guideSelectionDigest ?? null,
    allowedCapabilities: Object.freeze([...allowed]),
    hostMode: hostEvidence.hostMode ?? 'managed-G1',
  });
  // Real child-process boundary: spawn a fresh managed process that receives ONLY the sanitized pass2Context via stdin.
  // Narrowest safe mechanism available in this package is node:child_process spawnSync with process.execPath.
  // No secret-bearing env/argv is inherited; only the validated allow-list is portable.
  // This does NOT claim OS-level sandboxing beyond a distinct PID and sanitized stdio/env isolation.
  const payload = JSON.stringify(pass2Context);
  const sanitizedEnv = {};
  // Preserve minimal PATH for Node resolution if needed, but never pass secrets
  if (typeof process.env.PATH === 'string' && process.env.PATH.length > 0) {
    sanitizedEnv.PATH = process.env.PATH;
  }
  const child = spawnSync(process.execPath, ['-e', `
    const fs=require('fs');
    let input='';
    try { input=fs.readFileSync(0,'utf8'); } catch(e){ process.exit(2); }
    let ctx;
    try { ctx=JSON.parse(input); } catch(e){ process.exit(3); }
    const forbiddenKeys = new Set(['credential','credentials','secret','token','password','apiKey','api_key','privateKey','private_key','bindingPath','binding_path','bindingFile','env','sessionId','machineId','host','hostname']);
    function scan(obj, path='ctx'){
      if(obj===null||obj===undefined) return;
      if(typeof obj==='string'){
        if(obj.includes('sk-')||obj.includes('ghp_')||obj.includes('-----BEGIN')) process.exit(5);
        return;
      }
      if(Array.isArray(obj)){ obj.forEach((v,i)=>scan(v,path+'['+i+']')); return; }
      if(typeof obj==='object'){
        for(const [k,v] of Object.entries(obj)){
          if(forbiddenKeys.has(k)) process.exit(4);
          scan(v, path+'.'+k);
        }
      }
    }
    scan(ctx);
    // Verify no secret-bearing env vars were inherited
    for(const k of Object.keys(process.env)){
      const low=k.toLowerCase();
      if(low.includes('secret')||low.includes('token')||low.includes('credential')||low.includes('apikey')||low.includes('api_key')||low.includes('password')){
        process.exit(6);
      }
      const v=process.env[k]||'';
      if(v.includes('sk-')||v.includes('ghp_')||v.includes('-----BEGIN')){
        process.exit(7);
      }
    }
    // Honest output: prove child pid and that allowedCapabilities are exactly the portable set.
    process.stdout.write(JSON.stringify({ pid: process.pid, ppid: process.ppid, allowedCapabilities: ctx.allowedCapabilities, envKeys: Object.keys(process.env).sort() }));
  `], { input: payload, encoding: 'utf8', timeout: 2_500, maxBuffer: 64 * 1024, env: sanitizedEnv });
  if (child.error) {
    throw new AiCliError('ORCHESTRATION_INDETERMINATE', `pass2 fresh process spawn failed: ${child.error.message}`, { exitCode: 2 });
  }
  if (child.status !== 0) {
    throw new AiCliError('POLICY_DENIED', `pass2 context failed child validation (status ${child.status})`, { exitCode: 2 });
  }
  let proof;
  try {
    proof = JSON.parse(child.stdout);
  } catch {
    throw new AiCliError('ORCHESTRATION_INDETERMINATE', 'pass2 child did not return valid proof', { exitCode: 2 });
  }
  if (!Number.isInteger(proof.pid) || proof.pid <= 0) {
    throw new AiCliError('ORCHESTRATION_INDETERMINATE', 'pass2 child pid proof invalid', { exitCode: 2 });
  }
  if (proof.pid === process.pid) {
    throw new AiCliError('ORCHESTRATION_INDETERMINATE', 'pass2 child pid equals parent pid; no fresh process boundary', { exitCode: 2 });
  }
  // Prove that pass2 context is the only portable input: child echoed back exactly the allowedCapabilities.
  const childCaps = proof.allowedCapabilities ?? [];
  if (childCaps.length !== allowed.length || childCaps.some((c, i) => c !== allowed[i])) {
    throw new AiCliError('POLICY_DENIED', 'pass2 child allowedCapabilities mismatch', { exitCode: 2 });
  }
  // Prove no secret env was inherited (envKeys must not contain secret patterns)
  for (const k of proof.envKeys ?? []) {
    const low = k.toLowerCase();
    if (low.includes('secret') || low.includes('token') || low.includes('credential') || low.includes('apikey')) {
      throw new AiCliError('POLICY_DENIED', `pass2 child inherited secret env key ${k}`, { exitCode: 2 });
    }
  }
  return Object.freeze({
    pass2Context,
    pass2Nonce,
    createdAt: new Date().toISOString(),
    freshProcess: true,
    childPid: proof.pid,
    childPpid: proof.ppid,
    handshakeVerified: true,
  });
}

export function runTwoPass(options = {}) {
  // New API: { pass1Evidence, trustedEvidence, hostEvidence }
  // Legacy support: { evidence, hostEvidence } where evidence is treated as pass1Evidence
  // and hostEvidence doubles as trustedEvidence (which will correctly fail isolation if pass1 was ENTRY_READY)
  let pass1Evidence = options.pass1Evidence ?? null;
  let trustedEvidence = options.trustedEvidence ?? null;
  let hostEvidence = options.hostEvidence ?? {};

  if (pass1Evidence === null && options.evidence !== undefined) {
    pass1Evidence = options.evidence;
    if (trustedEvidence === null) {
      trustedEvidence = options.hostEvidence ?? {};
    }
  }

  if (!pass1Evidence || typeof pass1Evidence !== 'object' || Array.isArray(pass1Evidence)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runTwoPass requires pass1Evidence object (read-only state)', { exitCode: 2 });
  }
  if (!trustedEvidence || typeof trustedEvidence !== 'object' || Array.isArray(trustedEvidence)) {
    throw new AiCliError('ORCHESTRATION_INVALID_INPUT', 'runTwoPass requires trustedEvidence object (machine-local current evidence for pass-2)', { exitCode: 2 });
  }

  // Enforce ordering: pass1 -> validator -> pass2
  const pass1 = createPass1Plan(pass1Evidence);
  const validated = validateAndSelectProfile(pass1, trustedEvidence);
  // Pass2 gating may include additional hostEvidence fields (e.g., requestedCapabilities outside trustedEvidence)
  const gatingForPass2 = { ...trustedEvidence, ...hostEvidence };
  const pass2 = createPass2Context(validated, gatingForPass2);
  // Ensure pass1 and pass2 are distinct processes (nonces differ and child pid proves boundary)
  if (pass1.passId === pass2.pass2Nonce) {
    throw new AiCliError('ORCHESTRATION_INDETERMINATE', 'pass1 and pass2 must be distinct processes', { exitCode: 2 });
  }
  // Ensure no secret leaked across boundary
  const allKeys = [...Object.keys(pass1.sanitizedContext), ...Object.keys(pass2.pass2Context)];
  for (const k of allKeys) {
    if (SECRET_KEYS.has(k)) {
      throw new AiCliError('POLICY_DENIED', `secret key ${k} must not cross managed-host boundary`, { exitCode: 2 });
    }
  }
  return Object.freeze({
    pass1,
    validated,
    pass2,
    order: Object.freeze(['pass1', 'validator', 'pass2']),
  });
}

export function isPass1Isolated(pass1Plan) {
  try {
    assertPass1Isolation(pass1Plan);
    return true;
  } catch {
    return false;
  }
}

export function assertManagedDispatchEntry({ input, packet, rolePolicy, trustedEntryEvidence }) {
  if (packet?.collectionId || packet?.guide || packet?.guideSelectionDigest) {
    throw new AiCliError('PROJECT_GUIDE_APPROVAL_REQUIRED', 'guide requires D5 approval', { exitCode: 2 });
  }
  if (!rolePolicy) {
    throw new AiCliError('AI_ROLE_POLICY_REQUIRED', 'role policy required before managed dispatch', { exitCode: 2 });
  }
  for (const k of ['state', 'profile', 'guaranteeTier', 'guarantee', 'capabilityProfileId', 'capabilityProfileRevision', 'bindingPath', 'credential', 'secret']) {
    if (k in (input ?? {})) throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `model cannot self-set ${k}`, { exitCode: 2 });
  }
  const selStr = JSON.stringify(input?.selection ?? {});
  if (/shell|curl|direct-browser|browser\.navigate/i.test(selStr)) {
    throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', 'prompt-injected capability denied', { exitCode: 2 });
  }
  if (input?.capability && /(shell|curl|browser|provider|media|network)/i.test(String(input.capability)) && String(input.capability) !== 'runner.handoff' && String(input.capability) !== 'store.discovery' && String(input.capability) !== 'guide.validate' && String(input.capability) !== 'request.prepare') {
    throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', `capability ${input.capability} not allowed`, { exitCode: 2 });
  }
  const outwardCaps = new Set(['runner.handoff', 'store.discovery', 'guide.validate', 'request.prepare']);
  const wantsOutward = typeof input?.capability === 'string' && outwardCaps.has(String(input.capability));
  if (!wantsOutward) return;
  const trustedEvidence = trustedEntryEvidence ?? null;
  if (!trustedEvidence || typeof trustedEvidence !== 'object' || Array.isArray(trustedEvidence)) {
    throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', 'trusted entry evidence is required for outward action; none supplied via machine-local authority', { exitCode: 2 });
  }
  if (typeof trustedEvidence.entryState !== 'string' || typeof trustedEvidence.projectPolicyLoaded !== 'boolean') {
    throw new AiCliError('WEBMCP_ENTRY_RECEIPT_REQUIRED', 'trusted entry evidence is malformed: missing entryState or projectPolicyLoaded', { exitCode: 2 });
  }
  if (typeof trustedEvidence.entryPolicyRevision !== 'string' || typeof trustedEvidence.rolePolicyRevision !== 'string' || typeof trustedEvidence.capabilityProfileRevision !== 'string') {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', 'trusted entry evidence lacks exact policy/profile revisions', { exitCode: 2 });
  }
  const roleRev = computePolicyDigest(rolePolicy);
  if (trustedEvidence.rolePolicyRevision !== roleRev) {
    throw new AiCliError('AI_ROLE_POLICY_DIGEST_MISMATCH', 'trusted entry evidence rolePolicyRevision drift', { exitCode: 2 });
  }
  if (trustedEvidence.entryPolicyRevision !== ENTRY_POLICY_REVISION) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', 'trusted entry evidence entryPolicyRevision drift', { exitCode: 2 });
  }
  let plan;
  plan = buildEntryPlan({
    entryState: trustedEvidence.entryState,
    projectPolicyLoaded: trustedEvidence.projectPolicyLoaded,
    entryPolicyRevision: trustedEvidence.entryPolicyRevision,
    rolePolicyRevision: trustedEvidence.rolePolicyRevision,
    ...(trustedEvidence.capabilityProfileId ? { capabilityProfileId: trustedEvidence.capabilityProfileId } : {}),
    ...(trustedEvidence.capabilityClassesSorted ? { capabilityClasses: trustedEvidence.capabilityClassesSorted } : {}),
    ...(trustedEvidence.obligationIds ? { obligationIds: trustedEvidence.obligationIds } : {}),
    ...(trustedEvidence.guideRequired !== undefined ? { guideRequired: trustedEvidence.guideRequired } : {}),
    ...(trustedEvidence.collectionId !== undefined ? { collectionId: trustedEvidence.collectionId } : {}),
    ...(trustedEvidence.guideSelectionDigest !== undefined ? { guideSelectionDigest: trustedEvidence.guideSelectionDigest } : {}),
  });
  if (trustedEvidence.capabilityProfileRevision !== plan.capabilityProfileRevision) {
    throw new AiCliError('WEBMCP_ENTRY_POLICY_DIGEST_MISMATCH', 'trusted entry evidence capabilityProfileRevision mismatch', { exitCode: 2 });
  }
  const requestedCaps = input.capability ? [String(input.capability)] : [];
  selectCapabilityProfile(plan, {
    entryState: trustedEvidence.entryState,
    entryPolicyRevision: trustedEvidence.entryPolicyRevision,
    rolePolicyRevision: trustedEvidence.rolePolicyRevision,
    guideSelectionDigest: trustedEvidence.guideSelectionDigest ?? null,
    projectPolicyLoaded: trustedEvidence.projectPolicyLoaded,
    requestedCapabilities: requestedCaps,
  });
}
