// M1 Jev runtime readiness. Reports route/bin/version plus a provider
// group (installed/authenticated/canary) pinned to not-probed only — never
// true. Reads no credential file and spawns no provider binary.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JEV_DOCTOR_SCHEMA = 'webmcp-jev-doctor/1';

function packageVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function defaultBinPath() {
  try {
    return fileURLToPath(new URL('../../bin/webmcp-jev.mjs', import.meta.url));
  } catch {
    return null;
  }
}

export async function jevDoctor({ env = process.env } = {}) {
  const override = typeof env?.WEBMCP_JEV_BIN === 'string' && env.WEBMCP_JEV_BIN.length > 0
    ? env.WEBMCP_JEV_BIN
    : null;
  const fallback = defaultBinPath();
  const bin = override ?? fallback;
  return {
    ok: true,
    schema: JEV_DOCTOR_SCHEMA,
    version: packageVersion(),
    route: 'jev',
    bin,
    binAbsolute: typeof bin === 'string' ? isAbsolute(bin) : false,
    binExists: typeof bin === 'string' ? existsSync(bin) : false,
    envOverrideUsed: override !== null,
    provider: {
      installed: 'not-probed',
      authenticated: 'not-probed',
      canary: 'not-probed',
    },
  };
}
