# Discord Event Master Bot - セットアップガイド (Vercel Only)

## 📋 前提条件
- Googleアカウント
- Google Cloudプロジェクト (サービスアカウント作成用)
- Discordサーバーの管理者権限
- Vercelアカウント(無料) - https://vercel.com/signup
- **Node.js 18以上 (必須)** - コマンド登録スクリプトの実行に必要です
  - [Node.js公式サイト](https://nodejs.org/)から「LTS」バージョンをインストールしてください


---

## 🚀 セットアップ手順

### ステップ1: Google Sheetsの作成

詳細は [SHEETS_SAMPLE.md](./SHEETS_SAMPLE.md) を参照してください。

**概要:**
1. Google Sheetsで新規スプレッドシート作成
2. 3つのシートを作成: `Config`, `Member_DB`, `Event_Log`
3. 各シートにヘッダー行とサンプルデータを入力

> **重要:** Configシートには以下の項目が必要です:
> - Event_DayOfWeek
> - Event_StartTime
> - Recruit_DaysBefore
> - Remind_Start_Days
> - Remind_Undecided_Days
> - Quota_Interval_Days
> - Recruit_Mention (メンション対象: ロールID / @everyone / 空欄)

---

### ステップ2: Google Cloud サービスアカウントの作成

**この作業の目的:**
BotがGoogle Sheetsを読み書きするために、専用の「ロボット用Googleアカウント」を作成します。


1. **Google Cloud Consoleにアクセス**
   - https://console.cloud.google.com/
   - 新規プロジェクトを作成 (例: EventBot)

2. **Google Sheets APIを有効化**
   - 「APIとサービス」→「ライブラリ」
   - 「Google Sheets API」を検索
   - 「有効にする」をクリック

3. **サービスアカウントを作成**
   - 「APIとサービス」→「認証情報」
   - 「認証情報を作成」→「サービスアカウント」
   - 名前: `eventbot-sheets` など
   - 役割: 不要 (スキップ)
   - 作成完了

4. **JSON鍵をダウンロード**
   - 作成したサービスアカウントをクリック
   - 「キー」タブ → 「鍵を追加」→「新しい鍵を作成」
   - 形式: JSON → 「作成」
   - ダウンロードされたJSONファイルを保管

5. **スプレッドシートを共有**
   - サービスアカウントのメールアドレスをコピー
     (例: `eventbot-sheets@your-project.iam.gserviceaccount.com`)
   - Google Sheetsを開く
   - 「共有」をクリック
   - サービスアカウントのメールアドレスを追加 (編集者権限)

---

### ステップ3: Discord Botの作成

1. **Discord Developer Portalにアクセス**
   - https://discord.com/developers/applications
   - 「New Application」をクリック
   - Bot名を入力 (例: EventMasterBot)

2. **Botを作成**
   - 左メニュー「Bot」をクリック
   - 「Add Bot」→ 「Yes, do it!」
   - 「Reset Token」をクリックして**Bot Token**をコピー

3. **Public KeyとApplication IDを取得**
   - 左メニュー「General Information」
   - **Public Key**をコピー
   - **Application ID**をコピー (後で`DISCORD_APPLICATION_ID`として使用します)


4. **Bot権限を設定**
   - 左メニュー「Bot」
   - 「Privileged Gateway Intents」セクションで以下をON:
     - ✅ MESSAGE CONTENT INTENT
   - 「Bot Permissions」で以下を選択:
     - ✅ Send Messages
     - ✅ Mention Everyone
     - ✅ Use Slash Commands

5. **Botをサーバーに追加**
   - 左メニュー「OAuth2」→「URL Generator」
   - 「SCOPES」: `bot`, `applications.commands`
   - 「BOT PERMISSIONS」: `Send Messages`, `Mention Everyone`, `Use Slash Commands`
   - 生成されたURLをブラウザで開き、サーバーを選択

6. **Channel IDを取得**
   - **Discordの設定 → 詳細設定 → 「開発者モード」をONにする** (必須)
   - メッセージを送信したいチャンネルを右クリック → 「IDをコピー」

---

### ステップ4: Vercelプロジェクトのデプロイ

1. **Vercelアカウント作成**
   - https://vercel.com/signup
   - GitHubアカウントでログイン推奨

2. **プロジェクトをGitHubにプッシュ (推奨)**
   
   GitHubを使うと、更新が楽になります。
   
   - [GitHub Desktop](https://desktop.github.com/) などを使い、このフォルダ (`ChoiemuEventBot`) をリポジトリとしてアップロードします。
   - または、GitHubのWebサイトで新規リポジトリを作成し、ファイルをアップロードしてください。

3. **Vercel Dashboardでプロジェクトをインポート**
   - https://vercel.com/new
   - GitHubリポジトリを選択してインポート

4. **環境変数を設定**
   - Vercel Dashboard → Settings → Environment Variables
   - 以下を追加:

   | Variable | Value | 説明 |
   |----------|-------|------|
   | `DISCORD_PUBLIC_KEY` | (コピーした値) | Discord Public Key |
   | `DISCORD_APPLICATION_ID` | (コピーした値) | Discord Application ID |
   | `DISCORD_BOT_TOKEN` | (コピーした値) | Discord Bot Token |
   | `DISCORD_CHANNEL_ID` | (コピーした値) | 送信先チャンネルID |
   | `GOOGLE_SPREADSHEET_ID` | (URLから取得) | `https://docs.google.com/spreadsheets/d/`**これ**`/edit` の部分 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | (JSONファイルの中身) | ダウンロードしたJSONファイルをメモ帳で開き、全選択してコピー |
   | `CRON_SECRET` | (任意の文字列) |Cron実行用のパスワード (例: `Choiemu1234`) |

   > **GOOGLE_SERVICE_ACCOUNT_JSONの設定:**
   > JSONファイルの中身をそのまま貼り付けてください。改行が含まれていてもVercelが自動的に処理してくれます（1行にする必要はありません）。


5. **デプロイ**
   - 「Deploy」をクリック
   - デプロイ完了後、**Vercel URLをコピー** (例: `https://your-project.vercel.app`)

---

### ステップ5: Discord Interactionエンドポイントの設定

1. **Discord Developer Portalに戻る**
   - アプリケーションページ → 「General Information」

2. **Interactions Endpoint URLを設定**
   - 「INTERACTIONS ENDPOINT URL」に以下を入力:
     ```
     https://your-project.vercel.app/api/discord
     ```
   - 「Save Changes」
   - ✅ 緑のチェックマークが表示されればOK!

---

### ステップ6: スラッシュコマンドの登録

1. **ローカルの`.env`に環境変数を設定**
   - コマンドプロンプトやターミナルではなく、メモ帳などで `.env` ファイルを作成/編集します
   ```
   DISCORD_BOT_TOKEN=ここにBotTokenを貼り付け
   DISCORD_APPLICATION_ID=ここにApplicationIDを貼り付け
   ```

2. **コマンド登録スクリプトを実行**
   - このフォルダでコマンドプロンプトを開き、以下を実行します:
   ```bash
   npm run register-commands
   ```
   - ※ Node.jsがインストールされていないとエラーになります

3. **登録されるコマンド**
   | コマンド | 説明 |
   |---------|------|
   | `/recruit` | 募集メッセージを手動送信 |
   | `/pause @user` | メンバーのステータスを「休止中」に設定 |
   | `/resume @user` | メンバーのステータスを解除 |
   | `/members` | メンバー一覧をステータス付きで表示 |
   | `/addmember @user` | 新メンバーをMember_DBに追加 |

4. **確認**
   - Discordで `/` と入力して5つのコマンドが候補に表示されることを確認
   - ※ グローバルコマンドは反映に最大1時間かかる場合があります

5. **コマンド権限の設定 (オプション)**
   - サーバー設定 → 連携サービス → Bot名 → 各コマンドの権限を設定
   - デフォルトでは管理者権限が必要ですが、ロール単位で許可を追加できます
   - 例: 「運営」ロールに全コマンドの使用を許可

---

## ✅ 動作確認

### テスト1: Cronエンドポイントの手動テスト
**ブラウザで以下のURLにアクセス:**
`https://your-project.vercel.app/api/cron?cron=CRON_SECRETで設定した値`
※ VercelのCronジョブ設定画面から「Run」ボタンを押すのが一番簡単です。


### テスト2: 募集メッセージのテスト
1. `Config`シートの`Recruit_DaysBefore`を一時的に調整
2. Cronエンドポイントを実行
3. Discordチャンネルにメッセージとボタンが届くことを確認
4. `Recruit_Mention`の設定値に応じたメンションが正しいことを確認

### テスト3: ボタン操作
1. Discordのボタンをクリック
2. 「✅ 参加 で記録しました!」というメッセージが表示される
3. `Event_Log`シートに記録されることを確認

### テスト4: スラッシュコマンド
1. `/recruit` → 募集メッセージ（メンションなし）がチャンネルに投稿されることを確認
2. `/pause @user` → 対象メンバーのStatusが「休止中」になることを確認
3. `/resume @user` → 対象メンバーのStatusがクリアされることを確認
4. `/members` → 全メンバー一覧がステータス付きで表示されることを確認
5. `/addmember @user` → 新メンバーがMember_DBに追加されることを確認
6. 権限のないユーザーにはコマンドが表示されないことを確認

### テスト5: リマインドDM
1. イベント日が近い状態でCronを実行
2. 未回答者のDMにリマインドが**ボタン付き**で届くことを確認
3. DMのボタンから参加/不参加/未定を回答できることを確認
4. Statusが設定されたメンバーにはリマインドが届かないことを確認

### テスト6: ステータス制限
1. Member_DBのC列にステータス（休止中、スタッフ等）を設定
2. そのメンバーが参加/不参加/未定ボタンを押すとブロックされることを確認
3. 状況確認ボタンは引き続き使用可能であることを確認
4. 状況確認の表示にそのメンバーが含まれないことを確認

---

## 🔧 トラブルシューティング

### Vercelデプロイでエラー
- `package.json`が正しいか確認
- `api/discord.js`, `api/cron.js`が存在するか確認
- `lib/`ディレクトリの全ファイルが存在するか確認

### Google Sheets接続エラー
- `GOOGLE_SERVICE_ACCOUNT_JSON`が正しいJSON形式か確認
- スプレッドシートがサービスアカウントのメールと共有されているか確認
- `GOOGLE_SPREADSHEET_ID`が正しいか確認

### Discord検証エラー
- Discord Public Keyが正しいか確認
- Vercel URLに`/api/discord`が付いているか確認

### ボタンが反応しない
- Vercelログを確認 (Vercel Dashboard → Deployments → Functions)
- 環境変数が正しく設定されているか確認

### Cronが動かない
- Vercel Dashboard → Settings → Crons で設定を確認 (`0 * * * *` になっているか)
- `Config` シートの `Notification_Time` が現在の時刻(Hour)と一致しているか
- Vercel Hobbyプランなどの制限でCronがスキップされていないか

---

## 📝 運用Tips

### メンバーの追加
- **方法1**: Discordで `/addmember @user` コマンドを使用（推奨）
- **方法2**: `Member_DB`シートに手動で行を追加

### メンバーの休止・除外
- **方法1**: Discordで `/pause @user` コマンドを使用
- **方法2**: `Member_DB`シートのC列（Status）に値を入力

Statusに**何かしらの値**が入っていれば、そのメンバーは以下から除外されます:
- リマインドDM送信
- ノルマチェック
- 状況確認の表示
- 参加/不参加/未定の回答

使用例: `休止中`、`スタッフ`、`引退` など自由に設定可能。
解除は `/resume @user` またはC列を空欄にするだけ。

### 表示名について
メンバーがボタン操作を行うと、Discordの表示名がD列に自動保存されます。
手動で設定することも可能です。状況確認では表示名が優先されます。

### 募集メンションの変更
`Config`シートの`Recruit_Mention`を変更するだけ。
- ロールID → 特定ロールにメンション
- `@everyone` → 全員にメンション
- 空欄 → メンションなし

### イベント曜日・時刻の変更
`Config`シートの値を変更するだけ。コード修正不要。

### 手動で募集メッセージを送信
Discordで `/recruit` コマンドを使用（管理者/指定ロール）。
Cronが動かなかった場合の手動リカバリに使用できます。

### 過去のログ確認
`Event_Log`シートで全イベントの参加履歴を確認可能。

### コマンド権限のカスタマイズ
Discordサーバー設定 → 連携サービス → Bot名から、
各コマンドの使用を許可するロール/メンバーを個別に設定できます。

---

## 🎉 完了!
これでDiscord Event Master Botが完全にVercelで稼働します!