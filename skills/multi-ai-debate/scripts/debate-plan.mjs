#!/usr/bin/env node
// Usage:
//   node debate-plan.mjs <program-slug> [--dir <base>] [--force]
//        [--topic "<topic>"] [--objective "<objective>"]
//        [--strategy <id>] [--roles <file.json>]
//        [--moderator <route:model:effort:lane>]
//        [--debaters "<route:model:effort:lane>;<...>"]
//        [--refs "<path1,path2>"] [--lenses "<ponytail,speckit>"]
//        [--out <custom-output-path>]
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  SKILL_DIR, DEFAULT_TEMP, defaultRoles, loadStrategies,
  validateRoles, assignStances, STANCE_LABELS,
} from './lib/config.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const VALUE_FLAGS = ['--dir', '--strategy', '--roles', '--moderator', '--debaters', '--topic', '--objective', '--refs', '--lenses', '--out', '--rounds-count'];
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));

if (!positional[0]) {
  console.error('Usage: debate-plan.mjs <program-slug> [--topic "..."] [--strategy id] [--moderator spec] [--debaters "spec;spec"] [--refs "..."] [--lenses "..."]');
  process.exit(2);
}

const program = positional[0];
const base = flag('--dir') || DEFAULT_TEMP;
const force = has('--force');
const root = join(base, program);
const outFile = flag('--out') || join(root, 'debate-plan.draft.md');

if (existsSync(outFile) && !force) {
  console.error(`REFUSE: ${outFile} already exists (pass --force to overwrite draft plan)`);
  process.exit(1);
}

const strategies = loadStrategies();

const compose = (d) => {
  const laneFallback = d.route === 'claude-cli' ? 'claude-cli' : d.route === 'coordinator' ? 'coordinator' : d.route;
  if (d.lane) return d;
  return { ...d, lane: laneFallback };
};

const parseSpec = (spec, i = 1) => {
  const [route, model, effort, lane] = spec.split(':');
  return compose({
    id: `D${i}`,
    label: `Phản biện ${i}`,
    route,
    model: model || null,
    effort: effort && effort !== '-' ? effort : null,
    lane: lane || (route === 'claude-cli' ? 'claude-cli' : route === 'coordinator' ? 'coordinator' : route),
    options: route === 'codex' ? { sandbox: 'read-only', ephemeral: true } : route === 'agy' || route === 'opencode' ? { agentMode: 'plan' } : {},
    stance: 'neutral',
  });
};

let roles = defaultRoles();
const rolesFile = flag('--roles');
if (rolesFile) {
  if (!existsSync(rolesFile)) {
    console.error(`Missing roles file: ${rolesFile}`);
    process.exit(1);
  }
  roles = { ...roles, ...JSON.parse(readFileSync(rolesFile, 'utf8')) };
}

if (flag('--strategy')) roles.strategy = flag('--strategy');
if (flag('--moderator')) {
  const m = parseSpec(flag('--moderator'), 0);
  roles.moderator = { ...m, id: 'M0', label: 'Chủ trì', debaterIndex: undefined };
}
if (flag('--debaters')) {
  roles.debaters = flag('--debaters').split(';').filter(Boolean).map((s, i) => parseSpec(s.trim(), i + 1));
}

const errs = validateRoles(roles);
if (errs.length) {
  console.error('INVALID ROLES:\n  ' + errs.join('\n  '));
  process.exit(1);
}

const strategy = strategies[roles.strategy] || strategies['cross-exam'];
roles.strategy = strategy.id;

// Stance & Lenses assignment
let debaters = assignStances(strategy, roles.debaters);
const rawLenses = flag('--lenses');
if (rawLenses) {
  const lensesList = rawLenses.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  debaters = debaters.map((d, idx) => {
    const lens = lensesList[idx];
    if (lens) {
      const lensDesc = lens === 'ponytail'
        ? 'Ponytail Lens (YAGNI triệt để, tối giản hoá, ưu tiên stdlib)'
        : lens === 'speckit' || lens === 'spec-kit'
        ? 'Spec-Kit Lens (SDD, giao ước contract rõ ràng, phân rã đo lường được)'
        : `${lens.toUpperCase()} Lens`;
      return { ...d, lensInfo: lensDesc };
    }
    return d;
  });
}

// Build Markdown parts
const topicText = flag('--topic') || '[Chưa điền chủ đề] Xin vui lòng mô tả đề tài hoặc bài toán kiến trúc cần phản biện tại đây.';
const objectiveText = flag('--objective') || 'Tìm ra phương án kiến trúc tối ưu, phát hiện các điểm gãy rủi ro (blind spots), loại bỏ các abstraction thừa thãi và đạt được sự đồng thuận kỹ thuật.';

const rawRefs = flag('--refs');
let refsText = '';
if (rawRefs) {
  const list = rawRefs.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  refsText = list.map((r) => `- \`${r}\``).join('\n');
} else {
  refsText = '- `/Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit`\n- *(Bổ sung các tài liệu, PRD, spec hoặc đường dẫn mã nguồn liên quan)*';
}

const modInfo = roles.moderator?.route === 'coordinator'
  ? '**Coordinator (Agent điều phối đang chạy)** — Route: `coordinator`'
  : `**${roles.moderator?.lane || 'Chủ trì AI'}** — Route: \`${roles.moderator?.route}\` | Model: \`${roles.moderator?.model}\`${roles.moderator?.effort ? ` (effort: ${roles.moderator?.effort})` : ''}`;

const debaterRows = debaters.map((d) => {
  const stanceDesc = STANCE_LABELS[d.stance] || d.stance;
  const lensStr = d.lensInfo ? ` + ${d.lensInfo}` : '';
  const fullStance = `${d.stance}${lensStr} (${stanceDesc})`;
  const modelStr = `\`${d.model || '-'}\`${d.effort ? ` (${d.effort})` : ''}`;
  return `| **${d.id}** | \`${d.lane}\` | \`${d.route}\` | ${modelStr} | ${fullStance} | Sẵn sàng |`;
}).join('\n');

const roundNames = {
  independent: 'Khởi điểm & Độc lập',
  'cross-exam': 'Đối chất & Phản biện chéo',
  vote: 'Biểu quyết & Hội tụ phán quyết',
  delphi: 'Tổng hợp phản hồi ẩn danh & Hiệu chỉnh',
  attack: 'Tấn công điểm yếu (Red Team)',
  defend: 'Phòng thủ & Vá lỗi (Blue Team)',
};

const roundsDetail = strategy.rounds.map((r, idx) => {
  const typeName = r.label || roundNames[r.kind] || r.kind;
  const isFirst = idx === 0;
  const isLast = idx === strategy.rounds.length - 1;
  let focus = '';
  if (isFirst) {
    focus = 'Từng AI debater độc lập nghiên cứu bối cảnh, trả lời các câu hỏi cốt lõi mà không bị ảnh hưởng bởi các phản biện khác.';
  } else if (isLast) {
    focus = 'Bỏ phiếu chốt các lựa chọn kiến trúc surviving disagreements, ghi nhận điểm đồng thuận và các điều kiện kích hoạt đánh giá lại (revisit conditions).';
  } else {
    focus = 'Chủ trì tổng hợp các điểm bất đồng thực sự vào Agenda. Các debaters chất vấn và phản biện trực tiếp lập luận của nhau.';
  }

  return `#### Vòng ${r.n}: ${typeName} (\`${r.kind}\`)
- **Hình thức:** ${r.perDebater ? 'Độc lập từng Debater (Prompt riêng cho từng vị thế)' : 'Toàn thể hội đồng (Prompt chung)'}
- **Nội dung trọng tâm:** ${focus}
- **Đầu ra mong đợi:** File phản hồi tại \`r${r.n}/out/<lane>.json\` hoặc \`<lane>.md\`.`;
}).join('\n\n');

// Quota check placeholder or info
const quotaEstimation = `- **Codex CLI**: Kiểm tra cửa sổ 5h và weekly limit trước khi dispatch.
- **Claude Code CLI**: Ưu tiên bảo tồn token CLI (chuyển sang AGY Claude nếu weekly < 20%).
- **Antigravity & OpenCode**: Tuyệt đối dùng \`opencode-go/deepseek-v4.1-flash\` nếu có role DeepSeek (đã vượt qua bộ lọc an toàn).`;

// Read template and substitute
const templatePath = join(SKILL_DIR, 'templates', 'debate-plan.template.md');
if (!existsSync(templatePath)) {
  console.error(`Missing template: ${templatePath}`);
  process.exit(1);
}

let content = readFileSync(templatePath, 'utf8');
content = content
  .replaceAll('{{PROGRAM_SLUG}}', program)
  .replaceAll('{{DATE}}', new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }))
  .replaceAll('{{STRATEGY_NAME}}', strategy.name || strategy.id)
  .replaceAll('{{STRATEGY_ID}}', strategy.id)
  .replaceAll('{{ROUNDS_COUNT}}', String(strategy.rounds.length))
  .replaceAll('{{TOPIC}}', topicText)
  .replaceAll('{{OBJECTIVE}}', objectiveText)
  .replaceAll('{{REFERENCES}}', refsText)
  .replaceAll('{{TEMP_DIR}}', join(base, program))
  .replaceAll('{{MODERATOR_INFO}}', modInfo)
  .replaceAll('{{DEBATERS_TABLE}}', debaterRows)
  .replaceAll('{{STRATEGY_SUMMARY}}', strategy.summary || 'Tranh biện nhiều vòng có trọng tài')
  .replaceAll('{{RESOLVER}}', strategy.resolver || 'consensus')
  .replaceAll('{{ROUNDS_DETAIL}}', roundsDetail)
  .replaceAll('{{QUOTA_ESTIMATION}}', quotaEstimation);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, content, 'utf8');

console.log(`\n======================================================`);
console.log(` DỰ THẢO KẾ HOẠCH TRANH BIỆN ĐÃ ĐƯỢC TẠO THÀNH CÔNG `);
console.log(`======================================================`);
console.log(`Tệp dự thảo : ${outFile}`);
console.log(`Chương trình: ${program}`);
console.log(`Chiến lược  : ${strategy.id} (${strategy.rounds.length} vòng)`);
console.log(`Thành phần  : Chủ trì (${roles.moderator?.lane || 'coordinator'}) + ${debaters.length} debaters (${debaters.map(d => d.lane).join(', ')})`);
console.log(`\nCác bước tiếp theo:`);
console.log(`  1. Gửi bản dự thảo cho Người dùng kiểm tra và chỉnh sửa.`);
console.log(`  2. Sau khi Người dùng duyệt, khởi tạo chương trình:`);
console.log(`     node ${join(SKILL_DIR, 'scripts')}/debate-init.mjs ${program} --plan ${outFile}\n`);
