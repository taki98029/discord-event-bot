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
  /** 管理 UI / API のアクセストークン */
  ADMIN_TOKEN: string;
  /** テスト用シーム: 真値のとき Discord API 呼び出しをフィクスチャで代替する（ADR 0008） */
  MOCK_DISCORD?: string;
  // ※ 投稿チャンネルは Notification ごとに DB が持つため DISCORD_CHANNEL_ID は廃止。
}
