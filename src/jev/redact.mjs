// M2 redaction: state/secret must be redacted BEFORE hashing or sending.
// DESIGN D: closed-alphabet projection. Safety is established by an allowlist on output.
// Totality claim: the page-state projection is total on JSON-shaped input (circular references,
// BigInt, non-string content in string positions, missing/extra fields). Out of domain: a
// hostile enumerable getter that throws, and unbounded nesting depth (the schema bounds the
// shape and the client validates before the projection).
// The request projection refusal set is exactly: {criteria key not enum / not a
// caller ref / not canonical V*; criteria key colliding with a remapped key;
// literal eN key that is not a caller ref; declared-secret layer on caller prose
// and on question ids}.
// Closed ceiling list (residual classes):
// (1) a secret composed only of V words;
// (2) an undeclared secret in caller prose (goal/instructions) — a page value repeated in caller prose
//     with different case/spacing is covered by this caller-prose ceiling;
// (3) a secret in the urlOrigin hostname;
// (4) code drift from the projection rule (fuzz-tested);
// (5) question ids are caller-written keys sent on the wire, screened by declared-secret layer and exact canonical page value equality; a caller id built from page text (other than by exact equality) is caller error and belongs to the caller-id ceiling.
// captchaEvidence.sitekey is emitted as a sha256: digest (it is neither a value nor free text).
import { createHash } from 'node:crypto';
import { AiCliError } from '../errors.mjs';
import { OPERATIONS, SOLVER_CRITERIA_KEYS, NEXT_STEP_CRITERIA_KEYS, DETECTOR_KINDS } from './schemas.mjs';

export const REDACTED = '[REDACTED]';

function safeClone(val, seen = new WeakMap()) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (seen.has(val)) {
    return seen.get(val);
  }
  if (Array.isArray(val)) {
    const out = [];
    seen.set(val, out);
    for (let i = 0; i < val.length; i++) {
      out[i] = safeClone(val[i], seen);
    }
    return out;
  }
  const out = Object.getPrototypeOf(val) === null ? Object.create(null) : {};
  seen.set(val, out);
  for (const [k, v] of Object.entries(val)) {
    Object.defineProperty(out, k, {
      value: safeClone(v, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const STRUCTURAL_CRITERIA_KEYS = new Set([
  ...OPERATIONS,
  ...SOLVER_CRITERIA_KEYS,
  ...NEXT_STEP_CRITERIA_KEYS,
  // captcha-classify criteria keys ARE the frozen detector-kind vocabulary
  // (the engine emits `{k: null}` for every CAPTCHA_KINDS entry). Without
  // these the classify path refuses with JEV_REQUEST_INVALID (M2 amendment,
  // 2026-09-24; contracts unchanged).
  ...DETECTOR_KINDS,
  'answer',
  'ref',
  'targetRef',
]);

const STANDARD_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
  'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
  'command', 'complementary', 'composite', 'contentinfo', 'definition', 'deletion',
  'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'file',
  'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'image',
  'inlinebox', 'inlinetextbox', 'input', 'insertion', 'label', 'labeltext',
  'landmark', 'line', 'linebreak', 'link', 'list', 'listbox', 'listitem',
  'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note',
  'number', 'option', 'paragraph', 'password', 'presentation', 'progressbar',
  'radio', 'radiogroup', 'range', 'region', 'reset', 'roledescription',
  'rootwebarea', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'section', 'sectionhead', 'select', 'separator', 'slider',
  'spinbutton', 'statictext', 'status', 'strong', 'structure', 'submit',
  'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel',
  'tel', 'term', 'text', 'textarea', 'textbox', 'time', 'timer', 'toolbar',
  'tooltip', 'tree', 'treegrid', 'treeitem', 'url', 'webarea', 'widget', 'window',
]);

export function isStandardRole(role) {
  if (typeof role !== 'string') return false;
  return STANDARD_ROLES.has(normLabel(role).trim().toLowerCase());
}

export const BUILTIN_PATTERNS = [
  /sk-[A-Za-z0-9\-_]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /xox[bpas]-[A-Za-z0-9\-_]{8,}/g,
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:địa chỉ|dia chi|address)\s*[:=：＝]\s*[\p{Nd}]+\s+[\p{L}]+\s+[\p{L}]+/giu,
  /\b\d{13,19}\b/g,
];

const PII_PATTERNS = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g];

// Closed vocabulary V: all words are lowercase NFKC, length >= 2, no digits.
// Published sorted and frozen.
export const V = Object.freeze([...new Set([
  'about', 'accept', 'account', 'action', 'actions', 'add', 'address', 'again', 'agree', 'alert',
  'allow', 'amount', 'an', 'and', 'apply', 'area', 'article', 'as', 'at', 'auth', 'back', 'backup',
  'banner', 'bao', 'bat', 'bay', 'billing', 'birth', 'block', 'bo', 'body', 'box', 'buoc', 'button',
  'buu', 'by', 'bài', 'báo', 'bão', 'bát', 'bãy', 'băn', 'băng', 'băm', 'bặt', 'bắt', 'bẩm', 'bập',
  'bật', 'bảo', 'bản', 'bảng', 'bảy', 'bắn', 'bắp', 'bắt', 'bỏ', 'bộ', 'bụi', 'bức', 'bước', 'bưởi',
  'bưng', 'bước', 'bưu', 'bạc', 'bạn', 'bảng', 'bảo', 'bạt', 'bầu', 'bẫy', 'bầy', 'bật', 'bập', 'bật',
  'bắn', 'bắp', 'bắt', 'bậc', 'bận', 'bập', 'bật', 'bặt', 'bằng', 'bập', 'bật', 'bậc', 'bận', 'bật',
  'băng', 'bấm', 'bắn', 'bắp', 'bắt', 'bẫy', 'bậc', 'bận', 'bập', 'bật', 'bặc', 'bặt', 'bằng', 'bặc',
  'bây', 'cai', 'can', 'cancel', 'captcha', 'card', 'cards', 'cart', 'cell', 'change', 'changed',
  'char', 'characters', 'chars', 'check', 'checkbox', 'checkout', 'chi', 'chinh', 'cho', 'choice',
  'choi', 'chon', 'choose', 'chu', 'chuyển', 'chính', 'chủ', 'chữ', 'chức', 'chứng', 'chọn', 'chối',
  'city', 'clear', 'click', 'close', 'code', 'codes', 'combobox', 'conditions', 'confirm', 'cong',
  'contact', 'content', 'continue', 'copy', 'correct', 'country', 'coupon', 'create', 'cuoc', 'cvc',
  'cvv', 'cài', 'căn', 'công', 'cùng', 'cũng', 'cước', 'cần', 'có', 'của', 'daily', 'dan', 'dang',
  'dashboard', 'dat', 'data', 'date', 'day', 'decline', 'default', 'delete', 'deny', 'description',
  'detail', 'details', 'dia', 'dialog', 'dien', 'digit', 'digits', 'disable', 'disabled', 'discount',
  'do', 'don', 'done', 'dong', 'download', 'dropdown', 'dung', 'dân', 'dưới', 'dùng', 'edit',
  'element', 'email', 'empty', 'enable', 'enabled', 'enter', 'entry', 'error', 'example', 'exit',
  'expiration', 'expire', 'expired', 'expires', 'expiry', 'false', 'feedback', 'field', 'fields',
  'file', 'filter', 'finish', 'first', 'footer', 'for', 'forgot', 'form', 'forward', 'full',
  'general', 'generic', 'gia', 'giam', 'gio', 'giá', 'giảm', 'giỏ', 'go', 'grid', 'group', 'guest',
  'gui', 'gửi', 'hang', 'han', 'header', 'heading', 'help', 'het', 'hidden', 'hide', 'hien',
  'history', 'hoat', 'hoi', 'hour', 'hours', 'huy', 'hàng', 'hạn', 'hết', 'hiển', 'hiện', 'hoạt',
  'hồi', 'hủy', 'icon', 'if', 'image', 'img', 'in', 'incorrect', 'info', 'information', 'input',
  'invalid', 'is', 'it', 'item', 'items', 'ket', 'key', 'khau', 'khoan', 'khuyen', 'khách',
  'khóa', 'không', 'khẩu', 'khoản', 'khuyến', 'ki', 'kiem', 'kiếm', 'kết', 'kí', 'ký', 'ky',
  'label', 'lai', 'lan', 'language', 'last', 'least', 'level', 'limit', 'line', 'link', 'list',
  'load', 'loading', 'location', 'lock', 'locked', 'log', 'login', 'logout', 'luu', 'lại', 'lưu',
  'lần', 'ma', 'mail', 'main', 'mai', 'manage', 'mask', 'masked', 'mat', 'max', 'maximum', 'me',
  'medium', 'menu', 'message', 'messages', 'min', 'minh', 'minimum', 'minute', 'minutes', 'mo',
  'moi', 'month', 'mot', 'mua', 'my', 'mã', 'mãi', 'mở', 'mới', 'mật', 'một', 'nam', 'name',
  'navigation', 'new', 'news', 'newsletter', 'next', 'ngay', 'ngày', 'nhap', 'nhập', 'no', 'noi',
  'none', 'note', 'notice', 'notification', 'number', 'numbers', 'nối', 'năm', 'of', 'off', 'ok',
  'okay', 'on', 'online', 'open', 'operation', 'option', 'options', 'or', 'order', 'orders', 'otp',
  'out', 'page', 'pages', 'panel', 'passcode', 'passphrase', 'passwd', 'password', 'passwords',
  'paste', 'pause', 'pay', 'payment', 'personal', 'phan', 'phep', 'phong', 'phuc', 'phone',
  'phần', 'phản', 'phép', 'phòng', 'phục', 'pick', 'pin', 'policy', 'postal', 'preferences',
  'previous', 'price', 'privacy', 'profile', 'promo', 'qua', 'quantity', 'query', 'radio',
  'recovery', 'refresh', 'register', 'reload', 'remember', 'remove', 'required', 'resend', 'reset',
  'restart', 'result', 'results', 'retry', 'row', 'sai', 'save', 'saved', 'screen', 'search',
  'second', 'seconds', 'secret', 'secrets', 'section', 'security', 'select', 'selected', 'send',
  'sent', 'separator', 'session', 'setting', 'settings', 'shipping', 'show', 'sign', 'signin',
  'signout', 'signup', 'sinh', 'skip', 'slider', 'so', 'sort', 'ssn', 'standard', 'start',
  'state', 'status', 'step', 'steps', 'stop', 'street', 'strength', 'strong', 'sua', 'submit',
  'subscribe', 'subtotal', 'success', 'support', 'switch', 'system', 'sửa', 'số', 'table', 'tai',
  'tao', 'tat', 'telephone', 'term', 'terms', 'text', 'textbox', 'the', 'them', 'thi', 'thieu',
  'thoai', 'thong', 'thu', 'thuc', 'thành', 'thông', 'thoại', 'thực', 'thử', 'thị', 'thiểu',
  'thẻ', 'thêm', 'tiep', 'time', 'tin', 'tiep', 'tiếp', 'title', 'to', 'toan', 'today', 'toggle',
  'toi', 'token', 'tokens', 'total', 'toán', 'tracking', 'trang', 'true', 'trước', 'tu', 'tuc',
  'type', 'tài', 'tạo', 'tắt', 'tục', 'từ', 'tự', 'tối', 'uncheck', 'unit', 'unlock',
  'unsubscribe', 'up', 'update', 'updated', 'upload', 'us', 'use', 'user', 'username', 'valid',
  'value', 'van', 'vao', 'verification', 'verify', 'version', 'view', 'visible', 'voucher', 'vào',
  'vận', 'wait', 'warning', 'we', 'weak', 'web', 'week', 'welcome', 'window', 'xac', 'xoa',
  'xuat', 'xác', 'xóa', 'xuất', 'year', 'yes', 'your', 'zip'
])].sort());

const V_SET = new Set(V);
export const NON_VALUE_HINT_WORDS = V;

export function projectFreeText(text) {
  if (typeof text !== 'string') return text;
  const normalized = text
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toLowerCase();
  const rawTokens = normalized.match(/[\p{L}\p{M}\p{N}]+/gu);
  if (!rawTokens || rawTokens.length === 0) return '';
  const projected = rawTokens.map((token) => {
    if (V_SET.has(token)) return token;
    if (/^\p{N}+$/u.test(token)) return '#';
    return '…';
  });
  return projected.join(' ');
}

const COMPACT_SEPARATOR_RE = /[\s._/\-•|,*+:·–—\p{Default_Ignorable_Code_Point}\u180e]/u;

function canonicalUnits(text) {
  let compact = '';
  const entryAt = [];
  let u16 = 0;
  for (const ch of String(text ?? '')) {
    const folded = ch.normalize('NFKD').toLowerCase();
    const span = [u16, u16 + ch.length];
    for (const unit of folded) {
      if (!COMPACT_SEPARATOR_RE.test(unit)) {
        compact += unit;
        for (let k = 0; k < unit.length; k++) entryAt.push(span);
      }
    }
    u16 += ch.length;
  }
  return { compact, entryAt };
}

export function canonicalForMatch(text) {
  return canonicalUnits(text).compact;
}

export function normLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFC');
}

export function redactString(value, secrets = []) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let out = value;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 2) continue;
    out = out.split(secret).join(REDACTED);
  }
  for (const pattern of BUILTIN_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  for (const pattern of PII_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function containsSecret(value, secrets = []) {
  if (typeof value !== 'string') return false;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 2 && value.includes(secret)) return true;
  }
  for (const pattern of BUILTIN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

export function toOriginOnly(urlOrigin) {
  if (typeof urlOrigin !== 'string') return urlOrigin;
  const match = /^(https?):\/\/([^/]+?)(\/|$|\?|#)/.exec(urlOrigin.trim());
  if (!match) return urlOrigin;
  const [, scheme, host] = match;
  if (/[@\s]/.test(host)) return urlOrigin;
  return `${scheme.toLowerCase()}://${host.toLowerCase()}`;
}

export function canonicalJson(value, seen = new WeakSet()) {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '"[CIRCULAR]"';
    seen.add(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, seen)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  }
  if (typeof value === 'bigint') return `"${value.toString()}n"`;
  return JSON.stringify(value) ?? 'null';
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digestOf(value) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function stateDigestOf(state) {
  return digestOf(state);
}

export function assertSafeKey(key, { sensitiveValues = [], secrets = [], elementRefs = [], exact = true, shortValues = [] } = {}) {
  if (typeof key !== 'string') return;
  const compactKey = canonicalForMatch(key);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 3) continue;
    const compactSecret = canonicalForMatch(secret);
    if (compactSecret.length >= 2 && compactKey.includes(compactSecret)) {
      throw new AiCliError('JEV_REQUEST_INVALID', 'request key carries a declared secret', { details: { key: '[REDACTED-KEY]' } });
    }
  }
  if (containsSecret(key, secrets)) {
    throw new AiCliError('JEV_REQUEST_INVALID', 'request key carries a secret shape', { details: { key: '[REDACTED-KEY]' } });
  }
  PII_PATTERNS[0].lastIndex = 0;
  if (PII_PATTERNS[0].test(key)) {
    throw new AiCliError('JEV_REQUEST_INVALID', 'request key carries PII', { details: { key: '[REDACTED-KEY]' } });
  }
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive !== 'string') continue;
    const csec = canonicalForMatch(sensitive);
    if (compactKey.length > 0 && csec.length > 0 && csec === compactKey) {
      throw new AiCliError('JEV_REQUEST_INVALID', 'request key carries a sensitive value', { details: { key: '[REDACTED-KEY]' } });
    }
  }
  for (const sv of shortValues) {
    if (typeof sv !== 'string') continue;
    const csv = canonicalForMatch(sv);
    if (compactKey.length > 0 && csv.length > 0 && csv === compactKey) {
      throw new AiCliError('JEV_REQUEST_INVALID', 'request key carries a sensitive value', { details: { key: '[REDACTED-KEY]' } });
    }
    if (sv.length >= 2 && key === sv) {
      throw new AiCliError('JEV_REQUEST_INVALID', 'request key carries a sensitive value', { details: { key: '[REDACTED-KEY]' } });
    }
  }
  if (!exact && !elementRefs.includes(key)) {
    for (const sensitive of sensitiveValues) {
      if (typeof sensitive !== 'string') continue;
      const csec = canonicalForMatch(sensitive);
      if (csec.length >= 2 && compactKey.includes(csec)) {
        throw new AiCliError('JEV_REQUEST_INVALID', 'request key carries a sensitive value', { details: { key: '[REDACTED-KEY]' } });
      }
    }
    for (const sv of shortValues) {
      if (typeof sv !== 'string' || sv.length < 3) continue;
      if (key.includes(sv)) {
        throw new AiCliError('JEV_REQUEST_INVALID', 'request key carries a sensitive value', { details: { key: '[REDACTED-KEY]' } });
      }
    }
  }
}

export function fragmentScan(entries, { canonicals = [], shortCanonicals = [], patterns = [] } = {}) {
  const spanned = new Set();
  const entrySpans = [];
  let recreated = false;
  if (!Array.isArray(entries) || entries.length < 2) {
    return { spanned, spans: entrySpans, recreated };
  }
  if (Array.isArray(canonicals) && canonicals.length > 0) {
    let joined = '';
    const entryAt = [];
    for (let i = 0; i < entries.length; i++) {
      if (typeof entries[i] !== 'string') {
        joined += '\u0000';
        entryAt.push(-1);
        continue;
      }
      const compact = /[\p{L}\p{N}]/u.test(entries[i]) ? canonicalForMatch(entries[i]) : '';
      joined += compact;
      for (let k = 0; k < compact.length; k++) entryAt.push(i);
    }
    for (const canonical of canonicals) {
      if (typeof canonical !== 'string' || canonical.length < 2) continue;
      for (let at = joined.indexOf(canonical); at !== -1; at = joined.indexOf(canonical, at + 1)) {
        const first = entryAt[at];
        const last = entryAt[at + canonical.length - 1];
        if (first !== -1 && last !== -1 && first !== last) {
          if (entries.slice(first + 1, last).some((entry) => typeof entry === 'string' && !/[\p{L}\p{N}]/u.test(entry))) {
            recreated = true;
          }
          for (let i = first; i <= last; i++) spanned.add(i);
        }
      }
    }
  }
  const activePatterns = Array.isArray(patterns) && patterns.length > 0
    ? patterns
    : [...BUILTIN_PATTERNS, ...PII_PATTERNS];
  let rawJoined = '';
  const rawEntryAt = [];
  for (let i = 0; i < entries.length; i++) {
    if (typeof entries[i] !== 'string') {
      rawJoined += '\u0000';
      rawEntryAt.push(-1);
      continue;
    }
    const raw = entries[i];
    rawJoined += raw;
    for (let k = 0; k < raw.length; k++) rawEntryAt.push(i);
  }
  for (const pattern of activePatterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of rawJoined.matchAll(re)) {
      if (m[0].length === 0) continue;
      const first = rawEntryAt[m.index];
      const last = rawEntryAt[m.index + m[0].length - 1];
      if (first !== -1 && last !== -1 && first !== last) {
        for (let i = first; i <= last; i++) spanned.add(i);
      }
    }
  }
  return { spanned, spans: entrySpans, recreated };
}

export function assertNoShortEcho(strings, shortValues = []) {
  if (!Array.isArray(shortValues) || shortValues.length === 0) return;
  const canonicals = [];
  for (const s of shortValues) {
    if (typeof s !== 'string' || s.length === 0) continue;
    const c = canonicalForMatch(s);
    if (c.length > 0) canonicals.push(c);
  }
  if (canonicals.length === 0) return;
  for (const text of strings) {
    if (typeof text !== 'string') continue;
    const compactText = canonicalForMatch(text);
    for (const c of canonicals) {
      if (c.length >= 2 && compactText.includes(c)) {
        throw new AiCliError('JEV_REQUEST_INVALID', 'free text echoes a short sensitive value', {
          details: { text: '[REDACTED-TEXT]' },
        });
      }
    }
  }
}

export function assertNoPayloadReassembly(payload, sensitiveValues = [], shortValues = []) {
  const leaves = [];
  const content = [];
  const dynamicKeys = [];
  const byField = new Map();
  const seen = new WeakSet();
  const contentFields = new Set(['name', 'value', 'text', 'values', 'parentContext', 'goal', 'question', 'criteria']);
  const walk = (value, field = '') => {
    if (value && typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
    }
    if (typeof value === 'string') {
      leaves.push(value);
      if (contentFields.has(field)) content.push(value);
      if (!byField.has(field)) byField.set(field, []);
      byField.get(field).push(value);
    } else if (Array.isArray(value)) {
      value.forEach((entry) => walk(entry, field));
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        leaves.push(key);
        if (field === 'questions' || field === 'criteria') dynamicKeys.push(key);
        walk(entry, field === 'criteria' && typeof entry === 'string' ? 'criteria' : key);
      }
    }
  };
  walk(payload);
  const canonicals = [];
  for (const s of [...sensitiveValues, ...shortValues]) {
    if (typeof s === 'string' && s.length >= 2) {
      const c = canonicalForMatch(s);
      if (c.length >= 2) canonicals.push(c);
    }
  }
  const opts = {
    canonicals: [...new Set(canonicals)],
    patterns: [...BUILTIN_PATTERNS, ...PII_PATTERNS],
  };
  let reassembled = fragmentScan(leaves, opts).spanned.size > 0;
  for (const group of byField.values()) {
    if (reassembled) break;
    reassembled = fragmentScan(group, opts).spanned.size > 0;
  }
  if (!reassembled) reassembled = fragmentScan(content, opts).spanned.size > 0;
  if (!reassembled) reassembled = fragmentScan(dynamicKeys, opts).spanned.size > 0;
  if (reassembled) {
    throw new AiCliError('JEV_REQUEST_INVALID', 'redacted payload reassembles a sensitive value', {
      details: { field: '[REDACTED-FIELD]' },
    });
  }
}

export function collectSensitiveValues(state, { secrets = [] } = {}) {
  const values = new Set();
  const short = new Set();
  const addVal = (v) => {
    if (typeof v !== 'string' || v.length === 0) return;
    if (v.length >= 3 && canonicalForMatch(v).length >= 2) {
      values.add(v);
    } else if (v.length >= 2) {
      short.add(v);
    }
  };
  for (const s of secrets) addVal(s);
  if (Array.isArray(state?.elements)) {
    for (const el of state.elements) {
      if (typeof el?.value === 'string' && el.value.length > 0) addVal(el.value);
    }
  }
  if (Array.isArray(state?.recentActions)) {
    for (const action of state.recentActions) {
      if (typeof action?.text === 'string' && action.text.length > 0) addVal(action.text);
      if (Array.isArray(action?.values)) {
        for (const v of action.values) {
          if (typeof v === 'string' && v.length > 0) addVal(v);
        }
      }
    }
  }
  return {
    sensitiveValues: [...values].sort((a, b) => b.length - a.length),
    shortSensitiveValues: [...short],
  };
}

export function collectRequestSensitiveValues(request, { secrets = [] } = {}) {
  const collected = collectSensitiveValues(request?.state, { secrets });
  const descValues = new Set();
  const descShort = new Set();
  if (request?.questions && typeof request.questions === 'object') {
    for (const q of Object.values(request.questions)) {
      if (q?.criteria && typeof q.criteria === 'object') {
        for (const desc of Object.values(q.criteria)) {
          if (typeof desc === 'string' && desc.length > 0) {
            if (desc.length >= 3 && canonicalForMatch(desc).length >= 2) descValues.add(desc);
            else if (desc.length >= 2) descShort.add(desc);
          } else if (Array.isArray(desc)) {
            for (const item of desc) {
              if (typeof item === 'string' && item.length > 0) {
                if (item.length >= 3 && canonicalForMatch(item).length >= 2) descValues.add(item);
                else if (item.length >= 2) descShort.add(item);
              }
            }
          } else if (desc && typeof desc === 'object' && typeof desc.value === 'string' && desc.value.length > 0) {
            if (desc.value.length >= 3 && canonicalForMatch(desc.value).length >= 2) descValues.add(desc.value);
            else if (desc.value.length >= 2) descShort.add(desc.value);
          }
        }
      }
    }
  }
  const allSensitive = [...new Set([...collected.sensitiveValues, ...descValues])].sort((a, b) => b.length - a.length);
  const allShort = [...new Set([...collected.shortSensitiveValues, ...descShort])];
  return {
    sensitiveValues: allSensitive,
    shortSensitiveValues: allShort,
    descriptorValues: [...descValues],
    descriptorShort: [...descShort],
    patternStrings: [],
    patternShort: [],
  };
}

function isVWordString(str) {
  if (typeof str !== 'string') return false;
  const norm = str.normalize('NFKC').toLowerCase();
  const tokens = norm.match(/[\p{L}\p{M}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return false;
  return tokens.every((token) => V_SET.has(token));
}

export function isValidCriteriaKey(key, elementRefs = new Set(), refMap = new Map()) {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (/^e\d+$/u.test(key)) {
    return refMap.has(key) || elementRefs.has(key);
  }
  const mappedKey = refMap.has(key) ? refMap.get(key) : key;
  if (STRUCTURAL_CRITERIA_KEYS.has(mappedKey)) return true;
  if (refMap.has(key)) return true;
  if (elementRefs.has(key)) return true;
  if (typeof mappedKey === 'string' && mappedKey.length > 0 && projectFreeText(mappedKey) === mappedKey) return true;
  return false;
}

function projectCaptchaEvidence(ce) {
  if (!ce || typeof ce !== 'object' || Array.isArray(ce)) return;
  if (typeof ce.sitekey === 'string') {
    ce.sitekey = ce.sitekey.length > 0 ? `sha256:${sha256Hex(ce.sitekey)}` : '';
  } else if (ce.sitekey !== undefined && ce.sitekey !== null) {
    ce.sitekey = '';
  }
  for (const field of ['fingerprint', 'evidence', 'action']) {
    if (typeof ce[field] === 'string') {
      ce[field] = projectFreeText(ce[field]);
    } else if (ce[field] !== undefined && ce[field] !== null) {
      ce[field] = '';
    }
  }
}

export function redactState(state, { secrets = [], refMap = new Map(), newRefToOld = new Map() } = {}) {
  if (refMap && typeof refMap === 'object') {
    refMap.newRefToOld = newRefToOld;
  }
  if (!state || typeof state !== 'object') return state;
  const out = safeClone(state);
  if (typeof out.urlOrigin === 'string') {
    out.urlOrigin = toOriginOnly(out.urlOrigin);
  } else if (out.urlOrigin !== undefined && out.urlOrigin !== null) {
    out.urlOrigin = '';
  }
  if (typeof out.goal === 'string') {
    out.goal = redactString(out.goal, secrets);
  } else if (out.goal !== undefined && out.goal !== null) {
    out.goal = '';
  }
  if (Array.isArray(out.elements)) {
    out.elements = out.elements.map((el) => (el && typeof el === 'object' ? safeClone(el) : el));
    for (let i = 0; i < out.elements.length; i++) {
      const el = out.elements[i];
      if (!el || typeof el !== 'object') continue;
      const oldRef = el.ref;
      const newRef = `e${i + 1}`;
      if (typeof oldRef === 'string') {
        if (!refMap.has(oldRef)) {
          refMap.set(oldRef, newRef);
        }
        newRefToOld.set(newRef, oldRef);
      } else {
        newRefToOld.set(newRef, oldRef ?? '');
      }
    }
    for (let i = 0; i < out.elements.length; i++) {
      const el = out.elements[i];
      if (!el || typeof el !== 'object') continue;
      const newRef = `e${i + 1}`;
      el.ref = newRef;
      el.role = isStandardRole(el.role) ? normLabel(el.role).trim().toLowerCase() : 'generic';
      el.name = typeof el.name === 'string' ? projectFreeText(el.name) : '';
      if (typeof el.value === 'boolean') {
        // preserve boolean
      } else if (typeof el.value === 'string') {
        el.value = el.value.length > 0 ? REDACTED : '';
      } else if (el.value === undefined || el.value === null) {
        // preserve undefined or null
      } else {
        el.value = REDACTED;
      }
      if (Array.isArray(el.parentContext)) {
        el.parentContext = el.parentContext.map((c) => (typeof c === 'string' ? projectFreeText(c) : ''));
      }
      if (el.captchaEvidence && typeof el.captchaEvidence === 'object') {
        projectCaptchaEvidence(el.captchaEvidence);
      }
    }
  }
  if (Array.isArray(out.recentActions)) {
    out.recentActions = out.recentActions.map((act) => (act && typeof act === 'object' ? safeClone(act) : act));
    for (const action of out.recentActions) {
      if (!action || typeof action !== 'object') continue;
      if (typeof action.targetRef === 'string' && refMap.has(action.targetRef)) {
        action.targetRef = refMap.get(action.targetRef);
      } else {
        delete action.targetRef;
      }
      if (typeof action.text === 'string') {
        action.text = action.text.length > 0 ? REDACTED : '';
      } else if (action.text !== undefined && action.text !== null) {
        action.text = REDACTED;
      }
      if (Array.isArray(action.values)) {
        action.values = action.values.map((v) => {
          if (typeof v === 'string') return v.length > 0 ? REDACTED : '';
          if (v === undefined || v === null || typeof v === 'boolean') return v;
          return REDACTED;
        });
      }
    }
  }
  if (out.captchaEvidence && typeof out.captchaEvidence === 'object') {
    projectCaptchaEvidence(out.captchaEvidence);
  }
  return out;
}

export function redactQuestions(questions, { secrets = [], elementRefs = new Set(), refMap = new Map() } = {}) {
  if (!questions || typeof questions !== 'object') return questions;
  const out = {};
  for (const [qId, q] of Object.entries(questions)) {
    const qClone = q && typeof q === 'object' ? safeClone(q) : q;
    Object.defineProperty(out, qId, {
      value: qClone,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const [qId, q] of Object.entries(out)) {
    if (!q || typeof q !== 'object') continue;
    if (q.instructions && typeof q.instructions === 'object') {
      const newInstructions = {};
      for (const [k, v] of Object.entries(q.instructions)) {
        let val = '';
        if (typeof v === 'string') {
          val = redactString(v, secrets);
        }
        Object.defineProperty(newInstructions, k, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      q.instructions = newInstructions;
    }
    if (q.criteria && typeof q.criteria === 'object') {
      const newCriteria = {};
      const seenMappedKeys = new Set();
      for (const [key, desc] of Object.entries(q.criteria)) {
        if (!isValidCriteriaKey(key, elementRefs, refMap)) {
          throw new AiCliError('JEV_REQUEST_INVALID', 'criteria key is outside the allowed vocabulary', {
            details: { key: '[REDACTED-KEY]' },
          });
        }
        const mappedKey = refMap.has(key) ? refMap.get(key) : key;
        if (seenMappedKeys.has(mappedKey)) {
          throw new AiCliError('JEV_REQUEST_INVALID', 'criteria key collides with a remapped ref', {
            details: { key: '[REDACTED-KEY]' },
          });
        }
        seenMappedKeys.add(mappedKey);
        let mappedDesc;
        if (desc === null || desc === undefined) {
          mappedDesc = desc;
        } else if (typeof desc === 'boolean') {
          mappedDesc = desc;
        } else if (typeof desc === 'string') {
          mappedDesc = desc.length > 0 ? REDACTED : '';
        } else if (Array.isArray(desc)) {
          mappedDesc = desc.map((item) => {
            if (typeof item === 'string') return item.length > 0 ? REDACTED : '';
            if (item === null || item === undefined || typeof item === 'boolean') return item;
            return REDACTED;
          });
        } else if (desc && typeof desc === 'object') {
          const newDesc = { ...desc };
          newDesc.role = isStandardRole(newDesc.role) ? normLabel(newDesc.role).trim().toLowerCase() : 'generic';
          newDesc.name = typeof newDesc.name === 'string' ? projectFreeText(newDesc.name) : '';
          if (typeof newDesc.value === 'boolean') {
            // keep boolean
          } else if (typeof newDesc.value === 'string') {
            newDesc.value = newDesc.value.length > 0 ? REDACTED : '';
          } else if (newDesc.value === undefined || newDesc.value === null) {
            // keep undefined or null
          } else {
            newDesc.value = REDACTED;
          }
          if (typeof newDesc.ref === 'string') {
            if (refMap.has(newDesc.ref)) {
              newDesc.ref = refMap.get(newDesc.ref);
            } else {
              delete newDesc.ref;
            }
          } else if (newDesc.ref !== undefined) {
            delete newDesc.ref;
          }
          mappedDesc = newDesc;
        } else {
          mappedDesc = REDACTED;
        }
        Object.defineProperty(newCriteria, mappedKey, {
          value: mappedDesc,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      q.criteria = newCriteria;
    }
  }
  return out;
}

export function redactRequest(request, { secrets = [], refMap = new Map(), newRefToOld = new Map() } = {}) {
  if (refMap && typeof refMap === 'object') {
    refMap.newRefToOld = newRefToOld;
  }
  const out = safeClone(request ?? {});
  const { sensitiveValues, shortSensitiveValues } = collectRequestSensitiveValues(request, { secrets });
  const allSecrets = [...new Set([...secrets, ...sensitiveValues])];
  const rawElementRefs = Array.isArray(request?.state?.elements)
    ? request.state.elements.map((el) => el?.ref).filter((r) => typeof r === 'string')
    : [];

  // Z2: 1. Ids never sent on wire (requestId, runId, permitId, questionSet.id) are not screened at all.
  // 2. Question ids (which ARE sent) are screened against declared secrets (substring),
  // built-in token/email patterns, and page-derived values by exact canonical equality only.
  if (request?.questions && typeof request.questions === 'object') {
    const qKeyOpts = {
      sensitiveValues,
      shortValues: shortSensitiveValues,
      secrets: Array.isArray(secrets) ? secrets : [],
      exact: true,
    };
    for (const id of Object.keys(request.questions)) {
      assertSafeKey(id, qKeyOpts);
    }
  }

  if (out.state && typeof out.state === 'object') {
    out.state = redactState(out.state, { secrets: allSecrets, refMap, newRefToOld });
  }
  const elementRefSet = new Set(rawElementRefs);
  if (out.questions && typeof out.questions === 'object') {
    out.questions = redactQuestions(out.questions, { secrets: allSecrets, elementRefs: elementRefSet, refMap });
  }
  const rawCallerProse = [];
  if (typeof request?.state?.goal === 'string' && request.state.goal.length > 0) {
    rawCallerProse.push(request.state.goal);
  }
  if (request?.questions && typeof request.questions === 'object') {
    for (const q of Object.values(request.questions)) {
      if (q?.instructions && typeof q.instructions === 'object') {
        for (const v of Object.values(q.instructions)) {
          if (typeof v === 'string' && v.length > 0) rawCallerProse.push(v);
        }
      }
    }
  }
  const callerProse = [];
  if (typeof out.state?.goal === 'string' && out.state.goal.length > 0) {
    callerProse.push(out.state.goal);
  }
  if (out.questions && typeof out.questions === 'object') {
    for (const q of Object.values(out.questions)) {
      if (q?.instructions && typeof q.instructions === 'object') {
        for (const v of Object.values(q.instructions)) {
          if (typeof v === 'string' && v.length > 0) callerProse.push(v);
        }
      }
    }
  }
  const declaredSensitive = [];
  const declaredShort = [];
  for (const s of (Array.isArray(secrets) ? secrets : [])) {
    if (typeof s !== 'string' || s.length < 2) continue;
    if (s.length >= 3 && canonicalForMatch(s).length >= 2) {
      declaredSensitive.push(s);
    } else {
      declaredShort.push(s);
    }
  }
  assertNoShortEcho(rawCallerProse, declaredShort);
  assertNoPayloadReassembly(callerProse, declaredSensitive, declaredShort);
  return out;
}

export const isKnownSafeEntry = () => false;
