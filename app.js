/* ─────────────────────────────────────────────
   Focus Timer — app logic
   Vanilla JS, no dependencies, no build step.
   ───────────────────────────────────────────── */

(function () {
  'use strict';

  /* ── constants ───────────────────────────── */

  const STORAGE_KEY = 'focus-timer-v1';
  const SCHEMA_VERSION = 1;
  const TICK_MS = 250;                      // faster than 1s so the visible second never stalls
  const CIRCUMFERENCE = 2 * Math.PI * 88;   // must match r="88" on the ring in index.html

  const PHASES = {
    focus: { label: 'Focus',       key: 'focusMin', done: 'Focus session complete' },
    short: { label: 'Short break', key: 'shortMin', done: 'Short break over' },
    long:  { label: 'Long break',  key: 'longMin',  done: 'Long break over' }
  };

  const DEFAULTS = {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    rounds: 4,
    autoAdvance: true,
    sound: true,
    notify: false
  };

  const LIMITS = {
    focusMin: [1, 180],
    shortMin: [1, 180],
    longMin: [1, 180],
    rounds: [1, 12]
  };

  /* ── state ───────────────────────────────── */

  let settings = Object.assign({}, DEFAULTS);
  let tasks = [];

  let phase = 'focus';
  let completedFocus = 0;        // focus sessions finished since the last long break
  let remainingMs = minutesToMs(settings.focusMin);
  let deadline = null;           // epoch ms while running, null while paused
  let tickId = null;

  let editingId = null;          // task currently being renamed
  let lastTimeText = '';
  let lastAnnouncedMinute = null;

  /* ── elements ────────────────────────────── */

  const el = {};
  [
    'app', 'ringProgress', 'phaseLabel', 'timeDisplay', 'roundLabel', 'nextUp',
    'startPause', 'resetBtn', 'skipBtn', 'settingsDrawer',
    'focusMin', 'shortMin', 'longMin', 'rounds',
    'autoAdvance', 'sound', 'notify', 'notifyHint', 'restoreDefaults',
    'taskForm', 'taskInput', 'taskList', 'taskEmpty', 'taskCount', 'clearDone',
    'liveRegion'
  ].forEach((id) => { el[id] = document.getElementById(id); });

  /* ── helpers ─────────────────────────────── */

  function minutesToMs(min) { return Math.round(min * 60 * 1000); }

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  function phaseDuration(which) { return minutesToMs(settings[PHASES[which].key]); }

  function isRunning() { return deadline !== null; }

  function currentRemaining() {
    return isRunning() ? Math.max(0, deadline - Date.now()) : remainingMs;
  }

  function formatTime(ms) {
    const total = Math.ceil(ms / 1000);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  function spokenTime(ms) {
    const total = Math.ceil(ms / 1000);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins === 0) return secs + (secs === 1 ? ' second' : ' seconds') + ' remaining';
    return mins + (mins === 1 ? ' minute' : ' minutes') + ' remaining';
  }

  function announce(message) {
    if (el.liveRegion) el.liveRegion.textContent = message;
  }

  /* ── persistence ─────────────────────────── */

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: SCHEMA_VERSION,
        settings: settings,
        tasks: tasks
      }));
    } catch (err) {
      /* storage can be unavailable or full — keep running from memory */
    }
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return;
    }
    if (!raw) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (data.settings && typeof data.settings === 'object') {
      Object.keys(DEFAULTS).forEach((key) => {
        const value = data.settings[key];
        if (typeof DEFAULTS[key] === 'boolean') {
          if (typeof value === 'boolean') settings[key] = value;
        } else if (typeof value === 'number' && isFinite(value)) {
          settings[key] = clamp(Math.round(value), LIMITS[key][0], LIMITS[key][1]);
        }
      });
    }

    if (Array.isArray(data.tasks)) {
      tasks = data.tasks
        .filter((task) => task && typeof task.text === 'string')
        .map((task) => ({
          id: typeof task.id === 'string' ? task.id : makeId(),
          text: task.text.slice(0, 200),
          done: task.done === true
        }));
    }
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ── phase machine ───────────────────────── */

  // Which phase follows `which`, given how many focus sessions are banked.
  function nextPhaseAfter(which, bankedFocus) {
    if (which !== 'focus') return 'focus';
    return bankedFocus >= settings.rounds ? 'long' : 'short';
  }

  function setPhase(next, autoStart) {
    if (phase === 'long') completedFocus = 0;   // a long break closes the cycle
    deadline = null;                            // the previous phase is over either way
    phase = next;
    remainingMs = phaseDuration(next);
    lastAnnouncedMinute = null;
    if (autoStart) {
      start();
    } else {
      stopTicking();
      render();
    }
  }

  function handlePhaseEnd() {
    stopTicking();
    remainingMs = 0;
    renderTimer();

    const ended = phase;
    if (ended === 'focus') completedFocus += 1;

    const next = nextPhaseAfter(ended, completedFocus);
    chime();
    notifyPhaseEnd(ended, next);

    setPhase(next, settings.autoAdvance);
    announce(PHASES[ended].done + '. ' + PHASES[next].label +
      (settings.autoAdvance ? ' started.' : ' ready — press start.'));
    save();
  }

  /* ── timer controls ──────────────────────── */

  function startTicking() {
    stopTicking();
    tickId = window.setInterval(tick, TICK_MS);
  }

  function stopTicking() {
    if (tickId !== null) {
      window.clearInterval(tickId);
      tickId = null;
    }
  }

  function tick() {
    if (!isRunning()) return;
    if (deadline - Date.now() <= 0) {
      handlePhaseEnd();
      return;
    }
    renderTimer();
  }

  function start() {
    if (isRunning()) return;
    if (remainingMs <= 0) remainingMs = phaseDuration(phase);
    unlockAudio();                       // must happen inside a user gesture
    deadline = Date.now() + remainingMs;
    startTicking();
    render();
    announce(PHASES[phase].label + ' started, ' + spokenTime(currentRemaining()) + '.');
  }

  function pause() {
    if (!isRunning()) return;
    remainingMs = Math.max(0, deadline - Date.now());
    deadline = null;
    stopTicking();
    render();
    announce('Paused at ' + formatTime(remainingMs) + '.');
  }

  function toggleStartPause() {
    if (isRunning()) pause(); else start();
  }

  function resetPhase() {
    deadline = null;
    stopTicking();
    remainingMs = phaseDuration(phase);
    lastAnnouncedMinute = null;
    render();
    announce(PHASES[phase].label + ' reset to ' + formatTime(remainingMs) + '.');
  }

  function skipPhase() {
    deadline = null;
    const next = nextPhaseAfter(phase, completedFocus);   // skipping banks no round
    setPhase(next, false);
    announce('Skipped to ' + PHASES[next].label + '.');
    save();
  }

  /* ── chime ───────────────────────────────── */

  let audioCtx = null;

  function unlockAudio() {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try { audioCtx = new Ctor(); } catch (err) { audioCtx = null; return; }
    }
    if (audioCtx.state === 'suspended') {
      const resumed = audioCtx.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {});
    }
  }

  function chime() {
    if (!settings.sound) return;
    unlockAudio();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    [[784.0, 0], [1046.5, 0.17]].forEach(function (note) {
      const freq = note[0];
      const at = now + note[1];
      let osc, gain;
      try {
        osc = audioCtx.createOscillator();
        gain = audioCtx.createGain();
      } catch (err) {
        return;
      }
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(at);
      osc.stop(at + 0.6);
    });
  }

  /* ── notifications ───────────────────────── */

  function showNotifyHint(message) {
    if (!el.notifyHint) return;
    el.notifyHint.textContent = message || '';
    el.notifyHint.hidden = !message;
  }

  function requestNotifyPermission() {
    if (!('Notification' in window)) {
      settings.notify = false;
      el.notify.checked = false;
      showNotifyHint('This browser does not support notifications.');
      return;
    }
    if (!window.isSecureContext) {
      settings.notify = false;
      el.notify.checked = false;
      showNotifyHint('Notifications need https:// or localhost — the chime still works.');
      return;
    }
    if (Notification.permission === 'granted') {
      settings.notify = true;
      showNotifyHint('');
      save();
      return;
    }
    if (Notification.permission === 'denied') {
      settings.notify = false;
      el.notify.checked = false;
      showNotifyHint('Notifications are blocked for this site in your browser settings.');
      return;
    }

    Notification.requestPermission().then(function (result) {
      const granted = result === 'granted';
      settings.notify = granted;
      el.notify.checked = granted;
      showNotifyHint(granted ? '' : 'Permission was not granted, so notifications stay off.');
      save();
    }).catch(function () {
      settings.notify = false;
      el.notify.checked = false;
      showNotifyHint('Could not request notification permission.');
    });
  }

  function notifyPhaseEnd(ended, next) {
    if (!settings.notify) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(PHASES[ended].done, {
        body: settings.autoAdvance
          ? PHASES[next].label + ' has started.'
          : PHASES[next].label + ' is ready — press start.',
        tag: 'focus-timer-phase'
      });
    } catch (err) {
      /* some browsers require a service worker for notifications; ignore */
    }
  }

  /* ── rendering: timer ────────────────────── */

  function renderTimer() {
    const total = phaseDuration(phase);
    const remaining = currentRemaining();
    const text = formatTime(remaining);

    if (text !== lastTimeText) {
      el.timeDisplay.textContent = text;
      lastTimeText = text;
    }

    const progress = total > 0 ? clamp(remaining / total, 0, 1) : 0;
    el.ringProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress));

    // speak at most once a minute while running
    if (isRunning()) {
      const minute = Math.ceil(remaining / 60000);
      if (lastAnnouncedMinute === null) {
        lastAnnouncedMinute = minute;
      } else if (minute !== lastAnnouncedMinute) {
        lastAnnouncedMinute = minute;
        announce(PHASES[phase].label + ', ' + spokenTime(remaining) + '.');
      }
    }
  }

  function renderStatus() {
    const roundsTotal = settings.rounds;
    const banked = Math.min(completedFocus, roundsTotal);

    el.app.setAttribute('data-phase', phase);
    el.phaseLabel.textContent = PHASES[phase].label;

    el.roundLabel.textContent = phase === 'focus'
      ? 'Round ' + Math.min(banked + 1, roundsTotal) + ' of ' + roundsTotal
      : banked + ' of ' + roundsTotal + ' rounds done';

    const upcoming = nextPhaseAfter(phase, phase === 'focus' ? completedFocus + 1 : completedFocus);
    el.nextUp.textContent = 'Up next: ' + PHASES[upcoming].label.toLowerCase() +
      ' · ' + formatTime(phaseDuration(upcoming));

    el.startPause.textContent = isRunning() ? 'Pause' : (currentRemaining() < phaseDuration(phase) ? 'Resume' : 'Start');
  }

  function render() {
    renderStatus();
    renderTimer();
  }

  /* ── rendering: settings ─────────────────── */

  function renderSettings() {
    el.focusMin.value = settings.focusMin;
    el.shortMin.value = settings.shortMin;
    el.longMin.value = settings.longMin;
    el.rounds.value = settings.rounds;
    el.autoAdvance.checked = settings.autoAdvance;
    el.sound.checked = settings.sound;
    el.notify.checked = settings.notify;
  }

  function applyNumberSetting(key, input) {
    const limits = LIMITS[key];
    const parsed = parseInt(input.value, 10);
    const previousFull = phaseDuration(phase);

    if (!isFinite(parsed)) {
      input.value = settings[key];                 // reject junk, restore current value
      return;
    }

    settings[key] = clamp(Math.round(parsed), limits[0], limits[1]);
    input.value = settings[key];

    // If this phase is sitting untouched at full duration, show the new length right away.
    // Mid-session changes take effect the next time that phase starts.
    if (!isRunning() && remainingMs >= previousFull) {
      remainingMs = phaseDuration(phase);
    }

    save();
    render();
  }

  /* ── rendering: tasks ────────────────────── */

  // Every row carries both the display button and the rename input; editing toggles
  // `hidden` instead of replacing nodes. A node removed during `focusout` would never
  // receive the click that caused the blur, which would eat deletes and checkbox toggles.
  function buildRow(task) {
    const row = document.createElement('li');
    row.className = 'task' + (task.done ? ' task--done' : '');
    row.dataset.id = task.id;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'task__check';
    check.checked = task.done;
    row.appendChild(check);

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'task__text';
    label.dataset.act = 'edit';
    label.title = 'Click to rename';
    row.appendChild(label);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task__edit';
    input.maxLength = 200;
    input.hidden = true;
    input.setAttribute('aria-label', 'Rename task');
    row.appendChild(input);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task__del';
    del.dataset.act = 'delete';
    del.textContent = '×';
    row.appendChild(del);

    syncRow(row, task);
    return row;
  }

  // Refresh one row's text and labels in place, and leave it in display mode.
  function syncRow(row, task) {
    const check = row.querySelector('.task__check');
    const label = row.querySelector('.task__text');
    const input = row.querySelector('.task__edit');
    const del = row.querySelector('.task__del');

    row.className = 'task' + (task.done ? ' task--done' : '');
    check.checked = task.done;
    check.setAttribute('aria-label', (task.done ? 'Mark not done: ' : 'Mark done: ') + task.text);
    label.textContent = task.text;
    label.hidden = false;
    input.value = task.text;
    input.hidden = true;
    del.setAttribute('aria-label', 'Delete task: ' + task.text);
  }

  function renderTaskMeta() {
    const doneCount = tasks.filter(function (task) { return task.done; }).length;
    el.taskCount.textContent = doneCount + ' of ' + tasks.length + ' done';
    el.taskEmpty.hidden = tasks.length > 0;
    el.clearDone.disabled = doneCount === 0;
  }

  function renderTasks() {
    const list = el.taskList;
    list.textContent = '';
    tasks.forEach(function (task) { list.appendChild(buildRow(task)); });
    renderTaskMeta();
  }

  function rowFor(id) {
    return el.taskList.querySelector('.task[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
  }

  function findTask(id) {
    for (let i = 0; i < tasks.length; i += 1) {
      if (tasks[i].id === id) return tasks[i];
    }
    return null;
  }

  function addTask(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    tasks.push({ id: makeId(), text: trimmed.slice(0, 200), done: false });
    save();
    renderTasks();
    announce('Task added: ' + trimmed + '.');
  }

  function startEditing(row, task) {
    editingId = task.id;
    const label = row.querySelector('.task__text');
    const input = row.querySelector('.task__edit');
    input.value = task.text;
    label.hidden = true;
    input.hidden = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function commitEdit(input) {
    if (editingId === null) return;
    const id = editingId;
    editingId = null;

    const task = findTask(id);
    if (!task) { renderTasks(); return; }

    const trimmed = input.value.trim();
    if (!trimmed) {                       // cleared text removes the task
      tasks = tasks.filter(function (item) { return item.id !== id; });
      save();
      renderTasks();
      announce('Task deleted: ' + task.text + '.');
      return;
    }

    task.text = trimmed.slice(0, 200);
    save();
    const row = rowFor(id);
    if (row) syncRow(row, task);
    renderTaskMeta();
  }

  function cancelEdit(input) {
    if (editingId === null) return;
    const task = findTask(editingId);
    editingId = null;
    const row = input.closest('.task');
    if (row && task) {
      syncRow(row, task);
      row.querySelector('.task__text').focus();
    }
  }

  /* ── events ──────────────────────────────── */

  el.startPause.addEventListener('click', toggleStartPause);
  el.resetBtn.addEventListener('click', resetPhase);
  el.skipBtn.addEventListener('click', skipPhase);

  ['focusMin', 'shortMin', 'longMin', 'rounds'].forEach(function (key) {
    el[key].addEventListener('change', function () { applyNumberSetting(key, el[key]); });
  });

  el.autoAdvance.addEventListener('change', function () {
    settings.autoAdvance = el.autoAdvance.checked;
    save();
    renderStatus();
  });

  el.sound.addEventListener('change', function () {
    settings.sound = el.sound.checked;
    if (settings.sound) { unlockAudio(); chime(); }
    save();
  });

  el.notify.addEventListener('change', function () {
    if (el.notify.checked) {
      requestNotifyPermission();
    } else {
      settings.notify = false;
      showNotifyHint('');
      save();
    }
  });

  el.restoreDefaults.addEventListener('click', function () {
    settings = Object.assign({}, DEFAULTS);
    deadline = null;
    stopTicking();
    phase = 'focus';
    completedFocus = 0;
    remainingMs = phaseDuration('focus');
    lastAnnouncedMinute = null;
    showNotifyHint('');
    save();
    renderSettings();
    render();
    announce('Settings restored to defaults.');
  });

  el.taskForm.addEventListener('submit', function (event) {
    event.preventDefault();
    addTask(el.taskInput.value);
    el.taskInput.value = '';
    el.taskInput.focus();
  });

  el.taskList.addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-act]');
    if (!trigger) return;
    const row = trigger.closest('.task');
    if (!row) return;
    const id = row.dataset.id;

    if (trigger.dataset.act === 'delete') {
      const task = findTask(id);
      if (editingId === id) editingId = null;
      tasks = tasks.filter(function (item) { return item.id !== id; });
      save();
      renderTasks();
      if (task) announce('Task deleted: ' + task.text + '.');
    } else if (trigger.dataset.act === 'edit') {
      const task = findTask(id);
      if (task) startEditing(row, task);
    }
  });

  el.taskList.addEventListener('change', function (event) {
    const check = event.target;
    if (!check.classList.contains('task__check')) return;
    const row = check.closest('.task');
    if (!row) return;
    const task = findTask(row.dataset.id);
    if (!task) return;
    task.done = check.checked;
    save();
    renderTasks();
  });

  el.taskList.addEventListener('keydown', function (event) {
    if (!event.target.classList.contains('task__edit')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const field = event.target;
      commitEdit(field);
      const row = field.closest('.task');
      if (row) row.querySelector('.task__text').focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit(event.target);
    }
  });

  el.taskList.addEventListener('focusout', function (event) {
    if (!event.target.classList.contains('task__edit')) return;
    if (editingId === null) return;
    commitEdit(event.target);
  });

  el.clearDone.addEventListener('click', function () {
    const before = tasks.length;
    tasks = tasks.filter(function (task) { return !task.done; });
    if (tasks.length === before) return;
    if (editingId !== null && !findTask(editingId)) editingId = null;
    save();
    renderTasks();
    announce((before - tasks.length) + ' completed task(s) cleared.');
  });

  document.addEventListener('keydown', function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target && (target.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY|A)$/.test(target.tagName))) return;

    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      toggleStartPause();
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      resetPhase();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && isRunning()) tick();   // catch up after background throttling
  });

  /* ── boot ────────────────────────────────── */

  load();
  remainingMs = phaseDuration(phase);          // always start paused at a full phase
  if (settings.notify && (!('Notification' in window) || Notification.permission !== 'granted')) {
    settings.notify = false;                   // permission may have been revoked since last visit
  }
  renderSettings();
  renderTasks();
  render();
})();
