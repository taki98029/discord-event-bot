# discord-event-bot

Discord と連携し、イベントの **出欠確認・リマインド・参加ノルマ管理** と、開催日を決める **日程調整** を自動化する Bot。
1 デプロイで**複数の Discord サーバー**を管理でき、専用の **管理 UI** から設定・メンバー編集ができます。
登録が必要なサービスは **Discord・Cloudflare・GitHub の 3 つ**（GitHub は公開リポジトリの **Fork** と更新の **Sync fork** に使用。fork を Cloudflare Workers Builds に接続して動かします）。いずれも完全無料枠で自己ホストできます。

> **非エンジニアの方へ**: BOOTH で配布される **`setup.html` をダウンロードして開くだけ**で、
> 画面の案内に沿って初期設定を進められます（管理パスワードの自動生成・Bot 招待リンクの自動作成・
> コピーボタンつき）。**ターミナル操作は不要**です。

## デプロイ

- **非エンジニアの方**: BOOTH で配布される **`setup.html` をダウンロードして開くだけ**。画面の案内に従って設定できます（ターミナル不要）。
- **GitHub から直接使う方**: この公開リポジトリを **[Fork](https://github.com/taki98029/discord-event-bot/fork)** し、Cloudflare ダッシュボードで **Workers & Pages → Create application → Continue with GitHub** から自分の fork を選択します。ビルド設定の **Deploy command を `npm run deploy`** に変更して **Deploy** すると、**D1 は自動作成・マイグレーションも自動適用**されます。4 つのシークレット（`DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `DISCORD_BOT_TOKEN` / `ADMIN_TOKEN`）は Worker の **Settings → Variables and secrets** で設定。**ステップ詳細（実画面スクショ付き）は `setup.html` に委ねています。**
- **更新**: 自分の fork ページで **「Sync fork」** を押すだけ。Cloudflare Workers Builds が push を検知して自動再デプロイ（マイグレーション込み）。**CLI 不要**。

> 配布は **BOOTH＝入口（`setup.html` を配布）／公開 GitHub＝Fork 元（Cloudflare Workers Builds に接続）** の二段構成です。利用者は公開リポジトリを **fork** して自分のものとして運用し、更新は **「Sync fork」** で受け取ります。「Deploy to Cloudflare」ボタンは採用していません（ボタンは fork ではなく clone を作るため純正の「Sync fork」更新が使えない）。

## データベース名と複数インスタンス

`npm run deploy` は先頭で [`scripts/derive-db-name.mjs`](scripts/derive-db-name.mjs) を実行し、D1 データベース名を **Worker 名から自動導出**します（`<Worker名>-db`）。同一 Cloudflare アカウントに同じ fork を複数プロジェクト接続しても、各インスタンスの D1 が必ず分かれ、複数 Bot が 1 つの DB を共有して壊れる事故を防ぎます。

- **新規に導入する方**: 何も設定不要です。fork 接続時に Worker 名から D1 が自動作成されます。
- **既存の利用者（固定名で運用していた方）**: この自動導出を有効化したバージョンへ更新する際は、**Worker の Settings → Build → Build variables and secrets** に、これまで使っていた D1 名を明示してください。設定しないと Bot が新しい空の DB に接続し「データが消えた」ように見えます（旧 DB は残っているため設定を追加すれば元に戻ります）。

  ```
  DB_NAME = <これまで使っていた D1 名>
  ```

  優先順位は `DB_NAME`（明示指定）＞ Worker 名からの導出 ＞ 既定値、です。

## アーキテクチャ

```
Discord ──▶ Cloudflare Worker (1 デプロイで複数サーバー)
              ├─ POST /interactions   スラッシュコマンド / ボタン（Ed25519 署名検証）
              ├─ /api/admin/*         管理 API（ADMIN_TOKEN 認証）
              ├─ /api/planning/answers/*  日程調整の回答ページ用 API（本人専用リンク＋Cookie）
              ├─ /* (静的)            管理 UI・回答ページ /answer（SPA・同梱配信）
              └─ scheduled()          毎分 cron（奇数分＝出欠確認のペース配信／偶数分＝日程調整）
                     │ D1 binding
                     ▼
              Cloudflare D1 (segments / members / notifications / occurrences / responses / groupings / planning_*)
```

## 機能

- **出欠確認の 3 種類**: 定期（繰り返しのルールで開催日を自動計算）／不定期（テンプレートに開催日時を都度追加）／単発（テンプレートなしで 1 回分）
- **イベント募集**: 指定日数前に自動で募集メッセージを投稿（メンション対象を設定可能）。手動の 📣 投稿・再投稿も可
- **ボタン操作**: 参加/不参加/未定をワンクリック回答（チャンネル・DM 両対応）。未登録者は自動登録
- **リマインド**: 未回答者・未定者へ、DM または投稿チャンネルで（休止中メンバーは除外）
- **ノルマ確認**: 参加間隔が空いたメンバーへ DM（休止中メンバーは除外）
- **状況確認**: 「状況確認」ボタンでリアルタイムの参加状況を表示（他の人の回答を見せない設定も可）
- **日程調整**: 日程候補を出し、メンバーは回答ページのカレンダーで 〇△× を回答。回答一覧から開催日を決めてフォーラムに開催案内を作成（定期・単発）
- **スラッシュコマンド**: `/manage`（管理者・管理画面 URL）。募集の手動投稿は管理画面の 📣 から
- **管理 UI**: サーバー選択 → 出欠確認・日程調整・メンバー区分・回答履歴をブラウザから編集/閲覧（トークン認証）

## プロジェクト構成

```
src/
  index.ts          Worker 入口（fetch + scheduled）
  interactions/     Discord Interaction（コマンド/ボタン・署名検証）
  cron/             出欠確認のペース配信（募集/リマインド/ノルマ）
  planning/         日程調整（管理 API・回答ページ API・定期処理）
  admin/            管理 API（トークン認証）・セットアップ支援
  db/               D1 データ層（segments / members / notifications / occurrences / responses / groupings）
  discord/          Discord REST（メッセージ/DM）・コマンド定義（commands.json）
  lib/date.ts       JST 日付計算
ui/                 管理 SPA と回答ページ（静的アセット・ビルド済み）
migrations/         D1 スキーマ
scripts/            コマンド登録（CLI フォールバック）
tests/              vitest（D1 含む）
```

## 開発者向け（CLI）

- `npm run deploy` = `node scripts/derive-db-name.mjs && wrangler deploy && npm run db:migrate:remote`。先頭の `derive-db-name` が D1 名を決定（下記「データベース名と複数インスタンス」参照）→ `wrangler deploy` で D1 を自動作成し id を `wrangler.jsonc` に書き戻す → `db:migrate:remote` が id を解決してマイグレーション適用。配布用 `wrangler.jsonc` は `database_id` を**記載しない（省略）**前提なので、この順番でないと未作成の D1 にマイグレーションを当てようとして失敗する。
- マイグレーションはバインディング名 `DB` 指定（`wrangler d1 migrations apply DB --remote`）。配布先の D1 が別名で生成されるため統一。

## シークレット

Cloudflare に fork を接続する場合は **Worker の Settings → Variables and Secrets**（接続フローで入力欄が出ればそこでも可）で、CLI では `wrangler secret put`（本番）/ `.dev.vars`（ローカル）で設定:

| 名前 | 説明 | 取得場所 |
|-------|------|---------|
| `DISCORD_PUBLIC_KEY` | 署名検証用の公開鍵 | Discord Developer Portal → General Information |
| `DISCORD_APPLICATION_ID` | アプリ ID（コマンド登録用） | 同上 |
| `DISCORD_BOT_TOKEN` | Bot のトークン | Discord Developer Portal → Bot |
| `ADMIN_TOKEN` | 管理 UI / API のパスワード（自分で決めた長い文字列） | 自分で生成 |

> 投稿チャンネルは通知（Notification）ごとに管理 UI で設定するため、単一の `DISCORD_CHANNEL_ID` は廃止されています。
> メンバーピッカー（参加者一覧の取得）には Discord の **Server Members Intent**（特権）の有効化が必要です。

## Cron

`wrangler.jsonc` の `triggers.crons = ["* * * * *"]`（毎分）でチェックを実行（奇数分＝出欠確認、偶数分＝日程調整。cron トリガーは 1 本だけ使います）。実際の送信は通知ごとの「通知配信時刻」でゲートされ、送信ログによる冪等化で二重送信を防ぎます。

## ドキュメント

- `setup.html` — **非エンジニア向けセットアップ（BOOTH 配布・ターミナル不要）**

## ライセンス

[MIT](LICENSE)
