// sw-flux.js
// Lecture pendant le téléchargement, dans un navigateur : ce service worker
// répond aux adresses « flux-essaim/<numéro> » du lecteur vidéo en posant à la
// page qui les a demandées les mêmes questions que le protocole maison de
// l'application (flux-protocole.js) : « ouvrir », puis « octets ».
//
// Navigateur seulement, et en https (ou localhost) : un service worker exige
// un contexte sécurisé. Ailleurs (http sur le réseau local), la vidéo
// s'affiche une fois reçue en entier, comme avant.
//
// À côté de castunn.html : sa portée couvre alors la page.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function question(client, q) {
  return new Promise((ok) => {
    const canal = new MessageChannel();
    canal.port1.onmessage = (e) => ok(e.data);
    client.postMessage({ fluxEssaim: q }, [canal.port2]);
  });
}

self.addEventListener('fetch', (e) => {
  const m = /\/flux-essaim\/(\d+)$/.exec(new URL(e.request.url).pathname);
  if (!m) return;
  e.respondWith((async () => {
    const client = (e.clientId && await self.clients.get(e.clientId))
      || (await self.clients.matchAll({ type: 'window' }))[0];
    if (!client) return new Response(null, { status: 404 });
    const num = Number(m[1]);
    const tete = await question(client, { type: 'ouvrir', num, plage: e.request.headers.get('range') });
    if (!tete) return new Response(null, { status: 404 });
    if (tete.status === 416) return new Response(null, tete);
    let pos = tete.debut;
    const corps = new ReadableStream({
      async pull(ctrl) {
        if (pos > tete.fin) { ctrl.close(); return; }
        const octets = await question(client, { type: 'octets', num, pos, fin: tete.fin });
        if (!octets || !octets.byteLength) { ctrl.error(new Error('flux interrompu')); return; }
        pos += octets.byteLength;
        ctrl.enqueue(new Uint8Array(octets));
      }
    });
    return new Response(corps, { status: tete.status, headers: tete.headers });
  })());
});
