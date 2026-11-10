// Pass-through service worker.
//
// Chrome Android hanya menganggap situs "installable" (dan bikin WebAPK dengan
// ikon dari manifest) kalau ada service worker yang punya handler `fetch`.
// Tanpa handler ini, "Add to Home screen" cuma bikin shortcut biasa, dan
// launcher-nya bikin ikon huruf fallback (mis. "H" di kotak teal).
//
// Handler di bawah sengaja tidak meng-cache apa pun: semua request diteruskan
// ke network. Tujuannya memenuhi syarat installability, bukan offline mode.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Biarkan browser menangani sendiri request non-GET dan range request.
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;
  event.respondWith(
    fetch(req).catch(() => new Response('', { status: 504, statusText: 'Gateway Timeout' }))
  );
});
