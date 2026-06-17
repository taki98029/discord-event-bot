/**
 * セットアップ・ウィザード用のヘルパ（管理画面の初期設定を非エンジニア向けに支援）。
 * すべて handleAdmin 経由の ADMIN_TOKEN 認証下で呼ばれる。
 */
import type { Env } from '../env';
import { registerCommands } from '../discord/commands';

export interface SetupStatus {
  /** 各シークレットが設定済みか（値は返さない） */
  secrets: {
    DISCORD_PUBLIC_KEY: boolean;
    DISCORD_APPLICATION_ID: boolean;
    DISCORD_BOT_TOKEN: boolean;
    ADMIN_TOKEN: boolean;
  };
  /** Discord Developer Portal に貼り付ける Interaction Endpoint URL */
  interaction_endpoint_url: string;
  /** 管理画面 URL */
  admin_url: string;
}

/** 現在のセットアップ状況（シークレット有無・各種URL）を返す。 */
export function getSetupStatus(env: Env, request: Request): SetupStatus {
  const origin = new URL(request.url).origin;
  return {
    secrets: {
      DISCORD_PUBLIC_KEY: !!env.DISCORD_PUBLIC_KEY,
      DISCORD_APPLICATION_ID: !!env.DISCORD_APPLICATION_ID,
      DISCORD_BOT_TOKEN: !!env.DISCORD_BOT_TOKEN,
      ADMIN_TOKEN: !!env.ADMIN_TOKEN,
    },
    interaction_endpoint_url: `${origin}/interactions`,
    admin_url: `${origin}/`,
  };
}

/** 設定済みシークレットを使って Discord にスラッシュコマンドを登録する。 */
export async function registerCommandsForEnv(
  env: Env,
  guildId?: string | null,
): Promise<{ count: number; names: string[] }> {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_APPLICATION_ID) {
    throw new Error(
      'DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID が未設定です（Cloudflare のシークレットを確認してください）。',
    );
  }
  return registerCommands(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID, guildId ?? null);
}
