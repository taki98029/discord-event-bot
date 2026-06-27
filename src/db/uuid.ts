/**
 * UUID 発番（ADR 0016）。URL／API 表面に出るエンティティの uuid 列はすべてここから採る。
 * crypto.randomUUID() は Workers ランタイムでネイティブ、vitest/cloudflare:test でも提供される。
 */
export function newUuid(): string {
  return crypto.randomUUID();
}
