// Shared config/route layer for the multi-ai-debate skill.
// Single source of truth for role merging, strategy rounds, stances,
// prompt paths and provider command construction.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_TEMP = '/Users/ttcenter/Desktop/VIBE_CODE/temp';
export const CONFIG_NAME = 'debate.config.json';

export const BINS = {
  AI_CLI:
    process.env.WEBMCP_AI_CLI ||
    '/Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-ai-cli/bin/webmcp-ai.mjs',
  AGY: process.env.AGY_BIN || '/Users/ttcenter/.local/bin/agy',
  CLAUDE: process.env.CLAUDE_BIN || '/Users/ttcenter/.local/bin/claude',
  CODEX: process.env.CODEX_BIN || '/Users/ttcenter/.local/bin/codex',
  OPENCODE: process.env.OPENCODE_BIN || '/Users/ttcenter/.opencode/bin/opencode',
};

export const VALID_ROUTES = ['coordinator', 'agy', 'opencode', 'claude-cli', 'codex'];

export const STANCE_LABELS = {
  neutral: 'Trung lập — bảo vệ phương án bạn cho là đúng nhất, không nịnh.',
  for: 'ỦNG HỘ (pro) — lập luận bảo vệ phương án.',
  against: 'PHẢN ĐỐI (con) — lập luận chống phương án.',
  attacker: 'RED TEAM — tấn công: tìm lỗ hổng, giả định sai, failure mode.',
  defender: 'BLUE TEAM — phòng thủ: bảo vệ và vá các lỗ hổng đã bị chỉ ra.',
  devil: "DEVIL'S ADVOCATE — phản biện mạnh nhất có thể, kể cả khi bạn đồng ý.",
  socratic: 'SOCRATIC — chỉ đặt câu hỏi sắc bén, KHÔNG đưa đáp án.',
  steelman: 'STEELMAN — dựng phiên bản mạnh nhất của phương án người khác.',
  premortem: 'PRE-MORTEM — giả sử phương án đã thất bại, kể nguyên nhân.',
  prosecution: 'BÊN BUỘC TỘI — lập luận chống phương án.',
  defence: 'BÊN GỠ TỘI — lập luận bảo vệ phương án.',
  juror: 'BỒI THẨM — cân nhắc cả hai bên và ra phán quyết có lý do.',
  'hat-white': 'MŨ TRẮNG — dữ kiện, số liệu, khoảng trống thông tin.',
  'hat-red': 'MŨ ĐỎ — trực giác, cảm xúc, phản ứng.',
  'hat-yellow': 'MŨ VÀNG — lợi ích, giá trị, điều kiện thành công.',
  'hat-black': 'MŨ ĐEN — rủi ro, phản biện, tiêu cực hợp lý.',
  'hat-green': 'MŨ XANH LÁ — sáng tạo, phương án thay thế.',
  'hat-blue': 'MŨ XANH DƯƠNG — điều phối, tổng hợp, kiểm soát quy trình.',
};

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

export const defaultRoles = () => readJson(join(SKILL_DIR, 'roles.default.json'));
export const loadStrategies = () => readJson(join(SKILL_DIR, 'strategies.json'));
export const loadConfig = (root) => readJson(join(root, CONFIG_NAME));

export function stanceLine(stance) {
  const label = STANCE_LABELS[stance] || STANCE_LABELS.neutral;
  return `**Vai/vị thế được giao:** ${stance} — ${label}`;
}

// Assign stances for debaters that do not already have an explicit non-neutral one.
export function assignStances(strategy, debaters) {
  const mode = strategy.stanceMode || 'uniform';
  return debaters.map((d, i) => {
    if (d.stance && d.stance !== 'neutral') return d;
    let stance = 'neutral';
    const map = strategy.defaultStances || {};
    if (mode === 'assigned' || mode === 'pair') {
      if (map[d.id]) stance = map[d.id];
      else if (mode === 'pair') stance = i % 2 === 0 ? 'attacker' : 'defender';
    }
    return { ...d, stance };
  });
}

// Merge default roles + optional override + strategy, returning the effective plan.
export function resolvePlan(root) {
  const cfg = loadConfig(root);
  const strategies = loadStrategies();
  const strategy = strategies[cfg.strategy] || strategies['cross-exam'];
  const moderator = cfg.moderator || defaultRoles().moderator;
  const debaters = assignStances(strategy, cfg.debaters || defaultRoles().debaters);
  return { cfg, strategy, moderator, debaters };
}

export function participants(plan) {
  const list = [];
  if (plan.moderator && plan.moderator.route && plan.moderator.route !== 'coordinator') {
    list.push({ ...plan.moderator, role: 'moderator' });
  }
  plan.debaters.forEach((d, i) => list.push({ ...d, role: 'debater', debaterIndex: i + 1 }));
  return list;
}

export function promptFileFor(root, roundN, participant) {
  const dir = join(root, `r${roundN}`);
  if (participant.role === 'moderator') return join(dir, 'prompt-moderator.md');
  const perD = join(dir, `prompt-D${participant.debaterIndex}.md`);
  if (existsSync(perD)) return perD;
  return join(dir, 'prompt.md');
}

export function extractorFor(route) {
  if (route === 'codex') return 'md';
  if (route === 'claude-cli') return 'claude';
  return 'wrapper'; // agy + opencode wrapper envelope { ok, response.text }
}

export function checkDeepSeekModel(model) {
  if (!model || !/deepseek/i.test(model)) return null;
  // BẮT BUỘC dùng đúng v4.1 flash (opencode-go/deepseek-v4.1-flash).
  // TUYỆT ĐỐI CẤM deepseek-v4-flash, deepseek-v4-pro, v4 cũ vì tốn tiền.
  const isAllowedV41 = model === 'opencode-go/deepseek-v4.1-flash' || model === 'deepseek-v4.1-flash';
  if (!isAllowedV41) {
    return `PROHIBITED_MODEL: DeepSeek model '${model}' is forbidden (v4 tốn tiền). BẮT BUỘC dùng đúng 'opencode-go/deepseek-v4.1-flash'.`;
  }
  return null;
}

// Build the provider command for one participant. Returns null for coordinator.
export function routeCommand(participant, { promptFile, outDir, workspace, timeoutSec = 2400 }) {
  const route = participant.route;
  const lane = participant.lane;
  const model = participant.model;
  const effort = participant.effort;
  const opts = participant.options || {};
  const stdout = join(outDir, `${lane}.json`);
  const stderr = join(outDir, `${lane}.stderr.log`);
  const base = { timeoutSec, stdout, stderr, stdinFile: null, env: {}, workspace, lane };

  const dsErr = checkDeepSeekModel(model);
  if (dsErr) throw new Error(dsErr);

  if (route === 'agy' || route === 'opencode') {
    const args = [BINS.AI_CLI, 'generate', '--provider', route, '--model', model];
    if (effort) args.push('--effort', effort);
    args.push(
      '--prompt-file', promptFile,
      '--workspace', workspace,
      '--agent-mode', opts.agentMode || 'plan',
      '--events', '--timeout-ms', '2300000', '--json',
    );
    return {
      ...base,
      cmd: process.execPath,
      args,
      env: route === 'agy' ? { AGY_BIN: BINS.AGY } : { OPENCODE_BIN: BINS.OPENCODE },
    };
  }

  if (route === 'claude-cli') {
    const args = ['-p', '--model', model || 'opus'];
    if (effort) args.push('--effort', effort);
    args.push('--output-format', 'json');
    if (opts.restricted !== false) args.push('--restricted');
    return { ...base, cmd: BINS.CLAUDE, args, stdinFile: promptFile };
  }

  if (route === 'codex') {
    const args = ['exec', '--model', model, '--sandbox', opts.sandbox || 'read-only'];
    if (opts.ephemeral !== false) args.push('--ephemeral');
    args.push(
      '--json', '--skip-git-repo-check',
      '--output-last-message', join(outDir, `${lane}.md`),
      '-c', `model_reasoning_effort=${effort || 'high'}`,
      '-c', 'approval_policy=never', '-',
    );
    return {
      ...base,
      cmd: BINS.CODEX,
      args,
      stdinFile: promptFile,
      stdout: join(outDir, `${lane}.events.jsonl`),
      extractFile: join(outDir, `${lane}.md`),
    };
  }

  throw new Error(`unknown route: ${route}`);
}

export function validateRoles(roles) {
  const errs = [];
  const routesOk = (r) => VALID_ROUTES.includes(r);
  for (const d of roles.debaters || []) {
    if (!d.id) errs.push('debater missing id');
    if (!d.lane) errs.push(`${d.id}: missing lane`);
    if (!routesOk(d.route)) errs.push(`${d.id}: invalid route ${d.route}`);
    if (d.route !== 'coordinator' && !d.model) errs.push(`${d.id}: missing model`);
    const dsErr = checkDeepSeekModel(d.model);
    if (dsErr) errs.push(`${d.id}: ${dsErr}`);
  }
  const lanes = (roles.debaters || []).map((d) => d.lane);
  if (new Set(lanes).size !== lanes.length) errs.push('duplicate lane names');
  if (roles.moderator && roles.moderator.route && !routesOk(roles.moderator.route)) {
    errs.push(`moderator: invalid route ${roles.moderator.route}`);
  }
  const modDsErr = checkDeepSeekModel(roles.moderator?.model);
  if (modDsErr) errs.push(`moderator: ${modDsErr}`);

  const strategies = Object.keys(loadStrategies());
  if (roles.strategy && !strategies.includes(roles.strategy)) {
    errs.push(`invalid strategy ${roles.strategy} (valid: ${strategies.join(', ')})`);
  }
  return errs;
}
