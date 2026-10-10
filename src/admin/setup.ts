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
  /**
   * Bot の招待 URL（別サーバーへの追加招待・退出後の再招待用）。DISCORD_APPLICATION_ID 未設定なら null。
   * 保存値ではなくアプリ ID からの派生値（唯一の真実はシークレット）。
   */
  invite_url: string | null;
}

/**
 * 招待時に要求する権限ビット: VIEW_CHANNEL(1024)+SEND_MESSAGES(2048)+MENTION_EVERYONE(131072)
 * +SEND_MESSAGES_IN_THREADS(1<<38=274877906944・日程調整の開催前リマインドをフォーラム投稿内へ送るため・2026-09-23)。
 * セットアップガイド（setup.src.html の INVITE_PERMS）と同値に保つこと。
 */
export const INVITE_PERMISSIONS = '274878041088';

/** 招待 URL を組み立てる（scope は bot＋applications.commands＝スラッシュコマンド用）。 */
export function inviteUrl(applicationId: string): string {
  return (
    'https://discord.com/oauth2/authorize?client_id=' +
    encodeURIComponent(applicationId) +
    '&scope=bot%20applications.commands&permissions=' +
    INVITE_PERMISSIONS
  );
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
    invite_url: env.DISCORD_APPLICATION_ID ? inviteUrl(env.DISCORD_APPLICATION_ID) : null,
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
