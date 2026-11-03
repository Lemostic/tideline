/**
 * 导入模板生成（V0.15.0）
 *
 * 生成一个可直接填写的 .xlsx 模板：
 * - 「任务」工作表：8 列表头 + 冻结首行 + 优先级下拉 + 字段批注；
 * - 「填写说明」工作表：字段解释与取值范围。
 *
 * exceljs 体积不小，用动态 import 按需加载——只在用户点「下载模板」时才拉进来，
 * 不进应用主包。
 */

import type { Workbook as ExcelJsWorkbook } from 'exceljs';

/** 模板文件名 */
export const TEMPLATE_FILE_NAME = '潮线看板导入模板.xlsx';

/** 模板工作表名：读取时优先选这张表 */
export const TEMPLATE_SHEET_NAME = '任务';

/** 表头样式：深色底、白字、加粗 */
const HEADER_FILL = 'FF2F3B4C';
const HEADER_FONT = 'FFFFFFFF';
const NOTE_COLOR = 'FF8A94A6';
const GUIDE_TITLE_COLOR = 'FF2F3B4C';

interface TemplateColumn {
  header: string;
  width: number;
  note: string;
  required: boolean;
  example: string;
}

/** 模板的 8 个字段，顺序即列顺序 */
export const TEMPLATE_COLUMNS: TemplateColumn[] = [
  {
    header: '任务标题',
    width: 30,
    required: true,
    note: '任务名称。这一列必须保留，空标题的行会被跳过。',
    example: '登录页联调',
  },
  {
    header: '所属列',
    width: 14,
    required: false,
    note: '看板列名。留空默认进「待办」；同名会合并成同一列，列的顺序按首次出现的先后。',
    example: '进行中',
  },
  {
    header: '描述',
    width: 38,
    required: false,
    note: '任务详情，支持多行。',
    example: '与后端对齐登录接口字段',
  },
  {
    header: '开始日期',
    width: 14,
    required: false,
    note: '甘特图起始日期。支持 2026-11-03、2026/11/3、2026年11月3日、今天/明天。',
    example: '2026-11-03',
  },
  {
    header: '截止日期',
    width: 14,
    required: false,
    note: '截止日期，写法同上。',
    example: '2026-11-08',
  },
  {
    header: '优先级',
    width: 10,
    required: false,
    note: '高 / 中 / 低。也认 high、medium、low、P0、P1、P2。',
    example: '高',
  },
  {
    header: '标签',
    width: 20,
    required: false,
    note: '多个标签用逗号分隔，中英文逗号、顿号、分号都可以。',
    example: '前端,联调',
  },
  {
    header: '预估工时(分钟)',
    width: 16,
    required: false,
    note: '单位分钟。也认 1.5h、2小时、1天（=480 分钟）。',
    example: '90',
  },
];

/** 动态加载 exceljs，兼容 CJS 打包产物的 default 形态 */
async function loadExcelJs(): Promise<new () => ExcelJsWorkbook> {
  const mod = (await import('exceljs')) as unknown as {
    default?: { Workbook?: new () => ExcelJsWorkbook };
    Workbook?: new () => ExcelJsWorkbook;
  };
  const ctor = mod.Workbook ?? mod.default?.Workbook;
  if (!ctor) throw new Error('Excel 组件加载失败，请重启应用再试');
  return ctor;
}

/** 生成模板文件字节 */
export async function buildTemplateBytes(): Promise<Uint8Array> {
  const WorkbookCtor = await loadExcelJs();
  const workbook = new WorkbookCtor();

  buildTaskSheet(workbook);
  buildGuideSheet(workbook);

  const raw = (await workbook.xlsx.writeBuffer()) as unknown;
  return raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
}

/** 「任务」工作表：表头 + 一个空行占位 */
function buildTaskSheet(workbook: ExcelJsWorkbook): void {
  const sheet = workbook.addWorksheet(TEMPLATE_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  TEMPLATE_COLUMNS.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });

  const header = sheet.getRow(1);
  TEMPLATE_COLUMNS.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.value = column.header;
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.note = column.note;
  });
  header.height = 22;

  // 第 2 行留一个带格式的空行，用户直接往里写
  for (let index = 1; index <= TEMPLATE_COLUMNS.length; index += 1) {
    sheet.getRow(2).getCell(index).border = {
      bottom: { style: 'hair', color: { argb: 'FFD6DBE1' } },
    };
  }

  // 优先级列给个下拉，少打错字
  for (let row = 2; row <= 500; row += 1) {
    sheet.getCell(`F${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"高,中,低"'],
    };
  }
}

/** 「填写说明」工作表 */
function buildGuideSheet(workbook: ExcelJsWorkbook): void {
  const sheet = workbook.addWorksheet('填写说明');
  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 10;
  sheet.getColumn(3).width = 62;
  sheet.getColumn(4).width = 20;

  const title = sheet.getCell('A1');
  title.value = '潮线看板导入模板 · 填写说明';
  title.font = { bold: true, size: 14, color: { argb: GUIDE_TITLE_COLOR } };
  sheet.mergeCells('A1:D1');

  const intro = sheet.getCell('A2');
  intro.value = '在「任务」工作表里按下面的表头填写，第 2 行起逐行写任务，然后回到应用里导入即可。';
  intro.font = { size: 11, color: { argb: NOTE_COLOR } };
  sheet.mergeCells('A2:D2');

  const header = sheet.getRow(4);
  ['列名', '是否必填', '说明', '示例'].forEach((text, index) => {
    const cell = header.getCell(index + 1);
    cell.value = text;
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  TEMPLATE_COLUMNS.forEach((column, index) => {
    const row = sheet.getRow(5 + index);
    row.getCell(1).value = column.header;
    row.getCell(2).value = column.required ? '必填' : '选填';
    row.getCell(3).value = column.note;
    row.getCell(4).value = column.example;
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  });

  const notes: Array<[string, string]> = [
    ['日期写法', '2026-11-03、2026/11/3、2026.11.3、2026年11月3日、今天、明天都认；认不出来就留空。'],
    ['所属列', '留空默认进「待办」；同一个列名会合并成一列，列顺序按第一次出现的先后。'],
    ['优先级', '高 / 中 / 低，或 high / medium / low，或 P0 / P1 / P2。'],
    ['预估工时', '默认单位是分钟，也可以写 1.5h、2小时、1天。'],
    ['标签', '多个标签用逗号分隔：前端,联调。'],
    ['空行', '整行空着会被忽略；填了别的内容但没填标题，这一行会被跳过并在预览里标出来。'],
  ];

  const notesStart = 5 + TEMPLATE_COLUMNS.length + 2;
  const notesTitle = sheet.getCell(`A${notesStart}`);
  notesTitle.value = '常见问题';
  notesTitle.font = { bold: true, size: 12, color: { argb: GUIDE_TITLE_COLOR } };

  notes.forEach(([label, text], index) => {
    const row = sheet.getRow(notesStart + 1 + index);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true };
    row.getCell(3).value = text;
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  });
}
