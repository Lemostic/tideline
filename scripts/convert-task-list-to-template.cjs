/**
 * 把外部任务清单（Excel）转换成潮线导入模板格式。
 *
 * 用法：
 *   node scripts/convert-task-list-to-template.cjs <源文件.xlsx> <输出文件.xlsx>
 *
 * 默认按「细分优先级2未完成任务清单」的表头识别列：
 *   模块 / 任务项 | 功能点（最细粒度） | 前后端 | 当前进度 | 备注
 *
 * 映射规则：
 * - 任务标题  ← 功能点（最细粒度）
 * - 所属列    ← 模块 / 任务项（去掉「（N项）」后缀；合并单元格向下补齐）
 * - 描述      ← 当前进度 + 备注
 * - 标签      ← 前后端
 * - 优先级 / 起止日期 / 预估工时  ← 原表没有，留空
 *
 * 输出文件的工作表结构与应用内「下载 Excel 模板」一致：
 * 「任务」表（表头 + 数据）、「填写说明」表，并保留原表的「统计摘要」表。
 */
const ExcelJS = require('exceljs');

const source = process.argv[2];
const target = process.argv[3];

/** 去掉「（4项）」这类后缀，列名更干净 */
function cleanListName(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  return text.replace(/[（(]\s*\d+\s*项\s*[)）]\s*$/, '').trim() || text;
}

/** 百分比进度 → 文本 */
function progressText(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number') return `${Math.round(raw)}%`;
  const text = String(raw).trim();
  if (!text) return '';
  if (/^\d+(\.\d+)?$/.test(text)) return `${Math.round(Number(text))}%`;
  return text;
}

(async () => {
  const sourceWb = new ExcelJS.Workbook();
  await sourceWb.xlsx.readFile(source);
  const sheet = sourceWb.getWorksheet('未完成任务清单') ?? sourceWb.worksheets[0];

  // 定位表头行：包含「功能点」的那一行
  let headerRow = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, 10); r += 1) {
    const values = [];
    for (let c = 1; c <= sheet.columnCount; c += 1) values.push(String(sheet.getRow(r).getCell(c).text ?? ''));
    if (values.some((v) => v.includes('功能点'))) {
      headerRow = r;
      break;
    }
  }
  if (!headerRow) throw new Error('没找到表头行（应含「功能点」列）');

  const colIndex = (keyword) => {
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      const text = String(sheet.getRow(headerRow).getCell(c).text ?? '').trim();
      if (text.includes(keyword)) return c;
    }
    return 0;
  };

  const colModule = colIndex('模块');
  const colTitle = colIndex('功能点');
  const colSide = colIndex('前后端');
  const colProgress = colIndex('当前进度');
  const colRemark = colIndex('备注');
  if (!colTitle) throw new Error('没找到「功能点」列');

  const rows = [];
  let lastModule = '';
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const title = String(row.getCell(colTitle).text ?? '').trim();
    if (!title) continue;

    // 模块列可能是合并单元格，空值时沿用上一行
    const rawModule = String(row.getCell(colModule).text ?? '').trim();
    if (rawModule) lastModule = rawModule;
    const listTitle = cleanListName(rawModule || lastModule) || '待办';

    const progress = progressText(row.getCell(colProgress).value);
    const remark = String(row.getCell(colRemark).text ?? '').trim();
    const side = String(row.getCell(colSide).text ?? '').trim();

    const description = [progress ? `当前进度：${progress}` : '', remark]
      .filter(Boolean)
      .join('\n');

    rows.push({
      title,
      listTitle,
      description,
      labels: side ? [side] : [],
    });
  }

  // ---- 写出潮线导入模板格式 ----
  const out = new ExcelJS.Workbook();
  const task = out.addWorksheet('任务', { views: [{ state: 'frozen', ySplit: 1 }] });

  const headers = [
    '任务标题',
    '所属列',
    '描述',
    '开始日期',
    '截止日期',
    '优先级',
    '标签',
    '预估工时(分钟)',
  ];
  const widths = [46, 22, 34, 14, 14, 10, 12, 16];
  headers.forEach((text, index) => {
    task.getColumn(index + 1).width = widths[index];
  });

  const header = task.getRow(1);
  headers.forEach((text, index) => {
    const cell = header.getCell(index + 1);
    cell.value = text;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F3B4C' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  header.height = 22;

  rows.forEach((item, index) => {
    const row = task.getRow(2 + index);
    row.getCell(1).value = item.title;
    row.getCell(2).value = item.listTitle;
    row.getCell(3).value = item.description;
    row.getCell(7).value = item.labels.join(',');
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    for (let c = 1; c <= 8; c += 1) {
      row.getCell(c).border = { bottom: { style: 'hair', color: { argb: 'FFD6DBE1' } } };
    }
  });

  // 填写说明
  const guide = out.addWorksheet('填写说明');
  guide.getColumn(1).width = 18;
  guide.getColumn(2).width = 10;
  guide.getColumn(3).width = 62;
  guide.getColumn(4).width = 20;
  const gTitle = guide.getCell('A1');
  gTitle.value = '潮线看板导入模板 · 填写说明';
  gTitle.font = { bold: true, size: 14, color: { argb: 'FF2F3B4C' } };
  guide.mergeCells('A1:D1');
  const gIntro = guide.getCell('A2');
  gIntro.value = '本文件已按潮线导入模板格式转换好，可在应用里直接导入；在「任务」工作表继续追加任务后同样能导入。';
  gIntro.font = { size: 11, color: { argb: 'FF8A94A6' } };
  guide.mergeCells('A2:D2');

  const gHeader = guide.getRow(4);
  ['列名', '是否必填', '说明', '示例'].forEach((text, index) => {
    const cell = gHeader.getCell(index + 1);
    cell.value = text;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F3B4C' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  const guideRows = [
    ['任务标题', '必填', '任务名称。这一列必须保留，空标题的行会被跳过。', '模型数据列表查询搜索'],
    ['所属列', '选填', '看板列名。留空默认进「待办」；同名会合并成同一列，列的顺序按首次出现的先后。', '维护主页面'],
    ['描述', '选填', '任务详情，支持多行。', '当前进度：60%'],
    ['开始日期', '选填', '甘特图起始日期。支持 2026-11-03、2026/11/3、2026年11月3日、今天/明天。', ''],
    ['截止日期', '选填', '截止日期，写法同上。', ''],
    ['优先级', '选填', '高 / 中 / 低。也认 high、medium、low、P0、P1、P2。', ''],
    ['标签', '选填', '多个标签用逗号分隔，中英文逗号、顿号、分号都可以。', '后端'],
    ['预估工时(分钟)', '选填', '单位分钟。也认 1.5h、2小时、1天（=480 分钟）。', ''],
  ];
  guideRows.forEach((cells, index) => {
    const row = guide.getRow(5 + index);
    cells.forEach((value, column) => {
      row.getCell(column + 1).value = value;
    });
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  });

  // 原表的统计摘要原样保留，方便对照
  const summary = sourceWb.getWorksheet('统计摘要');
  if (summary) {
    const copy = out.addWorksheet('统计摘要');
    copy.getColumn(1).width = 30;
    copy.getColumn(2).width = 60;
    for (let r = 1; r <= summary.rowCount; r += 1) {
      for (let c = 1; c <= summary.columnCount; c += 1) {
        const value = summary.getRow(r).getCell(c).value;
        if (value !== null && value !== undefined) {
          copy.getRow(r).getCell(c).value = typeof value === 'object' ? String(value) : value;
        }
      }
    }
  }

  await out.xlsx.writeFile(target);

  const listTitles = [...new Set(rows.map((row) => row.listTitle))];
  console.log('任务数：', rows.length);
  console.log('看板列（按首次出现顺序）：', listTitles.join(' / '));
  console.log('输出：', target);
})();
