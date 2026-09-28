/**
 * Content script for eventbrite.com: finds event cards, asks the background
 * service worker (never the network directly -- see background.ts) whether
 * the stars favor each one for the person whose birth details are saved via
 * the popup, and glows the card green (favor) or red (skeptical).
 *
 * Card selector (`[data-testid="search-event"]`) and title source
 * (`a.event-card-link`'s `aria-label`, "View <title>") were taken from a
 * real, live-rendered Eventbrite search page (Playwright DOM inspection, not
 * guessed and not read from a static/markdown fetch of the page, which
 * cannot see real attributes at all). Deliberately avoids Eventbrite's
 * hashed CSS-module class names (e.g. `Container_root__163eu`), which are
 * webpack build hashes likely to change on Eventbrite's next deploy --
 * `data-testid` and the plain "event-card-link" class read as intentional,
 * more stable authoring conventions.
 *
 * Cards are scored lazily, one IntersectionObserver entry at a time, not all
 * at once on page load: this is both "update as the page scrolls" (the
 * literal ask) and a real cost control -- each score is a full two-call Jev
 * consultation against the shared Worker, which enforces a small rolling
 * per-IP spend cap (worker/wrangler.toml's SPEND_CAP_USD_PER_IP) shared with
 * the main app, so scoring an entire results page's ~20 cards eagerly would
 * burn through that budget in a single page load.
 */
import type { ScoreEventRequest, ScoreEventResponse } from "./messages";

const CARD_SELECTOR = '[data-testid="search-event"]';
const LINK_SELECTOR = "a.event-card-link";

const GLOW_CLASSES = ["cosmic-jev-glow-pending", "cosmic-jev-glow-green", "cosmic-jev-glow-red", "cosmic-jev-glow-neutral"];

const observedCards = new WeakSet<Element>();
const resultCache = new Map<string, ScoreEventResponse>();

interface EventInfo {
  title: string;
  href: string;
}

function extractEventInfo(card: Element): EventInfo | null {
  const link = card.querySelector(LINK_SELECTOR);
  if (!(link instanceof HTMLAnchorElement)) {
    return null;
  }
  const rawLabel = link.getAttribute("aria-label") ?? link.textContent ?? "";
  const title = rawLabel.replace(/^View\s+/i, "").trim();
  if (title === "") {
    return null;
  }
  return { title, href: link.href };
}

function setGlow(card: Element, glowClass: (typeof GLOW_CLASSES)[number]): void {
  card.classList.remove(...GLOW_CLASSES);
  card.classList.add(glowClass);
}

function render(card: Element, response: ScoreEventResponse): void {
  if (response.kind === "verdict") {
    setGlow(card, response.favor >= 0.5 ? "cosmic-jev-glow-green" : "cosmic-jev-glow-red");
    card.setAttribute("data-cosmic-jev-favor", response.favor.toFixed(2));
  } else {
    // Recusal, needs-detail, no saved birth details, or a call failure --
    // none of these are a verdict, so no green/red judgement is shown for
    // them, the same way the main app shows no thumb for a recusal.
    setGlow(card, "cosmic-jev-glow-neutral");
  }
}

async function scoreCard(card: Element): Promise<void> {
  const info = extractEventInfo(card);
  if (info === null) {
    return;
  }

  const cached = resultCache.get(info.href);
  if (cached !== undefined) {
    render(card, cached);
    return;
  }

  setGlow(card, "cosmic-jev-glow-pending");
  const request: ScoreEventRequest = { type: "SCORE_EVENT", title: info.title };
  const response = (await chrome.runtime.sendMessage(request)) as ScoreEventResponse;
  resultCache.set(info.href, response);
  render(card, response);
}

const intersectionObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      intersectionObserver.unobserve(entry.target);
      void scoreCard(entry.target);
    }
  },
  // Starts scoring a card a little before it's actually on screen, so the
  // glow is usually already there by the time the user scrolls it into view.
  { rootMargin: "200px" },
);

function observeAllCards(): void {
  for (const card of document.querySelectorAll(CARD_SELECTOR)) {
    if (!observedCards.has(card)) {
      observedCards.add(card);
      intersectionObserver.observe(card);
    }
  }
}

observeAllCards();

// Eventbrite's exact card-loading mechanism (client-side pagination,
// infinite scroll, or virtualization) wasn't confirmed from static
// inspection -- this re-scans on any DOM mutation and on scroll, rather than
// assuming one specific mechanism, so newly-rendered cards get picked up
// regardless of how they appeared.
new MutationObserver(() => observeAllCards()).observe(document.body, { childList: true, subtree: true });

let scrollScanQueued = false;
window.addEventListener(
  "scroll",
  () => {
    if (scrollScanQueued) return;
    scrollScanQueued = true;
    requestAnimationFrame(() => {
      scrollScanQueued = false;
      observeAllCards();
    });
  },
  { passive: true },
);
