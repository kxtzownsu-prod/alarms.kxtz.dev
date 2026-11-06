const STORAGE_KEY = 'alarms.kxtz';
const DB_NAME = 'alarms.kxtz';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const AUTO_CLEAR_MS = 20 * 60 * 1000;
const MAX_RANGE_ALARMS = 500;
const alarms = [];
let ringingAlarm = null;
let editingAlarm = null;
let savedDayState = [];
let notificationAsked = false;
let keepAliveOn = false;
let audioCtx = null;
let keepOsc = null;
let keepGain = null;
let keepWavUrl = '';
let wakeLock = null;
let dueTimer = null;
let autoClearTimer = null;
let addMode = 'single';

const clockEl = document.getElementById('clock');
const dateLabelEl = document.getElementById('dateLabel');
const alarmsContainer = document.getElementById('alarmsContainer');
const modeToggle = document.getElementById('modeToggle');
const bannerText = document.getElementById('bannerText');
const liveDot = document.getElementById('liveDot');
const armSoundBtn = document.getElementById('armSoundBtn');

const addOverlay = document.getElementById('addOverlay');
const addForm = document.getElementById('addForm');
const addAlarmBtn = document.getElementById('addAlarmBtn');
const bulkAddBtn = document.getElementById('bulkAddBtn');
const cancelAddBtn = document.getElementById('cancelAddBtn');
const timeInput = document.getElementById('timeInput');
const labelInput = document.getElementById('labelInput');
const soundInput = document.getElementById('soundInput');
const soundFile = document.getElementById('soundFile');
const repeatInput = document.getElementById('repeatInput');
const dayRepeatFields = document.getElementById('dayRepeatFields');
const dayInputs = [...document.querySelectorAll('#dayRepeatFields [data-day]')];
const addDialogTitle = document.getElementById('addDialogTitle');
const deleteEditBtn = document.getElementById('deleteEditBtn');
const soundHint = document.getElementById('soundHint');
const saveAlarmBtn = document.getElementById('saveAlarmBtn');
const alarmModeField = document.getElementById('alarmModeField');
const modeSingleBtn = document.getElementById('modeSingleBtn');
const modeRangeBtn = document.getElementById('modeRangeBtn');
const singleTimeField = document.getElementById('singleTimeField');
const rangeFields = document.getElementById('rangeFields');
const startTimeInput = document.getElementById('startTimeInput');
const endTimeInput = document.getElementById('endTimeInput');
const intervalInput = document.getElementById('intervalInput');
const rangeHint = document.getElementById('rangeHint');

const ringOverlay = document.getElementById('ringOverlay');
const ringTime = document.getElementById('ringTime');
const ringLabel = document.getElementById('ringLabel');
const stopBtn = document.getElementById('stopBtn');
const snoozeBtn = document.getElementById('snoozeBtn');
const allowSoundBtn = document.getElementById('allowSoundBtn');
const ringtone = document.getElementById('ringtone');
const keepAliveEl = document.getElementById('keepAlive');

function pad(n) {
  return String(n).padStart(2, '0');
}

function makeId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatHm(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseHm(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function formatMinutes(total) {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function dueAt(alarm, now) {
  const parts = alarm.time.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
}

function selectedDays(alarm) {
  return Array.isArray(alarm.days) ? alarm.days.map(Number) : [];
}

function repeats(alarm) {
  return !!(alarm.repeat || selectedDays(alarm).length);
}

function repeatsOn(alarm, weekday) {
  if (alarm.repeat) return true;
  const days = selectedDays(alarm);
  if (!days.length) return true;
  return days.includes(weekday);
}

function nextDue(alarm, now) {
  const parts = alarm.time.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  for (let i = 0; i < 8; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!repeatsOn(alarm, day.getDay())) continue;
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
    if (candidate.getTime() <= now.getTime()) continue;
    if (alarm.lastTriggered === todayKey(candidate)) continue;
    if (alarm.createdAt && alarm.createdAt > candidate.getTime()) continue;
    return candidate;
  }
  const fallback = dueAt(alarm, now);
  fallback.setDate(fallback.getDate() + 7);
  return fallback;
}

function shouldFire(alarm, now) {
  if (!alarm.enabled) return false;
  if (!repeatsOn(alarm, now.getDay())) return false;
  const due = dueAt(alarm, now);
  if (now < due) return false;
  if (alarm.lastTriggered === todayKey(now)) return false;
  if (alarm.createdAt && alarm.createdAt > due.getTime()) return false;
  return true;
}

function readDays() {
  return dayInputs.filter((input) => input.checked).map((input) => Number(input.dataset.day));
}

function writeDays(days) {
  const set = new Set((days || []).map(Number));
  dayInputs.forEach((input) => {
    input.checked = set.has(Number(input.dataset.day));
  });
}

function syncDayRepeatUi() {
  const daily = repeatInput.checked;
  dayRepeatFields.hidden = false;
  dayRepeatFields.classList.toggle('is-disabled', daily);
  dayInputs.forEach((input) => {
    input.disabled = daily;
  });
}

function onDailyChange() {
  if (repeatInput.checked) {
    savedDayState = readDays();
    writeDays(savedDayState);
  } else {
    writeDays(savedDayState);
  }
  syncDayRepeatUi();
}

function rangeInfo() {
  const start = parseHm(startTimeInput.value);
  const end = parseHm(endTimeInput.value);
  const interval = Number(intervalInput.value);
  if (start === null || end === null) {
    return { error: 'Set a start time and an end time.' };
  }
  if (end <= start) {
    return { error: 'End time must be after start time.' };
  }
  if (!Number.isInteger(interval) || interval < 1) {
    return { error: 'Interval must be at least 1 minute.' };
  }
  const count = Math.floor((end - start) / interval) + 1;
  if (count > MAX_RANGE_ALARMS) {
    return { error: `That would create ${count} alarms. The limit is ${MAX_RANGE_ALARMS}.` };
  }
  const times = [];
  for (let minute = start; minute <= end; minute += interval) {
    times.push(formatMinutes(minute));
  }
  return { times, count };
}

function updateRangeHint() {
  if (addMode !== 'range') return;
  if (!startTimeInput.value || !endTimeInput.value || !intervalInput.value) {
    rangeHint.textContent = 'Set a start time, end time, and interval.';
    rangeHint.classList.remove('is-error');
    saveAlarmBtn.textContent = 'Add alarms';
    return;
  }
  const info = rangeInfo();
  if (info.error) {
    rangeHint.textContent = info.error;
    rangeHint.classList.add('is-error');
    saveAlarmBtn.textContent = 'Add alarms';
    return;
  }
  const noun = info.count === 1 ? 'alarm' : 'alarms';
  const first = info.times[0];
  const last = info.times[info.times.length - 1];
  rangeHint.textContent = `Creates ${info.count} ${noun} from ${first} to ${last}.`;
  rangeHint.classList.remove('is-error');
  saveAlarmBtn.textContent = `Add ${info.count} ${noun}`;
}

function setAddMode(mode) {
  addMode = mode;
  const isRange = mode === 'range';
  singleTimeField.hidden = isRange;
  rangeFields.hidden = !isRange;
  timeInput.disabled = isRange;
  timeInput.required = !isRange;
  startTimeInput.disabled = !isRange;
  endTimeInput.disabled = !isRange;
  intervalInput.disabled = !isRange;
  startTimeInput.required = isRange;
  endTimeInput.required = isRange;
  intervalInput.required = isRange;
  modeSingleBtn.classList.toggle('is-selected', !isRange);
  modeRangeBtn.classList.toggle('is-selected', isRange);
  modeSingleBtn.setAttribute('aria-pressed', String(!isRange));
  modeRangeBtn.setAttribute('aria-pressed', String(isRange));
  if (isRange && !startTimeInput.value && timeInput.value) {
    startTimeInput.value = timeInput.value;
  }
  if (!isRange && !timeInput.value && startTimeInput.value) {
    timeInput.value = startTimeInput.value;
  }
  if (!editingAlarm) addDialogTitle.textContent = isRange ? 'Add alarms' : 'Add alarm';
  saveAlarmBtn.textContent = 'Save alarm';
  updateRangeHint();
}

function repeatBadge(alarm) {
  if (alarm.repeat) return 'Repeats daily';
  const days = selectedDays(alarm).slice().sort((a, b) => a - b);
  if (!days.length) return 'One time';
  return days.map((day) => DAY_NAMES[day]).join(' ');
}

function isArmed() {
  return alarms.some((alarm) => alarm.enabled) || !!ringingAlarm;
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sounds')) db.createObjectStore('sounds');
    };
    req.onsuccess = () => {
      req.result.addEventListener('close', () => { dbPromise = null; });
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function idbOp(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('sounds', mode);
    const store = tx.objectStore('sounds');
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbGet(key) {
  return idbOp('readonly', (store) => store.get(key));
}

function idbPut(key, value) {
  return idbOp('readwrite', (store) => store.put(value, key));
}

function idbDelete(key) {
  return idbOp('readwrite', (store) => store.delete(key));
}

function serialize(alarm) {
  return {
    id: alarm.id,
    time: alarm.time,
    label: alarm.label,
    soundUrl: alarm.soundKind === 'file' ? '' : alarm.soundUrl,
    soundName: alarm.soundName,
    soundKind: alarm.soundKind || 'url',
    soundId: alarm.soundId || null,
    repeat: alarm.repeat,
    days: selectedDays(alarm),
    enabled: alarm.enabled,
    lastTriggered: alarm.lastTriggered,
    createdAt: alarm.createdAt || 0,
  };
}

function saveAlarms() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alarms.map(serialize)));
}

async function loadAlarms() {
  let parsed = [];
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    parsed = [];
  }
  for (const row of parsed) {
    let soundUrl = row.soundUrl;
    if (row.soundKind === 'file' && row.soundId) {
      try {
        const blob = await idbGet(row.soundId);
        if (blob) soundUrl = URL.createObjectURL(blob);
      } catch {
        soundUrl = '';
      }
    }
    alarms.push({
      id: row.id,
      time: row.time,
      label: row.label || 'Alarm',
      soundUrl,
      soundName: row.soundName || '',
      soundKind: row.soundKind || 'url',
      soundId: row.soundId || null,
      repeat: !!row.repeat,
      days: Array.isArray(row.days) ? row.days.map(Number) : [],
      enabled: !!row.enabled,
      lastTriggered: row.lastTriggered || null,
      createdAt: row.createdAt || 0,
    });
  }
}

function releaseSound(soundId) {
  if (!soundId) return;
  if (alarms.some((alarm) => alarm.soundId === soundId)) return;
  idbDelete(soundId).catch(() => {});
}

function makeKeepAliveWav() {
  const rate = 8000;
  const n = rate;
  const dataSize = n * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) {
    const sample = Math.sin((2 * Math.PI * 18 * i) / rate) * 140;
    v.setInt16(44 + i * 2, sample, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function ensureCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

async function startKeepAlive() {
  const ctx = ensureCtx();
  try {
    if (ctx && ctx.state === 'suspended') await ctx.resume();
  } catch {}

  if (ringingAlarm) return;

  if (ctx && !keepOsc) {
    keepOsc = ctx.createOscillator();
    keepGain = ctx.createGain();
    keepOsc.frequency.value = 18;
    keepOsc.connect(keepGain);
    keepGain.connect(ctx.destination);
    keepOsc.start();
  }
  if (keepGain) keepGain.gain.value = 0.0008;

  if (!keepAliveEl.src) keepAliveEl.src = keepWavUrl;
  keepAliveEl.loop = true;
  keepAliveEl.volume = 0.02;
  try {
    await keepAliveEl.play();
    keepAliveOn = true;
  } catch {
    keepAliveOn = !!(ctx && ctx.state === 'running');
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ringingAlarm ? ringingAlarm.label : 'Alarms armed',
      artist: 'alarms.kxtz.dev',
    });
    navigator.mediaSession.playbackState = 'playing';
  }
  updateBanner();
}

function stopKeepAlive() {
  if (keepOsc) {
    try {
      keepOsc.stop();
    } catch {}
    try {
      keepOsc.disconnect();
      keepGain.disconnect();
    } catch {}
    keepOsc = null;
    keepGain = null;
  }
  keepAliveEl.pause();
  keepAliveOn = false;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  updateBanner();
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.hidden || !isArmed()) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  wakeLock.release().catch(() => {});
  wakeLock = null;
}

function syncBackground() {
  if (isArmed()) {
    startKeepAlive();
    requestWakeLock();
  } else {
    stopKeepAlive();
    releaseWakeLock();
  }
  armDueTimer();
  updateBanner();
}

function updateBanner() {
  const armed = isArmed();
  liveDot.hidden = !keepAliveOn;
  document.getElementById('bannerIcon').hidden = keepAliveOn;
  armSoundBtn.hidden = !armed || keepAliveOn;
  if (!armed) {
    bannerText.textContent =
      'Alarms keep running if this tab stays open in the background. Closing the tab still stops them.';
    return;
  }
  if (keepAliveOn) {
    bannerText.textContent =
      'Background running. You can switch tabs. Closing this tab still stops alarms.';
    return;
  }
  bannerText.textContent =
    'Tap Enable background so the timer can keep running after you switch tabs.';
}

function armDueTimer() {
  clearTimeout(dueTimer);
  const now = new Date();
  let next = Infinity;
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    const t = nextDue(alarm, now).getTime();
    if (t < next) next = t;
  }
  if (next === Infinity) return;
  const wait = Math.max(50, Math.min(next - Date.now(), 86400000));
  dueTimer = setTimeout(() => {
    updateClock();
    armDueTimer();
  }, wait);
}

function updateClock() {
  const now = new Date();
  clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  dateLabelEl.textContent = now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  checkAlarms(now);
}

function checkAlarms(now) {
  const due = [];
  let latest = null;
  let latestDue = -Infinity;
  for (const alarm of alarms) {
    if (!shouldFire(alarm, now)) continue;
    due.push(alarm);
    const dueTime = dueAt(alarm, now).getTime();
    if (dueTime >= latestDue) {
      latest = alarm;
      latestDue = dueTime;
    }
  }
  if (!due.length) return;
  for (const alarm of due) {
    alarm.lastTriggered = todayKey(now);
    if (!repeats(alarm)) alarm.enabled = false;
  }
  saveAlarms();
  triggerAlarm(latest);
  renderAlarms();
  syncBackground();
}

async function notifyAlarm(alarm) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body: `Alarm for ${alarm.time}`,
    tag: `alarm-${alarm.id}`,
    icon: './icon-192.png',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 120, 300, 120, 300],
    data: { id: alarm.id },
    actions: [
      { action: 'snooze', title: 'Snooze 5 min' },
      { action: 'stop', title: 'Stop' },
    ],
  };
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(alarm.label, opts);
  } catch {
    try {
      new Notification(alarm.label, { body: opts.body, tag: opts.tag, icon: opts.icon });
    } catch {}
  }
}

async function closeAlarmNotifications(id) {
  if (!id || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.getNotifications) return;
    const notes = await reg.getNotifications({ tag: id ? `alarm-${id}` : undefined });
    notes.forEach((note) => note.close());
  } catch {}
}

function triggerAlarm(alarm) {
  if (ringingAlarm) stopRinging();
  ringingAlarm = alarm;
  ringTime.textContent = alarm.time;
  ringLabel.textContent = alarm.label;
  ringOverlay.hidden = false;
  allowSoundBtn.hidden = true;
  document.title = `Alarm · ${alarm.label}`;
  clearTimeout(autoClearTimer);
  autoClearTimer = setTimeout(() => {
    autoClearTimer = null;
    stopRinging();
  }, AUTO_CLEAR_MS);

  ringtone.src = alarm.soundUrl;
  ringtone.loop = true;
  ringtone.currentTime = 0;
  const playPromise = ringtone.play();
  if (playPromise) {
    playPromise
      .then(() => {
        if (keepGain) keepGain.gain.value = 0;
        keepAliveEl.pause();
      })
      .catch(() => {
        allowSoundBtn.hidden = false;
      });
  }

  notifyAlarm(alarm);
  startKeepAlive();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: alarm.label,
      artist: alarm.time,
      album: 'alarms.kxtz.dev',
    });
    navigator.mediaSession.setActionHandler('pause', () => stopRinging());
    navigator.mediaSession.setActionHandler('stop', () => stopRinging());
  }
}

function stopRinging() {
  clearTimeout(autoClearTimer);
  autoClearTimer = null;
  const id = ringingAlarm && ringingAlarm.id;
  ringtone.pause();
  ringtone.currentTime = 0;
  ringOverlay.hidden = true;
  ringingAlarm = null;
  document.title = 'Alarms';
  closeAlarmNotifications(id);
  syncBackground();
}

function snoozeRinging(minutes) {
  const alarm = ringingAlarm;
  stopRinging();
  if (!alarm) return;
  const wakeAt = new Date(Date.now() + minutes * 60000);
  alarms.push({
    id: makeId(),
    time: formatHm(wakeAt),
    label: `${alarm.label} (snoozed)`,
    soundUrl: alarm.soundUrl,
    soundName: alarm.soundName,
    soundKind: alarm.soundKind,
    soundId: alarm.soundId,
    repeat: false,
    days: [],
    enabled: true,
    lastTriggered: null,
    createdAt: Date.now(),
  });
  saveAlarms();
  renderAlarms();
  syncBackground();
}

function renderAlarms() {
  if (alarms.length === 0) {
    alarmsContainer.innerHTML = `
      <div class="empty">
        <p>No alarms yet.</p>
        <button class="btn btn-primary" id="emptyAddBtn" type="button">+ Add alarm</button>
      </div>`;
    document.getElementById('emptyAddBtn').addEventListener('click', openAddDialog);
    return;
  }

  const sorted = [...alarms].sort((a, b) => a.time.localeCompare(b.time));
  const card = document.createElement('div');
  card.className = 'card';

  for (const alarm of sorted) {
    const row = document.createElement('div');
    row.className = `alarm-row${alarm.enabled ? '' : ' is-disabled'}`;
    row.innerHTML = `
      <button class="alarm-main" type="button" data-action="edit">
        <div class="alarm-time">${alarm.time}</div>
        <div class="alarm-info">
          <div class="alarm-label"></div>
          <div class="alarm-meta">
            <span class="badge"></span>
            <span class="sound-name"></span>
          </div>
        </div>
      </button>
      <div class="alarm-actions">
        <button class="btn btn-ghost btn-icon btn-sm" type="button" data-action="test" title="Test sound" aria-label="Test sound">▶</button>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" data-action="edit" title="Edit alarm" aria-label="Edit alarm">✎</button>
        <label class="switch">
          <input type="checkbox" data-action="toggle" aria-label="Enable alarm">
          <span class="track"><span class="thumb"></span></span>
        </label>
        <button class="btn btn-danger-ghost btn-icon btn-sm" type="button" data-action="delete" title="Delete alarm" aria-label="Delete alarm">✕</button>
      </div>`;

    row.querySelector('.alarm-label').textContent = alarm.label;
    row.querySelector('.sound-name').textContent = alarm.soundName;
    row.querySelector('.badge').textContent = repeatBadge(alarm);
    row.querySelector('[data-action="toggle"]').checked = alarm.enabled;

    row.querySelector('[data-action="test"]').addEventListener('click', () => {
      new Audio(alarm.soundUrl).play().catch(() => {});
    });
    row.querySelectorAll('[data-action="edit"]').forEach((btn) => {
      btn.addEventListener('click', () => openAlarmDialog(alarm));
    });
    row.querySelector('[data-action="toggle"]').addEventListener('change', (e) => {
      alarm.enabled = e.target.checked;
      if (alarm.enabled) alarm.lastTriggered = null;
      saveAlarms();
      renderAlarms();
      syncBackground();
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      deleteAlarm(alarm);
    });

    card.appendChild(row);
  }

  alarmsContainer.innerHTML = '';
  alarmsContainer.appendChild(card);
}

function askNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default' || notificationAsked) return;
  notificationAsked = true;
  Notification.requestPermission();
}

function deleteAlarm(alarm) {
  if (ringingAlarm && ringingAlarm.id === alarm.id) stopRinging();
  const index = alarms.indexOf(alarm);
  if (index !== -1) alarms.splice(index, 1);
  if (alarm.soundKind === 'file' && alarm.soundUrl) URL.revokeObjectURL(alarm.soundUrl);
  saveAlarms();
  releaseSound(alarm.soundId);
  if (editingAlarm && editingAlarm.id === alarm.id) closeAddDialog();
  renderAlarms();
  syncBackground();
}

function openAddDialog() {
  openAlarmDialog(null);
}

function openAlarmDialog(alarm) {
  editingAlarm = alarm;
  addForm.reset();
  addDialogTitle.textContent = alarm ? 'Edit alarm' : 'Add alarm';
  deleteEditBtn.hidden = !alarm;
  alarmModeField.hidden = !!alarm;
  setAddMode('single');
  if (alarm) {
    timeInput.value = alarm.time;
    labelInput.value = alarm.label;
    soundInput.value = alarm.soundKind === 'url' ? alarm.soundUrl : '';
    repeatInput.checked = !!alarm.repeat;
    savedDayState = selectedDays(alarm);
    writeDays(savedDayState);
    soundHint.textContent = `Current sound: ${alarm.soundName}. Leave blank to keep it.`;
  } else {
    repeatInput.checked = true;
    savedDayState = [];
    writeDays(savedDayState);
    soundHint.textContent =
      'A local file is stored in this browser. Use a URL if you want to share the same sound across devices.';
  }
  syncDayRepeatUi();
  addOverlay.hidden = false;
  timeInput.focus();
  askNotificationPermission();
}

function closeAddDialog() {
  addOverlay.hidden = true;
  editingAlarm = null;
}

addAlarmBtn.addEventListener('click', openAddDialog);
bulkAddBtn.addEventListener('click', () => {
  openAddDialog();
  setAddMode('range');
  startTimeInput.focus();
});
cancelAddBtn.addEventListener('click', closeAddDialog);
deleteEditBtn.addEventListener('click', () => {
  if (editingAlarm) deleteAlarm(editingAlarm);
});
repeatInput.addEventListener('change', onDailyChange);
modeSingleBtn.addEventListener('click', () => setAddMode('single'));
modeRangeBtn.addEventListener('click', () => setAddMode('range'));
[startTimeInput, endTimeInput, intervalInput].forEach((input) => {
  input.addEventListener('input', updateRangeHint);
});
addOverlay.addEventListener('click', (e) => {
  if (e.target === addOverlay) closeAddDialog();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !addOverlay.hidden) closeAddDialog();
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const existing = editingAlarm;
  const file = soundFile.files[0];
  const url = file ? '' : soundInput.value.trim();
  if (!file && !url && !existing) {
    soundInput.focus();
    return;
  }

  const isRange = !existing && addMode === 'range';
  let times = [timeInput.value];
  if (isRange) {
    const info = rangeInfo();
    if (info.error || !info.times.length) {
      updateRangeHint();
      return;
    }
    times = info.times;
  } else if (!timeInput.value) {
    timeInput.focus();
    return;
  }

  const daily = repeatInput.checked;
  const days = daily ? savedDayState.slice() : readDays();
  const label = labelInput.value.trim() || 'Alarm';
  const enabled = existing ? existing.enabled : true;
  const createdAt = existing ? existing.createdAt : Date.now();

  let soundUrl = existing ? existing.soundUrl : url;
  let soundKind = existing ? existing.soundKind : 'url';
  let soundId = existing ? existing.soundId : null;
  let soundName = existing ? existing.soundName : url;
  const oldSoundId = soundId;

  if (file) {
    soundKind = 'file';
    soundName = file.name;
  } else if (url) {
    soundKind = 'url';
    soundId = null;
    soundUrl = url;
    soundName = url;
    if (existing && existing.soundKind === 'file' && existing.soundUrl) {
      URL.revokeObjectURL(existing.soundUrl);
    }
  }

  if (isRange) {
    const groupSoundId = file ? makeId() : null;
    if (file) {
      try {
        await idbPut(groupSoundId, file);
      } catch {}
    }
    for (const time of times) {
      alarms.push({
        id: makeId(),
        time,
        label,
        soundUrl: file ? URL.createObjectURL(file) : soundUrl,
        soundName: file ? file.name : soundName,
        soundKind: file ? 'file' : 'url',
        soundId: groupSoundId,
        repeat: daily,
        days: days.slice(),
        enabled: true,
        lastTriggered: null,
        createdAt,
      });
    }
  } else {
    const id = existing ? existing.id : makeId();
    if (file) {
      soundId = existing ? existing.id : id;
      soundUrl = URL.createObjectURL(file);
      try {
        await idbPut(soundId, file);
      } catch {}
      if (existing && existing.soundKind === 'file' && existing.soundUrl && existing.soundUrl !== soundUrl) {
        URL.revokeObjectURL(existing.soundUrl);
      }
    }
    const next = {
      id,
      time: timeInput.value,
      label,
      soundUrl,
      soundName,
      soundKind,
      soundId,
      repeat: daily,
      days,
      enabled,
      lastTriggered: null,
      createdAt,
    };

    if (existing) {
      const index = alarms.indexOf(existing);
      if (index !== -1) alarms[index] = next;
      else alarms.push(next);
    } else {
      alarms.push(next);
    }
    if (oldSoundId && oldSoundId !== soundId) releaseSound(oldSoundId);
  }

  saveAlarms();
  closeAddDialog();
  renderAlarms();
  syncBackground();
  askNotificationPermission();
});

stopBtn.addEventListener('click', stopRinging);
snoozeBtn.addEventListener('click', () => snoozeRinging(5));
allowSoundBtn.addEventListener('click', () => {
  ringtone.play().catch(() => {});
  allowSoundBtn.hidden = true;
  startKeepAlive();
});
armSoundBtn.addEventListener('click', () => {
  startKeepAlive();
  askNotificationPermission();
});

modeToggle.addEventListener('click', () => {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const current = document.documentElement.dataset.mode || (systemDark ? 'dark' : 'light');
  document.documentElement.dataset.mode = current === 'dark' ? 'light' : 'dark';
});

document.addEventListener('pointerdown', () => {
  if (isArmed()) startKeepAlive();
});

document.addEventListener('visibilitychange', () => {
  updateClock();
  if (!document.hidden && isArmed()) {
    startKeepAlive();
    requestWakeLock();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!isArmed()) return;
  e.preventDefault();
  e.returnValue = '';
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'stop') stopRinging();
    if (data.type === 'snooze') snoozeRinging(5);
    if (data.type === 'open' && ringingAlarm) ringOverlay.hidden = false;
  });
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('pause', () => {
    if (ringingAlarm) stopRinging();
  });
  navigator.mediaSession.setActionHandler('stop', () => {
    if (ringingAlarm) stopRinging();
  });
}

keepWavUrl = makeKeepAliveWav();

(async () => {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch {}
  }
  await loadAlarms();
  renderAlarms();
  updateClock();
  setInterval(updateClock, 1000);
  syncBackground();
})();
