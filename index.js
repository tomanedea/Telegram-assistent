const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const schedule = require("node-schedule");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const DATA_FILE = "./data.json";
const TIMEZONE = "Europe/Bucharest";
const MODEL = "claude-sonnet-4-6";
const REMINDER_INTERVAL_MIN = 30;
const EVENING_BRIEFING_HOUR = 22;

if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_TOKEN");
if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { reminders: [], conversations: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      conversations: parsed.conversations || {},
    };
  } catch (err) {
    console.error("loadData error:", err.message);
    return { reminders: [], conversations: {} };
  }
}

let appData = loadData();

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(appData, null, 2));
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function nowRoText() {
  return new Date().toLocaleString("ro-RO", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function toRoTime(ts) {
  return new Date(ts).toLocaleString("ro-RO", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function roDayStart(ts) {
  const d = new Date(new Date(ts).toLocaleString("en-US", { timeZone: TIMEZONE }));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function roDayEnd(ts) {
  return roDayStart(ts) + 86400000 - 1;
}

function getUserReminders(chatId, includeDone = false) {
  return appData.reminders
    .filter((r) => r.chatId === String(chatId) && (includeDone || !r.done))
    .sort((a, b) => a.triggerAt - b.triggerAt);
}

function getTodayReminders(chatId) {
  const start = roDayStart(Date.now());
  const end = roDayEnd(Date.now());

  return getUserReminders(chatId).filter(
    (r) => r.triggerAt >= start && r.triggerAt <= end
  );
}

function getTomorrowReminders(chatId) {
  const start = roDayStart(Date.now()) + 86400000;
  const end = roDayEnd(Date.now()) + 86400000;

  return getUserReminders(chatId).filter(
    (r) => r.triggerAt >= start && r.triggerAt <= end
  );
}

function findReminderById(chatId, id) {
  return appData.reminders.find(
    (r) => r.chatId === String(chatId) && r.id === id
  );
}

function findConflicts(chatId, triggerAt, ignoreId = null) {
  const oneHour = 60 * 60 * 1000;

  return getUserReminders(chatId).filter(
    (r) =>
      r.id !== ignoreId &&
      Math.abs(r.triggerAt - triggerAt) < oneHour
  );
}

async function safeSend(chatId, text) {
  try {
    await bot.sendMessage(chatId, String(text || "").slice(0, 3900));
  } catch (err) {
    console.error("safeSend error:", err.message);
  }
}

function cancelReminderJobs(id) {
  ["pre", "trigger", "nag"].forEach((prefix) => {
    const job = schedule.scheduledJobs[`${prefix}-${id}`];
    if (job) job.cancel();
  });
}

function isDone(id) {
  return appData.reminders.find((r) => r.id === id)?.done === true;
}

function scheduleReminder(reminder) {
  cancelReminderJobs(reminder.id);

  if (reminder.done) return;

  const now = Date.now();
  const preTime = reminder.triggerAt - 30 * 60 * 1000;

  if (preTime > now) {
    schedule.scheduleJob(`pre-${reminder.id}`, new Date(preTime), async () => {
      if (isDone(reminder.id)) return;

      await safeSend(
        reminder.chatId,
        `🔔 Peste 30 de minute:\n${reminder.task}`
      );
    });
  }

  if (reminder.triggerAt > now) {
    schedule.scheduleJob(`trigger-${reminder.id}`, new Date(reminder.triggerAt), async () => {
      if (isDone(reminder.id)) return;

      await safeSend(
        reminder.chatId,
        `⏰ E timpul:\n${reminder.task}\n\nCând termini: /done_${reminder.id}`
      );

      startNagging(reminder);
    });
  } else {
    startNagging(reminder);
  }
}

function startNagging(reminder) {
  cancelReminderJobs(`nag-${reminder.id}`);

  const job = schedule.scheduleJob(
    `nag-${reminder.id}`,
    `*/${REMINDER_INTERVAL_MIN} * * * *`,
    async () => {
      if (isDone(reminder.id)) {
        job.cancel();
        return;
      }

      const elapsed = Math.max(
        0,
        Math.round((Date.now() - reminder.triggerAt) / 60000)
      );

      await safeSend(
        reminder.chatId,
        `🔁 Încă nefăcut (${elapsed} min întârziere):\n${reminder.task}\n\nCând termini: /done_${reminder.id}`
      );
    }
  );
}

function formatReminder(r) {
  return `• ${r.task}\n  🕐 ${toRoDate(r.triggerAt)}\n  /done_${r.id}`;
}

function formatReminderList(reminders, emptyText = "Nu ai remindere active.") {
  if (!reminders.length) return emptyText;
  return reminders.map(formatReminder).join("\n\n");
}

function buildReminderContext(chatId) {
  const reminders = getUserReminders(chatId, true).slice(-30);

  if (!reminders.length) {
    return "Nu există remindere salvate.";
  }

  return reminders
    .map((r) => {
      return [
        `id: ${r.id}`,
        `task: ${r.task}`,
        `data: ${toRoDate(r.triggerAt)}`,
        `timestamp: ${new Date(r.triggerAt).toISOString()}`,
        `status: ${r.done ? "done" : "active"}`,
      ].join(" | ");
    })
    .join("\n");
}

function extractFirstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;

      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }

  return null;
}

function normalizeActions(parsed) {
  if (!parsed) return [];

  if (Array.isArray(parsed.actions)) return parsed.actions;
  if (parsed.action) return [parsed];

  return [];
}

const SYSTEM_PROMPT = `
Ești Billy, un asistent personal real, prietenos, calm și practic, conectat la Telegram.

Rolul tău:
- ajuți utilizatorul cu remindere, agendă, organizare și conversații normale;
- te adaptezi la conversație;
- înțelegi corecții precum „nu la 12, la 10”, „mută-l pe mâine”, „șterge reminderul cu banca”;
- când utilizatorul întreabă câte taskuri are sau ce are în agendă, folosești contextul primit;
- nu spui niciodată că nu ai acces la remindere dacă ele apar în context.

Răspunsul tău trebuie să fie DOAR JSON valid, fără markdown, fără backticks, fără explicații în afara JSON.

Schema:
{
  "reply": "răspuns scurt și natural pentru utilizator",
  "actions": [
    {
      "action": "create_reminder",
      "task": "descriere task",
      "datetime": "ISO8601"
    }
  ]
}

Acțiuni posibile:
1. create_reminder
{
  "action": "create_reminder",
  "task": "...",
  "datetime": "ISO8601"
}

2. update_reminder
{
  "action": "update_reminder",
  "id": "id-ul reminderului din context",
  "task": "noua descriere sau null",
  "datetime": "noua dată ISO8601 sau null"
}

3. delete_reminder
{
  "action": "delete_reminder",
  "id": "id-ul reminderului din context"
}

4. mark_done
{
  "action": "mark_done",
  "id": "id-ul reminderului din context"
}

5. list_reminders
{
  "action": "list_reminders",
  "scope": "all|today|tomorrow"
}

6. chat
{
  "action": "chat"
}

Reguli importante:
- Dacă utilizatorul creează mai multe remindere într-un mesaj, pui mai multe acțiuni create_reminder în actions.
- Dacă utilizatorul corectează ora sau data unui reminder recent, folosești update_reminder și alegi cel mai probabil reminder din context.
- Dacă nu ești sigur la ce reminder se referă, NU inventa id. Pune action chat și cere o clarificare scurtă.
- Pentru date relative precum „mâine”, „luni”, „duminică seara”, calculezi față de data curentă din București.
- Pentru „seara”, dacă nu se specifică ora, folosește 20:00.
- Pentru „dimineața”, dacă nu se specifică ora, folosește 09:00.
- Pentru „prânz”, folosește 12:00.
- Pentru conversație normală, răspunzi natural în reply și pui actions [{"action":"chat"}].
- reply trebuie să fie natural, dar scurt.
`;

async function askClaude(chatId, userText) {
  if (!appData.conversations[chatId]) {
    appData.conversations[chatId] = [];
  }

  const activeContext = buildReminderContext(chatId);
  const recentConversation = appData.conversations[chatId].slice(-12);

  const userPayload = `
Data și ora curentă în București: ${nowRoText()}

Reminderele utilizatorului:
${activeContext}

Mesaj utilizator:
${userText}
`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [
      ...recentConversation,
      { role: "user", content: userPayload },
    ],
  });

  const raw = response?.content?.[0]?.text?.trim() || "";
  const jsonText = extractFirstJsonObject(raw);

  let parsed = null;
  if (jsonText) {
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      console.error("JSON parse error:", err.message);
      console.error("Raw Claude:", raw);
    }
  }

  appData.conversations[chatId].push({ role: "user", content: userText });
  appData.conversations[chatId].push({
    role: "assistant",
    content: parsed?.reply || raw || "OK",
  });

  appData.conversations[chatId] = appData.conversations[chatId].slice(-20);
  saveData();

  return parsed || {
    reply: raw || "Nu am reușit să procesez răspunsul.",
    actions: [{ action: "chat" }],
  };
}

function createReminder(chatId, task, datetime) {
  const triggerAt = new Date(datetime).getTime();

  if (Number.isNaN(triggerAt)) {
    return { ok: false, message: `Nu am înțeles data pentru: ${task}` };
  }

  const reminder = {
    id: generateId(),
    chatId: String(chatId),
    task: String(task || "Reminder").trim(),
    triggerAt,
    createdAt: Date.now(),
    done: false,
  };

  appData.reminders.push(reminder);
  saveData();
  scheduleReminder(reminder);

  const conflicts = findConflicts(chatId, triggerAt, reminder.id);

  let message = `✅ Am salvat:\n${reminder.task}\n🕐 ${toRoDate(reminder.triggerAt)}\n/done_${reminder.id}`;

  if (conflicts.length) {
    message += `\n\n⚠️ Atenție: mai ai ceva aproape de ora asta:\n`;
    message += conflicts.map((r) => `• ${r.task} la ${toRoTime(r.triggerAt)}`).join("\n");
  }

  return { ok: true, reminder, message };
}

function updateReminder(chatId, id, task, datetime) {
  const reminder = findReminderById(chatId, id);

  if (!reminder) {
    return { ok: false, message: "Nu am găsit reminderul pe care vrei să-l modific." };
  }

  if (task && task !== "null") {
    reminder.task = String(task).trim();
  }

  if (datetime && datetime !== "null") {
    const triggerAt = new Date(datetime).getTime();

    if (Number.isNaN(triggerAt)) {
      return { ok: false, message: "Nu am înțeles noua dată/oră." };
    }

    reminder.triggerAt = triggerAt;
  }

  reminder.updatedAt = Date.now();
  saveData();
  scheduleReminder(reminder);

  return {
    ok: true,
    reminder,
    message: `✅ Am actualizat reminderul:\n${reminder.task}\n🕐 ${toRoDate(reminder.triggerAt)}\n/done_${reminder.id}`,
  };
}

function deleteReminder(chatId, id) {
  const reminder = findReminderById(chatId, id);

  if (!reminder) {
    return { ok: false, message: "Nu am găsit reminderul de șters." };
  }

  reminder.done = true;
  reminder.deletedAt = Date.now();
  saveData();
  cancelReminderJobs(id);

  return {
    ok: true,
    message: `🗑️ Am șters reminderul:\n${reminder.task}`,
  };
}

function markDone(chatId, id) {
  const reminder = findReminderById(chatId, id);

  if (!reminder) {
    return { ok: false, message: "Nu am găsit task-ul." };
  }

  reminder.done = true;
  reminder.doneAt = Date.now();
  saveData();
  cancelReminderJobs(id);

  return {
    ok: true,
    message: `✅ Marcat ca done:\n${reminder.task}`,
  };
}

function listRemindersText(chatId, scope = "all") {
  let reminders = getUserReminders(chatId);

  if (scope === "today") {
    reminders = getTodayReminders(chatId);
  }

  if (scope === "tomorrow") {
    reminders = getTomorrowReminders(chatId);
  }

  if (!reminders.length) {
    if (scope === "today") return "Azi nu ai niciun reminder activ.";
    if (scope === "tomorrow") return "Mâine nu ai niciun reminder activ.";
    return "Nu ai niciun reminder activ.";
  }

  const title =
    scope === "today"
      ? "📋 Azi ai:"
      : scope === "tomorrow"
      ? "📋 Mâine ai:"
      : "📋 Remindere active:";

  return `${title}\n\n${formatReminderList(reminders)}`;
}

async function sendBriefing(chatId) {
  const today = getTodayReminders(chatId);
  const tomorrow = getTomorrowReminders(chatId);

  let msg = `🌙 Briefing rapid\n\n`;

  msg += today.length
    ? `Azi:\n${today.map(formatReminder).join("\n\n")}\n\n`
    : `Azi: nimic activ.\n\n`;

  msg += tomorrow.length
    ? `Mâine:\n${tomorrow.map(formatReminder).join("\n\n")}`
    : `Mâine: nimic activ.`;

  await safeSend(chatId, msg);
}

async function processAiResult(chatId, aiResult) {
  const actions = normalizeActions(aiResult);
  const output = [];

  if (!actions.length) {
    await safeSend(chatId, aiResult.reply || "OK.");
    return;
  }

  for (const action of actions) {
    if (!action || !action.action) continue;

    if (action.action === "create_reminder") {
      const result = createReminder(chatId, action.task, action.datetime);
      output.push(result.message);
      continue;
    }

    if (action.action === "update_reminder") {
      const result = updateReminder(chatId, action.id, action.task, action.datetime);
      output.push(result.message);
      continue;
    }

    if (action.action === "delete_reminder") {
      const result = deleteReminder(chatId, action.id);
      output.push(result.message);
      continue;
    }

    if (action.action === "mark_done") {
      const result = markDone(chatId, action.id);
      output.push(result.message);
      continue;
    }

    if (action.action === "list_reminders") {
      output.push(listRemindersText(chatId, action.scope || "all"));
      continue;
    }

    if (action.action === "chat") {
      output.push(aiResult.reply || "OK.");
      continue;
    }
  }

  const finalText = output.filter(Boolean).join("\n\n");

  if (finalText) {
    await safeSend(chatId, finalText);
  } else {
    await safeSend(chatId, aiResult.reply || "OK.");
  }
}

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const text = String(msg.text || "").trim();

  if (!text) return;

  try {
    if (text === "/start" || text === "/help") {
      await safeSend(
        chatId,
        `👋 Salut! Sunt Billy, asistentul tău personal.

Pot să:
• setez remindere
• modific remindere existente
• șterg remindere
• îți spun ce ai azi/mâine
• fac briefing rapid
• răspund natural la întrebări

Exemple:
- Luni la 10:00 am meeting
- Mută meetingul la 12:00
- La 10, nu la 12
- Șterge reminderul cu banca
- Câte taskuri am azi?

Comenzi:
/reminders
/today
/tomorrow
/briefing`
      );
      return;
    }

    if (text === "/reminders") {
      await safeSend(chatId, listRemindersText(chatId, "all"));
      return;
    }

    if (text === "/today") {
      await safeSend(chatId, listRemindersText(chatId, "today"));
      return;
    }

    if (text === "/tomorrow") {
      await safeSend(chatId, listRemindersText(chatId, "tomorrow"));
      return;
    }

    if (text === "/briefing") {
      await sendBriefing(chatId);
      return;
    }

    const doneMatch = text.match(/^\/done_([a-z0-9]+)/i);
    if (doneMatch) {
      const result = markDone(chatId, doneMatch[1]);
      await safeSend(chatId, result.message);
      return;
    }

    await bot.sendChatAction(chatId, "typing");

    const aiResult = await askClaude(chatId, text);
    await processAiResult(chatId, aiResult);
  } catch (err) {
    console.error("Main handler error:", err.message);
    await safeSend(chatId, "A apărut o eroare. Încearcă din nou.");
  }
});

function restoreJobs() {
  appData.reminders = appData.reminders.filter((r) => !r.deletedAt);
  saveData();

  const active = appData.reminders.filter((r) => !r.done);
  active.forEach(scheduleReminder);

  console.log(`✅ Restored ${active.length} active reminders.`);
}

function scheduleEveningBriefing() {
  schedule.scheduleJob(
    "evening-briefing",
    { hour: EVENING_BRIEFING_HOUR, minute: 0, tz: TIMEZONE },
    async () => {
      const chatIds = [...new Set(appData.reminders.map((r) => r.chatId))];

      for (const chatId of chatIds) {
        await sendBriefing(chatId);
      }
    }
  );
}

console.log("🤖 Billy pornit...");
restoreJobs();
scheduleEveningBriefing();
