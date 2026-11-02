import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  backupFilename,
  createBackup,
  parseBackup,
  summarizeBackup,
} from './backup';
import type { Board, Card, InboxItem, List } from './types';

const board: Board = {
  id: 'b_1',
  title: '看板',
  description: '简介',
  color: 'blue',
  starred: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const list: List = {
  id: 'l_1',
  boardId: 'b_1',
  title: '待办',
  color: 'slate',
  wipLimit: null,
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'c_1',
    boardId: 'b_1',
    listId: 'l_1',
    title: '任务',
    description: '',
    dueDate: null,
    startDate: null,
    estimatedMinutes: null,
    actualMinutes: null,
    priority: null,
    completed: false,
    deletedAt: null,
    labels: [],
    parentCardId: null,
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const inbox: InboxItem[] = [
  { id: 'i_1', content: '想法', createdAt: '2026-01-01T00:00:00.000Z' },
];

const validBackup = () =>
  createBackup({
    boards: [board],
    lists: [list],
    cards: [card(), card({ id: 'c_2', deletedAt: '2026-02-01T00:00:00.000Z' })],
    inbox,
    dependencies: [{ cardId: 'c_2', dependsOnCardId: 'c_1' }],
    boardSets: [],
    goals: [],
    teamMembers: [],
    overtimeRecords: [],
    performanceRecords: [],
    memberTenures: [],
    projects: [],
    projectMetaFields: [],
    projectRoles: [],
    recurrences: [],
    automationRules: [],
    cardActivity: [],
    customFields: [],
    cardFieldValues: [],
    savedViews: [],
  });

describe('backup helpers', () => {
  it('创建备份时统计活动任务、回收站任务与依赖', () => {
    const summary = summarizeBackup(validBackup());
    expect(summary).toEqual({
      boards: 1,
      lists: 1,
      cards: 2,
      trashed: 1,
      inbox: 1,
      dependencies: 1,
      boardSets: 0,
      goals: 0,
      teamMembers: 0,
      overtimeRecords: 0,
      performanceRecords: 0,
      memberTenures: 0,
      projects: 0,
      projectMetaFields: 0,
      projectRoles: 0,
      recurrences: 0,
      automationRules: 0,
      cardActivity: 0,
      customFields: 0,
      cardFieldValues: 0,
      savedViews: 0,
    });
  });

  it('解析合法备份并保留回收站字段', () => {
    const backup = parseBackup(JSON.stringify(validBackup()));
    expect(backup.app).toBe('tideline');
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(backup.cards).toHaveLength(2);
    expect(backup.cards[1].deletedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('旧备份缺少工时字段时补 null，并保留新备份中的零与分钟数', () => {
    const old = validBackup();
    const restored = parseBackup(JSON.stringify(old));
    expect(restored.cards[0].estimatedMinutes).toBeNull();
    expect(restored.cards[0].actualMinutes).toBeNull();

    const withMinutes = validBackup();
    withMinutes.cards[0].estimatedMinutes = 90;
    withMinutes.cards[0].actualMinutes = 0;
    const roundTrip = parseBackup(JSON.stringify(withMinutes));
    expect(roundTrip.cards[0].estimatedMinutes).toBe(90);
    expect(roundTrip.cards[0].actualMinutes).toBe(0);
  });

  it('保留自定义标签颜色并兼容缺少颜色字段的旧备份', () => {
    const current = validBackup();
    current.boards[0] = { ...board, labelColors: { 研发: 'rose' } };
    expect(parseBackup(JSON.stringify(current)).boards[0].labelColors).toEqual({ 研发: 'rose' });

    const old = validBackup();
    expect(parseBackup(JSON.stringify(old)).boards[0].labelColors).toEqual({});
  });

  it('拒绝备份中的无效标签颜色', () => {
    const invalid = validBackup();
    invalid.boards[0] = { ...board, labelColors: { 研发: 'invalid' as Board['color'] } };
    expect(() => parseBackup(JSON.stringify(invalid))).toThrow('标签颜色');
  });

  it('拒绝非潮线备份、错误版本和非法 JSON', () => {
    expect(() => parseBackup('not json')).toThrow('有效的 JSON');
    expect(() =>
      parseBackup(JSON.stringify({ ...validBackup(), app: 'other' })),
    ).toThrow('不是潮线');
    expect(() =>
      parseBackup(JSON.stringify({ ...validBackup(), formatVersion: 9 })),
    ).toThrow('不受支持');
  });

  it('拒绝重复 id 与引用不存在的列表', () => {
    const backup = validBackup();
    expect(() => parseBackup(JSON.stringify({ ...backup, cards: [backup.cards[0], backup.cards[0]] }))).toThrow(
      '重复的任务 id',
    );
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...backup,
          cards: [{ ...backup.cards[0], listId: 'l_missing' }],
        }),
      ),
    ).toThrow('不存在的列表');
  });

  it('备份文件名可安全用于 Windows', () => {
    const name = backupFilename(new Date('2026-10-30T12:34:56.789Z'));
    expect(name).toBe('tideline-backup-2026-10-30T12-34-56-789Z.json');
    expect(name).not.toMatch(/[:\\/]/);
  });

  it('备份往返保留自定义字段与取值', () => {
    const backup = validBackup();
    backup.customFields = [
      {
        id: 'cf_1',
        boardId: 'b_1',
        name: '阶段',
        fieldType: 'select',
        options: [{ id: 'opt_a', label: '甲', color: '#0f766e' }],
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    backup.cardFieldValues = [
      { cardId: 'c_1', fieldId: 'cf_1', valueText: 'opt_a', valueNumber: null },
    ];
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.customFields).toHaveLength(1);
    expect(parsed.customFields[0].options[0].label).toBe('甲');
    expect(parsed.cardFieldValues[0].valueText).toBe('opt_a');
    expect(summarizeBackup(parsed).customFields).toBe(1);
    expect(summarizeBackup(parsed).cardFieldValues).toBe(1);
  });

  it('旧备份缺少自定义字段时按空数组处理', () => {
    const backup = validBackup();
    delete (backup as { customFields?: unknown }).customFields;
    delete (backup as { cardFieldValues?: unknown }).cardFieldValues;
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.customFields).toEqual([]);
    expect(parsed.cardFieldValues).toEqual([]);
  });

  it('拒绝指向不存在选项、看板与任务的字段数据', () => {
    const base = validBackup();
    base.customFields = [
      {
        id: 'cf_1',
        boardId: 'b_1',
        name: '阶段',
        fieldType: 'select',
        options: [{ id: 'opt_a', label: '甲', color: '#0f766e' }],
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    base.cardFieldValues = [
      { cardId: 'c_1', fieldId: 'cf_1', valueText: 'opt_missing', valueNumber: null },
    ];
    expect(() => parseBackup(JSON.stringify(base))).toThrow('不存在的选项');

    base.cardFieldValues = [
      { cardId: 'c_missing', fieldId: 'cf_1', valueText: 'opt_a', valueNumber: null },
    ];
    expect(() => parseBackup(JSON.stringify(base))).toThrow('不存在的任务');

    base.cardFieldValues = [];
    base.customFields[0].boardId = 'b_missing';
    expect(() => parseBackup(JSON.stringify(base))).toThrow('不存在的看板');
  });

  it('备份保留保存视图并统计数量', () => {
    const backup = validBackup();
    backup.savedViews = [
      {
        id: 'sv_1',
        boardId: 'b_1',
        name: '高优先级',
        viewType: 'table',
        filters: {
          keyword: '',
          status: 'active',
          priorities: ['high'],
          labels: [],
          fieldFilters: [],
          blocked: false,
        },
        sort: { key: 'priority', direction: 'asc' },
        isBuiltin: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.savedViews).toHaveLength(1);
    expect(parsed.savedViews[0].name).toBe('高优先级');
    expect(parsed.savedViews[0].filters.priorities).toEqual(['high']);
    expect(summarizeBackup(parsed).savedViews).toBe(1);
  });

  it('旧备份缺少保存视图时按空数组处理', () => {
    const backup = validBackup();
    delete (backup as { savedViews?: unknown }).savedViews;
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.savedViews).toEqual([]);
  });

  it('拒绝引用不存在看板或 id 重复的保存视图', () => {
    const base = validBackup();
    base.savedViews = [
      {
        id: 'sv_1',
        boardId: 'b_missing',
        name: '坏视图',
        viewType: 'board',
        filters: {
          keyword: '',
          status: 'all',
          priorities: [],
          labels: [],
          fieldFilters: [],
          blocked: false,
        },
        sort: { key: 'due-asc', direction: 'asc' },
        isBuiltin: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    expect(() => parseBackup(JSON.stringify(base))).toThrow('不存在的看板');

    base.savedViews[0].boardId = 'b_1';
    base.savedViews.push({ ...base.savedViews[0] });
    expect(() => parseBackup(JSON.stringify(base))).toThrow('重复的保存视图 id');
  });

  it('保存视图引用的字段不存在时拒绝这份备份', () => {
    const base = validBackup();
    base.savedViews = [
      {
        id: 'sv_1',
        boardId: 'b_1',
        name: '按阶段',
        viewType: 'board',
        filters: {
          keyword: '',
          status: 'all',
          priorities: [],
          labels: [],
          fieldFilters: [
            { fieldId: 'cf_gone', optionIds: ['opt_a'], min: null, max: null },
          ],
          blocked: false,
        },
        sort: { key: 'due-asc', direction: 'asc' },
        isBuiltin: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    expect(() => parseBackup(JSON.stringify(base))).toThrow('不存在的自定义字段');
  });

  it('备份往返保留未出勤原因，并拒绝脏的未出勤记录', () => {
    const stamp = '2026-01-01T00:00:00.000Z';
    const withProject = () => {
      const backup = validBackup();
      backup.projects = [
        {
          id: 'p_1',
          name: '项目',
          description: '',
          color: '#0f766e',
          status: 'active',
          starred: false,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ];
      backup.projectRoles = [
        {
          id: 'pr_1',
          projectId: 'p_1',
          name: '开发',
          color: '#2f6fd0',
          position: 0,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ];
      backup.teamMembers = [
        {
          id: 'm_1',
          projectId: 'p_1',
          roleId: 'pr_1',
          name: '张三',
          role: 'dev',
          status: 'active',
          joinedAt: '2026-01-01',
          releasedAt: null,
          note: '',
          createdAt: stamp,
          updatedAt: stamp,
        },
      ];
      backup.overtimeRecords = [
        {
          id: 'ot_1',
          projectId: 'p_1',
          memberId: 'm_1',
          date: '2026-10-31',
          hours: 8,
          status: 'absent',
          absenceReason: '临时发烧请假',
          note: '',
          createdAt: stamp,
          updatedAt: stamp,
        },
      ];
      return backup;
    };

    const parsed = parseBackup(JSON.stringify(withProject()));
    expect(parsed.overtimeRecords[0]).toMatchObject({
      status: 'absent',
      absenceReason: '临时发烧请假',
    });
    expect(summarizeBackup(parsed).overtimeRecords).toBe(1);

    const legacy = withProject();
    legacy.overtimeRecords[0] = {
      ...legacy.overtimeRecords[0],
      status: 'done',
    };
    delete (legacy.overtimeRecords[0] as { absenceReason?: string }).absenceReason;
    expect(parseBackup(JSON.stringify(legacy)).overtimeRecords[0].absenceReason).toBe('');

    const missingReason = withProject();
    missingReason.overtimeRecords[0] = {
      ...missingReason.overtimeRecords[0],
      absenceReason: '   ',
    };
    expect(() => parseBackup(JSON.stringify(missingReason))).toThrow('未出勤原因');

    const dirty = withProject();
    dirty.overtimeRecords[0] = { ...dirty.overtimeRecords[0], status: 'done' };
    expect(() => parseBackup(JSON.stringify(dirty))).toThrow('不应包含未出勤原因');
  });

  it('旧备份的子任务清单展开为真实子卡片', () => {
    const backup = validBackup();
    backup.dependencies = [];
    const legacyCard = {
      ...card(),
      id: 'c_legacy',
      subtasks: [
        { id: 's1', title: '子1', done: false },
        { id: 's2', title: '子2', done: true },
      ],
    } as unknown as Card;
    backup.cards = [legacyCard];
    const parsed = parseBackup(JSON.stringify(backup));
    const children = parsed.cards.filter((item) => item.parentCardId === 'c_legacy');
    expect(children.map((item) => item.title)).toEqual(['子1', '子2']);
    expect(children[1].completed).toBe(true);
    expect(parsed.cards).toHaveLength(3);
  });

  it('拒绝父任务缺失或成环的备份任务树', () => {
    const missing = validBackup();
    missing.dependencies = [];
    missing.cards = [
      { ...card(), id: 'p1' },
      { ...card(), id: 'ch1', parentCardId: 'missing' },
    ];
    expect(() => parseBackup(JSON.stringify(missing))).toThrow('父任务不存在');

    const cyclic = validBackup();
    cyclic.dependencies = [];
    cyclic.cards = [
      { ...card(), id: 'p1', parentCardId: 'ch1' },
      { ...card(), id: 'ch1', parentCardId: 'p1' },
    ];
    expect(() => parseBackup(JSON.stringify(cyclic))).toThrow('循环');
  });
});
