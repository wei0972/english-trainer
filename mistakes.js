const MODES = ['speak', 'spell', 'listen'];
const LEVELS = ['miss', 'close', 'skip', 'wrong'];
const KEEP = 10;

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const validEvent = (event) => isObject(event) && MODES.includes(event.mode) && LEVELS.includes(event.level) && typeof event.heard === 'string' && typeof event.at === 'number' && Number.isFinite(event.at);

export function validateMistakes(value) {
  if (!isObject(value)) return {};
  const cleaned = {};
  for (const [word, entry] of Object.entries(value)) {
    if (!isObject(entry) || !Array.isArray(entry.events)) continue;
    const events = entry.events.filter(validEvent).map(({ mode, heard, level, at }) => ({ mode, heard, level, at }));
    const fixed = {};
    if (isObject(entry.fixed)) for (const mode of MODES) if (typeof entry.fixed[mode] === 'number' && Number.isFinite(entry.fixed[mode])) fixed[mode] = entry.fixed[mode];
    if (events.length) cleaned[word] = { events, fixed };
  }
  return cleaned;
}

export function recordMistake(book = {}, word, event) {
  const entry = book[word] || { events: [], fixed: {} };
  const events = [...entry.events, { mode: event.mode, heard: event.heard ?? '', level: event.level, at: event.at ?? Date.now() }];
  // Keep only the last KEEP events of this mode; other modes are untouched.
  const sameMode = events.filter((item) => item.mode === event.mode);
  const dropped = new Set(sameMode.slice(0, Math.max(0, sameMode.length - KEEP)));
  return { ...book, [word]: { events: events.filter((item) => !dropped.has(item)), fixed: { ...entry.fixed } } };
}

export function markFixed(book = {}, word, mode, now = Date.now()) {
  if (!book[word]) return { ...book };
  return { ...book, [word]: { ...book[word], fixed: { ...book[word].fixed, [mode]: now } } };
}

const activeEvents = (entry) => entry.events.filter((event) => event.at > (entry.fixed?.[event.mode] ?? 0));

export function activeEventsOf(book = {}, word) {
  return book[word] ? activeEvents(book[word]) : [];
}

export function activeWords(book = {}) {
  return Object.entries(book)
    .map(([word, entry]) => { const active = activeEvents(entry); return { word, count: active.length, last: active.reduce((max, event) => Math.max(max, event.at), 0) }; })
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .map((item) => item.word);
}

export function confusionPairs(book = {}, minCount = 2) {
  const groups = new Map();
  for (const [word, entry] of Object.entries(book)) {
    for (const event of entry.events) {
      if (event.mode !== 'speak' && event.mode !== 'spell') continue;
      const heard = String(event.heard || '').toLowerCase().trim().replace(/\s+/g, ' ');
      if (!heard || heard === word.toLowerCase()) continue;
      const key = `${word}\u0000${heard}`;
      const group = groups.get(key) || { word, heard, mode: event.mode, count: 0 };
      group.count++;
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter((group) => group.count >= minCount).sort((a, b) => b.count - a.count);
}

export function mistakeCount(book = {}, word) {
  return book[word]?.events.length ?? 0;
}
