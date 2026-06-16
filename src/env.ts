/** Worker のバインディング / シークレット */
export interface Env {
  /** D1 データベース */
  DB: D1Database;
  /** 静的アセット（管理 UI） */
  ASSETS: Fetcher;

  // --- シークレット（wrangler secret put / .dev.vars）---
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_CHANNEL_ID: string;
  /** 管理 UI / API のアクセストークン */
  ADMIN_TOKEN: string;
}
