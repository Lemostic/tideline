/**
 * 导入文件读取（V0.15.0）
 *
 * 把用户选的 .xlsx / .csv 变成「行数组」，交给纯函数层做字段映射。
 * xlsx 走 exceljs 的动态 import，csv 走自带的解析器。
 */

import type { Workbook as ExcelJsWorkbook } from 'exceljs';
import { parseCsvText, type ImportCell } from './excelImport';

/** 单次导入的行数上限，防止误传超大文件把界面卡死 */
export const MAX_IMPORT_ROWS = 5000;

/** 读取结果 */
export interface ImportFileResult {
  fileName: string;
  /** 实际读取的工作表名 */
  sheetName: string;
  rows: ImportCell[][];
}

/** exceljs 的单元格值可能是富文本、公式、超链接，这里归一成基础类型 */
function excelCellValue(value: unknown): ImportCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('richText' in record && Array.isArray(record.richText)) {
      return record.richText
        .map((part) => {
          const item = part as { text?: unknown };
          return typeof item?.text === 'string' ? item.text : '';
        })
        .join('');
    }
    if ('result' in record) return excelCellValue(record.result);
    if ('error' in record) return null;
    if ('text' in record) return excelCellValue(record.text);
  }
  return String(value);
}

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

/** 读取导入文件 */
export async function readImportFile(file: File): Promise<ImportFileResult> {
  const name = file.name ?? '';
  const extension = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';

  if (extension === 'csv') {
    const text = await file.text();
    const rows = parseCsvText(text);
    assertRowLimit(rows.length);
    return { fileName: name, sheetName: 'CSV', rows };
  }

  if (extension === 'xls') {
    throw new Error('暂不支持 .xls 老格式，请在 Excel 里另存为 .xlsx 或 .csv 后再导入');
  }

  if (extension !== 'xlsx') {
    throw new Error('请选择 .xlsx 或 .csv 文件');
  }

  const buffer = await file.arrayBuffer();
  const WorkbookCtor = await loadExcelJs();
  const workbook = new WorkbookCtor();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.getWorksheet('任务') ?? workbook.worksheets[0];
  if (!sheet) throw new Error('这个 Excel 里没有可读的工作表');

  const width = sheet.columnCount ?? 0;
  const rows: ImportCell[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    if (rows.length > MAX_IMPORT_ROWS) return;
    const values: ImportCell[] = [];
    for (let index = 1; index <= width; index += 1) {
      values.push(excelCellValue(row.getCell(index).value));
    }
    rows.push(values);
  });

  assertRowLimit(rows.length);

  return { fileName: name, sheetName: sheet.name, rows };
}

/** 行数上限校验 */
function assertRowLimit(count: number): void {
  if (count > MAX_IMPORT_ROWS + 1) {
    throw new Error(`文件超过 ${MAX_IMPORT_ROWS} 行，请拆分后再导入`);
  }
}
