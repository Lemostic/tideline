import { describe, expect, it } from 'vitest';
import type { Workbook as ExcelJsWorkbook } from 'exceljs';
import { parseImportRows } from '@/lib/excelImport';
import { readImportFile } from '@/lib/excelFile';
import { buildTemplateBytes, TEMPLATE_SHEET_NAME } from '@/lib/excelTemplate';

/**
 * 端到端管道测试：模板生成 → 填数据 → 读文件 → 解析成任务清单。
 * 覆盖前端 exceljs 动态加载、表头映射与字段解析的整条链路。
 */
async function loadExcelJs(): Promise<new () => ExcelJsWorkbook> {
  const mod = (await import('exceljs')) as unknown as {
    default?: { Workbook?: new () => ExcelJsWorkbook };
    Workbook?: new () => ExcelJsWorkbook;
  };
  const ctor = mod.Workbook ?? mod.default?.Workbook;
  if (!ctor) throw new Error('exceljs 加载失败');
  return ctor;
}

describe('Excel 导入管道', () => {
  it('模板内容正确：表头、说明页与优先级下拉', async () => {
    const bytes = await buildTemplateBytes();
    const ExcelJs = await loadExcelJs();
    const workbook = new ExcelJs();
    await workbook.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );

    const task = workbook.getWorksheet(TEMPLATE_SHEET_NAME);
    expect(task).toBeTruthy();
    expect(task?.getRow(1).getCell(1).value).toBe('任务标题');
    expect(task?.getRow(1).getCell(8).value).toBe('预估工时(分钟)');
    // 优先级列带下拉，避免用户填错
    expect(task?.getCell('F2').dataValidation.type).toBe('list');
    // 表头冻结，滚动时始终可见
    expect(task?.views?.[0]?.state).toBe('frozen');

    const guide = workbook.getWorksheet('填写说明');
    expect(guide).toBeTruthy();
    expect(guide?.getCell('A1').value).toContain('导入模板');
  });

  it('模板能生成、能填数据、能被读回并解析成任务', async () => {
    // 1. 生成模板
    const bytes = await buildTemplateBytes();
    expect(bytes.byteLength).toBeGreaterThan(1000);

    // 2. 用模板里的工作表填数据（模拟用户在 Excel 里填写）
    const ExcelJs = await loadExcelJs();
    const workbook = new ExcelJs();
    const sheet = workbook.addWorksheet(TEMPLATE_SHEET_NAME);
    sheet.getRow(1).getCell(1).value = '任务标题';
    sheet.getRow(1).getCell(2).value = '所属列';
    sheet.getRow(1).getCell(3).value = '描述';
    sheet.getRow(1).getCell(4).value = '开始日期';
    sheet.getRow(1).getCell(5).value = '截止日期';
    sheet.getRow(1).getCell(6).value = '优先级';
    sheet.getRow(1).getCell(7).value = '标签';
    sheet.getRow(1).getCell(8).value = '预估工时(分钟)';

    sheet.getRow(2).getCell(1).value = '登录页联调';
    sheet.getRow(2).getCell(2).value = '进行中';
    sheet.getRow(2).getCell(3).value = '与后端对齐字段';
    sheet.getRow(2).getCell(4).value = '2026-11-03';
    sheet.getRow(2).getCell(5).value = '2026-11-08';
    sheet.getRow(2).getCell(6).value = '高';
    sheet.getRow(2).getCell(7).value = '前端,联调';
    sheet.getRow(2).getCell(8).value = 90;

    sheet.getRow(3).getCell(1).value = '接口联调';
    sheet.getRow(3).getCell(2).value = '进行中';
    sheet.getRow(3).getCell(5).value = '2026/11/9';
    sheet.getRow(3).getCell(6).value = 'P1';
    sheet.getRow(3).getCell(8).value = '1.5h';

    sheet.getRow(4).getCell(1).value = '写文档';
    sheet.getRow(4).getCell(2).value = '待办';

    // 故意留一行有内容但没标题
    sheet.getRow(5).getCell(2).value = '待办';
    sheet.getRow(5).getCell(3).value = '只有描述没有标题';

    const buffer = (await workbook.xlsx.writeBuffer()) as unknown;
    const filled = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as ArrayBuffer);

    // 3. 当作上传文件读回来
    const file = new File([filled], '任务清单.xlsx');
    const loaded = await readImportFile(file);
    expect(loaded.sheetName).toBe(TEMPLATE_SHEET_NAME);

    // 4. 解析成任务清单
    const parsed = parseImportRows(loaded.rows);
    expect(parsed.listTitles).toEqual(['进行中', '待办']);
    expect(parsed.cards).toHaveLength(3);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].rowNumber).toBe(5);

    expect(parsed.cards[0]).toMatchObject({
      title: '登录页联调',
      listTitle: '进行中',
      description: '与后端对齐字段',
      startDate: '2026-11-03',
      dueDate: '2026-11-08',
      priority: 'high',
      labels: ['前端', '联调'],
      estimatedMinutes: 90,
    });
    expect(parsed.cards[1].dueDate).toBe('2026-11-09');
    expect(parsed.cards[1].priority).toBe('medium');
    expect(parsed.cards[1].estimatedMinutes).toBe(90);
    expect(parsed.cards[2].listTitle).toBe('待办');
  });

  it('CSV 也能读出同样的结构', async () => {
    const csv = [
      '任务标题,所属列,截止日期,优先级',
      '登录页联调,进行中,2026-11-08,高',
      '写文档,待办,,',
    ].join('\n');
    const file = new File([`\uFEFF${csv}`], '任务清单.csv', { type: 'text/csv' });
    const loaded = await readImportFile(file);
    const parsed = parseImportRows(loaded.rows);

    expect(parsed.listTitles).toEqual(['进行中', '待办']);
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[0].dueDate).toBe('2026-11-08');
    expect(parsed.cards[0].priority).toBe('high');
  });

  it('不支持的格式给出明确提示', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], '老表格.xls');
    await expect(readImportFile(file)).rejects.toThrow('.xls');
  });
});
