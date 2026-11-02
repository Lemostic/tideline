import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './api';
import type { OvertimeRecord } from './types';

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

describe('周末加班未出勤（V0.13.2）', () => {
  it('未出勤必须填写原因，保存时去掉首尾空白', async () => {
    const { member } = await makeMember();
    await expect(
      api.createOvertime({
        memberId: member.id,
        date: '2026-10-31',
        hours: 8,
        status: 'absent',
        absenceReason: '   ',
      }),
    ).rejects.toThrow('请填写未出勤原因');

    await expect(
      api.createOvertime({
        memberId: member.id,
        date: '2026-10-31',
        hours: 8,
        status: 'absent',
        absenceReason: 'x'.repeat(201),
      }),
    ).rejects.toThrow('最多 200 字');

    const record = await api.createOvertime({
      memberId: member.id,
      date: '2026-10-31',
      hours: 8,
      status: 'absent',
      absenceReason: ' 临时发烧请假 ',
    });
    expect(record.status).toBe('absent');
    expect(record.absenceReason).toBe('临时发烧请假');
    expect((await api.getSnapshot()).overtimeRecords[0].absenceReason).toBe('临时发烧请假');
  });

  it('切回已出勤时清空原因，再次标记未出勤需要重新填写', async () => {
    const { member } = await makeMember();
    const record = await api.createOvertime({
      memberId: member.id,
      date: '2026-10-31',
      hours: 8,
      status: 'absent',
      absenceReason: '事假',
    });
    const done = await api.updateOvertime({ id: record.id, patch: { status: 'done' } });
    expect(done.status).toBe('done');
    expect(done.absenceReason).toBe('');
    await expect(
      api.updateOvertime({ id: record.id, patch: { status: 'absent' } }),
    ).rejects.toThrow('请填写未出勤原因');
    const absent = await api.updateOvertime({
      id: record.id,
      patch: { status: 'absent', absenceReason: '临时调休' },
    });
    expect(absent.absenceReason).toBe('临时调休');
  });

  it('读取旧 localStorage 数据时补齐 absenceReason，并清理非未出勤的残留原因', async () => {
    const { project, role, member } = await makeMember();
    const legacy: OvertimeRecord[] = [
      {
        id: 'ot_legacy',
        projectId: project.id,
        memberId: member.id,
        date: '2026-10-31',
        hours: 8,
        status: 'done',
        absenceReason: '不该保留的历史原因',
        note: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const raw = JSON.parse(storage.get('tideline.db.v1') ?? '{}');
    storage.set(
      'tideline.db.v1',
      JSON.stringify({ ...raw, overtimeRecords: legacy, teamMembers: [], projects: [], projectRoles: [] }),
    );
    const snapshot = await api.getSnapshot();
    expect(snapshot.overtimeRecords[0].absenceReason).toBe('');
    expect(snapshot.overtimeRecords[0].status).toBe('done');
    expect(role.id).toBeTruthy();
  });
});
