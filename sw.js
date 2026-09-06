// sw.js — minimal passthrough Service Worker
//
// This exists ONLY to satisfy the PWA installability checklist (Chrome /
// Android WebAPK requires a registered Service Worker with a fetch handler).
// It intentionally does NOT cache anything and does NOT intercept requests
// meaningfully — every request is just forwarded to the network as-is. This
// keeps Groq Whisper API calls, the Mediabunny CDN import, Google Fonts, and
// any other third-party/CDN/WebSocket traffic completely untouched.
//
// If you later want offline support, add a real cache strategy — but do it
// deliberately and scoped only to same-origin static assets, never to
// cross-origin API calls.

const SW_VERSION = 'v1';

self.addEventListener('install', (event) => {
  // Activate this SW immediately instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of any already-open clients right away.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Network-first, no caching, no interception logic: just required to
  // exist so the browser recognizes this as an installable PWA.
  // Any request Chrome can't fetch via the SW (e.g. it throws) is left to
  // fall through to normal browser networking by not calling
  // event.respondWith() at all — but we do call it here with a plain
  // network fetch so the fetch handler is unambiguously "real".
  event.respondWith(
    fetch(event.request).catch((err) => {
      // Never fabricate a cached/offline response — that could silently
      // break an API call or CDN import. Just propagate the network error
      // the way it would have failed without a Service Worker at all.
      throw err;
    })
  );
});
