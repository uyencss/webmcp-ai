import { createSupervisor } from './supervisor.mjs';

function readArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

async function main() {
  const mode = readArgValue('--mode') ?? 'create';
  const coordinationId = readArgValue('--coordination-id');

  // Bootstrap metadata arrives on stdin (owner descriptors only); tokens,
  // prompts and passwords never enter argv.
  let bootstrap = {};
  try {
    const raw = readFileSync(0, 'utf8').trim();
    if (raw) bootstrap = JSON.parse(raw);
  } catch {
    bootstrap = {};
  }

  const supervisor = await createSupervisor({
    env: process.env,
    mode,
    ...(coordinationId ? { coordinationId } : {}),
    manifest: { owner: bootstrap.owner ?? null },
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    protocol: 'webmcp.ai-orchestration/v0',
    coordinationId: supervisor.coordinationId,
    fenceEpoch: supervisor.fenceEpoch,
    processGeneration: supervisor.processGeneration,
  })}\n`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    protocol: 'webmcp.ai-orchestration/v0',
    error: {
      code: error.code ?? 'ORCHESTRATION_INDETERMINATE',
      message: error.message,
    },
  })}\n`);
  process.exit(1);
});
