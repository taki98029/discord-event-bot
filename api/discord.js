const nacl = require('tweetnacl');
const { upsertEventLog, getAllConfig, updateMemberDisplayName, getAllMembers, setMemberStatus, addMember } = require('../lib/sheets');
const { sendDiscordMessage, createButtonComponents } = require('../lib/discord');
const { formatDate, getTargetDate } = require('../lib/date-utils');

/**
 * Discord Interaction署名を検証
 * @param {string} signature - X-Signature-Ed25519ヘッダーの値
 * @param {string} timestamp - X-Signature-Timestampヘッダーの値
 * @param {string} body - リクエストボディ(生データ)
 * @param {string} publicKey - Discord Application Public Key
 * @returns {boolean} 検証結果
 */
function verifyDiscordSignature(signature, timestamp, body, publicKey) {
  try {
    const message = new Uint8Array(Buffer.from(timestamp + body));
    const signatureBuffer = new Uint8Array(Buffer.from(signature, 'hex'));
    const publicKeyBuffer = new Uint8Array(Buffer.from(publicKey, 'hex'));

    return nacl.sign.detached.verify(
      message,
      signatureBuffer,
      publicKeyBuffer
    );
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * rawBodyを取得するためのヘルパー
 * @param {Object} req - Vercel Request
 * @returns {Promise<string>} 生のリクエストボディ
 */
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Vercel Serverless Function - Discord Interactionハンドラー
 * [PRD 4.3] 回答処理 (doPost) - Upsert & Response
 */
module.exports = async (req, res) => {
  console.log('[Discord] Received request:', req.method);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    console.error('[Discord] Missing DISCORD_PUBLIC_KEY environment variable');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!signature || !timestamp) {
    console.error('[Discord] Missing signature headers');
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  // 生のリクエストボディを取得 (署名検証用)
  // [Security] User Review #6: bodyParser: falseを前提とし、JSON.stringifyによる再構築を避ける
  let rawBody;
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
  } else {
    try {
      // bodyParser: false の場合、ここに来るはず
      rawBody = await getRawBody(req);
    } catch (error) {
      console.error('[Discord] Failed to read raw body:', error);
      return res.status(400).json({ error: 'Failed to read request body' });
    }
  }

  const isValid = verifyDiscordSignature(signature, timestamp, rawBody, publicKey);

  if (!isValid) {
    console.error('[Discord] Signature verification failed');
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  console.log('[Discord] Signature verified ✓');

  let interaction;
  try {
    interaction = typeof rawBody === 'string' ? JSON.parse(rawBody) : req.body;
  } catch (error) {
    console.error('[Discord] Failed to parse body:', error);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Ping応答 (type: 1)
  if (interaction.type === 1) {
    console.log('[Discord] Responding to PING');
    return res.status(200).json({ type: 1 });
  }

  // [PRD 4.3] Discordからのボタン操作(Interaction JSON)を受け取る
  // Type 2: APPLICATION_COMMAND (スラッシュコマンド)
  if (interaction.type === 2) {
    const commandName = interaction.data?.name;
    console.log(`[Discord] Slash command: /${commandName}`);

    if (commandName === 'recruit') {
      try {
        const config = await getAllConfig();
        const targetDate = getTargetDate({
          eventDayOfWeek: config.Event_DayOfWeek,
          eventStartTime: config.Event_StartTime
        });
        const targetDateStr = formatDate(targetDate);

        const message = `📅 **イベント募集開始!**\n\n` +
          `日時: **${targetDateStr} (${config.Event_DayOfWeek}) ${config.Event_StartTime}~**\n\n` +
          `参加状況を下のボタンで回答してください!`;

        const components = createButtonComponents(targetDateStr);
        await sendDiscordMessage(message, components);

        return res.status(200).json({
          type: 4,
          data: {
            content: `✅ **${targetDateStr}** の募集メッセージを送信しました!`,
            flags: 64
          }
        });
      } catch (error) {
        console.error('[Discord] /recruit error:', error.message);
        return res.status(200).json({
          type: 4,
          data: {
            content: '❌ 募集メッセージの送信に失敗しました。',
            flags: 64
          }
        });
      }
    }

    if (commandName === 'pause') {
      try {
        const targetUserId = interaction.data.options?.[0]?.value;
        const resolved = interaction.data.resolved?.users?.[targetUserId];
        const targetName = resolved?.global_name || resolved?.username || targetUserId;

        const found = await setMemberStatus(targetUserId, '休止中');
        if (found) {
          return res.status(200).json({
            type: 4,
            data: { content: `⏸️ **${targetName}** を休止中に設定しました。`, flags: 64 }
          });
        } else {
          return res.status(200).json({
            type: 4,
            data: { content: `❌ **${targetName}** はMember_DBに登録されていません。`, flags: 64 }
          });
        }
      } catch (error) {
        console.error('[Discord] /pause error:', error.message);
        return res.status(200).json({
          type: 4,
          data: { content: '❌ ステータスの更新に失敗しました。', flags: 64 }
        });
      }
    }

    if (commandName === 'resume') {
      try {
        const targetUserId = interaction.data.options?.[0]?.value;
        const resolved = interaction.data.resolved?.users?.[targetUserId];
        const targetName = resolved?.global_name || resolved?.username || targetUserId;

        const found = await setMemberStatus(targetUserId, '');
        if (found) {
          return res.status(200).json({
            type: 4,
            data: { content: `▶️ **${targetName}** の休止中を解除しました。`, flags: 64 }
          });
        } else {
          return res.status(200).json({
            type: 4,
            data: { content: `❌ **${targetName}** はMember_DBに登録されていません。`, flags: 64 }
          });
        }
      } catch (error) {
        console.error('[Discord] /resume error:', error.message);
        return res.status(200).json({
          type: 4,
          data: { content: '❌ ステータスの更新に失敗しました。', flags: 64 }
        });
      }
    }

    if (commandName === 'members') {
      try {
        const members = await getAllMembers();
        if (members.length === 0) {
          return res.status(200).json({
            type: 4,
            data: { content: '📋 登録メンバーはいません。', flags: 64 }
          });
        }

        let message = `📋 **メンバー一覧 (${members.length}名)**\n\n`;
        for (const m of members) {
          const statusIcon = m.status ? '⏸️' : '🟢';
          const statusText = m.status || 'アクティブ';
          const name = m.displayName || m.name;
          message += `${statusIcon} **${name}** (${m.name}) - ${statusText}\n`;
        }

        return res.status(200).json({
          type: 4,
          data: { content: message, flags: 64 }
        });
      } catch (error) {
        console.error('[Discord] /members error:', error.message);
        return res.status(200).json({
          type: 4,
          data: { content: '❌ メンバー一覧の取得に失敗しました。', flags: 64 }
        });
      }
    }

    if (commandName === 'addmember') {
      try {
        const targetUserId = interaction.data.options?.[0]?.value;
        const resolved = interaction.data.resolved?.users?.[targetUserId];
        const targetUserName = resolved?.username || '';
        const targetDisplayName = interaction.data.resolved?.members?.[targetUserId]?.nick
          || resolved?.global_name || targetUserName;

        const result = await addMember(targetUserId, targetUserName, targetDisplayName);
        if (result === 'exists') {
          return res.status(200).json({
            type: 4,
            data: { content: `⚠️ **${targetDisplayName}** は既に登録されています。`, flags: 64 }
          });
        }
        return res.status(200).json({
          type: 4,
          data: { content: `✅ **${targetDisplayName}** (${targetUserName}) をMember_DBに追加しました!`, flags: 64 }
        });
      } catch (error) {
        console.error('[Discord] /addmember error:', error.message);
        return res.status(200).json({
          type: 4,
          data: { content: '❌ メンバーの追加に失敗しました。', flags: 64 }
        });
      }
    }

    // 未知のコマンド
    return res.status(200).json({
      type: 4,
      data: {
        content: '❌ 不明なコマンドです',
        flags: 64
      }
    });
  }

  // Type 3: MESSAGE_COMPONENT (ボタン操作)
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id;
    // DMの場合は interaction.user、サーバーの場合は interaction.member.user
    const user = interaction.member?.user || interaction.user;

    if (!customId || !user) {
      console.error('[Discord] Missing custom_id or user');
      return res.status(400).json({ error: 'Invalid interaction data' });
    }

    const userId = user.id;
    const userName = user.username;
    // Discord表示名: サーバーニックネーム > グローバル表示名 > ユーザー名
    const displayName = interaction.member?.nick || user.global_name || userName;

    console.log(`[Discord] Button clicked: ${customId} by ${displayName} (${userName})`);

    // [PRD 4.3] custom_id形式: {action}_{YYYY/MM/DD}
    // これによりボタン押下時にイベント日付を特定できる
    const parts = customId.split('_');
    const action = parts[0];
    const eventDate = parts.slice(1).join('_');

    // [PRD 4.3] StatusMapping
    const statusMap = {
      'participate': '参加',
      'absent': '不参加',
      'undecided': '未定'
    };

    // [PRD 4.4] 状況確認 (Status Check)
    if (action === 'status') {
      const { getEventStatus } = require('../lib/sheets');
      const { buildStatusMessage } = require('../lib/discord.js');

      try {
        const statusData = await getEventStatus(eventDate);
        const messageContent = buildStatusMessage(eventDate, statusData);

        return res.status(200).json({
          type: 4,
          data: {
            content: messageContent,
            flags: 64 // Ephemeral
          }
        });
      } catch (error) {
        console.error('[Discord] Failed to get status:', error.message);
        return res.status(200).json({
          type: 4,
          data: {
            content: '❌ 状況確認に失敗しました。',
            flags: 64
          }
        });
      }
    }

    const status = statusMap[action];

    if (!status) {
      console.error('[Discord] Unknown action:', action);
      return res.status(200).json({
        type: 4,
        data: {
          content: '❌ 不明なアクションです',
          flags: 64
        }
      });
    }

    // Statusが設定されているメンバーは回答を制限
    try {
      const members = await getAllMembers();
      const member = members.find(m => m.userId === userId);

      if (member) {
        // 既存メンバーの場合、Statusチェック
        if (member.status) {
          return res.status(200).json({
            type: 4,
            data: {
              content: `⏸️ あなたは現在「${member.status}」のため、回答できません。\n管理者に \`/resume\` でステータスを解除してもらってください。`,
              flags: 64
            }
          });
        }
      } else {
        // [New Feature] 未登録メンバーの場合、自動登録
        try {
          await addMember(userId, userName, displayName);
          console.log(`[Discord] Auto-registered new member: ${displayName} (${userId})`);
        } catch (addErr) {
          console.error('[Discord] Failed to auto-register member:', addErr.message);
          // 登録失敗しても、ログ記録は続行する (致命的エラーではない)
        }
      }
    } catch (err) {
      console.error('[Discord] Failed to check member status:', err.message);
      // チェック失敗時は回答を許可（安全側に倒す）
    }

    // [PRD 4.3] Upsert処理: Event_Log を検索し、一致すれば更新、なければ新規追加
    try {
      await upsertEventLog(eventDate, userId, userName, status);

      // Member_DBの表示名を自動更新 (未設定の場合のみ)
      updateMemberDisplayName(userId, displayName, userName).catch(err => {
        console.error('[Discord] Failed to update display name:', err.message);
      });

      console.log(`[Discord] Recorded to Sheets: ${displayName} (${userName}) - ${status}`);

      // [PRD 4.3] レスポンス処理 (重要)
      // 3秒以内に JSON形式 (type: 4) で正常レスポンスを返す
      return res.status(200).json({
        type: 4,
        data: {
          content: `✅ **${status}** で記録しました!`,
          flags: 64 // Ephemeral (自分にしか見えない)
        }
      });
    } catch (error) {
      console.error('[Discord] Failed to record:', error.message);
      return res.status(200).json({
        type: 4,
        data: {
          content: '❌ 記録に失敗しました。管理者に連絡してください。',
          flags: 64
        }
      });
    }
  }

  console.log('[Discord] Unknown interaction type:', interaction.type);
  return res.status(200).json({
    type: 4,
    data: {
      content: 'このインタラクションはサポートされていません',
      flags: 64
    }
  });
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
