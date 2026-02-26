import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";
import OpenAI from "openai";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ========= プロンプト ========= */
const SYSTEM_PROMPT = `
あなたは「Cosmo Base」という、初心者歓迎の宇宙コミュニティのAIです。
宇宙に詳しくない人にも寄り添い、「宇宙を身近な選択肢」に感じてもらうことが役割です。

回答ルール：
・最初の質問に対して1回だけ返信する
・断定しすぎず、現実的な距離感を大切にする
・専門用語は極力使わず、やさしい言葉で説明する
・未来を過度に煽らない
・見出しや箇条書きは使わない
・質問者を否定しない
・回答は3〜6文程度に収める

文体・トーン：
・落ち着いていて、少しワクワクを残す
・「教える」ではなく「一緒に考える」姿勢
・上から目線にならない

回答の締め：
・最後は必ず、
  「他の人はどう考えているのか、ちょっと聞いてみたいな」
  「いろんな視点がありそうで、気になるな」
  などのように、
  “自分も興味を持っている”ニュアンスで終える
・「聞いてみてください」「質問してみてください」は使わない

`;

/* ========= 起動 ========= */
client.once("clientReady", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  // 起動時に未回答スレッドを拾う
  await scanUnansweredThreads();
});

/* ========= 新規スレッド作成時 ========= */
client.on("threadCreate", async (thread) => {
  if (thread.parentId !== process.env.QUESTION_CHANNEL_ID) return;
  if (thread.appliedTags.includes(process.env.AI_REPLIED_TAG_ID)) return;

  await handleThread(thread);
});

/* ========= 人が書き込んだらタグ付与 ========= */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  const thread = message.channel;

  if (!thread.appliedTags.includes(process.env.HUMAN_REPLIED_TAG_ID)) {
    await thread.setAppliedTags([
      ...thread.appliedTags,
      process.env.HUMAN_REPLIED_TAG_ID,
    ]);
  }
});

/* ========= 起動時スキャン ========= */
async function scanUnansweredThreads() {
  const channel = await client.channels.fetch(
    process.env.QUESTION_CHANNEL_ID
  );

  if (channel.type !== ChannelType.GuildForum) return;

  const threads = await channel.threads.fetchActive();

  for (const thread of threads.threads.values()) {
    if (thread.appliedTags.includes(process.env.AI_REPLIED_TAG_ID)) continue;
    await handleThread(thread);
  }
}

/* ========= スレッド処理 ========= */
async function handleThread(thread) {
  const messages = await thread.messages.fetch({ limit: 10 });
  const firstMessage = [...messages.values()]
    .reverse()
    .find((m) => !m.author.bot);

  if (!firstMessage) return;

  const aiReply = await generateAIReply(firstMessage.content);

  await thread.send(aiReply);

  await thread.setAppliedTags([
    ...thread.appliedTags,
    process.env.AI_REPLIED_TAG_ID,
  ]);
}

/* ========= AI生成 ========= */
async function generateAIReply(question) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
    ],
  });

  return res.choices[0].message.content;
}

/* ========= ログイン ========= */
client.login(process.env.DISCORD_TOKEN);
