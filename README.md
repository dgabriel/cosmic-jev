# Cosmic JEV

Cosmic JEV (né Cosmic Oracle) is an art piece framed as haruspicy: you give it
a birthdate and an activity, it sacrifices the question to real planetary
positions, and [TypeSafe's Jev model](https://openrouter.ai/) hands back a
👍/👎 verdict. A Cloudflare Worker proxies the Jev/OpenRouter calls so the API
key never ships to the browser.

Live site: https://dawngabriel.com/cosmic-jev/ (also mirrored at
https://dgabriel.github.io/cosmic-jev/).

See [`docs/spec.md`](docs/spec.md) for the full project brief and routing
rules, and [`docs/jev-openrouter.md`](docs/jev-openrouter.md) for the Jev API
notes.

## Running it locally

Requires Node ≥ 22.12.

```bash
npm install
npm run dev          # http://localhost:5173
```

By default this uses `StubOracle` — deterministic, offline, no API key
needed. To hit the real Jev model instead (this costs real money and shares
a per-IP spend cap with the live site):

```bash
VITE_ORACLE=jev VITE_WORKER_URL=https://cosmic-oracle-worker.cosmic-oracle.workers.dev npm run dev
```

Other useful commands:

```bash
npm test              # Vitest
npm run typecheck     # tsc --noEmit
npm run build         # typecheck, release gate, then production build to dist/
```

## Chrome extension

`extension/` is a Manifest V3 extension that overlays Eventbrite event cards
with a glowing outline — green if Jev favors attending, red if it doesn't —
based on your saved birth chart. It always talks to the real, deployed Jev
Worker (no stub mode).

### Loading it, starting from a computer with no extensions installed

1. **Prerequisites**: Google Chrome, plus Git and Node.js ≥ 22.12 (check with
   `node -v`; install from [nodejs.org](https://nodejs.org) if missing).

2. **Get the code:**

   ```bash
   git clone https://github.com/dgabriel/cosmic-jev.git
   cd cosmic-jev
   npm install
   ```

3. **Build the extension:**

   ```bash
   npm run build:extension
   ```

   This writes the loadable extension to `extension/dist/`.

4. **Enable Developer mode in Chrome** (off by default on a clean install):
   open `chrome://extensions` and toggle **Developer mode** on, top-right —
   this reveals the "Load unpacked" button.

5. **Load it:** click **Load unpacked** and select the `extension/dist`
   folder. It should appear as "Cosmic JEV for Eventbrite" with a violet
   sparkle icon. (`manifest.json` pins a fixed `"key"`, so it always gets the
   same extension ID regardless of machine or file path — that ID is already
   allowlisted on the Worker.)

6. **Set your birth details:** click the toolbar icon to open the popup,
   enter your birthdate (and optionally time/location), and save. This is
   stored via `chrome.storage.local`, on this device only.

7. **Use it:** visit `https://www.eventbrite.com/` and browse or search for
   events. Cards are scored lazily as they scroll into view (and cached per
   event) to keep real Jev calls to a minimum, since they share the same
   per-IP spend cap as the main site.

If the icon isn't visible in the toolbar after loading, click the
puzzle-piece icon and pin "Cosmic JEV for Eventbrite."

## Privacy

Birth details you enter live only in your browser's `localStorage` (web app)
or `chrome.storage.local` (extension). The web app never sends them: Jev
receives your question plus computed chart results (the ruling planet's
position, its aspects to your natal Sun and Moon, the Moon phase), via the
Worker and OpenRouter. The Worker stores one thing per request, for the spend
cap: your IP address (IPv6 collapsed to its /64) and that request's cost. The
same note appears at the bottom of the app.
