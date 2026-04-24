const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const schedule = require("node-schedule");
const fs = require("fs");

// CONFIG
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATA_FILE = "./data.json";
const TIMEZONE = "Europe/Bucharest";
const REMINDER_INTERVAL_MIN = 30;

// INIT
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// STORAGE
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { reminders: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE));
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(appData, null, 2));
}
let appData = loadData();

// HELPERS
function generateId() {
  return Math.random().toString(36).slice(2, 10);
}
function toRoDate(ts) {
  return new Date(ts).toLocaleString("ro-RO", {
    timeZone: TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function safeSend(chatId, text) {
  return bot.sendMessage(chatId, text);
}

// SCHEDULER
function scheduleReminder(r) {
  const now = Date.now();

  const pre = r.triggerAt - 30 * 60 * 1000;
  if (pre > now) {
    schedule.scheduleJob(new Date(pre), () =>
      safeSend(r.chatId, `🔔 Peste 30 min: ${r.task}`)
    );
  }

  if (r.triggerAt > now) {
    schedule.scheduleJob(new Date(r.triggerAt), () =>
      safeSend(r.chatId, `⏰ E timpul: ${r.task}\n/done_${r.id}`)
    );
  }
}

// CLAUDE
const SYSTEM_PROMPT = `
Returnează DOAR JSON valid.

Un reminder:
{"type":"reminder","task":"...","datetime":"ISO"}

Mai multe:
{"type":"reminders","items":[{"task":"...","datetime":"ISO"}]}
`;

async function askClaude(text) {
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  });

  return res.content[0].text;
}

// PARSE
function extractReminders(text) {
  const results = [];

  try {
    const jsons = text.match(/\{[\s\S]*?\}/g) || [];

    for (const j of jsons) {
      try {
        const obj = JSON.parse(j);

        if (obj.type === "reminder") {
          results.push(obj);
        }

        if (obj.type === "reminders") {
          obj.items.forEach((i) => results.push(i));
        }
      } catch {}
    }
  } catch {}

  return results;
}

// HANDLER
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  // DONE
  const doneMatch = text.match(/\/done_(\w+)/);
  if (doneMatch) {
    const r = appData.reminders.find((x) => x.id === doneMatch[1]);
    if (r) {
      r.done = true;
      saveData();
      return safeSend(chatId, `✅ Done: ${r.task}`);
    }
  }

  // LIST
  if (text === "/reminders") {
    const list = appData.reminders.filter((r) => !r.done);
    if (!list.length) return safeSend(chatId, "Nu ai remindere.");

    return safeSend(
      chatId,
      list.map((r) => `${r.task}\n${toRoDate(r.triggerAt)}\n/done_${r.id}`).join("\n\n")
    );
  }

  // NORMAL
  try {
    const reply = await askClaude(text);
    const reminders = extractReminders(reply);

    if (!reminders.length) {
      return safeSend(chatId, reply);
    }

    let created = [];

    for (const r of reminders) {
      const ts = new Date(r.datetime).getTime();
      if (isNaN(ts)) continue;

      const newR = {
        id: generateId(),
        chatId,
        task: r.task,
        triggerAt: ts,
        done: false,
      };

      appData.reminders.push(newR);
      scheduleReminder(newR);
      created.push(newR);
    }

    saveData();

    return safeSend(
      chatId,
      created.map((r) => `✅ ${r.task}\n${toRoDate(r.triggerAt)}`).join("\n\n")
    );
  } catch (err) {
    console.log(err);
    safeSend(chatId, "Eroare...");
  }
});

// START
console.log("BOT PORNIT");
