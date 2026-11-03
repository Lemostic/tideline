/**
 * Excel / CSV 导入解析层（V0.15.0）
 *
 * 纯函数：只做「表格 → 任务清单」的映射，不依赖 exceljs、不写库、不碰界面。
 * 好处是可以用 vitest 覆盖所有取值规则，改动解析逻辑不必启动应用。
 *
 * 三个概念：
 * - 单元格（ImportCell）：字符串 / 数字 / 布尔 / Date / 空；
 * - 列映射（ImportColumnMap）：表头 → 字段，缺失记 -1；
 * - 解析结果（ImportParseResult）：任务卡片 + 看板列清单 + 错误行 + 警告。
 */

import type { Priority } from './types';

/** 导入文件里的单元格取值 */
export type ImportCell = string | number | boolean | Date | null | undefined;

/** 模板支持的字段 */
export type ImportField =
  | 'title'
  | 'list'
  | 'description'
  | 'startDate'
  | 'dueDate'
  | 'priority'
  | 'labels'
  | 'estimatedMinutes';

/** 列映射；-1 表示该列在文件里不存在 */
export type ImportColumnMap = Record<ImportField, number>;

/** 解析出来的一条任务 */
export interface ParsedImportCard {
  title: string;
  /** 所属看板列名；文件里留空时为「待办」 */
  listTitle: string;
  description: string;
  startDate: string | null;
  dueDate: string | null;
  priority: Priority | null;
  labels: string[];
  estimatedMinutes: number | null;
  /** 文件中的行号（1 起），用于错误提示定位 */
  rowNumber: number;
  /** 该行的非致命提醒（字段没读出来） */
  warnings: string[];
}

/** 一行读不了的问题（缺标题等） */
export interface ImportRowError {
  rowNumber: number;
  reason: string;
}

/** 整个文件的解析结果 */
export interface ImportParseResult {
  columns: ImportColumnMap;
  /** 看板列清单：去重后按首次出现顺序 */
  listTitles: string[];
  cards: ParsedImportCard[];
  errors: ImportRowError[];
  /** 整体级提示（缺列、文件为空等） */
  warnings: string[];
  /** 表头之后的数据行总数（含被跳过的错误行） */
  totalRows: number;
}

/** 缺省看板列名：文件里没写「所属列」时的落点 */
export const DEFAULT_LIST_TITLE = '待办';

/** 字段匹配顺序：先到先得，同一字段以最靠左的表头为准 */
const FIELD_ORDER: ImportField[] = [
  'title',
  'list',
  'description',
  'startDate',
  'dueDate',
  'priority',
  'labels',
  'estimatedMinutes',
];

/**
 * 表头别名表。归一化后比较（见 normalizeHeader）。
 * 精确匹配优先于前缀匹配，所以「任务描述」不会被「任务」抢走。
 */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  title: ['任务标题', '标题', '任务名称', '任务名', '名称', '任务', '事项', '需求'],
  list: ['所属列', '所在列', '看板列', '列表', '分组', '阶段', '状态', '列'],
  description: ['任务描述', '描述', '详情', '说明', '备注', '内容'],
  startDate: ['开始日期', '起始日期', '开始时间', '开始'],
  dueDate: ['截止日期', '结束日期', '交付日期', '到期日', '截止', '结束'],
  priority: ['优先级', '优先度', '紧急度'],
  labels: ['标签列表', '标签'],
  estimatedMinutes: ['预估工时分钟', '预估分钟', '预计工时', '预估工时', '工时', '预估'],
};

/** Excel 序列号的基准日（1900 日期系统，兼容 Excel 的 1900 闰年误差） */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/** 表头归一化：去掉空白、括号、冒号、星号等修饰，只留中文/字母/数字 */
export function normalizeHeader(text: string): string {
  return text
    .replace(/[\s\u3000]/g, '')
    .replace(/[（()）【】\[\]:：*＊#]/g, '')
    .toLowerCase();
}

/** 单元格转文本：兼容 ExcelJS 的富文本、公式、超链接等对象形态 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('result' in record) return cellText(record.result);
    if ('richText' in record && Array.isArray(record.richText)) {
      return record.richText
        .map((part) => {
          const item = part as { text?: unknown };
          return typeof item?.text === 'string' ? item.text : '';
        })
        .join('');
    }
    if ('text' in record) return cellText(record.text);
    if ('error' in record) return '';
  }
  return String(value);
}

/** 组装 YYYY-MM-DD */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 校验年月日是否真实存在 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1970 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
  );
}

/**
 * 解析日期。支持：
 * 原生 Date、Excel 序列号、20261103、2026-11-03、2026/11/3、2026.11.3、
 * 2026年11月3日、11/3（补当年）、ISO 时间戳取日期部分、今天/明天/后天/昨天。
 */
export function parseDateValue(value: ImportCell): { date: string | null; invalid: boolean } {
  if (value === null || value === undefined) return { date: null, invalid: false };

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { date: null, invalid: true };
    return { date: formatDate(value), invalid: false };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { date: null, invalid: true };
    // 20261103 这类紧凑写法
    if (Number.isInteger(value) && value >= 19000101 && value <= 20991231) {
      const year = Math.floor(value / 10000);
      const month = Math.floor((value % 10000) / 100);
      const day = value % 100;
      if (!isRealDate(year, month, day)) return { date: null, invalid: true };
      return { date: formatDate(new Date(year, month - 1, day)), invalid: false };
    }
    // Excel 序列号
    if (value > 0 && value < 100000) {
      const utc = new Date(EXCEL_EPOCH_UTC + Math.round(value) * 86400000);
      return {
        date: `${utc.getUTCFullYear()}-${`${utc.getUTCMonth() + 1}`.padStart(2, '0')}-${`${utc.getUTCDate()}`.padStart(2, '0')}`,
        invalid: false,
      };
    }
    return { date: null, invalid: true };
  }

  const text = String(value).trim();
  if (!text) return { date: null, invalid: false };

  // 20261103 这类紧凑写法（字符串形态）
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return buildDate(+compact[1], +compact[2], +compact[3]);

  const relative = parseRelativeDate(text);
  if (relative) return { date: relative, invalid: false };

  const chinese = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
  if (chinese) return buildDate(+chinese[1], +chinese[2], +chinese[3]);

  const full = /^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/.exec(text);
  if (full) return buildDate(+full[1], +full[2], +full[3]);

  const monthDay = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})$/.exec(text);
  if (monthDay) {
    const month = +monthDay[1];
    const day = +monthDay[2];
    if (!isRealDate(new Date().getFullYear(), month, day)) return { date: null, invalid: true };
    return { date: formatDate(new Date(new Date().getFullYear(), month - 1, day)), invalid: false };
  }

  return { date: null, invalid: true };
}

/** 组装并校验年月日 */
function buildDate(year: number, month: number, day: number): { date: string | null; invalid: boolean } {
  if (!isRealDate(year, month, day)) return { date: null, invalid: true };
  return { date: formatDate(new Date(year, month - 1, day)), invalid: false };
}

/** 相对日期：今天 / 明天 / 后天 / 昨天 */
function parseRelativeDate(text: string): string | null {
  const map: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 后天: 2, 昨天: -1, 昨日: -1 };
  const offset = map[text];
  if (offset === undefined) return null;
  const base = new Date();
  return formatDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset));
}

/**
 * 解析预估工时（分钟）。支持 90、1.5h、2小时、30分钟、30m、1天、1d。
 */
export function parseMinutesValue(value: ImportCell): { minutes: number | null; invalid: boolean } {
  if (value === null || value === undefined) return { minutes: null, invalid: false };

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return { minutes: null, invalid: true };
    return { minutes: Math.round(value), invalid: false };
  }

  const text = String(value).trim();
  if (!text) return { minutes: null, invalid: false };

  const day = /^(\d+(?:\.\d+)?)\s*(天|日|d|day|days)$/i.exec(text);
  if (day) {
    const minutes = Math.round(Number(day[1]) * 480);
    return { minutes, invalid: false };
  }

  const hour = /^(\d+(?:\.\d+)?)\s*(小时|时|h|hr|hour|hours)$/i.exec(text);
  if (hour) {
    const minutes = Math.round(Number(hour[1]) * 60);
    return { minutes, invalid: false };
  }

  const minute = /^(\d+(?:\.\d+)?)\s*(分钟|分|m|min|minute|minutes)?$/i.exec(text);
  if (minute) {
    const minutes = Math.round(Number(minute[1]));
    return { minutes, invalid: false };
  }

  return { minutes: null, invalid: true };
}

const PRIORITY_TABLE: Array<[string, Priority]> = [
  ['高', 'high'],
  ['高优', 'high'],
  ['紧急', 'high'],
  ['最高', 'high'],
  ['重要', 'high'],
  ['high', 'high'],
  ['highest', 'high'],
  ['p0', 'high'],
  ['一级', 'high'],
  ['1', 'high'],
  ['中', 'medium'],
  ['中优', 'medium'],
  ['普通', 'medium'],
  ['一般', 'medium'],
  ['medium', 'medium'],
  ['normal', 'medium'],
  ['p1', 'medium'],
  ['二级', 'medium'],
  ['2', 'medium'],
  ['低', 'low'],
  ['低优', 'low'],
  ['不急', 'low'],
  ['low', 'low'],
  ['lowest', 'low'],
  ['p2', 'low'],
  ['三级', 'low'],
  ['3', 'low'],
];

/** 解析优先级：无法识别时返回 null（不报错） */
export function parsePriorityValue(value: ImportCell): Priority | null {
  const text = cellText(value).trim();
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/[\s\u3000]/g, '');
  for (const [alias, priority] of PRIORITY_TABLE) {
    if (normalized === alias) return priority;
  }
  return null;
}

/** 解析标签：逗号、顿号、分号、竖线、换行都可以分隔 */
export function parseLabelsValue(value: ImportCell): string[] {
  const text = cellText(value);
  if (!text.trim()) return [];
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const part of text.split(/[,，、;；|\n]+/)) {
    const label = part.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/** 表头映射：把一行表头映射到各字段，缺失记 -1 */
export function mapHeaders(headerRow: ImportCell[]): ImportColumnMap {
  const map: ImportColumnMap = {
    title: -1,
    list: -1,
    description: -1,
    startDate: -1,
    dueDate: -1,
    priority: -1,
    labels: -1,
    estimatedMinutes: -1,
  };

  const texts = headerRow.map((cell) => normalizeHeader(cellText(cell)));

  // 第一轮：精确匹配，保证「任务描述」落到描述而不是标题
  texts.forEach((text, index) => {
    if (!text) return;
    for (const field of FIELD_ORDER) {
      if (map[field] !== -1) continue;
      if (HEADER_ALIASES[field].includes(text)) {
        map[field] = index;
        return;
      }
    }
  });

  // 第二轮：前缀匹配，补上「预估工时（分钟）」这类写法
  texts.forEach((text, index) => {
    if (!text) return;
    for (const field of FIELD_ORDER) {
      if (map[field] !== -1) continue;
      if (HEADER_ALIASES[field].some((alias) => text.startsWith(alias))) {
        map[field] = index;
        return;
      }
    }
  });

  return map;
}

/** 整行是否为空 */
function isBlankRow(row: ImportCell[]): boolean {
  return row.every((cell) => {
    if (cell === null || cell === undefined) return true;
    if (cell instanceof Date) return false;
    return cellText(cell).trim() === '';
  });
}

/** 取某列的值 */
function cellAt(row: ImportCell[], index: number): ImportCell {
  if (index < 0) return null;
  return row[index] ?? null;
}

/**
 * 把表格行解析成任务清单。
 *
 * 第一行非空行视作表头；整行为空静默跳过；有内容但没标题记为错误行并跳过；
 * 其他字段读不出来只记警告，任务照常导入。
 */
export function parseImportRows(rows: ImportCell[][]): ImportParseResult {
  const warnings: string[] = [];
  const errors: ImportRowError[] = [];
  const cards: ParsedImportCard[] = [];
  const listTitles: string[] = [];
  const seenLists = new Set<string>();

  let headerIndex = 0;
  while (headerIndex < rows.length && isBlankRow(rows[headerIndex])) headerIndex += 1;

  const emptyColumns: ImportColumnMap = {
    title: -1,
    list: -1,
    description: -1,
    startDate: -1,
    dueDate: -1,
    priority: -1,
    labels: -1,
    estimatedMinutes: -1,
  };

  if (headerIndex >= rows.length) {
    return {
      columns: emptyColumns,
      listTitles: [],
      cards: [],
      errors: [],
      warnings: ['文件里没有可读的内容'],
      totalRows: 0,
    };
  }

  const columns = mapHeaders(rows[headerIndex]);
  if (columns.title === -1) {
    return {
      columns,
      listTitles: [],
      cards: [],
      errors: [],
      warnings: ['未找到任务标题列，请使用模板里的「任务标题」表头'],
      totalRows: 0,
    };
  }

  const missing = FIELD_ORDER.filter((field) => field !== 'title' && columns[field] === -1);
  if (missing.length > 0) {
    const names = missing.map((field) => FIELD_LABELS[field]).join('、');
    warnings.push(`未识别到「${names}」列，这些字段将留空`);
  }

  let totalRows = 0;
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (isBlankRow(row)) continue;
    totalRows += 1;
    const rowNumber = index + 1;

    const title = cellText(cellAt(row, columns.title)).trim();
    if (!title) {
      errors.push({ rowNumber, reason: '缺少任务标题，已跳过这一行' });
      continue;
    }

    const rowWarnings: string[] = [];

    const startDate = parseDateValue(cellAt(row, columns.startDate));
    if (startDate.invalid) rowWarnings.push('开始日期无法识别，已留空');

    const dueDate = parseDateValue(cellAt(row, columns.dueDate));
    if (dueDate.invalid) rowWarnings.push('截止日期无法识别，已留空');

    const minutes = parseMinutesValue(cellAt(row, columns.estimatedMinutes));
    if (minutes.invalid) rowWarnings.push('预估工时无法识别，已留空');

    const listTitle = cellText(cellAt(row, columns.list)).trim() || DEFAULT_LIST_TITLE;
    if (!seenLists.has(listTitle)) {
      seenLists.add(listTitle);
      listTitles.push(listTitle);
    }

    cards.push({
      title,
      listTitle,
      description: cellText(cellAt(row, columns.description)).trim(),
      startDate: startDate.date,
      dueDate: dueDate.date,
      priority: parsePriorityValue(cellAt(row, columns.priority)),
      labels: parseLabelsValue(cellAt(row, columns.labels)),
      estimatedMinutes: minutes.minutes,
      rowNumber,
      warnings: rowWarnings,
    });
  }

  return { columns, listTitles, cards, errors, warnings, totalRows };
}

/** 字段中文名，用于「未找到某列」的提示 */
export const FIELD_LABELS: Record<ImportField, string> = {
  title: '任务标题',
  list: '所属列',
  description: '描述',
  startDate: '开始日期',
  dueDate: '截止日期',
  priority: '优先级',
  labels: '标签',
  estimatedMinutes: '预估工时',
};

/** 解析结果摘要：用于预览区的一句话提示 */
export function summarizeImport(result: ImportParseResult): string {
  const parts = [`${result.listTitles.length} 列`, `${result.cards.length} 个任务`];
  if (result.errors.length > 0) parts.push(`${result.errors.length} 行有问题`);
  const warned = result.cards.filter((card) => card.warnings.length > 0).length;
  if (warned > 0) parts.push(`${warned} 个任务有字段提醒`);
  return parts.join(' · ');
}

/** 嗅探 CSV 分隔符：逗号 / 分号 / 制表符，取出现最多者 */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = sample.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 解析 CSV 文本：支持引号包裹、字段内换行与转义引号（""）。
 * 自动去掉 UTF-8 BOM，并嗅探分隔符。
 */
export function parseCsvText(text: string): ImportCell[][] {
  const content = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(content);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      pushField();
      continue;
    }
    if (char === '\n') {
      pushRow();
      continue;
    }
    if (char === '\r') continue;
    field += char;
  }

  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}
