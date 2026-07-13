export class AiCliError extends Error {
  constructor(code, message, { exitCode = 1, retryable = false, details = undefined, cause = undefined } = {}) {
    super(message, { cause });
    this.name = 'AiCliError';
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function asAiCliError(error) {
  if (error instanceof AiCliError) return error;
  return new AiCliError('INTERNAL_ERROR', error?.message || String(error), { cause: error });
}
