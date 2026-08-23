import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GUIDE_PATH = fileURLToPath(
  new URL('../../skills/webmcp-ai-cli/references/orchestration-runtime.md', import.meta.url),
);

/**
 * The packaged runtime guide is the single source of operator prose. It is
 * never synthesized from provider state at runtime.
 */
export function readOrchestrationGuide({ packageVersion, format = 'markdown' } = {}) {
  const raw = readFileSync(GUIDE_PATH, 'utf8');
  const withVersion = packageVersion
    ? raw.replaceAll('{{PACKAGE_VERSION}}', String(packageVersion))
    : raw;
  if (format === 'json') {
    return { format: 'markdown', guide: withVersion };
  }
  return withVersion;
}
