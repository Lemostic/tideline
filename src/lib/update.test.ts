import { describe, expect, it, vi } from 'vitest';
import { checkForUpdate, compareVersions } from '@/lib/update';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const release = {
  tag_name: 'v0.6.2',
  name: '潮线 0.6.2',
  body: '修复更新检查',
  published_at: '2026-11-01T00:00:00Z',
  html_url: 'https://github.com/Lemostic/tideline/releases/tag/v0.6.2',
};

describe('compareVersions', () => {
  it('比较主版本与补丁版本', () => {
    expect(compareVersions('0.6.1', '0.6.0')).toBe(1);
    expect(compareVersions('v0.6.0', '0.6.1')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
  });

  it('正式版优先于预发布版', () => {
    expect(compareVersions('0.6.1', '0.6.1-rc.1')).toBe(1);
    expect(compareVersions('0.6.1-rc.2', '0.6.1-rc.1')).toBe(1);
    expect(compareVersions('0.6.1-beta', '0.6.1-rc')).toBe(-1);
  });
});

describe('checkForUpdate', () => {
  it('发现更高版本时标记可更新', async () => {
    const result = await checkForUpdate('0.6.1', vi.fn().mockResolvedValue(jsonResponse(release)));
    expect(result.hasUpdate).toBe(true);
    expect(result.latest?.version).toBe('0.6.2');
    expect(result.latest?.notes).toContain('修复');
  });

  it('当前已是最新版本时 hasUpdate 为 false', async () => {
    const result = await checkForUpdate('0.6.2', vi.fn().mockResolvedValue(jsonResponse(release)));
    expect(result.hasUpdate).toBe(false);
  });

  it('仓库没有 Release 时返回 null', async () => {
    const result = await checkForUpdate(
      '0.6.1',
      vi.fn().mockResolvedValue(new Response('', { status: 404 })),
    );
    expect(result.latest).toBeNull();
    expect(result.hasUpdate).toBe(false);
  });

  it('非 2xx 响应抛出可读错误', async () => {
    await expect(
      checkForUpdate('0.6.1', vi.fn().mockResolvedValue(new Response('', { status: 500 }))),
    ).rejects.toThrow('500');
  });
});
