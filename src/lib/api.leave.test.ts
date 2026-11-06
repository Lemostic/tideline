import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './api';
import type { LeaveRecord } from './types';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
});

async function makeMember() {
  const project = await api.createProject({ name: '项目' });
  const role = await api.createProjectRole({ projectId: project.id, name: '开发' });
  const member = await api.createTeamMember({
    projectId: project.id,
    roleId: role.id,
    name: '张三',
  });
  return { project, role, member };
}

describe('请假记录（V0.16.0 / V0.16.1 纯记录口径）', () => {
  it('创建请假记录：天数按填写值保存，项目从成员反查', async () => {
    const { project, member } = await makeMember();
    const record = await api.createLeave({
      memberId: member.id,
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      days: 2.5,
      reason: '  家中有事  ',
      note: '已交接',
    });
    expect(record.projectId).toBe(project.id);
    expect(record.days).toBe(2.5);
    expect(record.leaveType).toBe('other');
    expect(record.reason).toBe('家中有事');
    expect(record.note).toBe('已交接');
    // 纯记录口径：没有审批状态字段
    expect('status' in record).toBe(false);

    const stored = (await api.getSnapshot()).leaveRecords;
    expect(stored).toHaveLength(1);
    expect(stored[0].days).toBe(2.5);
  });

  it('天数与区间解耦：区间 3 天仍可只记 0.5 天', async () => {
    const { member } = await makeMember();
    const record = await api.createLeave({
      memberId: member.id,
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      days: 0.5,
      reason: '半天事假',
    });
    expect(record.days).toBe(0.5);
    expect(record.startDate).toBe('2026-10-01');
    expect(record.endDate).toBe('2026-10-03');
  });

  it('校验天数与日期区间，非法输入不落库', async () => {
    const { member } = await makeMember();
    await expect(
      api.createLeave({
        memberId: member.id,
        startDate: '',
        endDate: '2026-10-03',
        days: 1,
        reason: '家中有事',
      }),
    ).rejects.toThrow('请选择请假开始日期');

    await expect(
      api.createLeave({
        memberId: member.id,
        startDate: '2026-10-05',
        endDate: '2026-10-01',
        days: 1,
        reason: '家中有事',
      }),
    ).rejects.toThrow('结束日期不能早于开始日期');

    await expect(
      api.createLeave({
        memberId: member.id,
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        days: 0,
        reason: '家中有事',
      }),
    ).rejects.toThrow('请假天数必须大于 0');

    await expect(
      api.createLeave({
        memberId: member.id,
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        days: 1.234,
        reason: '家中有事',
      }),
    ).rejects.toThrow('请假天数最多 2 位小数');

    await expect(
      api.createLeave({
        memberId: member.id,
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        days: 1,
        reason: '   ',
      }),
    ).rejects.toThrow('请填写请假事由');

    expect((await api.getSnapshot()).leaveRecords).toHaveLength(0);
  });

  it('改日期不改天数，改天数生效', async () => {
    const { member } = await makeMember();
    const record = await api.createLeave({
      memberId: member.id,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      days: 2,
      reason: '家中有事',
    });
    const widened = await api.updateLeave({
      id: record.id,
      patch: { endDate: '2026-10-05' },
    });
    expect(widened.days).toBe(2);

    const fewer = await api.updateLeave({ id: record.id, patch: { days: 1.25 } });
    expect(fewer.days).toBe(1.25);
  });

  it('删除请假记录后快照里不再保留', async () => {
    const { member } = await makeMember();
    const record = await api.createLeave({
      memberId: member.id,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      days: 1,
      reason: '家中有事',
    });
    await api.deleteLeave({ id: record.id });
    expect((await api.getSnapshot()).leaveRecords).toHaveLength(0);
  });

  it('读取旧 localStorage 数据时丢弃审批状态并补齐天数', async () => {
    const { project, member } = await makeMember();
    const legacy = [
      {
        id: 'lv_legacy',
        projectId: project.id,
        memberId: member.id,
        startDate: '2026-10-01',
        endDate: '2026-10-04',
        leaveType: 'annual',
        status: 'pending',
        reason: '年假出行',
        note: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as unknown as LeaveRecord[];
    const raw = JSON.parse(storage.get('tideline.db.v1') ?? '{}');
    storage.set('tideline.db.v1', JSON.stringify({ ...raw, leaveRecords: legacy }));
    const snapshot = await api.getSnapshot();
    // 缺 days 时按区间自然日补齐（10-01 ~ 10-04 共 4 天）
    expect(snapshot.leaveRecords[0].days).toBe(4);
    expect(snapshot.leaveRecords[0].leaveType).toBe('annual');
    expect('status' in snapshot.leaveRecords[0]).toBe(false);
  });
});
