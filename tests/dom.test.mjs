/**
 * Logic suite — runs the page in jsdom with a fake clock, so whole Pomodoro
 * phases can be fast-forwarded in milliseconds. No browser, no server needed.
 *
 *   npm run test:dom
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  →  ' + extra : ''}`); }
};
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the page in a fresh jsdom window.
 * `seed` is the localStorage payload the page should start from.
 * The returned `advance()` moves a fake clock that app.js reads through Date.now();
 * `tick()` then waits long enough in real time for the page's 250ms interval to fire.
 */
function boot(seed) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.com/focus-timer/',
    pretendToBeVisual: true
  });
  const win = dom.window;
  const errors = [];
  win.addEventListener('error', (e) => errors.push(String(e.message)));

  if (seed) win.localStorage.setItem('focus-timer-v1', seed);

  let fakeNow = 1700000000000;
  const RealDate = win.Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args); }
    static now() { return fakeNow; }
  }
  win.Date = FakeDate;

  win.eval(appSrc);

  return {
    win,
    errors,
    advance: (ms) => { fakeNow += ms; },
    $: (id) => win.document.getElementById(id),
    text: (id) => win.document.getElementById(id).textContent,
    tick: async () => { await sleep(320); }
  };
}

const SEED = JSON.stringify({
  version: 1,
  settings: { focusMin: 1, shortMin: 1, longMin: 1, rounds: 2, autoAdvance: true, sound: false, notify: false },
  tasks: []
});

/* ───── 1. boot state ───── */
console.log('\n1. initial state');
{
  const a = boot(SEED);
  eq('time shows a full focus phase', a.text('timeDisplay'), '01:00');
  eq('phase label', a.text('phaseLabel'), 'Focus');
  eq('round label', a.text('roundLabel'), 'Round 1 of 2');
  eq('next up', a.text('nextUp'), 'Up next: short break · 01:00');
  eq('button says Start', a.text('startPause'), 'Start');
  eq('settings reflect storage', a.$('focusMin').value, '1');
  eq('empty task message visible', a.$('taskEmpty').hidden, false);
  eq('clear completed disabled', a.$('clearDone').disabled, true);
  ok('no page errors', a.errors.length === 0, a.errors.join('; '));
  a.win.close();
}

/* ───── 2. countdown ticks every second and survives background gaps ───── */
console.log('\n2. countdown');
{
  const a = boot(SEED);
  a.$('startPause').click();
  eq('button flips to Pause', a.text('startPause'), 'Pause');

  a.advance(1000); await a.tick();
  eq('after 1s', a.text('timeDisplay'), '00:59');
  a.advance(1000); await a.tick();
  eq('after 2s', a.text('timeDisplay'), '00:58');
  a.advance(1000); await a.tick();
  eq('after 3s', a.text('timeDisplay'), '00:57');

  // a long gap, as if the tab was throttled or the machine slept
  a.advance(20000); await a.tick();
  eq('after a 20s background gap', a.text('timeDisplay'), '00:37');

  const offset = parseFloat(a.$('ringProgress').style.strokeDashoffset);
  const circ = 2 * Math.PI * 88;
  ok('ring is ~62% depleted', Math.abs(offset / circ - (1 - 37 / 60)) < 0.02, `offset ratio ${(offset / circ).toFixed(3)}`);
  a.win.close();
}

/* ───── 3. pause / resume / reset ───── */
console.log('\n3. pause, resume, reset');
{
  const a = boot(SEED);
  a.$('startPause').click();
  a.advance(20000); await a.tick();
  a.$('startPause').click();                       // pause
  eq('paused reading', a.text('timeDisplay'), '00:40');
  eq('button says Resume', a.text('startPause'), 'Resume');

  a.advance(600000); await a.tick();               // 10 minutes pass while paused
  eq('paused clock did not move', a.text('timeDisplay'), '00:40');

  a.$('startPause').click();                       // resume
  a.advance(10000); await a.tick();
  eq('resumes from where it stopped', a.text('timeDisplay'), '00:30');

  a.$('resetBtn').click();
  eq('reset restores the full phase', a.text('timeDisplay'), '01:00');
  eq('reset stops the timer', a.text('startPause'), 'Start');
  a.advance(5000); await a.tick();
  eq('stays put after reset', a.text('timeDisplay'), '01:00');
  a.win.close();
}

/* ───── 4. full pomodoro cycle ───── */
console.log('\n4. phase machine (2 rounds per long break)');
{
  const a = boot(SEED);
  const run = async () => { a.$('startPause').click(); a.advance(61000); await a.tick(); };

  await run();
  eq('focus 1 → short break', a.text('phaseLabel'), 'Short break');
  eq('rounds banked', a.text('roundLabel'), '1 of 2 rounds done');
  eq('auto-advance started it', a.text('startPause'), 'Pause');
  eq('break shows full duration', a.text('timeDisplay'), '01:00');

  a.advance(61000); await a.tick();
  eq('short break → focus', a.text('phaseLabel'), 'Focus');
  eq('round counter', a.text('roundLabel'), 'Round 2 of 2');
  eq('next up is the long break', a.text('nextUp'), 'Up next: long break · 01:00');

  a.advance(61000); await a.tick();
  eq('focus 2 → long break', a.text('phaseLabel'), 'Long break');
  eq('both rounds banked', a.text('roundLabel'), '2 of 2 rounds done');

  a.advance(61000); await a.tick();
  eq('long break → focus', a.text('phaseLabel'), 'Focus');
  eq('cycle restarts at round 1', a.text('roundLabel'), 'Round 1 of 2');
  ok('no page errors through a full cycle', a.errors.length === 0, a.errors.join('; '));
  a.win.close();
}

/* ───── 5. auto-advance off, and skip ───── */
console.log('\n5. auto-advance off / skip');
{
  const a = boot(SEED);
  a.$('autoAdvance').checked = false;
  a.$('autoAdvance').dispatchEvent(new a.win.Event('change'));

  a.$('startPause').click();
  a.advance(61000); await a.tick();
  eq('phase advanced', a.text('phaseLabel'), 'Short break');
  eq('but waits for Start', a.text('startPause'), 'Start');
  a.advance(5000); await a.tick();
  eq('clock is not running', a.text('timeDisplay'), '01:00');

  a.$('skipBtn').click();
  eq('skip from break → focus', a.text('phaseLabel'), 'Focus');
  eq('skip banks no extra round', a.text('roundLabel'), 'Round 2 of 2');
  a.$('skipBtn').click();
  eq('skipping focus does not credit it', a.text('phaseLabel'), 'Short break');
  eq('still 1 banked round', a.text('roundLabel'), '1 of 2 rounds done');
  a.win.close();
}

/* ───── 6. settings validation ───── */
console.log('\n6. settings');
{
  const a = boot(SEED);
  const setField = (id, value) => {
    a.$(id).value = value;
    a.$(id).dispatchEvent(new a.win.Event('change'));
  };

  setField('focusMin', '45');
  eq('idle phase picks up the new length', a.text('timeDisplay'), '45:00');

  setField('focusMin', '999');
  eq('clamped to the max', a.$('focusMin').value, '180');
  setField('focusMin', '0');
  eq('clamped to the min', a.$('focusMin').value, '1');
  setField('focusMin', 'abc');
  eq('junk is rejected', a.$('focusMin').value, '1');
  setField('rounds', '12.7');
  eq('rounds rounded and clamped', a.$('rounds').value, '12');

  setField('focusMin', '10');
  a.$('startPause').click();
  a.advance(30000); await a.tick();
  setField('focusMin', '20');
  eq('mid-session change does not jump the clock', a.text('timeDisplay'), '09:30');

  a.$('restoreDefaults').click();
  eq('defaults restored', a.$('focusMin').value, '25');
  eq('and the timer resets', a.text('timeDisplay'), '25:00');
  a.win.close();
}

/* ───── 7. tasks ───── */
console.log('\n7. tasks');
{
  const a = boot(SEED);
  const add = (text) => {
    a.$('taskInput').value = text;
    a.$('taskForm').dispatchEvent(new a.win.Event('submit', { bubbles: true, cancelable: true }));
  };
  const rows = () => a.win.document.querySelectorAll('.task');

  add('Write the report');
  add('Review the PR');
  add('   ');                                   // whitespace only
  eq('two tasks added, blank ignored', rows().length, 2);
  eq('count line', a.text('taskCount'), '0 of 2 done');
  eq('empty message hidden', a.$('taskEmpty').hidden, true);
  eq('task text is set as text, not HTML', rows()[0].querySelector('.task__text').textContent, 'Write the report');

  add('<img src=x onerror=alert(1)>');
  eq('markup stays inert text', rows()[2].querySelector('.task__text').textContent, '<img src=x onerror=alert(1)>');
  eq('no element was injected', rows()[2].querySelectorAll('img').length, 0);

  // check one off
  const check = rows()[0].querySelector('.task__check');
  check.checked = true;
  check.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  eq('count updates', a.text('taskCount'), '1 of 3 done');
  ok('row gets the done class', rows()[0].classList.contains('task--done'));
  eq('clear completed enabled', a.$('clearDone').disabled, false);

  // rename
  rows()[1].querySelector('.task__text').click();
  const field = rows()[1].querySelector('.task__edit');
  eq('edit field revealed', field.hidden, false);
  eq('display text hidden', rows()[1].querySelector('.task__text').hidden, true);
  field.value = 'Review the PR carefully';
  field.dispatchEvent(new a.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  eq('rename committed', rows()[1].querySelector('.task__text').textContent, 'Review the PR carefully');
  eq('back to display mode', rows()[1].querySelector('.task__edit').hidden, true);

  // escape cancels
  rows()[1].querySelector('.task__text').click();
  const field2 = rows()[1].querySelector('.task__edit');
  field2.value = 'scrapped';
  field2.dispatchEvent(new a.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  eq('escape restores the old text', rows()[1].querySelector('.task__text').textContent, 'Review the PR carefully');

  // delete a row while another is mid-edit — the "focusout eats the click" case
  rows()[1].querySelector('.task__text').click();
  rows()[1].querySelector('.task__edit').dispatchEvent(new a.win.Event('focusout', { bubbles: true }));
  rows()[2].querySelector('.task__del').click();
  eq('delete still lands after a blur-commit', rows().length, 2);

  // clear completed
  a.$('clearDone').click();
  eq('only the completed one went', rows().length, 1);
  eq('survivor', rows()[0].querySelector('.task__text').textContent, 'Review the PR carefully');
  eq('count line', a.text('taskCount'), '0 of 1 done');

  // persistence
  const saved = a.win.localStorage.getItem('focus-timer-v1');
  const b = boot(saved);
  eq('tasks survive a reload', b.win.document.querySelectorAll('.task').length, 1);
  eq('text survives', b.win.document.querySelector('.task__text').textContent, 'Review the PR carefully');
  eq('timer reopens paused at a full phase', b.text('timeDisplay'), '01:00');
  eq('and is not running', b.text('startPause'), 'Start');
  ok('no errors', a.errors.length === 0 && b.errors.length === 0, [...a.errors, ...b.errors].join('; '));
  a.win.close(); b.win.close();
}

/* ───── 8. keyboard and corrupt storage ───── */
console.log('\n8. keyboard and resilience');
{
  const a = boot(SEED);
  const key = (k, target) => target.dispatchEvent(new a.win.KeyboardEvent('keydown', {
    key: k, code: k === ' ' ? 'Space' : undefined, bubbles: true, cancelable: true
  }));

  key(' ', a.win.document.body);
  eq('space starts the timer', a.text('startPause'), 'Pause');
  a.advance(10000); await a.tick();
  key(' ', a.win.document.body);
  eq('space pauses it', a.text('startPause'), 'Resume');
  key('r', a.win.document.body);
  eq('r resets', a.text('timeDisplay'), '01:00');

  key(' ', a.$('taskInput'));
  eq('space in a text field is ignored by the timer', a.text('startPause'), 'Start');
  key('r', a.$('taskInput'));
  eq('r in a text field too', a.text('timeDisplay'), '01:00');
  a.win.close();

  const c = boot('{not json at all');
  eq('corrupt storage falls back to defaults', c.text('timeDisplay'), '25:00');
  ok('no errors from corrupt storage', c.errors.length === 0, c.errors.join('; '));
  c.win.close();

  const d = boot(JSON.stringify({
    version: 1,
    settings: { focusMin: 'x', rounds: 99 },
    tasks: [{ text: 'kept' }, null, 42]
  }));
  eq('bad setting ignored', d.$('focusMin').value, '25');
  eq('out-of-range setting clamped', d.$('rounds').value, '12');
  eq('malformed tasks filtered out', d.win.document.querySelectorAll('.task').length, 1);
  eq('id generated for the survivor', !!d.win.document.querySelector('.task').dataset.id, true);
  d.win.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
