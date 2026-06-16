# Cloudflare 移行 設計ドキュメント

ChoiemuEventBot（Discord イベント勤怠管理 Bot）を **Vercel + Google Sheets** から
**Cloudflare Workers + D1** へ移行し、あわせて **管理用の専用 UI** を追加するための設計。

- 作成日: 2026-06-17
- 方針決定方法: grill-me による設計レビュー（全10論点を確定）
- 関連: [`PRD.txt`](../PRD.txt)（現行仕様）, [`README.md`](../README.md), [`SETUP.md`](../SETUP.md)

---

## 1. 背景とゴール

| 項目 | 現状 | 移行後 |
|------|------|--------|
| ホスティング | Vercel Serverless Functions | **Cloudflare Workers**（単一 Worker） |
| データ | Google Sheets（`googleapis`） | **Cloudflare D1**（SQLite） |
| 管理 | スプレッドシートを直接編集 | **専用 UI**（Worker に同梱配信） |
| 配布形態 | 個人運用 | **自己ホスト型（OSS 公開想定）** |

**設計原則**

1. **自己ホスト最優先** — 利用者が登録するサービスを最小化（Discord + Cloudflare のみ）、完全無料枠で動作。
2. **1:1 機能パリティ** — 今回は「同じ動作を Cloudflare で再現」に集中。マルチテナント化・仕様改善は次弾。
3. **単一デプロイ** — `wrangler deploy` 1 回で Bot・cron・UI がすべて立ち上がる。

---

## 2. 確定した設計判断（Decision Record）

| # | 論点 | 確定内容 |
|---|------|---------|
| 1 | スコープ | 1:1 機能パリティ移植 + 専用 UI。マルチテナント化・仕様改善は次弾 |
| 2 | トポロジー | 単一 Worker・単一 D1（fetch=interactions+admin / scheduled=cron / 静的アセット=UI 同梱） |
| 3 | データモデル | UI 対象 = config / members(=メンバーマスタ) / event_log(閲覧)。用語は "member" |
| 4 | データ移行 | 3 テーブル全移行（履歴必須）。一度きりの移行スクリプト。規模 20 名・半年・約 500 行 |
| 5 | スキーマ | config=KV 型 / members(+dm_channel_id) / event_log 複合 PK で upsert |
| 6 | UI 認証 | 管理者トークン方式（`ADMIN_TOKEN` シークレット 1 個・Bearer・定数時間比較）。将来 Cloudflare Access へ昇格可 |
| 7 | 言語/構成 | TypeScript・`src/` 構成・ローカル git 管理 |
| 8 | cron | 固定 `0 12 * * *` UTC(=JST21:00)・現挙動忠実再現。下記 2 点は次弾送り |
| 9 | Interaction | 同期 type4 応答 + 副作用は `ctx.waitUntil()` / `discord-interactions` で署名検証（`tweetnacl` 廃止） |
| 10 | テスト/dev | vitest + @cloudflare/vitest-pool-workers（重点= db/ と lib/date） / `wrangler dev` + cloudflared トンネル + テスト用 Discord アプリ |

### 次弾送り（今回は現挙動のまま移植）

- **`Notification_Time` が未使用（デッド設定）** — 現状は cron スケジュール（JST21:00）が実質ハードコード。configで可変にするには毎時起動+時刻判定が必要。
- **当日リマインドが実質 no-op** — cron が JST21:00 発火 ＝ イベント開始時刻と同時のため `現在時刻 < 開始時刻` が成立しない。

---

## 3. アーキテクチャ

```
                       Discord
                          │  (Interactions / Bot REST)
                          ▼
┌─────────────────────────────────────────────┐
│  Cloudflare Worker  (choiemu-event-bot)       │
│                                               │
│  fetch(request, env, ctx)                     │
│   ├─ POST /interactions   署名検証→コマンド/ボタン (公開)│
│   ├─ /api/admin/*         トークン認証→CRUD API        │
│   └─ /* (それ以外)         静的アセット(UI)を配信         │
│                                               │
│  scheduled(event, env, ctx)                   │
│   └─ 日次チェック (募集/未回答/未定/ノルマ)              │
│                                               │
│   静的アセット: ui/  (管理 SPA)                  │
└───────────────┬───────────────────────────────┘
                │ D1 binding (env.DB)
                ▼
          Cloudflare D1  (choiemu-event-bot-db)
          ├─ config       (key/value)
          ├─ members      (メンバーマスタ)
          └─ event_log    (出欠記録)
```

### ルーティング規約

| パス | 認証 | ハンドラ |
|------|------|---------|
| `POST /interactions` | Ed25519 署名（Discord） | `src/interactions/` |
| `/api/admin/*` | `Authorization: Bearer <ADMIN_TOKEN>` | `src/admin/` |
| `GET /admin`, `/`, その他 | なし（静的） | `env.ASSETS` で `ui/` を配信 |

> `/interactions` は Discord が叩くため公開必須。UI/API のみトークンで保護する（パス単位の認証）。

---

## 4. データモデル（D1 スキーマ）

`migrations/0001_init.sql` 参照。

```sql
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE members (
  user_id       TEXT PRIMARY KEY,        -- Discord User ID
  user_name     TEXT,                    -- 管理用名（旧 Member_DB A 列）
  status        TEXT NOT NULL DEFAULT '',-- 休止中/スタッフ等。空=アクティブ（旧 C 列）
  display_name  TEXT,                    -- 表示名・自動更新（旧 D 列）
  dm_channel_id TEXT,                    -- DM チャンネル ID キャッシュ（サブリクエスト削減）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_log (
  event_date TEXT NOT NULL,              -- 'YYYY/MM/DD'（JST・ゼロ埋めで辞書順=時系列順）
  user_id    TEXT NOT NULL,
  user_name  TEXT,
  status     TEXT NOT NULL,              -- 参加/不参加/未定
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_date, user_id)      -- upsert の自然キー
);
CREATE INDEX idx_event_log_user ON event_log(user_id);
```

### config の既知キー（旧 Config シート互換）

| キー | 例 | 用途 |
|------|----|------|
| `Event_DayOfWeek` | `WEDNESDAY` | 開催曜日（英大文字） |
| `Event_StartTime` | `21:00` | 開始時刻 `HH:MM` |
| `Recruit_DaysBefore` | `6` | 何日前に募集 |
| `Remind_Start_Days` | `3` | 未回答リマインド開始日 |
| `Remind_Undecided_Days` | `1` | 未定者リマインド日 |
| `Quota_Interval_Days` | `30` | ノルマ間隔日数 |
| `Recruit_Mention` | `@everyone` / ロール ID | 募集時メンション |
| `Notification_Time` | `21` | （現状未使用・次弾） |

---

## 5. 主要ロジックの対応表（旧 → 新）

| 旧（Sheets 実装） | 新（D1 実装） | 備考 |
|------|------|------|
| `getAllConfig()` | `db/config.ts: getAllConfig()` | `SELECT * FROM config` |
| `getAllMembers()` | `db/members.ts: getAllMembers()` | |
| `upsertEventLog()`（全行走査+rowIndex） | `db/eventLog.ts: upsert()` | `INSERT ... ON CONFLICT DO UPDATE` 一発 |
| `checkQuotaStatus()` | `db/eventLog.ts: checkQuota()` | 参加最終日を SQL で集計 |
| `getEventStatus()` | `db/eventLog.ts: getEventStatus()` | 休止メンバー除外 |
| `getUndecidedUsers()` | `db/eventLog.ts: getUndecided()` | |
| `setMemberStatus()` / `addMember()` / `updateMemberDisplayName()` | `db/members.ts` 各関数 | |
| `lib/discord.js`（fetch） | `src/discord/rest.ts` | ほぼ流用。DM は `dm_channel_id` キャッシュ |
| `lib/date-utils.js` | `src/lib/date.ts` | JST 計算。テスト重点 |
| `api/discord.js` | `src/interactions/` + `src/index.ts` | 署名検証は `verifyKey` |
| `api/cron.js` | `src/cron/dailyCheck.ts` + `scheduled()` | |

### サブリクエスト上限対策（重要）

Workers 無料枠は **1 起動あたりサブリクエスト 50 回**。DM は「DM チャンネル作成 + 送信」で 2 回消費する。
20 名全員に DM すると 40 回となり上限に近い。

→ **`members.dm_channel_id` に初回作成時のチャンネル ID を保存**し、以降は作成を省略（1 回に半減）。
これで 20 名 = 20 回程度に収まり、将来の増員にも耐える。

---

## 6. 移行とカットオーバー

1. `scripts/migrate-from-sheets.mjs` を**ローカルで 1 回だけ実行**
   （既存 `googleapis` で 3 シートを読み出し → D1 へ INSERT）。
2. `wrangler dev` + cloudflared トンネルで**テスト用 Discord アプリ**を使い動作確認。
3. 本番 D1 へ移行データ投入 → Discord Developer Portal の **Interaction Endpoint URL を Worker の URL に差し替え**。
4. 旧 Vercel デプロイを停止。`api/`・`lib/`・`vercel.json` は撤去（このリポジトリからは移行完了後に削除）。

> 移行中は旧 Vercel コード（`api/`, `lib/`）と新 `src/` が**併存**する。新コードが完成・検証できるまで本番は止めない。

---

## 7. 環境変数 / シークレット

すべて `wrangler secret put`（本番）/ `.dev.vars`（ローカル・gitignore 済）で設定。**コミットしない。**

| 名前 | 種別 | 取得元 |
|------|------|--------|
| `DISCORD_PUBLIC_KEY` | secret | 既存 `.env` |
| `DISCORD_APPLICATION_ID` | secret | 既存 `.env` |
| `DISCORD_BOT_TOKEN` | secret | 既存 `.env` |
| `DISCORD_CHANNEL_ID` | secret | 既存 `.env` |
| `ADMIN_TOKEN` | secret | 新規生成（長いランダム文字列） |

`wrangler.toml` には D1 バインド（`database_id` はデプロイ者が `wrangler d1 create` 後に記入）と cron のみ。

---

## 8. テスト / ローカル開発

- **テスト**: `vitest` + `@cloudflare/vitest-pool-workers`。重点は `src/db/`（upsert・ノルマ・除外）と `src/lib/date.ts`（JST）。
- **ローカル**: `wrangler dev`（ローカル D1）。Discord 検証は `cloudflared` クイックトンネルで一時公開し、**本番と別のテスト用 Discord アプリ**の Interaction Endpoint に設定。

---

## 9. 実装フェーズ

- **0. 基盤** — git・`package.json`・`wrangler.toml`・`tsconfig`・雛形
- **1. データ層** — `migrations/`・`src/db/`・`src/lib/date.ts`・テスト
- **2. Discord 連携** — `src/discord/`・`src/interactions/`・`src/index.ts` fetch
- **3. cron** — `src/cron/`・`scheduled()`
- **4. 移行 & カットオーバー** — `scripts/migrate-from-sheets.mjs`・`register-commands`
- **5. 専用 UI** — `ui/`・`src/admin/`
- **6. 仕上げ** — README/SETUP 更新・テスト green
