export const ORCHESTRATION_PROTOCOL = 'webmcp.ai-orchestration/v0';
export const WORKER_CALLBACK_PROTOCOL = 'webmcp.ai-worker-callback/v0';
export const DELIVERY_PROTOCOL = 'webmcp.ai-orchestration-delivery/v0';

export const ORCHESTRATION_LIMITS = Object.freeze({
  maxRequestBytes: 1024 * 1024,
  maxDeliveryBytes: 512 * 1024,
  maxInlinePayloadBytes: 256 * 1024,
  maxBatchDeliveries: 256,
  maxWaitMs: 60_000,
  maxRefBytes: 32 * 1024 * 1024,
  journalBackpressureBytes: 480 * 1024 * 1024,
  journalHardLimitBytes: 512 * 1024 * 1024,
  defaultConcurrentDispatches: 4,
  maxConcurrentDispatches: 16,
  defaultDelegationDepth: 1,
  maxDelegationDepth: 4,
  maxAcceptanceCommands: 16,
  maxAcceptanceCommandMs: 1_800_000,
});

export const OPERATIONS = Object.freeze([
  'coordination.inspect',
  'coordination.transfer',
  'coordination.close',
  'task.create',
  'task.cancel',
  'dispatch.start',
  'dispatch.reply',
  'dispatch.guidance',
  'dispatch.permission.resolve',
  'dispatch.interrupt',
  'dispatch.verify',
  'decision-gate.create',
  'decision-gate.resolve',
  'delivery.wait',
  'delivery.ack',
]);

export const WORKER_CALLBACK_OPERATIONS = Object.freeze([
  'worker.heartbeat',
  'worker.progress',
  'worker.question',
  'worker.escalation',
  'worker.terminal',
]);

export const DELIVERY_TYPES = Object.freeze([
  'coordination_created',
  'coordination_state_changed',
  'task_created',
  'task_state_changed',
  'dispatch_created',
  'dispatch_state_changed',
  'worker_binding_recorded',
  'worker_started',
  'heartbeat',
  'progress',
  'question',
  'reply',
  'escalation',
  'guidance',
  'permission_requested',
  'permission_resolved',
  'worker_done',
  'worker_failed',
  'worker_cancelled',
  'decision_gate_created',
  'decision_gate_resolved',
  'decision_gate_expired',
  'decision_gate_cancelled',
  'test_verdict_recorded',
  'acceptance_recorded',
  'ownership_transferred',
  'cleanup_recorded',
]);

export const TERMINAL_WORKER_DELIVERY_TYPES = Object.freeze([
  'worker_done',
  'worker_failed',
  'worker_cancelled',
]);

export const CRITICAL_DELIVERY_TYPES = Object.freeze([
  'question',
  'escalation',
  'permission_requested',
  'permission_resolved',
  'decision_gate_created',
  'decision_gate_resolved',
  'decision_gate_expired',
  'decision_gate_cancelled',
  'worker_done',
  'worker_failed',
  'worker_cancelled',
  'acceptance_recorded',
  'ownership_transferred',
  'cleanup_recorded',
]);

export const ORCHESTRATION_MODES = Object.freeze([
  'full-handoff',
  'delegated-result-return',
  'supervised-orchestration',
]);

export const GUARANTEE_TIERS = Object.freeze([
  'native-controlled',
  'owned-process',
  'attached-observer',
  'unsupported',
]);

export const COORDINATION_STATES = Object.freeze(['open', 'closing', 'closed', 'abandoned']);

export const TEST_VERDICTS = Object.freeze([
  'not_run',
  'intended_RED',
  'GREEN',
  'failed',
  'indeterminate',
]);

export const ACCEPTANCE_STATES = Object.freeze(['pending', 'accepted', 'rejected', 'indeterminate']);

export const ID_PREFIXES = Object.freeze({
  coordination: 'coord_',
  request: 'req_',
  task: 'task_',
  dispatch: 'disp_',
  worker: 'worker_',
  gate: 'gate_',
  delivery: 'del_',
  callback: 'cbk_',
  ref: 'ref_',
});

export const ORCHESTRATION_ERROR_CODES = Object.freeze(new Set([
  'ORCHESTRATION_DISABLED',
  'ORCHESTRATION_INVALID_INPUT',
  'ORCHESTRATION_UNSUPPORTED_VERSION',
  'COORDINATION_NOT_FOUND',
  'COORDINATION_CLOSED',
  'COORDINATION_LOCKED',
  'TASK_NOT_FOUND',
  'DISPATCH_NOT_FOUND',
  'DECISION_GATE_NOT_FOUND',
  'DECISION_GATE_BLOCKING',
  'STALE_COORDINATOR_EPOCH',
  'WORKER_IDENTITY_UNPROVEN',
  'WORKER_CALLBACK_UNAUTHORIZED',
  'ORCHESTRATION_CURSOR_EXPIRED',
  'ORCHESTRATION_EVENT_GAP',
  'WORKER_PROCESS_LOST',
  'PERMISSION_REQUIRED',
  'POLICY_DENIED',
  'PROVIDER_PROTOCOL_ERROR',
  'ORCHESTRATION_INDETERMINATE',
  'JOURNAL_BACKPRESSURE',
  'JOURNAL_LIMIT_REACHED',
  'JOURNAL_CORRUPT',
  'SNAPSHOT_CORRUPT',
  'UNSUPPORTED_CAPABILITY',
]));

export const SNAPSHOT_SCHEMA = 'webmcp.ai-orchestration-snapshot/v0';
export const MANIFEST_SCHEMA = 'webmcp.ai-orchestration-manifest/v0';
