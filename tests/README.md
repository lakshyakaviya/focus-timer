# Tests

Two suites. Neither is part of the published site — nothing here is loaded by `index.html`.

```sh
cd tests
npm install
npm test            # both suites
```

| Suite | What it does |
| --- | --- |
| `dom.test.mjs` | Loads the page in **jsdom** with a fake clock, so whole Pomodoro phases fast-forward in milliseconds. Covers the phase machine, settings validation, task editing, persistence and corrupt-storage handling. No browser, no server. |
| `browser.test.mjs` | Drives the real page in your installed **Chrome or Edge** via Playwright, starting its own static server. Covers what jsdom cannot: real per-second rendering, the SVG ring, Web Audio, notifications, CSS themes, layout and focus styles. Writes screenshots to `tests/shots/`. |

Run one at a time with `npm run test:dom` or `npm run test:browser`.

## Why both

jsdom is fast and deterministic but has no layout, no Web Audio and no notifications, so it
cannot tell you the ring renders or the chime fires. The browser suite can, but is slower and
depends on a real browser being installed. Together they cover the app; separately each has a
blind spot.

The browser suite needs no browser download: `playwright-core` ships no binaries and drives a
Chromium-based browser you already have.

## Options

| Variable | Effect |
| --- | --- |
| `TEST_URL` | Test a deployed URL instead of a local server, e.g. `TEST_URL=https://lakshyakaviya.github.io/focus-timer/ npm run test:browser` |
| `CHROME_PATH` | Point at a specific Chromium-based browser if auto-detection misses yours |
| `HEADED=1` | Show the browser window instead of running headless |

## Notes on what is and isn't covered

- **Timing.** The browser suite watches the real clock for ~3.5s to confirm the readout steps one
  second at a time, then switches to Playwright's fake clock to fast-forward whole phases. The
  jsdom suite fakes `Date.now()` the same way and also simulates a 20-second background gap, which
  is the case a naive decrementing timer gets wrong.
- **Audio.** Headless Chrome has no audio output. The tests confirm the `AudioContext` is created
  on a user gesture and that oscillators start at phase end — not that you can hear it. Check that
  by ear once.
- **Notifications.** The tests grant permission and assert the call fires with the right title and
  body. Whether the OS actually draws the toast is outside the browser's control.
- **Screen reader output.** The live region's text is asserted indirectly at best. If you change
  the announcement logic, listen to it with a real screen reader.
