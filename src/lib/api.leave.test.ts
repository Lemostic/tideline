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

describe('请假记录（V0.16.0）', () => {
  it('创建请假记录：天数按自然日推导，项目从成员反查，默认已批准', async () => {
    const { project, member } = await makeMember();
    const record = await api.createLeave({
      memberId: member.id,
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      reason: '  家中有事  ',
      note: '已交接',
    });
    expect(record.projectId).toBe(project.id);
    expect(record.days).toBe(3);
    expect(record.status).toBe('approved');
    expect(record.leaveType).toBe('other');
    expect(record.reason).toBe('家中有事');
    expect(record.note).toBe('已交接');

    const stored = (await api.getSnapshot()).leaveRecords;
    expect(stored).toHaveLength(1);
    expect(stored[0].days).toBe(3);
  });

  it('校验起止日期与事由，非法输入不落库', async () => {
    const { member } = await makeMember();
    await expect(
      api.createLeave({
        memberId: member.id,
        startDate: '',
        endDate: '2026-10-03',
        reason: '家中有事',
      }),
    ).rejects.toThrow('请选择请假开始日期');

    await expect(
      api.createLeave({
        memberId: member.id,
        startDate: '2026-10-05',
        endDate: '2026-10-01',
        reason: '家中有事',
      }),
    ).rejects.toThrow('结束日期不能早于开始日期');

    await expect(
      api.createLeave({
        memberId: member.id,
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        reason: '   ',
      }),
    ).rejects.toThrow('请填写请假事由');

    expect((await api.getSnapshot()).leaveRecords).toHaveLength(0);
  });

  it('修改区间后重新计算天数，切换状态不影响天数', async () => {
    const { member } = await makeMember();
    const record = await api.createLeave({
      memberId: member.id,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      reason: '家中有事',
    });
    const widened = await api.updateLeave({
      id: record.id,
      patch: { endDate: '2026-10-05' },
    });
    expect(widened.days).toBe(5);

    const pending = await api.updateLeave({ id: record.id, patch: { status: 'pending' } });
    expect(pending.status).toBe('pending');
    expect(pending.days).toBe(5);

    const rejected = await api.updateLeave({ id: record.id, patch: { status: 'rejected' } });
    expect(rejected.status).toBe('rejected');
  });

  it('删除请假记录后快照里不再保留', async () => {
    const { member } = await makeMember();
    const record = await api.createLeave({
      memberId: member.id,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      reason: '家中有事',
    });
    await api.deleteLeave({ id: record.id });
    expect((await api.getSnapshot()).leaveRecords).toHaveLength(0);
  });

  it('读取旧 localStorage 数据时补齐 days 与类型状态', async () => {
    const { project, member } = await makeMember();
    const legacy = [
      {
        id: 'lv_legacy',
        projectId: project.id,
        memberId: member.id,
        startDate: '2026-10-01',
        endDate: '2026-10-04',
        leaveType: 'annual',
        status: 'approved',
        reason: '年假出行',
        note: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as unknown as LeaveRecord[];
    const raw = JSON.parse(storage.get('tideline.db.v1') ?? '{}');
    storage.set(
      'tideline.db.v1',
      JSON.stringify({ ...raw, leaveRecords: legacy }),
    );
    const snapshot = await api.getSnapshot();
    expect(snapshot.leaveRecords[0].days).toBe(4);
    expect(snapshot.leaveRecords[0].leaveType).toBe('annual');
    expect(snapshot.leaveRecords[0].status).toBe('approved');
  });
});
