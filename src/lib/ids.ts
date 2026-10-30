/** 轻量 ID 生成器：本地单机场景下随机 ID 足够，无碰撞风险。 */
export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}${random}`;
}

/** 生成 ISO 时间戳（UTC），统一由前端写入，后端原样存储。 */
export function nowISO(): string {
  return new Date().toISOString();
}
