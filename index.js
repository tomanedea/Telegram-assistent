process.env.TZ = "Europe/Bucharest";

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

if (!TELEGRAM_TOKEN) throw new Error("Missing TELEGRAM_TOKEN");
if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { reminders: [], conversations: {}, profile: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    return {
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      conversations: parsed.conversations || {},
      profile: parsed.profile || {},
    };
  } catch {
    return { reminders: [], conversations: {}, profile: {} };
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

function parseBucharestDateTime(datetime) {
  const raw = String(datetime || "").trim();

  const clean = raw
    .replace("Z", "")
    .replace(/[+-]\d{2}:\d{2}$/, "");

  return new Date(clean).getTime();
}

function getActiveReminders(chatId) {
  return appData.reminders
    .filter((r) => r.chatId === String(chatId) && !r.done && !r.deletedAt)
    .sort((a, b) => a.triggerAt - b.triggerAt);
}

function getAllUserReminders(chatId) {
  return appData.reminders
    .filter((r) => r.chatId === String(chatId) && !r.deletedAt)
    .sort((a, b) => a.triggerAt - b.triggerAt);
}

function dayStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayEnd(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function getTodayReminders(chatId) {
  const start = dayStart();
  const end = dayEnd();

  return getActiveReminders(chatId).filter(
    (r) => r.triggerAt >= start && r.triggerAt <= end
  );
}

function getTomorrowReminders(chatId) {
  const start = dayStart(Date.now() + 86400000);
  const end = dayEnd(Date.now() + 86400000);

  return getActiveReminders(chatId).filter(
    (r) => r.triggerAt >= start && r.triggerAt <= end
  );
}

function findReminderById(chatId, id) {
  return appData.reminders.find(
    (r) => r.chatId === String(chatId) && r.id === id && !r.deletedAt
  );
}

function findConflicts(chatId, triggerAt, ignoreId = null) {
  const oneHour = 60 * 60 * 1000;

  return getActiveReminders(chatId).filter(
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

function scheduleReminder(reminder) {
  cancelReminderJobs(reminder.id);

  if (reminder.done || reminder.deletedAt) return;

  const now = Date.now();
  const preTime = reminder.triggerAt - 30 * 60 * 1000;

  if (preTime > now) {
    schedule.scheduleJob(`pre-${reminder.id}`, new Date(preTime), async () => {
      const current = findReminderById(reminder.chatId, reminder.id);
      if (!current || current.done || current.deletedAt) return;

      await safeSend(
        reminder.chatId,
        `🔔 Peste 30 de minute:\n${current.task}`
      );
    });
  }

  if (reminder.triggerAt > now) {
    schedule.scheduleJob(`trigger-${reminder.id}`, new Date(reminder.triggerAt), async () => {
      const current = findReminderById(reminder.chatId, reminder.id);
      if (!current || current.done || current.deletedAt) return;

      await safeSend(
        reminder.chatId,
        `⏰ Reminder:\n${current.task}\n\nCând termini: /done_${current.id}`
      );

      startNagging(current);
    });
  }
}

function startNagging(reminder) {
  const oldJob = schedule.scheduledJobs[`nag-${reminder.id}`];
  if (oldJob) oldJob.cancel();

  schedule.scheduleJob(
    `nag-${reminder.id}`,
    `*/${REMINDER_INTERVAL_MIN} * * * *`,
    async () => {
      const current = findReminderById(reminder.chatId, reminder.id);
      if (!current || current.done || current.deletedAt) {
        const job = schedule.scheduledJobs[`nag-${reminder.id}`];
        if (job) job.cancel();
        return;
      }

      await safeSend(
        reminder.chatId,
        `🔁 Încă ai acest task nefăcut:\n${current.task}\n\nCând termini: /done_${current.id}`
      );
    }
  );
}

function formatReminder(r) {
  return `• ${r.task}\n  🕐 ${toRoDate(r.triggerAt)}\n  /done_${r.id}`;
}

function listText(chatId, scope = "all") {
  let list = getActiveReminders(chatId);

  if (scope === "today") list = getTodayReminders(chatId);
  if (scope === "tomorrow") list = getTomorrowReminders(chatId);

  if (!list.length) {
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

  return `${title}\n\n${list.map(formatReminder).join("\n\n")}`;
}

function reminderContext(chatId) {
  const list = getAllUserReminders(chatId).slice(-40);

  if (!list.length) return "Nu există remindere salvate.";

  return list
    .map((r) =>
      [
        `id=${r.id}`,
        `task=${r.task}`,
        `date=${toRoDate(r.triggerAt)}`,
        `iso_local=${new Date(r.triggerAt).toLocaleString("sv-SE", { timeZone: TIMEZONE }).replace(" ", "T")}`,
        `status=${r.done ? "done" : "active"}`,
      ].join(" | ")
    )
    .join("\n");
}

function extractFirstJson(text) {
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
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  return null;
}

const SYSTEM_PROMPT = `
Ești Billy, un asistent personal real, natural, cald și practic, conectat prin Telegram.

Te comporți ca un asistent personal care ține minte agenda utilizatorului, îl ajută să se organizeze și vorbește natural, scurt și util.

RĂSPUNSUL TĂU TREBUIE SĂ FIE MEREU DOAR JSON VALID.
Nu folosi markdown. Nu folosi backticks. Nu scrie text în afara JSON.

Schema obligatorie:
{
  "reply": "mesaj natural scurt pentru utilizator",
  "actions": [
    {
      "action": "chat"
    }
  ]
}

Acțiuni disponibile:

1. create_reminder
{
  "action": "create_reminder",
  "task": "descriere task",
  "datetime": "YYYY-MM-DDTHH:mm:ss"
}

2. update_reminder
{
  "action": "update_reminder",
  "id": "id din context",
  "task": null sau "noua descriere",
  "datetime": null sau "YYYY-MM-DDTHH:mm:ss"
}

3. delete_reminder
{
  "action": "delete_reminder",
  "id": "id din context"
}

4. mark_done
{
  "action": "mark_done",
  "id": "id din context"
}

5. list_reminders
{
  "action": "list_reminders",
  "scope": "all" sau "today" sau "tomorrow"
}

6. chat
{
  "action": "chat"
}

REGULI:
- Dacă userul cere un reminder, folosești create_reminder.
- Dacă userul cere mai multe remindere, creezi mai multe acțiuni create_reminder.
- Dacă userul corectează un reminder anterior, folosești update_reminder.
- Exemple de corecție: „nu la 12, la 10”, „mută-l mâine”, „de fapt la 18”.
- Dacă userul întreabă „ce am azi?”, „câte taskuri am?”, „ce remindere am?”, folosești list_reminders.
- Dacă userul spune că a terminat ceva, folosești mark_done.
- Dacă userul cere să ștergi/anulezi ceva, folosești delete_reminder.
- Dacă nu ești sigur la ce reminder se referă, folosești chat și ceri clarificare.
- Dacă userul spune „în 5 min”, calculezi exact față de data/ora curentă primită.
- Pentru „seara” fără oră, folosește 20:00.
- Pentru „dimineața” fără oră, folosește 09:00.
- Pentru „la prânz”, folosește 12:00.
- IMPORTANT: datetime trebuie să fie ora locală din București, fără Z și fără offset.
- Exemplu corect: 2026-04-24T13:22:00
- Exemplu greșit: 2026-04-24T13:22:00Z
- Nu spune niciodată că nu ai acces la remindere dacă ele apar în context.
- Fii natural în reply, dar scurt.
`;

async function askClaude(chatId, userText) {
  if (!appData.conversations[chatId]) appData.conversations[chatId] = [];

  const recent = appData.conversations[chatId].slice(-12);

  const payload = `
Data și ora curentă în București: ${nowRoText()}

Remindere salvate:
${reminderContext(chatId)}

Mesaj utilizator:
${userText}
`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [
      ...recent,
      { role: "user", content: payload },
    ],
  });

  const raw = response?.content?.[0]?.text?.trim() || "";
  const json = extractFirstJson(raw);

  let parsed = null;

  if (json) {
    try {
      parsed = JSON.parse(json);
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

function normalizeActions(result) {
  if (!result) return [];
  if (Array.isArray(result.actions)) return result.actions;
  if (result.action) return [result];
  return [{ action: "chat" }];
}

function createReminder(chatId, task, datetime) {
  const triggerAt = parseBucharestDateTime(datetime);

  if (Number.isNaN(triggerAt)) {
    return `Nu am înțeles data/ora pentru: ${task}`;
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

  let msg = `✅ Am salvat:\n${reminder.task}\n🕐 ${toRoDate(triggerAt)}\n/done_${reminder.id}`;

  if (conflicts.length) {
    msg += `\n\n⚠️ Mai ai ceva aproape de ora asta:\n`;
    msg += conflicts.map((r) => `• ${r.task} la ${toRoTime(r.triggerAt)}`).join("\n");
  }

  return msg;
}

function updateReminder(chatId, id, task, datetime) {
  const reminder = findReminderById(chatId, id);

  if (!reminder) return "Nu am găsit reminderul pe care vrei să-l modific.";

  if (task && task !== "null") reminder.task = String(task).trim();

  if (datetime && datetime !== "null") {
    const triggerAt = parseBucharestDateTime(datetime);
    if (Number.isNaN(triggerAt)) return "Nu am înțeles noua dată/oră.";
    reminder.triggerAt = triggerAt;
  }

  reminder.updatedAt = Date.now();
  saveData();
  scheduleReminder(reminder);

  return `✅ Am actualizat:\n${reminder.task}\n🕐 ${toRoDate(reminder.triggerAt)}\n/done_${reminder.id}`;
}

function deleteReminder(chatId, id) {
  const reminder = findReminderById(chatId, id);
  if (!reminder) return "Nu am găsit reminderul de șters.";

  reminder.deletedAt = Date.now();
  reminder.done = true;
  saveData();
  cancelReminderJobs(id);

  return `🗑️ Am șters:\n${reminder.task}`;
}

function markDone(chatId, id) {
  const reminder = findReminderById(chatId, id);
  if (!reminder) return "Nu am găsit task-ul.";

  reminder.done = true;
  reminder.doneAt = Date.now();
  saveData();
  cancelReminderJobs(id);

  return `✅ Marcat ca done:\n${reminder.task}`;
}

async function processAiResult(chatId, result) {
  const actions = normalizeActions(result);
  const outputs = [];

  for (const action of actions) {
    if (!action || !action.action) continue;

    if (action.action === "create_reminder") {
      outputs.push(createReminder(chatId, action.task, action.datetime));
      continue;
    }

    if (action.action === "update_reminder") {
      outputs.push(updateReminder(chatId, action.id, action.task, action.datetime));
      continue;
    }

    if (action.action === "delete_reminder") {
      outputs.push(deleteReminder(chatId, action.id));
      continue;
    }

    if (action.action === "mark_done") {
      outputs.push(markDone(chatId, action.id));
      continue;
    }

    if (action.action === "list_reminders") {
      outputs.push(listText(chatId, action.scope || "all"));
      continue;
    }

    if (action.action === "chat") {
      outputs.push(result.reply || "OK.");
      continue;
    }
  }

  await safeSend(chatId, outputs.filter(Boolean).join("\n\n") || result.reply || "OK.");
}

async function sendBriefing(chatId) {
  const today = getTodayReminders(chatId);
  const tomorrow = getTomorrowReminders(chatId);

  let msg = "🌙 Briefing rapid\n\n";

  msg += today.length
    ? `Azi:\n${today.map(formatReminder).join("\n\n")}\n\n`
    : "Azi: nimic activ.\n\n";

  msg += tomorrow.length
    ? `Mâine:\n${tomorrow.map(formatReminder).join("\n\n")}`
    : "Mâine: nimic activ.";

  await safeSend(chatId, msg);
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
• modific remindere
• șterg remindere
• îți spun ce ai azi/mâine
• fac briefing rapid
• înțeleg corecții naturale

Exemple:
- În 5 min să plec
- Luni la 10 am meeting
- La 12, nu la 10
- Șterge reminderul cu banca
- Ce am azi?

Comenzi:
/reminders
/today
/tomorrow
/briefing`
      );
      return;
    }

    if (text === "/reminders") {
      await safeSend(chatId, listText(chatId, "all"));
      return;
    }

    if (text === "/today") {
      await safeSend(chatId, listText(chatId, "today"));
      return;
    }

    if (text === "/tomorrow") {
      await safeSend(chatId, listText(chatId, "tomorrow"));
      return;
    }

    if (text === "/briefing") {
      await sendBriefing(chatId);
      return;
    }

    const doneMatch = text.match(/^\/done_([a-z0-9]+)/i);
    if (doneMatch) {
      await safeSend(chatId, markDone(chatId, doneMatch[1]));
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
    { hour: 22, minute: 0, tz: TIMEZONE },
    async () => {
      const chatIds = [...new Set(appData.reminders.map((r) => r.chatId))];

      for (const chatId of chatIds) {
        await sendBriefing(chatId);
      }
    }
  );
}

console.log("🤖 Billy PRO pornit...");
restoreJobs();
scheduleEveningBriefing();
