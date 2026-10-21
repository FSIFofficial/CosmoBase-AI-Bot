import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import { GoogleGenAI } from "@google/genai";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

/* ========= 投稿時間制限（日本時間） ========= */
function isAllowedTime() {
  // 動かすサーバーのタイムゾーンに関係なく日本時間で判定する
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const weekday = parts.find(p => p.type === "weekday").value;
  const hour = Number(parts.find(p => p.type === "hour").value);

  if (weekday === "Sat" || weekday === "Sun") {
    return hour >= 12 && hour < 22;
  }
  return hour >= 7 && hour < 22;
}

/* ========= プロンプト ========= */
const SYSTEM_PROMPT = `
あなたは「Cosmo Base」という、初心者歓迎の宇宙コミュニティのAIです。
宇宙に詳しくない人にも寄り添い、「宇宙を身近な選択肢」として感じてもらうことが役割です。
「宇宙に少し詳しい、優しいお兄さん」のような存在として振る舞ってください。

回答ルール：
・断定しすぎず、現実的な距離感を大切にする
・専門用語は極力使わず、使う場合は一言で補足する
・未来を過度に煽らない
・見出しや箇条書きは使わない
・質問者を否定しない
・回答は3〜6文程度に収める
・可能であれば「身近な例」や「生活とのつながり」を1つ入れる
・宇宙と関係ない話題や雑談には、短く自然に返し、無理に宇宙の話につなげない

文体・トーン：
・落ち着いていて、少しワクワクを残す
・「教える」ではなく「一緒に考える」姿勢
・上から目線にならない
・言い切らず、「〜と言われていることも多いです」など余白を残す
・「です・ます」を基本に、ときどき「〜だね」「〜かな」くらいのやわらかさを混ぜる
・「こんにちは」「ようこそ」などのあいさつや、自己紹介から始めない
・いきなり本題から入る
・「！」は使っても1回まで。テンションを上げすぎない
・「素晴らしい質問ですね」のような質問をほめる前置きはしない
・絵文字や顔文字は使わない

回答の締め：
・最後は必ず、
  「他の人はどう考えているのか、ちょっと聞いてみたいな」
  「いろんな視点がありそうで、気になるな」
  などのように、
“自分も興味を持っている”ニュアンスで終える
・「聞いてみてください」「質問してみてください」は使わない
`;

/* ========= 設定 ========= */
const SCAN_LIMIT = 50; // 未回答チェックで確認する直近メッセージ数
const SCAN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // これより古い質問には答えない
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 未回答チェックの間隔
const MAX_RETRY = 3;

const answering = new Set(); // 回答中のメッセージID（二重回答防止）
let scanning = false;

/* ========= 起動 ========= */
client.once("clientReady", async () => {
  console.log(`🤖 Logged in as ${client.user.tag} (model: ${GEMINI_MODEL})`);
  await scanUnansweredMessages();

  // 時間外に来た質問にも、受付時間になったら答える
  setInterval(scanUnansweredMessages, SCAN_INTERVAL_MS);
});

/* ========= メッセージ ========= */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!isAllowedTime()) return;

  const channelId = message.channel.isThread()
    ? message.channel.parentId
    : message.channelId;
  if (channelId !== process.env.QUESTION_CHANNEL_ID) return;

  try {
    /* ===== メンション対応 ===== */
    if (message.mentions.has(client.user)) {
      await answerMention(message);
      return;
    }

    /* ===== 新しい質問（返信ではない投稿）に回答 ===== */
    if (isQuestion(message)) {
      await answerQuestion(message);
    }
  } catch (err) {
    console.error("返信エラー:", err);
  }
});

/* ========= 質問判定 ========= */
// 質問チャンネル直下の、誰かへの返信ではない投稿を質問とみなす
function isQuestion(message) {
  if (message.author.bot) return false;
  if (message.channel.isThread()) return false;
  if (message.reference) return false;
  return message.content.trim().length > 0;
}

/* ========= 未回答チェック ========= */
async function scanUnansweredMessages() {
  if (!isAllowedTime() || scanning) return;
  scanning = true;

  try {
    const channel = await client.channels.fetch(
      process.env.QUESTION_CHANNEL_ID
    );

    if (channel.type !== ChannelType.GuildText) {
      console.log("QUESTION_CHANNEL_ID がテキストチャンネルではありません");
      return;
    }

    const messages = await channel.messages.fetch({ limit: SCAN_LIMIT });

    // Botが既に返信した質問のID
    const answeredIds = new Set(
      [...messages.values()]
        .filter(m => m.author.id === client.user.id && m.reference?.messageId)
        .map(m => m.reference.messageId)
    );

    const unanswered = [...messages.values()]
      .reverse()
      .filter(m => isQuestion(m))
      .filter(m => !answeredIds.has(m.id))
      .filter(m => Date.now() - m.createdTimestamp < SCAN_MAX_AGE_MS);

    for (const message of unanswered) {
      await answerQuestion(message);
    }
  } catch (err) {
    console.error("未回答チェックエラー:", err);
  } finally {
    scanning = false;
  }
}

/* ========= 質問への回答 ========= */
async function answerQuestion(message) {
  if (answering.has(message.id)) return;
  answering.add(message.id);

  try {
    const reply = await generateWithRetry(message.content);
    if (reply) await message.reply(reply);
  } finally {
    answering.delete(message.id);
  }
}

/* ========= メンションへの回答 ========= */
async function answerMention(message) {
  const messages = await message.channel.messages.fetch({ limit: 20 });

  const history = [...messages.values()]
    .reverse()
    .filter(m => m.id !== message.id)
    .map(m => {
      const name = m.author.id === client.user.id ? "あなた" : m.author.username;
      return `${name}: ${cleanMention(m.content)}`;
    })
    .join("\n");

  const prompt = `
以下はチャンネルの最近の会話です。
${history}

今、${message.author.username} さんがあなたを呼んで、こう書きました。
「${cleanMention(message.content)}」

会話の流れをふまえて、この呼びかけに返事をしてください。
`;

  const reply = await generateWithRetry(prompt);
  if (reply) await message.reply(reply);
}

// メッセージ中のメンション表記（<@123...>）を取り除く
function cleanMention(text) {
  return text.replace(/<@!?\d+>/g, "").trim();
}

/* ========= AI生成 ========= */
async function generateWithRetry(text) {
  for (let i = 1; i <= MAX_RETRY; i++) {
    const reply = await generateAIReply(text);
    if (reply) return reply;
    console.log(`FAIL ${i}回`);
  }
  return null;
}

async function generateAIReply(text) {
  try {
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: text,
      config: { systemInstruction: SYSTEM_PROMPT },
    });

    return result.text || null;
  } catch (err) {
    console.error("Geminiエラー詳細:", err);
    return null;
  }
}

/* ========= ログイン ========= */
client.login(process.env.DISCORD_TOKEN);

/* ========= 自動終了（GitHub Actions用） ========= */
// RUN_MINUTES が設定されていれば、その分数で正常終了する（未設定なら常駐）
const runMinutes = Number(process.env.RUN_MINUTES);
if (runMinutes > 0) {
  setTimeout(async () => {
    console.log(`⏹ ${runMinutes}分経過したので終了します`);
    await client.destroy();
    process.exit(0);
  }, runMinutes * 60 * 1000);
}
