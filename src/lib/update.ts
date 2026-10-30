/**
 * 更新检查（V0.6.1）：只读取 GitHub 最新正式 Release，不自动下载或静默安装。
 * 安装包签名完成前，更新动作始终交给用户从发布页手动下载。
 */

export const GITHUB_REPO = 'Lemostic/tideline';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`;

export interface LatestRelease {
  /** 去掉前缀 v 的版本号，例如 0.6.1 */
  version: string;
  /** Release 标题；为空时回退到 tag */
  name: string;
  notes: string;
  publishedAt: string | null;
  /** GitHub Release 页面，用于手动下载安装包 */
  url: string;
}

export interface UpdateCheck {
  currentVersion: string;
  latest: LatestRelease | null;
  hasUpdate: boolean;
  checkedAt: string;
}

interface ParsedVersion {
  core: number[];
  prerelease: string[] | null;
}

function parseVersion(input: string): ParsedVersion {
  const cleaned = input.trim().replace(/^v/i, '').split('+')[0];
  const [corePart, prereleasePart] = cleaned.split('-', 2);
  const core = corePart.split('.').map((part) => {
    const numeric = Number.parseInt(part, 10);
    return Number.isFinite(numeric) ? numeric : 0;
  });
  while (core.length < 3) core.push(0);
  return {
    core,
    prerelease: prereleasePart ? prereleasePart.split('.') : null,
  };
}

/** 语义化版本比较；返回 1 表示 a 更新，-1 表示 b 更新，0 表示相同。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const diff = Number(leftPart) - Number(rightPart);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function normalizeRelease(raw: unknown): LatestRelease {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('GitHub 返回了无法识别的版本信息');
  }
  const value = raw as Record<string, unknown>;
  const tag = typeof value.tag_name === 'string' ? value.tag_name.trim() : '';
  if (!tag) throw new Error('GitHub Release 缺少版本标签');
  const version = tag.replace(/^v/i, '');
  const url =
    typeof value.html_url === 'string' && value.html_url.startsWith('https://github.com/')
      ? value.html_url
      : `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
  return {
    version,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : tag,
    notes: typeof value.body === 'string' ? value.body.trim() : '',
    publishedAt: typeof value.published_at === 'string' ? value.published_at : null,
    url,
  };
}

/**
 * 查询仓库最新正式 Release。
 * - 404：仓库还没有正式发布版本，返回 latest: null；
 * - 403：未登录调用触发了 GitHub 速率限制；
 * - 网络错误原样抛出，由 UI 给出可重试提示。
 */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheck> {
  const response = await fetchImpl(LATEST_RELEASE_API, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });

  if (response.status === 404) {
    return {
      currentVersion,
      latest: null,
      hasUpdate: false,
      checkedAt: new Date().toISOString(),
    };
  }
  if (response.status === 403) {
    throw new Error('GitHub 接口请求过于频繁，请稍后再试，或直接打开发布页');
  }
  if (!response.ok) {
    throw new Error(`检查更新失败（GitHub 返回 ${response.status}）`);
  }

  const release = normalizeRelease(await response.json());
  return {
    currentVersion,
    latest: release,
    hasUpdate: compareVersions(release.version, currentVersion) > 0,
    checkedAt: new Date().toISOString(),
  };
}
