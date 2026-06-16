/**
 * 日付計算ユーティリティ
 * [PRD 1] タイムゾーン: Asia/Tokyo (JST)
 */

/**
 * 日付をYYYY/MM/DD形式にフォーマット
 * @param {Date|string} date - 日付
 * @returns {string} YYYY/MM/DD形式の文字列
 */
function formatDate(date) {
    if (typeof date === 'string') {
        date = new Date(date);
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}/${month}/${day}`;
}

/**
 * 現在のJST時刻を取得
 * @returns {Date} JST時刻
 */
function getJSTNow() {
    // [Reliability] toLocaleStringに依存せず、計算でJST時間を生成
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000; // JST = UTC+9
    // 現在のUTC時刻 + 9時間 + (ローカルがUTCからどれだけずれているか補正)
    // Vercel(UTC)の場合: offset=0 => UTC+9h
    // ローカル(JST)の場合: offset=-9h => UTC (そのまま)
    return new Date(now.getTime() + (now.getTimezoneOffset() * 60 * 1000) + jstOffset);
}

/**
 * 次のイベント日を計算
 * [PRD 4.1] ターゲット日付の特定
 * @param {Object} config - 設定オブジェクト
 * @returns {Date} ターゲットイベント日
 */
function getTargetDate(config) {
    // [PRD 4.1] 現在日時を取得
    const now = getJSTNow();

    const targetDayOfWeek = config.eventDayOfWeek; // e.g., "WEDNESDAY"
    const eventStartTime = config.eventStartTime; // e.g., "21:00"

    const dayMap = {
        'SUNDAY': 0, 'MONDAY': 1, 'TUESDAY': 2, 'WEDNESDAY': 3,
        'THURSDAY': 4, 'FRIDAY': 5, 'SATURDAY': 6
    };

    const targetDay = dayMap[targetDayOfWeek];
    const currentDay = now.getDay();

    // 時刻をパース
    const [hours, minutes] = eventStartTime.split(':').map(Number);

    // 現在時刻と開始時刻の比較用 (分単位)
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentTimeInMinutes = currentHours * 60 + currentMinutes;
    const eventTimeInMinutes = hours * 60 + minutes;

    let daysToAdd = 0;

    // [PRD 4.1] 「今日」が Event_DayOfWeek と一致する場合
    if (currentDay === targetDay) {
        if (currentTimeInMinutes < eventTimeInMinutes) {
            // [PRD 4.1] 現在時刻 < Event_StartTime なら、ターゲットは 「今日」
            daysToAdd = 0;
        } else {
            // [PRD 4.1] 現在時刻 >= Event_StartTime なら、ターゲットは 「来週」
            daysToAdd = 7;
        }
    } else {
        // 今日以降の最も近いイベント日
        daysToAdd = (targetDay - currentDay + 7) % 7;
        // ※ (targetDay - currentDay + 7) % 7 が 0 になるのは currentDay == targetDay の場合のみだが
        // 上記if文で分岐済みなため、ここに来ることはない。
        // 万が一のための安全策としてCode.gs準拠で残す場合は以下だが、論理的には不要。
        if (daysToAdd === 0) {
            daysToAdd = 7;
        }
    }

    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() + daysToAdd);
    targetDate.setHours(hours, minutes, 0, 0);

    return targetDate;
}

/**
 * イベントまでの日数を計算
 * [PRD 4.1] daysUntilEvent = targetDate - today
 * @param {Date} targetDate - イベント日
 * @returns {number} 日数差
 */
function getDaysUntilEvent(targetDate) {
    const now = getJSTNow();

    // 時間部分をリセットして日付のみで比較 (Code.gsのロジックに合わせる推奨)
    // ただしCode.gsは単純引き算とMath.floorを使用していたため、それに従う。
    // targetDateはsetHoursされているため、nowも近い形にする必要があるが、
    // Code.gsは `const now = new Date(); ... diffTime = targetDate.getTime() - now.getTime();`
    // としていたため、厳密には時間差が含まれる。
    // しかし `Math.floor` しているので、例えば 「あと23時間」なら 0日、「あと25時間」なら 1日となる。
    // PRDの意図する「日数」として、ここでは「日付の差分」を計算するように明確化する。

    const target = new Date(targetDate);
    target.setHours(0, 0, 0, 0);

    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const diffTime = target.getTime() - today.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
}

module.exports = {
    formatDate,
    getTargetDate,
    getDaysUntilEvent,
    getJSTNow
};
