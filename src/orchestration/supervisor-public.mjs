import { AiCliError } from '../errors.mjs';
import { assertCoordinatorDispatcher } from './managed-host/host-isolation.mjs';
import { createSupervisor as createInternalSupervisor } from './supervisor.mjs';

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeSupervisorOptions(options) {
  if (!isPlainObject(options)) {
    throw new AiCliError(
      'ORCHESTRATION_INVALID_INPUT',
      'public createSupervisor options must be a plain object',
      { exitCode: 2 },
    );
  }

  // The Browser dispatcher is a process-local construction object. The
  // marker is created by the Browser factory and is intentionally not
  // serializable or reproducible from public data. Validate it before the
  // internal supervisor sees any options; never brand an arbitrary callback.
  if (Object.hasOwn(options, 'coordinatorDispatcher')) {
    assertCoordinatorDispatcher(options.coordinatorDispatcher);
  }

  return options;
}

/**
 * Stable package boundary for an in-process supervisor.
 *
 * Existing supervisor options remain construction-time options, while the
 * coordinator dispatcher is accepted only when it carries the process-local
 * Browser trust marker validated by the implementation. No authority,
 * private key, filesystem root, environment secret, JSON, or IPC value is
 * created or serialized by this facade.
 */
export async function createSupervisor(options = {}) {
  return createInternalSupervisor(normalizeSupervisorOptions(options));
}
