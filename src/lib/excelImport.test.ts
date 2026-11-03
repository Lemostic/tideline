import { describe, expect, it } from 'vitest';
import {
  cellText,
  detectDelimiter,
  mapHeaders,
  normalizeHeader,
  parseCsvText,
  parseDateValue,
  parseImportRows,
  parseLabelsValue,
  parseMinutesValue,
  parsePriorityValue,
  summarizeImport,
} from '@/lib/excelImport';

describe('normalizeHeader', () => {
  it('去掉空白、括号与冒号', () => {
    expect(normalizeHeader('预估工时(分钟)')).toBe('预估工时分钟');
    expect(normalizeHeader(' 任务标题 ')).toBe('任务标题');
    expect(normalizeHeader('所属列：')).toBe('所属列');
    expect(normalizeHeader('任务标题*')).toBe('任务标题');
  });
});

describe('mapHeaders', () => {
  it('按标准表头映射各列', () => {
    const map = mapHeaders(['任务标题', '所属列', '描述', '开始日期', '截止日期', '优先级', '标签', '预估工时(分钟)']);
    expect(map).toEqual({
      title: 0,
      list: 1,
      description: 2,
      startDate: 3,
      dueDate: 4,
      priority: 5,
      labels: 6,
      estimatedMinutes: 7,
    });
  });

  it('缺少的列记为 -1', () => {
    const map = mapHeaders(['标题', '备注']);
    expect(map.title).toBe(0);
    expect(map.description).toBe(1);
    expect(map.dueDate).toBe(-1);
  });

  it('同一字段以最靠左的表头为准', () => {
    const map = mapHeaders(['标题', '任务名称']);
    expect(map.title).toBe(0);
  });

  it('「任务描述」归到描述而不是标题', () => {
    const map = mapHeaders(['任务标题', '任务描述']);
    expect(map.title).toBe(0);
    expect(map.description).toBe(1);
  });

  it('容忍常见别名', () => {
    const map = mapHeaders(['名称', '列表', '到期日', '紧急度', '标签列表', '工时']);
    expect(map.title).toBe(0);
    expect(map.list).toBe(1);
    expect(map.dueDate).toBe(2);
    expect(map.priority).toBe(3);
    expect(map.labels).toBe(4);
    expect(map.estimatedMinutes).toBe(5);
  });
});

describe('parseDateValue', () => {
  it('原生日期按本地时区取年月日', () => {
    expect(parseDateValue(new Date(2026, 10, 3))).toEqual({ date: '2026-11-03', invalid: false });
  });

  it('支持多种分隔符与中文写法', () => {
    expect(parseDateValue('2026-11-03').date).toBe('2026-11-03');
    expect(parseDateValue('2026/11/3').date).toBe('2026-11-03');
    expect(parseDateValue('2026.11.3').date).toBe('2026-11-03');
    expect(parseDateValue('2026年11月3日').date).toBe('2026-11-03');
    expect(parseDateValue('20261103').date).toBe('2026-11-03');
    expect(parseDateValue('2026-11-03T10:00:00Z').date).toBe('2026-11-03');
  });

  it('缺年份时补当年', () => {
    const year = new Date().getFullYear();
    expect(parseDateValue('11/3').date).toBe(`${year}-11-03`);
  });

  it('支持 Excel 序列号', () => {
    const serial = Math.round((Date.UTC(2026, 10, 3) - Date.UTC(1899, 11, 30)) / 86400000);
    expect(parseDateValue(serial).date).toBe('2026-11-03');
  });

  it('空值不算错误，无法识别的值算错误', () => {
    expect(parseDateValue('')).toEqual({ date: null, invalid: false });
    expect(parseDateValue(null)).toEqual({ date: null, invalid: false });
    expect(parseDateValue('不是日期')).toEqual({ date: null, invalid: true });
    expect(parseDateValue('2026-13-40')).toEqual({ date: null, invalid: true });
  });
});

describe('parseMinutesValue', () => {
  it('支持多种工时写法', () => {
    expect(parseMinutesValue(90).minutes).toBe(90);
    expect(parseMinutesValue('90').minutes).toBe(90);
    expect(parseMinutesValue('1.5h').minutes).toBe(90);
    expect(parseMinutesValue('2小时').minutes).toBe(120);
    expect(parseMinutesValue('30分钟').minutes).toBe(30);
    expect(parseMinutesValue('1天').minutes).toBe(480);
  });

  it('空值与非法值区分处理', () => {
    expect(parseMinutesValue('')).toEqual({ minutes: null, invalid: false });
    expect(parseMinutesValue('待定')).toEqual({ minutes: null, invalid: true });
  });
});

describe('parsePriorityValue', () => {
  it('识别中文、英文与编号写法', () => {
    expect(parsePriorityValue('高')).toBe('high');
    expect(parsePriorityValue('紧急')).toBe('high');
    expect(parsePriorityValue('P0')).toBe('high');
    expect(parsePriorityValue('1')).toBe('high');
    expect(parsePriorityValue('普通')).toBe('medium');
    expect(parsePriorityValue('medium')).toBe('medium');
    expect(parsePriorityValue('P1')).toBe('medium');
    expect(parsePriorityValue('低')).toBe('low');
    expect(parsePriorityValue('p2')).toBe('low');
  });

  it('无法识别时返回 null', () => {
    expect(parsePriorityValue('随便')).toBeNull();
    expect(parsePriorityValue('')).toBeNull();
  });
});

describe('parseLabelsValue', () => {
  it('支持多种分隔符并去重', () => {
    expect(parseLabelsValue('前端，联调; 后端、前端')).toEqual(['前端', '联调', '后端']);
    expect(parseLabelsValue('')).toEqual([]);
  });
});

describe('cellText', () => {
  it('兼容富文本与公式对象', () => {
    expect(cellText({ richText: [{ text: '登录' }, { text: '联调' }] })).toBe('登录联调');
    expect(cellText({ formula: 'A1', result: '结果' })).toBe('结果');
    expect(cellText({ text: '链接', hyperlink: 'https://example.com' })).toBe('链接');
    expect(cellText(null)).toBe('');
    expect(cellText(90)).toBe('90');
  });
});

describe('parseImportRows', () => {
  const header = ['任务标题', '所属列', '描述', '开始日期', '截止日期', '优先级', '标签', '预估工时(分钟)'];

  it('解析成任务清单并归并看板列', () => {
    const result = parseImportRows([
      header,
      ['登录页联调', '进行中', '与后端对齐字段', '2026-11-03', '2026-11-08', '高', '前端,联调', 90],
      ['接口联调', '进行中', '', '', '2026/11/9', '中', '', '1.5h'],
      ['写文档', '待办', '', '', '', '', '', ''],
    ]);

    expect(result.cards).toHaveLength(3);
    expect(result.listTitles).toEqual(['进行中', '待办']);
    expect(result.cards[0]).toMatchObject({
      title: '登录页联调',
      listTitle: '进行中',
      description: '与后端对齐字段',
      startDate: '2026-11-03',
      dueDate: '2026-11-08',
      priority: 'high',
      labels: ['前端', '联调'],
      estimatedMinutes: 90,
      rowNumber: 2,
    });
    expect(result.cards[1].dueDate).toBe('2026-11-09');
    expect(result.cards[1].estimatedMinutes).toBe(90);
  });

  it('空行静默跳过，缺标题的行记为错误', () => {
    const result = parseImportRows([
      header,
      [],
      ['', '进行中', '只有描述'],
      ['正常任务', '待办', '', '', '', '', '', ''],
    ]);

    expect(result.cards).toHaveLength(1);
    expect(result.errors).toEqual([{ rowNumber: 3, reason: '缺少任务标题，已跳过这一行' }]);
    expect(result.totalRows).toBe(2);
  });

  it('所属列留空时落到「待办」', () => {
    const result = parseImportRows([header, ['没有列的任务', '', '', '', '', '', '', '']]);
    expect(result.listTitles).toEqual(['待办']);
    expect(result.cards[0].listTitle).toBe('待办');
  });

  it('字段读不出来时记警告但任务照常导入', () => {
    const result = parseImportRows([header, ['任务', '待办', '', '不是日期', '', '随便', '', '待定']]);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].warnings).toEqual([
      '开始日期无法识别，已留空',
      '预估工时无法识别，已留空',
    ]);
    expect(result.cards[0].priority).toBeNull();
  });

  it('找不到标题列时给出提示', () => {
    const result = parseImportRows([['无关列', '其他'], ['值', '值2']]);
    expect(result.cards).toHaveLength(0);
    expect(result.warnings[0]).toContain('未找到任务标题列');
  });

  it('摘要包含列数、任务数与问题行数', () => {
    const result = parseImportRows([
      header,
      ['任务', '待办', '', '', '', '', '', ''],
      ['', '待办', '', '', '', '', '', ''],
    ]);
    expect(summarizeImport(result)).toContain('1 行有问题');
  });
});

describe('parseCsvText', () => {
  it('解析引号与内嵌分隔符', () => {
    const rows = parseCsvText('a,b\n"x,y",2');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,y', '2'],
    ]);
  });

  it('支持转义引号与字段内换行', () => {
    const rows = parseCsvText('标题,描述\n"他说""你好""","第一行\n第二行"');
    expect(rows[1][0]).toBe('他说"你好"');
    expect(rows[1][1]).toBe('第一行\n第二行');
  });

  it('去掉 BOM 并嗅探制表符分隔', () => {
    const rows = parseCsvText('\uFEFF标题\t所属列\n任务\t待办');
    expect(rows[0]).toEqual(['标题', '所属列']);
    expect(rows[1]).toEqual(['任务', '待办']);
  });

  it('分隔符嗅探函数可用', () => {
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
  });
});
