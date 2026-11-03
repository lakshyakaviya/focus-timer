# Focus Timer

A single-page Pomodoro timer with a task list. Plain HTML, CSS and JavaScript — no build step, no
dependencies, no accounts, no tracking. Everything you type stays in your own browser.

## Features

- **Pomodoro cycle** — focus → short break → focus → … → long break, with a round counter and an
  "up next" line so you always know what follows.
- **Configurable** — focus, short break and long break lengths, and how many rounds precede a long
  break. Optionally auto-start the next phase.
- **Accurate in background tabs** — the countdown is computed from a deadline timestamp rather than
  by decrementing on every tick, so throttled or sleeping tabs don't drift.
- **Task list** — add, rename (click the text), check off, delete, and clear completed.
- **Chime and desktop notification** when a phase ends (both optional; the chime is synthesised with
  the Web Audio API, so there is no audio file to load).
- **Keyboard** — <kbd>Space</kbd> starts/pauses, <kbd>R</kbd> resets. Both are ignored while you're
  typing in a field.
- **Light and dark** — follows your operating system's colour scheme.

Settings and tasks are saved to `localStorage`. The timer itself always opens paused at a full phase,
rather than guessing whether it should have been running while the tab was closed.

## Run it locally

Any static file server works. Using Python:

```sh
cd focus-timer
python -m http.server 8000
```

Then open <http://localhost:8000>.

Opening `index.html` directly from disk works too, but `file://` is not a secure context, so desktop
notifications are unavailable there. The chime and everything else still work.

## Deploy to GitHub Pages

1. Push this repository to GitHub (`main` branch).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, then pick
   **`main`** and **`/ (root)`**, and save.
4. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

All asset paths are relative, so the site works correctly from that `/<repo-name>/` sub-path. The
empty `.nojekyll` file tells GitHub Pages to publish the files as-is instead of running them through
Jekyll.

## Files

| File | What's in it |
|---|---|
| `index.html` | Markup for the timer dial, controls, settings drawer and task list |
| `styles.css` | Design tokens, layout, light/dark themes |
| `app.js` | Timer engine, phase machine, settings, tasks, persistence, chime, notifications |
| `.nojekyll` | Marker that disables Jekyll processing on GitHub Pages |

## Browser support

Current versions of Chrome, Edge, Firefox and Safari. The app uses ES2020 syntax, `aspect-ratio`,
CSS custom properties and `Element.closest` — no polyfills, no transpiler.
