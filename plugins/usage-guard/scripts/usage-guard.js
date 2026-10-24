#!/usr/bin/env node
// usage-guard: defers token-heavy work when Claude plan usage nears its limit.
//
// Modes (first CLI argument):
//   prompt      UserPromptSubmit hook: rough complexity estimate, defers heavy prompts at 90%+
//   pre         PreToolUse hook: pauses a running heavy task until the limit resets
//   post        PostToolUse hook: captures get_usage results, asks Claude to refresh stale data
//   statusline  statusLine command (terminal CLI): records rate_limits, prints a short line
//   status | on | off | release | set <key> <value> | queue | clear-queue | classify <text>
//
// Usage data comes from a cache (~/.claude/usage-guard/usage.json) filled by the
// desktop app's get_usage tool (captured in `post`) or by the CLI status line.
// Any internal error fails open: the hook exits 0 and Claude carries on.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = path.join(os.homedir(), '.claude', 'usage-guard');
const CACHE = path.join(DATA, 'usage.json');
const CONFIG = path.join(DATA, 'config.json');
const SESSIONS = path.join(DATA, 'sessions');
const QUEUE = path.join(DATA, 'deferred.jsonl');
const LOG = path.join(DATA, 'guard.log');
const RELEASE = path.join(DATA, 'release'); // touch (or `release`) to end a pause early
const SCRIPT_PATH = path.join(DATA, 'script-path'); // where this script lives, for the skill and status line

const DEFAULTS = {
  enabled: true,
  threshold_pct: 90, // heavy tasks pause / are deferred from this level
  hard_pct: 98, // every task pauses from this level
  warn_pct: 80, // Claude is told to be frugal, data is refreshed more often
  prompt_mode: 'wait', // 'wait': hold a heavy prompt until reset; 'block': reject it and queue it
  max_wait_hours: 5.5, // longer waits (weekly window) stop the task instead of sleeping
  reset_buffer_sec: 60,
  escalate_after: { light: 25, medium: 8 }, // tool calls before a task counts as heavy
  usage_tool: 'mcp__ccd_session_mgmt__get_usage',
};
const EXEMPT_TOOLS = /^(mcp__ccd_session_mgmt__get_usage|mcp__ccd_turn__|AskUserQuestion$|ToolSearch$)/;
const SUBAGENT_TOOLS = /^(Agent|Task|Workflow)$/;

// ---------- small helpers ----------

function ensureDirs() {
  fs.mkdirSync(SESSIONS, { recursive: true });
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function log(msg) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
function config() {
  const cfg = { ...DEFAULTS, ...readJson(CONFIG, {}) };
  cfg.escalate_after = { ...DEFAULTS.escalate_after, ...(cfg.escalate_after || {}) };
  if (process.env.USAGE_GUARD_DISABLED === '1') cfg.enabled = false;
  return cfg;
}
function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}
function isDesktop() {
  return !!process.env.CLAUDE_CODE_DESKTOP_APP_VERSION;
}
function fmtTime(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${hm}`;
}
function fmtDur(ms) {
  if (ms < 60e3) return `${Math.max(0, Math.round(ms / 1000))} сек`;
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
}
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (!Number.isNaN(n)) return toMs(n);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// ---------- usage cache ----------

const WINDOW_LABELS = {
  five_hour: '5-часовой',
  seven_day: 'недельный',
  seven_day_opus: 'недельный (Opus)',
  seven_day_sonnet: 'недельный (Sonnet)',
};

// Finds usage windows in a get_usage result, a statusline payload or an OAuth usage response.
function extractWindows(value, depth = 0) {
  if (value == null || depth > 6) return null;
  if (typeof value === 'string') {
    const i = value.indexOf('{');
    if (i < 0) return null;
    try {
      return extractWindows(JSON.parse(value.slice(i)), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const w = extractWindows(v, depth + 1);
      if (w) return w;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (Array.isArray(value.windows) && value.windows.some((w) => w && w.percentUsed != null)) {
    return value.windows
      .filter((w) => w && w.percentUsed != null)
      .map((w) => ({ key: w.label, label: w.label, pct: Number(w.percentUsed), resetsAt: toMs(w.resetsAt) }));
  }
  const keyed = Object.entries(value).filter(
    ([, w]) => w && typeof w === 'object' && (w.used_percentage != null || w.utilization != null),
  );
  if (keyed.length) {
    return keyed.map(([k, w]) => ({
      key: k,
      label: WINDOW_LABELS[k] || k,
      pct: Number(w.used_percentage ?? w.utilization),
      resetsAt: toMs(w.resets_at ?? w.resetsAt),
    }));
  }
  for (const k of ['plan', 'rate_limits', 'content', 'text', 'result', 'structuredContent']) {
    if (k in value) {
      const w = extractWindows(value[k], depth + 1);
      if (w) return w;
    }
  }
  return null;
}

function saveUsage(windows, source) {
  if (!windows || !windows.length) return false;
  writeJson(CACHE, { updated: Date.now(), source, windows });
  return true;
}

// Usage only grows inside a window, so an old reading is still a lower bound;
// a window whose reset time has passed counts as 0.
function usageNow() {
  const cache = readJson(CACHE, null);
  const now = Date.now();
  const ws = (cache?.windows || []).map((w) => ({ ...w, pct: w.resetsAt && w.resetsAt <= now ? 0 : w.pct }));
  const top = ws.reduce((a, w) => (!a || w.pct > a.pct ? w : a), null);
  return { cache, ws, pct: top ? top.pct : null, top, age: cache ? now - cache.updated : Infinity };
}

// How long a reading stays fresh: the closer to the limit, the more often we look.
function refreshEveryMs(pct) {
  if (pct == null) return 0;
  if (pct >= 85) return 2 * 60e3;
  if (pct >= 70) return 5 * 60e3;
  if (pct >= 50) return 10 * 60e3;
  return 20 * 60e3;
}
function isStale(u) {
  return u.age > refreshEveryMs(u.pct);
}

// The pause must last until every window at or above `level` has reset.
function waitTarget(ws, level) {
  const over = ws.filter((w) => w.pct >= level && w.resetsAt);
  return over.length ? over.reduce((a, w) => (w.resetsAt > a.resetsAt ? w : a)) : null;
}

// ---------- complexity estimate ----------

const HEAVY = [
  'с нуля', 'реализуй', 'разработай', 'спроектируй', 'рефактор', 'перепиши', 'миграц', 'мигрир',
  'во всех файлах', 'по всему проекту', 'весь проект', 'всю кодовую', 'всего репозитор', 'архитектур',
  'полноценн', 'интегрир', 'внедри', 'покрой тестами', 'напиши тесты', 'аудит', 'исследуй', 'исследован',
  'проанализируй', 'оптимизируй', 'портируй', 'создай проект', 'создай приложение', 'создай сайт',
  'implement', 'from scratch', 'refactor', 'rewrite', 'migrate', 'migration', 'entire', 'whole codebase',
  'across the codebase', 'all files', 'architecture', 'end-to-end', 'integrate', 'test suite', 'write tests',
  'audit', 'research', 'optimize', 'port to', 'build a', 'build an', 'ultracode', 'deep-research',
];
const MEDIUM = [
  'создай', 'напиши', 'сделай', 'добавь', 'настрой', 'почини', 'исправь', 'отладь', 'обнови', 'установи',
  'скилл', 'хук', 'hook', 'skill', 'скрипт', 'сайт', 'бот', 'игр', 'api', 'сервер', 'базу данных',
  'create', 'write', 'make', 'add', 'fix', 'debug', 'set up', 'setup', 'install', 'update', 'script', 'deploy',
];
const LIGHT = [
  'что такое', 'что значит', 'объясни', 'почему', 'как работает', 'переведи', 'сколько', 'какой', 'какая',
  'какие', 'покажи', 'опечат', 'переименуй', 'коротко', 'кратко', 'спасибо', 'статус', 'что думаешь',
  'explain', 'what is', "what's", 'why ', 'how does', 'translate', 'typo', 'rename', 'quick question',
  'thanks', 'status',
];

function classify(text) {
  const t = (text || '').toLowerCase();
  if (/!(heavy|тяжел)/.test(t)) return { cls: 'heavy', score: 99, why: ['ручная метка'] };
  if (/!(light|легк)/.test(t)) return { cls: 'light', score: -99, why: ['ручная метка'] };
  let score = 0;
  const why = [];
  const hit = (list) => list.filter((k) => t.includes(k));
  const h = hit(HEAVY);
  const m = hit(MEDIUM);
  const l = hit(LIGHT);
  if (h.length) (score += Math.min(2 * h.length, 6)), why.push(`крупные: ${h.slice(0, 3).join(', ')}`);
  if (m.length) (score += Math.min(m.length, 3)), why.push(`действия: ${m.slice(0, 3).join(', ')}`);
  if (l.length) (score -= Math.min(2 * l.length, 4)), why.push(`лёгкие: ${l.slice(0, 3).join(', ')}`);
  const len = t.length;
  if (len > 1500) (score += 3), why.push('очень длинный');
  else if (len > 600) (score += 2), why.push('длинный');
  else if (len > 250) score += 1;
  else if (len < 80 && !m.length) score -= 1;
  const listItems = (t.match(/^\s*(\d+[.)]|[-*•])\s+/gm) || []).length;
  if (listItems >= 3) (score += 2), why.push(`${listItems} пунктов`);
  if (t.includes('```')) score += 1;
  if (/^\s*\/(code-review|deep-research|simplify|security-review|init)\b/.test(t)) (score += 4), why.push('тяжёлая команда');
  if (len < 200 && /\?\s*$/.test(t) && !h.length) score -= 1;
  const cls = score >= 4 ? 'heavy' : score >= 1 ? 'medium' : 'light';
  return { cls, score, why };
}

const CLS_RU = { light: 'лёгкая', medium: 'средняя', heavy: 'сложная' };

// ---------- per-session state ----------

function sessionFile(id) {
  return path.join(SESSIONS, String(id || 'unknown').replace(/[^\w.-]/g, '_') + '.json');
}
function loadSession(id) {
  return readJson(sessionFile(id), null);
}
function saveSession(id, s) {
  writeJson(sessionFile(id), s);
}
function pruneSessions() {
  try {
    const cutoff = Date.now() - 7 * 864e5;
    for (const f of fs.readdirSync(SESSIONS)) {
      const p = path.join(SESSIONS, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

// ---------- pausing ----------

// Sleeps until `until` in short ticks so `off` or `release` can end the pause early.
function pauseUntil(until, why) {
  log(`pause start: ${why}; until ${new Date(until).toISOString()}`);
  try {
    fs.unlinkSync(RELEASE);
  } catch {}
  const started = Date.now();
  let reason = 'reset';
  while (Date.now() < until) {
    if (fs.existsSync(RELEASE)) {
      reason = 'released';
      try {
        fs.unlinkSync(RELEASE);
      } catch {}
      break;
    }
    if (!config().enabled) {
      reason = 'disabled';
      break;
    }
    sleepMs(Math.min(15000, until - Date.now()));
  }
  log(`pause end: ${reason} after ${fmtDur(Date.now() - started)}`);
  return { reason, waited: Date.now() - started };
}

function refreshHint(cfg) {
  return `[usage-guard] Данные о лимитах плана устарели. Вызови ${cfg.usage_tool} (без аргументов), прежде чем продолжать; результат сохранится автоматически.`;
}

function pauseNote(p, w) {
  if (p.reason === 'released') return `[usage-guard] Пауза снята вручную через ${fmtDur(p.waited)}.`;
  if (p.reason === 'disabled') return `[usage-guard] Пауза прервана: guard выключен.`;
  return `[usage-guard] Пауза ${fmtDur(p.waited)}: ждали сброса лимита (${w.label}). Лимит должен быть восстановлен, продолжай задачу.`;
}

// ---------- hook handlers ----------

function onPrompt(input, cfg) {
  const text = input.prompt || '';
  const est = classify(text);
  const bypass = /!force\b/i.test(text);
  const u = usageNow();
  if (Math.random() < 0.05) pruneSessions();
  saveSession(input.session_id, {
    cls: est.cls,
    score: est.score,
    why: est.why,
    tools: 0,
    bypass,
    started: Date.now(),
    snippet: text.slice(0, 160),
  });
  log(`prompt: ${est.cls} (score ${est.score}) usage=${u.pct ?? '?'}% bypass=${bypass}`);
  if (bypass) return;

  const level = est.cls === 'heavy' ? cfg.threshold_pct : cfg.hard_pct;
  if (u.pct != null && u.pct >= level) {
    const w = waitTarget(u.ws, level);
    const until = w.resetsAt + cfg.reset_buffer_sec * 1000;
    const wait = until - Date.now();
    const head = `Лимит плана ${u.pct}% (${w.label}), задача оценена как ${CLS_RU[est.cls]}.`;
    if (cfg.prompt_mode === 'block' || wait > cfg.max_wait_hours * 3600e3) {
      fs.appendFileSync(
        QUEUE,
        JSON.stringify({ at: new Date().toISOString(), cwd: input.cwd, resetsAt: w.resetsAt, cls: est.cls, prompt: text }) + '\n',
      );
      out({
        decision: 'block',
        reason: `usage-guard: ${head} Запрос отложен и сохранён в очередь (/usage-guard queue). Лимит сбросится ${fmtTime(w.resetsAt)}. Чтобы выполнить сейчас, добавьте в запрос !force.`,
      });
      return;
    }
    const p = pauseUntil(until, `prompt ${est.cls} at ${u.pct}%`);
    if (p.reason === 'released') saveSession(input.session_id, { ...loadSession(input.session_id), bypass: true });
    const ctx = [pauseNote(p, w)];
    if (isDesktop()) ctx.push(refreshHint(cfg));
    out({
      systemMessage: `usage-guard: ${head} Запрос ждал ${fmtDur(p.waited)} и теперь выполняется.`,
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.join('\n') },
    });
    return;
  }

  const ctx = [];
  if (u.pct != null && u.pct >= cfg.warn_pct) {
    ctx.push(
      `[usage-guard] Использовано ${u.pct}% лимита плана (${u.top.label}, сброс ${fmtTime(u.top.resetsAt)}). Задача оценена как ${CLS_RU[est.cls]}: работай экономно, без лишних чтений и субагентов.`,
    );
  }
  if (isDesktop() && isStale(u) && (est.cls !== 'light' || (u.pct ?? 0) >= cfg.warn_pct)) ctx.push(refreshHint(cfg));
  if (ctx.length) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.join('\n') } });
}

function onPre(input, cfg) {
  const tool = input.tool_name || '';
  if (EXEMPT_TOOLS.test(tool)) return;
  const id = input.session_id;
  const s = loadSession(id) || { cls: 'medium', score: 0, tools: 0, started: Date.now(), why: ['промпт не виден'] };
  s.tools = (s.tools || 0) + 1;
  if (s.cls !== 'heavy' && SUBAGENT_TOOLS.test(tool)) (s.cls = 'heavy'), (s.escalated = `субагент (${tool})`);
  else if (s.cls !== 'heavy' && s.tools > (cfg.escalate_after[s.cls] ?? 999))
    (s.cls = 'heavy'), (s.escalated = `${s.tools} вызовов инструментов`);
  saveSession(id, s);
  if (s.bypass) return;

  const u = usageNow();
  const level = s.cls === 'heavy' ? cfg.threshold_pct : cfg.hard_pct;
  if (u.pct != null && u.pct >= level) {
    const w = waitTarget(u.ws, level);
    const until = w.resetsAt + cfg.reset_buffer_sec * 1000;
    if (until - Date.now() > cfg.max_wait_hours * 3600e3) {
      log(`pre: stop, ${w.label} resets ${new Date(w.resetsAt).toISOString()}`);
      out({
        continue: false,
        stopReason: `usage-guard: лимит ${u.pct}% (${w.label}), сброс только ${fmtTime(w.resetsAt)}. Сложная задача остановлена; продолжите после сброса или отправьте запрос с !force.`,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `usage-guard: лимит плана ${u.pct}%, задача остановлена до ${fmtTime(w.resetsAt)}.`,
        },
      });
      return;
    }
    const p = pauseUntil(until, `pre ${tool} ${s.cls} at ${u.pct}%`);
    if (p.reason === 'released') saveSession(id, { ...s, bypass: true }); // don't pause again on the next call
    out({ systemMessage: `usage-guard: лимит был ${u.pct}% (${w.label}), ${CLS_RU[s.cls]} задача стояла на паузе ${fmtDur(p.waited)}. ${pauseNote(p, w)}` });
    return;
  }

  // Close to the limit on a heavy task with old numbers: make Claude look first (once per 5 min).
  if (isDesktop() && s.cls === 'heavy' && (u.pct ?? 0) >= cfg.warn_pct && isStale(u) && Date.now() - (s.preNagAt || 0) > 5 * 60e3) {
    s.preNagAt = Date.now();
    saveSession(id, s);
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${refreshHint(cfg)} Затем повтори этот же вызов ${tool}.`,
      },
    });
  }
}

function onPost(input, cfg) {
  const tool = input.tool_name || '';
  if (tool === cfg.usage_tool || /get_usage$/.test(tool)) {
    const ok = saveUsage(extractWindows(input.tool_response), 'get_usage');
    log(`post: usage ${ok ? 'saved' : 'not found in tool response'}`);
    return;
  }
  if (!isDesktop()) return;
  const s = loadSession(input.session_id);
  const u = usageNow();
  if (!s || !isStale(u)) return;
  if (s.cls === 'light' && (u.pct ?? 0) < cfg.warn_pct) return;
  if (Date.now() - (s.nagAt || 0) < 3 * 60e3) return;
  s.nagAt = Date.now();
  saveSession(input.session_id, s);
  out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: refreshHint(cfg) } });
}

function onStatusline(input) {
  saveUsage(extractWindows(input.rate_limits), 'statusline');
  const u = usageNow();
  const parts = [input.model?.display_name].filter(Boolean);
  for (const w of u.ws) parts.push(`${w.key === 'seven_day' ? '7д' : w.key === 'five_hour' ? '5ч' : w.label} ${Math.round(w.pct)}%`);
  if (u.pct != null && u.pct >= config().threshold_pct) parts.push('⏸ тяжёлые задачи на паузе');
  process.stdout.write(parts.join(' · '));
}

// ---------- CLI ----------

function cli(cmd, args) {
  const cfg = config();
  const raw = readJson(CONFIG, {});
  switch (cmd) {
    case 'status': {
      const u = usageNow();
      console.log(`usage-guard: ${cfg.enabled ? 'включён' : 'ВЫКЛЮЧЕН'}; пороги: сложные ${cfg.threshold_pct}%, все ${cfg.hard_pct}%, режим запроса: ${cfg.prompt_mode}`);
      if (!u.cache) console.log('Данных о лимитах ещё нет (нужен вызов get_usage или statusline в CLI).');
      else {
        console.log(`Данные: ${u.cache.source}, ${fmtDur(u.age)} назад${isStale(u) ? ' (устарели)' : ''}`);
        for (const w of u.ws) console.log(`  ${w.label}: ${w.pct}%${w.resetsAt ? `, сброс ${fmtTime(w.resetsAt)}` : ''}`);
      }
      const q = fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').trim().split('\n').filter(Boolean).length : 0;
      console.log(`Отложенных запросов в очереди: ${q}`);
      return;
    }
    case 'on':
    case 'off':
      writeJson(CONFIG, { ...raw, enabled: cmd === 'on' });
      console.log(`usage-guard ${cmd === 'on' ? 'включён' : 'выключен'}`);
      return;
    case 'release':
      fs.writeFileSync(RELEASE, String(Date.now()));
      console.log('Текущая пауза будет снята в течение 15 секунд.');
      return;
    case 'set': {
      const [key, value] = args;
      if (!(key in DEFAULTS) || key === 'escalate_after') return console.log(`Неизвестный ключ. Доступны: ${Object.keys(DEFAULTS).filter((k) => k !== 'escalate_after').join(', ')}`);
      const v = typeof DEFAULTS[key] === 'number' ? Number(value) : typeof DEFAULTS[key] === 'boolean' ? value === 'true' : value;
      writeJson(CONFIG, { ...raw, [key]: v });
      console.log(`${key} = ${JSON.stringify(v)}`);
      return;
    }
    case 'queue': {
      const lines = fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (!lines.length) return console.log('Очередь пуста.');
      lines.forEach((l, i) => {
        const e = JSON.parse(l);
        console.log(`#${i + 1} [${e.at}] ${e.cls}, cwd=${e.cwd}, сброс ${fmtTime(e.resetsAt)}\n${e.prompt}\n`);
      });
      return;
    }
    case 'clear-queue':
      try {
        fs.unlinkSync(QUEUE);
      } catch {}
      console.log('Очередь очищена.');
      return;
    case 'classify': {
      const r = classify(args.join(' '));
      console.log(`${r.cls} (${CLS_RU[r.cls]}), score ${r.score}; ${r.why.join('; ')}`);
      return;
    }
    case 'record': // record '<json>' — manual or scripted usage update
      console.log(saveUsage(extractWindows(args.join(' ')), 'manual') ? 'Сохранено.' : 'Не удалось разобрать данные.');
      return;
    default:
      console.log('Команды: status | on | off | release | set <key> <value> | queue | clear-queue | classify <text> | record <json>');
  }
}

// Plugin installs live in a versioned cache directory, so publish the current location.
function recordScriptPath() {
  const self = __filename.replace(/\\/g, '/');
  try {
    if (fs.readFileSync(SCRIPT_PATH, 'utf8').trim() === self) return;
  } catch {}
  fs.writeFileSync(SCRIPT_PATH, self);
}

function main() {
  ensureDirs();
  recordScriptPath();
  const [mode, ...args] = process.argv.slice(2);
  const hooks = { prompt: onPrompt, pre: onPre, post: onPost };
  if (mode === 'statusline') return onStatusline(readStdin());
  if (!hooks[mode]) return cli(mode, args);
  const cfg = config();
  if (!cfg.enabled) return;
  hooks[mode](readStdin(), cfg);
}

try {
  main();
} catch (e) {
  log(`error: ${e && e.stack ? e.stack : e}`);
}
process.exit(0);
