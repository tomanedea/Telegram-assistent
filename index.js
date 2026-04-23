const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const schedule = require("node-schedule");
const fs = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const REMINDER_INTERVAL_MIN = 30;
const EVENING_BRIEFING_HOUR = 22; // 22:00 București
const DATA_FILE = "./data.json";
const TIMEZONE = "Europe/Bucharest";

// ─── Init ─────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Persistent Storage ───────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { reminders: [], conversations: {} };
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { reminders: [], conversations: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let appData = loadData();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).substr(2, 8);
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

function startOfDayBucharest(ts) {
  const d = new Date(
    new Date(ts).toLocaleString("en-US", { timeZone: TIMEZONE })
  );
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDayBucharest(ts) {
  return startOfDayBucharest(ts) + 86400000 - 1;
}

// ─── Conflict & Load Detection ───────────────────────────────────────────────
function getRemindersForDay(chatId, dayTs) {
  const start = startOfDayBucharest(dayTs);
  const end = endOfDayBucharest(dayTs);
  return appData.reminders.filter(
    (r) =>
      r.chatId === String(chatId) &&
      !r.done &&
      r.triggerAt >= start &&
      r.triggerAt <= end
  );
}

function findConflicts(chatId, triggerAt) {
  // Conflict = another task within 1 hour window
  const window = 60 * 60 * 1000;
  return appData.reminders.filter(
    (r) =>
      r.chatId === String(chatId) &&
      !r.done &&
      Math.abs(r.triggerAt - triggerAt) < window
  );
}

function buildConflictMessage(conflicts, newTask, newTs) {
  const conflictList = conflicts
    .map((r) => `  • ${r.task} (${toRoTime(r.triggerAt)})`)
    .join("\n");

  return (
    `⚠️ *Ai deja ceva în acel interval:*\n${conflictList}\n\n` +
    `Noul task: *${newTask}* la ${toRoTime(newTs)}\n\n` +
    `Ce facem?\n` +
    `1️⃣ /keep — Păstrez ambele\n` +
    `2️⃣ /reschedule — Vreau să mut noul task\n` +
    `3️⃣ /cancel_new — Renunț la noul task`
  );
}

function buildLoadMessage(chatId, dayTs, newTask) {
  const tasks = getRemindersForDay(chatId, dayTs);
  const taskList = tasks.map((r) => `  • ${r.task} (${toRoTime(r.triggerAt)})`).join("\n");
  return (
    `📋 Ziua asta ai deja *${tasks.length} taskuri*:\n${taskList}\n\n` +
    `Plus noul task: *${newTask}*\n\n` +
    `Ești sigur că poți gestiona? Răspunde:\n` +
    `✅ /ok_load — Da, merge\n` +
    `🔁 /reschedule — Vreau să mut ceva`
  );
}

// ─── Pending state (waiting for user decision) ───────────────────────────────
// Structure: { chatId: { type: "conflict"|"load"|"reschedule", pendingReminder: {...} } }
let pendingDecisions = {};

// ─── Schedule Logic ───────────────────────────────────────────────────────────
function scheduleReminder(reminder) {
  const now = Date.now();

  // Pre-reminder 30 min before
  const preTime = reminder.triggerAt - 30 * 60 * 1000;
  if (preTime > now) {
    schedule.scheduleJob(`pre-${reminder.id}`, new Date(preTime), async () => {
      if (isDone(reminder.id)) return;
      await bot.sendMessage(
        reminder.chatId,
        `🔔 Peste 30 de minute: *${reminder.task}*`,
        { parse_mode: "Markdown" }
      );
    });
  }

  // Main trigger
  if (reminder.triggerAt > now) {
    schedule.scheduleJob(
      `trigger-${reminder.id}`,
      new Date(reminder.triggerAt),
      async () => {
        if (isDone(reminder.id)) return;
        await bot.sendMessage(
          reminder.chatId,
          `⏰ *E timpul!* ${reminder.task}\n\nCând termini: /done_${reminder.id}`,
          { parse_mode: "Markdown" }
        );
        startNagging(reminder);
      }
    );
  } else {
    // Already past — nag immediately
    startNagging(reminder);
  }
}

function startNagging(reminder) {
  const job = schedule.scheduleJob(
    `nag-${reminder.id}`,
    `*/${REMINDER_INTERVAL_MIN} * * * *`,
    async () => {
      if (isDone(reminder.id)) {
        job.cancel();
        return;
      }
      const elapsed = Math.round((Date.now() - reminder.triggerAt) / 60000);
      await bot.sendMessage(
        reminder.chatId,
        `🔁 Încă nefăcut (${elapsed} min întârziere): *${reminder.task}*\n\nCând termini: /done_${reminder.id}`,
        { parse_mode: "Markdown" }
      );
    }
  );
}

function isDone(id) {
  return appData.reminders.find((r) => r.id === id)?.done === true;
}

function addAndScheduleReminder(reminder) {
  appData.reminders.push(reminder);
  saveData(appData);
  scheduleReminder(reminder);
}

// ─── Evening Briefing ─────────────────────────────────────────────────────────
function scheduleEveningBriefing() {
  // Every day at 22:00 Bucharest
  schedule.scheduleJob(
    "evening-briefing",
    { hour: EVENING_BRIEFING_HOUR, minute: 0, tz: TIMEZONE },
    async () => {
      const allChatIds = [
        ...new Set(appData.reminders.map((r) => r.chatId)),
      ];

      for (const chatId of allChatIds) {
        await sendEveningBriefing(chatId);
      }
    }
  );
}

async function sendEveningBriefing(chatId) {
  const now = Date.now();
  const todayStart = startOfDayBucharest(now);
  const todayEnd = endOfDayBucharest(now);
  const tomorrowStart = todayStart + 86400000;
  const tomorrowEnd = todayEnd + 86400000;

  const todayAll = appData.reminders.filter(
    (r) => r.chatId === String(chatId) && r.triggerAt >= todayStart && r.triggerAt <= todayEnd
  );
  const done = todayAll.filter((r) => r.done);
  const missed = todayAll.filter((r) => !r.done && r.triggerAt < now);
  const remaining = todayAll.filter((r) => !r.done && r.triggerAt >= now);
  const tomorrow = appData.reminders.filter(
    (r) => r.chatId === String(chatId) && !r.done && r.triggerAt >= tomorrowStart && r.triggerAt <= tomorrowEnd
  );

  let msg = `🌙 *Briefing de seară — ${new Date().toLocaleDateString("ro-RO", { timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long" })}*\n\n`;

  if (done.length) {
    msg += `✅ *Realizat azi (${done.length}):*\n`;
    done.forEach((r) => (msg += `  • ${r.task}\n`));
    msg += "\n";
  } else {
    msg += `✅ *Realizat azi:* nimic marcat ca done\n\n`;
  }

  if (missed.length) {
    msg += `❌ *Ratat / nefinalizat (${missed.length}):*\n`;
    missed.forEach((r) => (msg += `  • ${r.task} (era la ${toRoTime(r.triggerAt)})\n`));
    msg += "\n";
  }

  if (remaining.length) {
    msg += `⏳ *Mai rămâne azi (${remaining.length}):*\n`;
    remaining.forEach((r) => (msg += `  • ${r.task} la ${toRoTime(r.triggerAt)}\n`));
    msg += "\n";
  }

  if (tomorrow.length) {
    msg += `📅 *Mâine ai (${tomorrow.length}):*\n`;
    tomorrow.forEach((r) => (msg += `  • ${r.task} la ${toRoTime(r.triggerAt)}\n`));
    msg += "\n";
  } else {
    msg += `📅 *Mâine:* lista goală — zi liberă!\n\n`;
  }

  // Ask  for a short motivational/practical comment
  try {
    const context = `Azi: ${done.length} done, ${missed.length} ratate. Mâine: ${tomorrow.length} taskuri. Fă un comentariu scurt (1-2 propoziții) în română, practic și direct, fără emojis inutile.`;
    const Reply = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 150,
      messages: [{ role: "user", content: context }],
    });
    msg += `💬 _${claudeReply.content[0].text}_`;
  } catch {}

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// ─── Claude AI ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Ești un asistent personal inteligent conectat prin Telegram.
Vorbești în română sau engleză, în funcție de limba mesajului primit.
Ești direct, util, concis. Fără răspunsuri lungi inutile.

Când utilizatorul menționează un task cu o dată/oră, răspunzi DOAR cu JSON în formatul exact:
{"type":"reminder","task":"descrierea scurtă a taskului","datetime":"ISO8601"}

Când e o întrebare normală sau conversație, răspunzi natural ca asistent general.
Nu include backtick-uri sau markdown în jurul JSON-ului.
Data și ora curentă în București: ${new Date().toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" })}`;

async function askClaude(chatId, userMessage) {
  if (!appData.conversations[chatId]) appData.conversations[chatId] = [];
  appData.conversations[chatId].push({ role: "user", content: userMessage });
  const history = appData.conversations[chatId].slice(-20);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const reply = response.content[0].text;
  appData.conversations[chatId].push({ role: "assistant", content: reply });
  saveData(appData);
  return reply;
}

function tryParseReminder(text) {
  try {
    const match = text.match(/\{[\s\S]*"type"\s*:\s*"reminder"[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (parsed.type === "reminder" && parsed.task && parsed.datetime) return parsed;
  } catch {}
  return null;
}

// ─── Message Handler ──────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // ── /done_ID ──
  const doneMatch = text.match(/^\/done_([a-z0-9]+)/i);
  if (doneMatch) {
    const id = doneMatch[1];
    const reminder = appData.reminders.find((r) => r.id === id);
    if (reminder) {
      reminder.done = true;
      reminder.doneAt = Date.now();
      saveData(appData);
      ["trigger", "pre", "nag"].forEach((p) => {
        const j = schedule.scheduledJobs[`${p}-${id}`];
        if (j) j.cancel();
      });
      await bot.sendMessage(chatId, `✅ *${reminder.task}* — marcat done!`, {
        parse_mode: "Markdown",
      });
    } else {
      await bot.sendMessage(chatId, "Nu am găsit task-ul.");
    }
    return;
  }

  // ── /keep — user wants to keep both despite conflict ──
  if (text === "/keep") {
    const pending = pendingDecisions[chatId];
    if (pending && pending.pendingReminder) {
      addAndScheduleReminder(pending.pendingReminder);
      delete pendingDecisions[chatId];
      await bot.sendMessage(
        chatId,
        `✅ Ambele taskuri păstrate. Reminder setat pentru *${pending.pendingReminder.task}* la ${toRoDate(pending.pendingReminder.triggerAt)}\n\nCând termini: /done_${pending.pendingReminder.id}`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  // ── /ok_load — user acknowledges heavy day ──
  if (text === "/ok_load") {
    const pending = pendingDecisions[chatId];
    if (pending && pending.pendingReminder) {
      addAndScheduleReminder(pending.pendingReminder);
      delete pendingDecisions[chatId];
      await bot.sendMessage(
        chatId,
        `✅ Reminder setat: *${pending.pendingReminder.task}* la ${toRoDate(pending.pendingReminder.triggerAt)}\n\nSucces cu ziua! /done_${pending.pendingReminder.id}`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  // ── /cancel_new — user cancels the new task ──
  if (text === "/cancel_new") {
    delete pendingDecisions[chatId];
    await bot.sendMessage(chatId, "🗑️ Noul task a fost anulat.");
    return;
  }

  // ── /reschedule — user wants to pick a new time ──
  if (text === "/reschedule") {
    const pending = pendingDecisions[chatId];
    if (pending) {
      pendingDecisions[chatId] = { ...pending, type: "reschedule" };
      await bot.sendMessage(
        chatId,
        `🔁 Spune-mi când vrei să muți *${pending.pendingReminder.task}*.\nEx: "Joi la 15:00" sau "Mâine dimineață la 9"`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  // ── /start ──
  if (text === "/start") {
    await bot.sendMessage(
      chatId,
      `👋 *Salut! Sunt asistentul tău personal.*\n\n` +
        `Ce pot face pentru tine:\n` +
        `📌 Setez reminder-uri — spune-mi task + dată/oră\n` +
        `⚠️ Te avertizez dacă ai conflicte de program\n` +
        `📋 Te atenționez dacă ziua e prea aglomerată\n` +
        `🌙 La 22:00 îți trimit un briefing cu ziua ta\n` +
        `🧠 Răspund la orice întrebare\n\n` +
        `*Exemple:*\n` +
        `• "Mâine la 14:00 meeting cu echipa"\n` +
        `• "Vineri la 10 trebuie să trimit raportul"\n` +
        `• "Ce mai e pe lista de azi?"\n\n` +
        `Comenzi: /reminders /briefing /start`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── /reminders ──
  if (text === "/reminders") {
    const active = appData.reminders.filter(
      (r) => r.chatId === String(chatId) && !r.done
    );
    if (!active.length) {
      await bot.sendMessage(chatId, "📭 Nu ai niciun reminder activ.");
      return;
    }
    const sorted = active.sort((a, b) => a.triggerAt - b.triggerAt);
    const list = sorted
      .map((r) => `• *${r.task}*\n  🕐 ${toRoDate(r.triggerAt)}\n  /done_${r.id}`)
      .join("\n\n");
    await bot.sendMessage(chatId, `📋 *Reminder-uri active:*\n\n${list}`, {
      parse_mode: "Markdown",
    });
    return;
  }

  // ── /briefing — manual trigger ──
  if (text === "/briefing") {
    await sendEveningBriefing(String(chatId));
    return;
  }

  // ── Handle reschedule reply ──
  const pending = pendingDecisions[chatId];
  if (pending && pending.type === "reschedule") {
    await bot.sendChatAction(chatId, "typing");
    const reply = await askClaude(
      String(chatId),
      `Vreau să mut taskul "${pending.pendingReminder.task}" la: ${text}`
    );
    const parsed = tryParseReminder(reply);
    if (parsed) {
      const newTs = new Date(parsed.datetime).getTime();
      if (!isNaN(newTs)) {
        pending.pendingReminder.triggerAt = newTs;
        pending.pendingReminder.id = generateId(); // new id for new time
        const conflicts2 = findConflicts(chatId, newTs);
        const dayTasks2 = getRemindersForDay(chatId, newTs);
        delete pendingDecisions[chatId];

        if (conflicts2.length > 0) {
          pendingDecisions[chatId] = { type: "conflict", pendingReminder: pending.pendingReminder };
          await bot.sendMessage(chatId, buildConflictMessage(conflicts2, pending.pendingReminder.task, newTs), { parse_mode: "Markdown" });
        } else if (dayTasks2.length >= 3) {
          pendingDecisions[chatId] = { type: "load", pendingReminder: pending.pendingReminder };
          await bot.sendMessage(chatId, buildLoadMessage(chatId, newTs, pending.pendingReminder.task), { parse_mode: "Markdown" });
        } else {
          addAndScheduleReminder(pending.pendingReminder);
          await bot.sendMessage(
            chatId,
            `✅ Mutat! *${pending.pendingReminder.task}* → ${toRoDate(newTs)}\n\nCând termini: /done_${pending.pendingReminder.id}`,
            { parse_mode: "Markdown" }
          );
        }
        return;
      }
    }
    await bot.sendMessage(chatId, "Nu am înțeles data. Încearcă din nou, ex: *Joi la 16:00*", { parse_mode: "Markdown" });
    return;
  }

  // ── Normal message — send to Claude ──
  try {
    await bot.sendChatAction(chatId, "typing");
    const reply = await askClaude(String(chatId), text);
    const reminderData = tryParseReminder(reply);

    if (reminderData) {
      const triggerAt = new Date(reminderData.datetime).getTime();
      if (isNaN(triggerAt)) {
        await bot.sendMessage(chatId, "Nu am înțeles data/ora. Încearcă mai specific, ex: *mâine la 14:30*.", { parse_mode: "Markdown" });
        return;
      }

      const id = generateId();
      const newReminder = {
        id,
        chatId: String(chatId),
        task: reminderData.task,
        triggerAt,
        createdAt: Date.now(),
        done: false,
      };

      // Check conflicts (within 1h)
      const conflicts = findConflicts(chatId, triggerAt);
      if (conflicts.length > 0) {
        pendingDecisions[chatId] = { type: "conflict", pendingReminder: newReminder };
        await bot.sendMessage(chatId, buildConflictMessage(conflicts, newReminder.task, triggerAt), { parse_mode: "Markdown" });
        return;
      }

      // Check load (3+ tasks same day)
      const dayTasks = getRemindersForDay(chatId, triggerAt);
      if (dayTasks.length >= 3) {
        pendingDecisions[chatId] = { type: "load", pendingReminder: newReminder };
        await bot.sendMessage(chatId, buildLoadMessage(chatId, triggerAt, newReminder.task), { parse_mode: "Markdown" });
        return;
      }

      // All clear — add reminder
      addAndScheduleReminder(newReminder);
      await bot.sendMessage(
        chatId,
        `✅ *Reminder setat!*\n\n📌 ${newReminder.task}\n🕐 ${toRoDate(triggerAt)}\n\nÎți amintesc din 30 în 30 min până confirmi.\nCând termini: /done_${id}`,
        { parse_mode: "Markdown" }
      );
    } else {
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Error:", err.message);
    await bot.sendMessage(chatId, "A apărut o eroare. Încearcă din nou.");
  }
});

// ─── Restore jobs on startup ──────────────────────────────────────────────────
function restoreJobs() {
  appData.reminders = appData.reminders.filter((r) => !r.done);
  appData.reminders.forEach((r) => scheduleReminder(r));
  console.log(`✅ Restored ${appData.reminders.length} active reminders.`);
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("🤖 Bot pornit...");
restoreJobs();
scheduleEveningBriefing();
