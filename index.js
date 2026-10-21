import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ========= 投稿時間制限 ========= */
function isAllowedTime() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();

  if (day === 0 || day === 6) {
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
・最初の質問に対して1回だけ返信する
・断定しすぎず、現実的な距離感を大切にする
・専門用語は極力使わず、使う場合は一言で補足する
・未来を過度に煽らない
・見出しや箇条書きは使わない
・質問者を否定しない
・回答は3〜6文程度に収める
・可能であれば「身近な例」や「生活とのつながり」を1つ入れる

文体・トーン：
・落ち着いていて、少しワクワクを残す
・「教える」ではなく「一緒に考える」姿勢
・上から目線にならない
・言い切らず、「〜と言われていることも多いです」など余白を残す

回答の締め：
・最後は必ず、
  「他の人はどう考えているのか、ちょっと聞いてみたいな」
  「いろんな視点がありそうで、気になるな」
  などのように、
“自分も興味を持っている”ニュアンスで終える
・「聞いてみてください」「質問してみてください」は使わない
`;

/* ========= 設定 ========= */
const SCAN_LIMIT = 50; // 起動時に確認する直近メッセージ数
const SCAN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // これより古い質問には答えない
const MAX_RETRY = 3;

/* ========= 起動 ========= */
client.once("clientReady", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await scanUnansweredMessages();
});

/* ========= メッセージ ========= */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!isAllowedTime()) return;

  const channelId = message.channel.isThread()
    ? message.channel.parentId
    : message.channelId;
  if (channelId !== process.env.QUESTION_CHANNEL_ID) return;

  /* ===== メンション対応 ===== */
  if (message.mentions.has(client.user)) {
    const messages = await message.channel.messages.fetch({ limit: 20 });

    const text = [...messages.values()]
      .reverse()
      .filter(m => !m.author.bot)
      .map(m => `${m.author.username}: ${m.content}`)
      .join("\n");

    const reply = await generateAIReply(text);
    if (!reply) return;

    await message.reply("呼んでくれてありがとう。\n\n" + reply);
    return;
  }

  /* ===== 新しい質問（返信ではない投稿）に回答 ===== */
  if (isQuestion(message)) {
    await answerQuestion(message);
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

/* ========= 起動時スキャン ========= */
async function scanUnansweredMessages() {
  if (!isAllowedTime()) return;

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
}

/* ========= 質問への回答 ========= */
async function answerQuestion(message) {
  for (let i = 1; i <= MAX_RETRY; i++) {
    const reply = await generateAIReply(message.content);
    if (reply) {
      await message.reply(reply);
      return;
    }
    console.log(`FAIL ${i}回: ${message.id}`);
  }
}

/* ========= AI生成 ========= */
async function generateAIReply(text) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    const result = await model.generateContent(
      SYSTEM_PROMPT + "\n\n" + text
    );

    return result.response.text();
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
