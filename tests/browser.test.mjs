/**
 * Browser suite — drives the real page in your installed Chrome (or Edge) through
 * Playwright. Starts its own static server, so nothing else needs to be running.
 *
 *   npm run test:browser
 *   TEST_URL=https://lakshyakaviya.github.io/focus-timer/ npm run test:browser
 *   CHROME_PATH="/path/to/chrome" npm run test:browser
 *   HEADED=1 npm run test:browser          # watch it happen
 *
 * Screenshots land in tests/shots/ (gitignored).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

/* ── find a browser ──────────────────────── */

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('No Chrome or Edge found. Set CHROME_PATH to a Chromium-based browser.');
  process.exit(1);
}

/* ── tiny static server (skipped when TEST_URL is given) ── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(root, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, body) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const own = process.env.TEST_URL ? null : await serve(ROOT);
const URL = process.env.TEST_URL || `http://127.0.0.1:${own.port}/`;
const ORIGIN = new globalThis.URL(URL).origin;
console.log(`testing ${URL}`);

/* ── harness ─────────────────────────────── */

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  →  ' + extra : ''}`); }
};
const eq = (label, a, b) => ok(label, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// Injected before page scripts: records notification and Web Audio activity while
// still calling through to the real APIs.
const SPY = () => {
  window.__spy = { notifications: [], oscillators: 0, ctxCreated: false };
  const RealNotification = window.Notification;
  if (RealNotification) {
    function Spy(title, opts) {
      window.__spy.notifications.push({ title: title, body: opts && opts.body, tag: opts && opts.tag });
      try { return new RealNotification(title, opts); } catch (e) { return {}; }
    }
    Spy.requestPermission = function () { return RealNotification.requestPermission.apply(RealNotification, arguments); };
    Object.defineProperty(Spy, 'permission', { get: function () { return RealNotification.permission; } });
    window.Notification = Spy;
  }
  const RealCtx = window.AudioContext;
  if (RealCtx) {
    window.AudioContext = class extends RealCtx {
      constructor() { super(); window.__spy.ctxCreated = true; }
      createOscillator() {
        const osc = super.createOscillator();
        const start = osc.start.bind(osc);
        osc.start = function () { window.__spy.oscillators += 1; return start.apply(null, arguments); };
        return osc;
      }
    };
  }
};

function watch(page, bag) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') bag.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => bag.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => bag.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED });

/* ───── 1. loads clean, renders, real-time per-second ticking ───── */
console.log('\n1. load + real-time ticking (dark)');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems);
  await page.addInitScript(SPY);
  await page.goto(URL, { waitUntil: 'load' });

  eq('title', await page.title(), 'Focus Timer');
  eq('stylesheet applied', await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(14, 17, 22)');
  eq('initial time', (await page.textContent('#timeDisplay')).trim(), '25:00');
  eq('initial phase', (await page.textContent('#phaseLabel')).trim(), 'Focus');

  const ring = await page.locator('#ringProgress').boundingBox();
  ok('ring has real size', ring.width > 200 && Math.abs(ring.width - ring.height) < 2, JSON.stringify(ring));

  const dash = await page.evaluate(() => {
    const el = document.getElementById('ringProgress');
    return { offset: el.style.strokeDashoffset, array: getComputedStyle(el).strokeDasharray };
  });
  ok('ring starts full', parseFloat(dash.offset) < 1, JSON.stringify(dash));
  ok('dasharray matches the radius', Math.abs(parseFloat(dash.array) - 2 * Math.PI * 88) < 0.5, dash.array);

  await page.screenshot({ path: `${SHOTS}/01-dark-idle.png` });

  // real time, no fake clock: every second must appear exactly once, in order
  await page.click('#startPause');
  eq('button flips', (await page.textContent('#startPause')).trim(), 'Pause');
  const seen = [];
  const started = Date.now();
  while (Date.now() - started < 3600) {
    const t = (await page.textContent('#timeDisplay')).trim();
    if (seen[seen.length - 1] !== t) seen.push(t);
    await page.waitForTimeout(60);
  }
  console.log(`       observed: ${seen.join(' → ')}`);
  ok('counts down one second at a time', seen.length >= 3 && seen.slice(1).every((t, i) => {
    const toS = (s) => { const [m, sec] = s.split(':').map(Number); return m * 60 + sec; };
    return toS(seen[i]) - toS(t) === 1;
  }), seen.join(','));

  const ringMoved = await page.evaluate(() => parseFloat(document.getElementById('ringProgress').style.strokeDashoffset));
  ok('ring depletes as time passes', ringMoved > 0, String(ringMoved));

  await page.screenshot({ path: `${SHOTS}/02-dark-running.png` });
  ok('no console errors / failed requests', problems.length === 0, problems.join(' | '));
  await ctx.close();
}

/* ───── 2. full cycle with a fast-forwarded clock, chime + notification ───── */
console.log('\n2. full pomodoro cycle, chime, notification');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await ctx.grantPermissions(['notifications'], { origin: ORIGIN });
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems);
  await page.addInitScript(SPY);
  await page.clock.install();
  await page.goto(URL, { waitUntil: 'load' });

  // 1-minute phases, 2 rounds per long break
  await page.locator('#settingsDrawer summary').click();
  for (const [id, val] of [['focusMin', '1'], ['shortMin', '1'], ['longMin', '1'], ['rounds', '2']]) {
    await page.fill(`#${id}`, val);
    await page.dispatchEvent(`#${id}`, 'change');
  }
  await page.check('#notify');
  await page.check('#sound');
  eq('notification toggle stuck on (permission granted)', await page.isChecked('#notify'), true);
  eq('hint stays hidden when granted', await page.locator('#notifyHint').isHidden(), true);
  eq('phase picked up the 1-minute setting', (await page.textContent('#timeDisplay')).trim(), '01:00');
  await page.screenshot({ path: `${SHOTS}/03-settings-open.png` });

  await page.click('#startPause');
  eq('audio context created on the start gesture', await page.evaluate(() => window.__spy.ctxCreated), true);

  const step = async () => { await page.clock.fastForward('01:05'); await page.waitForTimeout(150); };

  await step();
  eq('focus 1 → short break', (await page.textContent('#phaseLabel')).trim(), 'Short break');
  eq('round banked', (await page.textContent('#roundLabel')).trim(), '1 of 2 rounds done');
  eq('auto-advance kept it running', (await page.textContent('#startPause')).trim(), 'Pause');
  ok('chime played (oscillators started)', await page.evaluate(() => window.__spy.oscillators) >= 2,
     String(await page.evaluate(() => window.__spy.oscillators)));
  const notes = await page.evaluate(() => window.__spy.notifications);
  eq('one notification fired', notes.length, 1);
  eq('notification title', notes[0] && notes[0].title, 'Focus session complete');
  eq('notification body', notes[0] && notes[0].body, 'Short break has started.');

  const breakAccent = await page.evaluate(() => getComputedStyle(document.getElementById('ringProgress')).stroke);
  await page.screenshot({ path: `${SHOTS}/04-dark-break.png` });

  await step();
  eq('short break → focus', (await page.textContent('#phaseLabel')).trim(), 'Focus');
  eq('round counter', (await page.textContent('#roundLabel')).trim(), 'Round 2 of 2');
  const focusAccent = await page.evaluate(() => getComputedStyle(document.getElementById('ringProgress')).stroke);
  ok('accent colour differs between focus and break', breakAccent !== focusAccent, `${focusAccent} vs ${breakAccent}`);

  await step();
  eq('focus 2 → long break', (await page.textContent('#phaseLabel')).trim(), 'Long break');
  await step();
  eq('long break → focus, cycle restarts', (await page.textContent('#roundLabel')).trim(), 'Round 1 of 2');
  eq('four notifications in total', (await page.evaluate(() => window.__spy.notifications)).length, 4);
  ok('no console errors through the cycle', problems.length === 0, problems.join(' | '));
  await ctx.close();
}

/* ───── 3. tasks, keyboard, persistence across a real reload ───── */
console.log('\n3. tasks + reload');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems);
  await page.goto(URL, { waitUntil: 'load' });

  for (const t of ['Draft the launch email', 'Review PR #214', 'Fix the timer drift bug', 'Book the standup room']) {
    await page.fill('#taskInput', t);
    await page.press('#taskInput', 'Enter');
  }
  eq('four tasks added', await page.locator('.task').count(), 4);
  eq('count line', (await page.textContent('#taskCount')).trim(), '0 of 4 done');

  await page.locator('.task').nth(1).locator('.task__check').check();
  eq('count updates', (await page.textContent('#taskCount')).trim(), '1 of 4 done');
  const lineThrough = await page.locator('.task').nth(1).locator('.task__text')
    .evaluate((el) => getComputedStyle(el).textDecorationLine);
  eq('done row is struck through', lineThrough, 'line-through');

  // rename by clicking the text
  await page.locator('.task').nth(2).locator('.task__text').click();
  eq('edit field visible', await page.locator('.task').nth(2).locator('.task__edit').isVisible(), true);
  await page.locator('.task').nth(2).locator('.task__edit').fill('Fix the timer drift bug (done upstream)');
  await page.locator('.task').nth(2).locator('.task__edit').press('Enter');
  eq('rename committed', (await page.locator('.task').nth(2).locator('.task__text').textContent()).trim(),
     'Fix the timer drift bug (done upstream)');

  // delete via the row button (hover reveals it)
  await page.locator('.task').nth(3).hover();
  await page.waitForTimeout(300);                 // let the 120ms opacity transition finish
  const delOpacity = await page.locator('.task').nth(3).locator('.task__del').evaluate((el) => getComputedStyle(el).opacity);
  eq('delete button appears on hover', delOpacity, '1');
  await page.locator('.task').nth(3).locator('.task__del').click();
  eq('task deleted', await page.locator('.task').count(), 3);

  await page.screenshot({ path: `${SHOTS}/05-dark-tasks.png` });

  // keyboard: space on the page starts, space in the input does not
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  eq('space starts the timer', (await page.textContent('#startPause')).trim(), 'Pause');
  await page.keyboard.press('Space');
  eq('space pauses it', (await page.textContent('#startPause')).trim(), 'Resume');
  await page.keyboard.press('r');
  eq('r resets', (await page.textContent('#timeDisplay')).trim(), '25:00');
  await page.fill('#taskInput', 'typing here');
  await page.press('#taskInput', 'Space');
  eq('space inside the field is left alone', (await page.textContent('#startPause')).trim(), 'Start');
  eq('and it typed a space', await page.inputValue('#taskInput'), 'typing here ');

  await page.reload({ waitUntil: 'load' });
  eq('tasks survive a real reload', await page.locator('.task').count(), 3);
  eq('completed state survives', await page.locator('.task').nth(1).locator('.task__check').isChecked(), true);
  eq('timer reopens paused and full', (await page.textContent('#timeDisplay')).trim(), '25:00');
  eq('not running', (await page.textContent('#startPause')).trim(), 'Start');
  ok('no console errors', problems.length === 0, problems.join(' | '));
  await ctx.close();
}

/* ───── 4. light theme + mobile layout ───── */
console.log('\n4. light theme + mobile');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems);
  await page.goto(URL, { waitUntil: 'load' });
  for (const t of ['Draft the launch email', 'Review PR #214']) {
    await page.fill('#taskInput', t);
    await page.press('#taskInput', 'Enter');
  }
  await page.locator('.task').nth(1).locator('.task__check').check();
  eq('light background', await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(244, 246, 250)');
  const twoCol = await page.evaluate(() => {
    const [a, b] = document.querySelectorAll('.panel');
    return a.getBoundingClientRect().top === b.getBoundingClientRect().top;
  });
  ok('two columns side by side on desktop', twoCol);
  await page.screenshot({ path: `${SHOTS}/06-light-desktop.png` });

  await page.setViewportSize({ width: 375, height: 760 });
  await page.waitForTimeout(100);
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth
  }));
  ok('no horizontal scroll at 375px', overflow.scrollW <= overflow.clientW + 1, JSON.stringify(overflow));
  const stacked = await page.evaluate(() => {
    const [a, b] = document.querySelectorAll('.panel');
    return b.getBoundingClientRect().top > a.getBoundingClientRect().bottom - 1;
  });
  ok('panels stack on mobile', stacked);
  const dialW = (await page.locator('.dial').boundingBox()).width;
  ok('dial fits the narrow viewport', dialW <= 375 - 32, String(dialW));
  await page.screenshot({ path: `${SHOTS}/07-light-mobile.png`, fullPage: true });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${SHOTS}/08-dark-mobile.png`, fullPage: true });
  ok('no console errors', problems.length === 0, problems.join(' | '));
  await ctx.close();
}

/* ───── 5. focus ring / tab order ───── */
console.log('\n5. keyboard focus');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  const order = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => {
      const a = document.activeElement;
      return (a.id || a.className || a.tagName).toString().trim();
    }));
  }
  console.log(`       tab order: ${order.join(' → ')}`);
  ok('start button is reachable early', order.slice(0, 3).includes('startPause'), order.join(','));
  const outline = await page.evaluate(() => {
    document.getElementById('startPause').focus();
    return getComputedStyle(document.getElementById('startPause')).outlineWidth;
  });
  ok('focus-visible outline is drawn', parseFloat(outline) > 0, outline);
  await page.screenshot({ path: `${SHOTS}/09-focus-ring.png`, clip: { x: 300, y: 500, width: 680, height: 260 } });
  await ctx.close();
}

await browser.close();
if (own) own.server.close();

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots → ${SHOTS}`);
process.exit(fail ? 1 : 0);
