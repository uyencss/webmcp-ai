#!/usr/bin/env node
// Self-check: scaffolds throwaway programs in a tmp dir, verifies config merge,
// strategy rounds and prompt assembly. Makes NO provider calls.
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const S = new URL('.', import.meta.url).pathname;
const node = process.execPath;
const base = mkdtempSync(join(tmpdir(), 'mad-selfcheck-'));
let pass = 0;
const ok = (cond, msg) => {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else { pass++; console.log(`ok: ${msg}`); }
};
const run = (script, ...a) => execFileSync(node, [join(S, script), ...a], { encoding: 'utf8' });

try {
  // 1. Default scaffold (cross-exam, 5 lanes, 3 rounds)
  run('debate-init.mjs', 'default-run', '--dir', base);
  const root = join(base, 'default-run');
  const cfg = JSON.parse(readFileSync(join(root, 'debate.config.json'), 'utf8'));
  ok(cfg.strategy === 'cross-exam', 'default strategy is cross-exam');
  ok(cfg.debaters.length === 5, 'default has 5 debaters');
  ok(cfg.debaters[2].model === 'gpt-6-sol' && cfg.debaters[2].effort === 'high', 'D3 = codex gpt-6-sol high');
  ok(existsSync(join(root, 'r3', 'out')), 'round-3 out dir scaffolded');

  run('assemble-round.mjs', root, '1');
  const r1 = readFileSync(join(root, 'r1', 'prompt.md'), 'utf8');
  ok(r1.includes('VÒNG 1'), 'R1 prompt uses r1 header');
  ok(r1.includes('Context brief'), 'R1 prompt embeds context brief');

  run('assemble-round.mjs', root, '3');
  ok(existsSync(join(root, 'r3', 'prompt-D5.md')), 'vote round is per-debater (D5 prompt exists)');
  ok(readFileSync(join(root, 'r3', 'prompt-D5.md'), 'utf8').includes('Debater 5'), 'vote prompt names the debater');

  // 2. Custom roles + red-team strategy via inline flags
  run('debate-init.mjs', 'custom-run', '--dir', base, '--strategy', 'red-team',
    '--debaters', 'codex:gpt-6-sol:high;agy:gemini-3.8-flash-high:high');
  const croot = join(base, 'custom-run');
  const ccfg = JSON.parse(readFileSync(join(croot, 'debate.config.json'), 'utf8'));
  ok(ccfg.debaters.length === 2, 'custom has 2 debaters');
  ok(ccfg.debaters[0].route === 'codex' && ccfg.debaters[1].route === 'agy', 'custom routes parsed');
  run('assemble-round.mjs', croot, '2');
  const d1 = readFileSync(join(croot, 'r2', 'prompt-D1.md'), 'utf8');
  const d2 = readFileSync(join(croot, 'r2', 'prompt-D2.md'), 'utf8');
  ok(d1.includes('RED TEAM'), 'red-team assigns attacker stance to D1');
  ok(d2.includes('BLUE TEAM'), 'red-team assigns defender stance to D2');

  // 3. Invalid strategy is rejected
  let rejected = false;
  try {
    run('debate-init.mjs', 'bad-run', '--dir', base, '--strategy', 'nope');
  } catch { rejected = true; }
  ok(rejected, 'invalid strategy rejected');

  // 4. Prohibited legacy model (deepseek-v4-flash) is rejected, v4.1 flash is accepted
  let deepseekV4Rejected = false;
  try {
    run('debate-init.mjs', 'deepseek-v4-run', '--dir', base,
      '--moderator', 'opencode:opencode-go/deepseek-v4-flash:-:moderator');
  } catch { deepseekV4Rejected = true; }
  ok(deepseekV4Rejected, 'prohibited expensive deepseek-v4-flash is rejected');

  run('debate-init.mjs', 'deepseek-v41-host-run', '--dir', base,
    '--moderator', 'opencode:opencode-go/deepseek-v4.1-flash:-:moderator');
  const dscfg = JSON.parse(readFileSync(join(base, 'deepseek-v41-host-run', 'debate.config.json'), 'utf8'));
  ok(dscfg.moderator.model === 'opencode-go/deepseek-v4.1-flash', 'deepseek-v4.1-flash accepted as host/moderator');

  // 5. debate-plan.mjs scaffolds valid draft plan with 5 sections and lenses
  run('debate-plan.mjs', 'plan-test-run', '--dir', base,
    '--topic', 'Tối giản kiến trúc WebMCP Project Kit',
    '--strategy', 'cross-exam',
    '--lenses', 'ponytail,speckit');
  const planFile = join(base, 'plan-test-run', 'debate-plan.draft.md');
  ok(existsSync(planFile), 'debate-plan.draft.md created');
  const planMd = readFileSync(planFile, 'utf8');
  ok(planMd.includes('DỰ THẢO KẾ HOẠCH CUỘC HỌP TRANH BIỆN'), 'draft plan has main title');
  ok(planMd.includes('I. BỐI CẢNH & CHỦ ĐỀ TRANH LUẬN'), 'draft plan has section I');
  ok(planMd.includes('II. THÀNH PHẦN THAM DỰ & PHÂN VAI'), 'draft plan has section II');
  ok(planMd.includes('III. KỊCH BẢN & TIẾN TRÌNH CÁC VÒNG'), 'draft plan has section III');
  ok(planMd.includes('IV. ƯỚC TÍNH QUOTA & TÀI NGUYÊN'), 'draft plan has section IV');
  ok(planMd.includes('V. DANH MỤC CHỜ NGƯỜI DÙNG KIỂM TRA & CHỈNH SỬA'), 'draft plan has section V');
  ok(planMd.includes('Ponytail Lens'), 'draft plan incorporates Ponytail lens');
  ok(planMd.includes('Spec-Kit Lens'), 'draft plan incorporates Spec-Kit lens');
  ok(planMd.includes('Vòng 1: Quan điểm độc lập'), 'draft plan maps round 1 correctly');
  ok(planMd.includes('Vòng 2: Chất vấn chéo'), 'draft plan maps round 2 correctly');
  ok(planMd.includes('Vòng 3: Biểu quyết chốt'), 'draft plan maps round 3 correctly');

  // 6. debate-init.mjs preserves plan into debate-plan.approved.md
  run('debate-init.mjs', 'plan-test-run', '--dir', base, '--plan', planFile);
  const planRoot = join(base, 'plan-test-run');
  ok(existsSync(join(planRoot, 'debate-plan.approved.md')), 'debate-plan.approved.md preserved upon init');
  const planCfg = JSON.parse(readFileSync(join(planRoot, 'debate.config.json'), 'utf8'));
  ok(planCfg.plan === 'debate-plan.approved.md', 'debate.config.json records approved plan reference');

  // 7. debate-plan.mjs rejects prohibited deepseek-v4 model
  let planDsV4Rejected = false;
  try {
    run('debate-plan.mjs', 'plan-bad-ds', '--dir', base,
      '--moderator', 'opencode:opencode-go/deepseek-v4-flash:-:moderator');
  } catch { planDsV4Rejected = true; }
  ok(planDsV4Rejected, 'debate-plan.mjs rejects prohibited expensive deepseek-v4-flash');

  // 8. extract-responses.mjs AGY brain attribution (fake HOME, offline, no provider)
  const f2Home = join(base, 'f2-home');
  const f2Prog = join(base, 'f2-run');
  const f2Brain = join(f2Home, '.gemini', 'antigravity-cli', 'brain');
  const f2Out = join(f2Prog, 'r2', 'out');
  mkdirSync(f2Out, { recursive: true });
  mkdirSync(join(f2Brain, 'brain-a'), { recursive: true });
  mkdirSync(join(f2Brain, 'brain-b'), { recursive: true });
  writeFileSync(join(f2Prog, 'debate.config.json'), JSON.stringify({
    strategy: 'cross-exam',
    moderator: { route: 'coordinator', model: '-' },
    debaters: [
      { route: 'agy', model: 'fake-model', effort: '-', lane: 'agy-a' },
      { route: 'agy', model: 'fake-model', effort: '-', lane: 'agy-b' },
    ],
  }, null, 2));
  const textA = 'SHORT-A';
  const textB = 'SHORT-B';
  const writeLane = (lane, text, elapsedMs) => writeFileSync(join(f2Out, `${lane}.json`), JSON.stringify({
    ok: true, provider: 'agy', model: 'fake-model', response: { text }, timing: { elapsedMs },
  }));
  const runExtract = (env) => execFileSync(node, [join(S, 'extract-responses.mjs'), join(f2Prog, 'r2')], {
    encoding: 'utf8', env: { ...process.env, HOME: f2Home, ...env },
  });
  const laneA = () => join(f2Out, 'agy-a.md');
  const laneB = () => join(f2Out, 'agy-b.md');

  const t0 = Date.now();
  const artifactA1 = `ARTIFACT-A1 ${'x'.repeat(120)}`;
  const artifactA2 = `ARTIFACT-A2 ${'y'.repeat(120)}`;
  const pathA1 = join(f2Brain, 'brain-a', 'artifact-a1.md');
  const pathA2 = join(f2Brain, 'brain-a', 'artifact-a2.md');
  const pathBstale = join(f2Brain, 'brain-b', 'artifact-old.md');
  writeFileSync(pathA1, artifactA1);
  writeFileSync(pathBstale, 'STALE-ARTIFACT '.repeat(20));
  const at = (ms) => new Date(t0 - ms);
  utimesSync(pathA1, at(30_000), at(30_000));      // inside A's window
  utimesSync(pathBstale, at(10 * 60_000), at(10 * 60_000)); // outside every fresh window
  writeLane('agy-a', textA, 60_000);
  writeLane('agy-b', textB, 10_000);

  // Case 1: A in-window single candidate -> brain artifact; B none -> response.text.
  let out = runExtract({});
  ok(readFileSync(laneA(), 'utf8') === artifactA1 + '\n', 'in-window single artifact attributed to its own lane');
  ok(readFileSync(laneB(), 'utf8') === textB + '\n', 'lane without artifact keeps its own response.text');
  ok(out.includes('execution-window'), 'attribution logs the execution-window method');

  // Case 2: two in-window candidates -> ambiguous, keep response.text (never guess).
  writeFileSync(pathA2, artifactA2);
  utimesSync(pathA2, at(20_000), at(20_000));
  out = runExtract({});
  ok(readFileSync(laneA(), 'utf8') === textA + '\n', 'ambiguous window keeps response.text');
  ok(out.includes('brain-ambiguous(2)'), 'ambiguous window logs a typed warning');

  // Case 3: parallel lanes sharing one artifact path -> dropped for all lanes.
  rmSync(pathA2, { force: true });
  writeLane('agy-a', textA, 60_000);
  writeLane('agy-b', textB, 120_000); // B window now also contains artifact-a1
  out = runExtract({});
  ok(readFileSync(laneA(), 'utf8') === textA + '\n', 'shared artifact is never attributed to lane A');
  ok(readFileSync(laneB(), 'utf8') === textB + '\n', 'shared artifact is never attributed to lane B');
  ok(out.includes('brain-shared(2 lanes)'), 'shared artifact logs a typed warning');

  // Case 4: missing timing -> fail-safe, keep response.text.
  writeFileSync(join(f2Out, 'agy-a.json'), JSON.stringify({ ok: true, provider: 'agy', response: { text: textA } }));
  out = runExtract({});
  ok(readFileSync(laneA(), 'utf8') === textA + '\n', 'missing timing keeps response.text');
  ok(out.includes('brain-no-timing'), 'missing timing logs a typed warning');

  console.log(`\nselfcheck: ${pass} checks passed`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
