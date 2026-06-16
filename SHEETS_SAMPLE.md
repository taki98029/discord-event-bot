# Google Sheets サンプルデータ

このファイルは、Botが使用するGoogle Sheetsの「設計図」です。
**この通りに3つのシート（ページ）を作成しないと、Botは動きません。**

---

## 全体像
1つのスプレッドシートの中に、以下の3つのシートを作成します：
1. **`Config`** : Botの設定（開催日や通知時間など）
2. **`Member_DB`** : メンバーリスト
3. **`Event_Log`** : 出欠の記録（Botが自動で書きます）

---

## シート1: Config

| Key | Value | 説明 |
|-----|-------|------|
| Event_DayOfWeek | WEDNESDAY | イベント開催曜日 (英語大文字) |
| Event_StartTime | 21:00 | イベント開始時刻 (HH:MM) |
| Recruit_DaysBefore | 6 | 募集開始日 (N日前) |
| Remind_Start_Days | 3 | 未回答リマインド開始日 (N日前) |
| Remind_Undecided_Days | 1 | 未定者リマインド日 (N日前) |
| Quota_Interval_Days | 30 | 参加間隔ノルマ (例: 30日に1回参加が必要) |
| Recruit_Mention | @everyone | 募集メッセージのメンション対象 (ロールID / @everyone / 空欄=メンションなし) |

| Discord_Bot_Token | YOUR_BOT_TOKEN_HERE | Discord Bot Token |
| Discord_Channel_ID | YOUR_CHANNEL_ID_HERE | Discord Channel ID |
| GAS_Auth_Token | YOUR_RANDOM_TOKEN_HERE | Vercel連携用認証トークン |

### 設定方法
1. Google Sheetsの下部にある「+」ボタンを押して新しいシートを作ります
2. シートの名前（タブの名前）をダブルクリックして **`Config`** に変更します
3. **A1**セルに「Key」、**B1**セルに「Value」と入力します
4. A2〜A12に、上の表の「Key」をそのままコピー＆ペーストします
5. B2〜B12に、あなたのサーバーに合わせた設定値を入力します


---

## シート2: Member_DB

| User Name | Discord User ID | Status | Display Name |
|-----------|-----------------|--------|--------------|
| taro_discord | 123456789012345678 | | 太郎 |
| hanako_discord | 234567890123456789 | | 花子 |
| jiro_discord | 345678901234567890 | 休止中 | 次郎 |
| staff_discord | 456789012345678901 | スタッフ | スタッフ太郎 |

### 設定方法
1. 新しいシートを作り、名前を **`Member_DB`** に変更します
2. 1行目（A1〜D1）に以下の見出しを入力します
   - A1: `User Name`
   - B1: `Discord User ID`
   - C1: `Status`
   - D1: `Display Name`
3. 2行目以降は**空のままでOK**です（Botが自動で追加します）
   - ※もちろん、最初から手動で入力しておいても構いません

### 各項目の説明
- **User Name (A列)**: わかりやすい名前（Botは使いません。管理用です）
- **Discord User ID (B列)**: Discordの「18桁くらいの数字」です（必須）
  - **自動追加機能**: 募集メッセージのボタンを押すと、Botが自動的にIDと名前をこのシートに追加します
  - 手動登録したい場合: Discord設定→詳細設定→「開発者モード」をONにし、ユーザーを右クリックして「IDをコピー」
- **Status (C列)**: ここに何か文字が入っていると、その人はリマインドやノルマチェックから除外されます
  - 例: `休止中`、`スタッフ`、`引退` など。空欄なら「参加対象」扱いです
- **Display Name (D列)**: 状況確認メッセージで表示される名前です
  - 空欄でもOKです（Botが自動的にDiscordの表示名を保存してくれます）


---

## シート3: Event_Log

| Event Date | User ID | User Name | Status | Timestamp |
|------------|---------|-----------|--------|-----------|
| 2026/02/12 | 123456789012345678 | 太郎 | 参加 | 2026-02-06 10:30:00 |
| 2026/02/12 | 234567890123456789 | 花子 | 不参加 | 2026-02-06 11:15:00 |
| 2026/02/12 | 345678901234567890 | 次郎 | 未定 | 2026-02-06 14:20:00 |

### 設定方法
### 設定方法
1. 新しいシートを作り、名前を **`Event_Log`** に変更します
2. 1行目（A1〜E1）に以下の見出しを入力するだけでOKです（**データは空で大丈夫**）
   - A1: `Event Date`
   - B1: `User ID`
   - C1: `User Name`
   - D1: `Status`
   - E1: `Timestamp`

**注意:** このシートは基本的に自動管理されるため、手動での編集は不要です。

---

## 📝 シート作成の完全手順

### 1. 新規スプレッドシート作成
1. https://sheets.google.com/ にアクセス
2. 「空白」で新規作成
3. 名前を「EventBot_DB」などに変更

### 2. デフォルトシートの名前変更
1. 下部のシートタブ「シート1」を右クリック → 「名前を変更」
2. 「Config」に変更

### 3. 追加シート作成
1. 下部の「+」ボタンをクリック
2. 新しいシートが作成される
3. シート名を「Member_DB」に変更
4. もう一度「+」ボタンで3つ目のシートを作成
5. シート名を「Event_Log」に変更

### 4. 各シートにデータ入力
- **Config**: 全項目埋めてください
- **Member_DB**: 最低でも自分1行分は入力してください（テスト用）
- **Event_Log**: 1行目の見出しだけでOKです


---

## ✅ 設定完了後の確認事項

- [ ] 3つのシート (Config, Member_DB, Event_Log) が作成されている
- [ ] Configシートに10個の設定項目が入力されている
- [ ] Member_DBシートにメンバー情報が入力されている
- [ ] Event_Logシートにヘッダー行が作成されている
- [ ] スプレッドシートのタイムゾーンが「Asia/Tokyo」になっている
  - (ファイル → 設定 → 全般タブ → タイムゾーン)

---

これでGoogle Sheetsの準備は完了です! 次は[SETUP.md](file:///c:/Users/Owner/Documents/ChoiemuEventBot/SETUP.md)に従ってDiscord Botの設定を行ってください。
