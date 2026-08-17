// test/signal.test.js
// Tests d'intégration du serveur de signalisation.
// Objectif : figer le contrat réseau (découverte, identité des pairs, rooms,
// tchat, transfert binaire) AVANT de refactorer le renderer, pour que toute
// régression se voie immédiatement.
//
//   npm test

const {
  startServer, httpGet, connect, joinRoom, sleep,
  test, run, assert, assertEqual
} = require('./helpers');

const PORT = Number(process.env.TEST_PORT || 8099);
let server;

/* ============================ Découverte ============================ */

test('GET /castunn annonce un serveur Castunn (contrat de découverte LAN)', async () => {
  const { status, body } = await httpGet(PORT, '/castunn');
  assertEqual(status, 200, 'statut HTTP');
  const json = JSON.parse(body);
  assertEqual(json.app, 'castunn', 'champ app');
  assert(json.ws === true, 'le serveur doit annoncer le support WebSocket');
});

test('GET / répond OK (health check hébergeur)', async () => {
  const { status, body } = await httpGet(PORT, '/');
  assertEqual(status, 200, 'statut HTTP');
  assertEqual(body.trim(), 'OK', 'corps');
});

/* ======================== Connexion / identité ======================= */

test('la connexion attribue un peerId via "hello"', async () => {
  const a = await connect(PORT, 'alice');
  assert(typeof a.peerId === 'string' && a.peerId.length > 0, 'peerId manquant');
  await a.close();
});

test("l'IP annoncée par le client est diffusée quand le serveur ne voit qu'un loopback", async () => {
  // Reproduit le cas du reverse proxy (alwaysdata) : remoteAddress = ::1.
  // Sans l'IP transmise dans le join, les pairs affichaient "Connexion de ::1".
  const room = 'ip-proxy';
  const a = await connect(PORT, 'alice');
  await joinRoom(a, room, { ip: '88.120.5.7', nick: 'alice' });

  const b = await connect(PORT, 'bob');
  await joinRoom(b, room, { ip: '90.11.22.33', nick: 'bob' });

  const presence = await a.waitForType('presence', (m) => m.action === 'join');
  assertEqual(presence.ip, '90.11.22.33', 'IP du pair');
  assertEqual(presence.nick, 'bob', 'pseudo du pair');
  assert(!String(presence.ip).includes('::1'), 'aucune adresse loopback ne doit fuiter');

  await a.close(); await b.close();
});

test('"announce" met à jour IP/pseudo et est relayé à la room', async () => {
  const room = 'announce';
  const a = await connect(PORT, 'alice');
  await joinRoom(a, room, { ip: '10.0.0.1', nick: 'alice' });

  const b = await connect(PORT, 'bob');
  await joinRoom(b, room, { ip: '', nick: '' });   // IP pas encore connue (ipify lent)
  await a.waitForType('presence', (m) => m.action === 'join');

  b.send({ type: 'announce', ip: '90.11.22.33', nick: 'bob' }); // arrivée tardive

  const ann = await a.waitForType('announce');
  assertEqual(ann.ip, '90.11.22.33', 'IP annoncée');
  assertEqual(ann.nick, 'bob', 'pseudo annoncé');
  assertEqual(ann.from, b.peerId, 'émetteur');

  // et l'identité mise à jour doit servir au départ suivant
  await b.close();
  const leave = await a.waitForType('presence', (m) => m.action === 'leave');
  assertEqual(leave.ip, '90.11.22.33', 'IP au moment du départ');

  await a.close();
});

test("un client ne reçoit pas son propre message de présence", async () => {
  const room = 'self-presence';
  const a = await connect(PORT, 'alice');
  await joinRoom(a, room, { ip: '10.0.0.1', nick: 'alice' });
  await a.expectNothing((e) => e.json?.type === 'presence', 400, 'presence de soi-même');
  await a.close();
});

/* ============================== Rooms ============================== */

test('la liste "peers" contient les pairs déjà présents', async () => {
  const room = 'peers-list';
  const a = await connect(PORT, 'alice');
  await joinRoom(a, room, { ip: '10.0.0.1' });

  const b = await connect(PORT, 'bob');
  await joinRoom(b, room, { ip: '10.0.0.2' });
  const peers = await b.waitForType('peers');

  assert(Array.isArray(peers.peers), 'peers doit être un tableau');
  assertEqual(peers.peers.length, 1, 'nombre de pairs');
  assertEqual(peers.peers[0], a.peerId, 'identifiant du pair présent');

  await a.close(); await b.close();
});

test('les rooms sont étanches', async () => {
  const a = await connect(PORT, 'alice');
  const b = await connect(PORT, 'bob');
  await joinRoom(a, 'salon-A', { ip: '10.0.0.1' });
  await joinRoom(b, 'salon-B', { ip: '10.0.0.2' });

  a.send({ type: 'chat', text: 'coucou A', fromName: 'alice' });
  await b.expectNothing((e) => e.json?.type === 'chat', 500, 'chat venu d\'une autre room');

  await a.close(); await b.close();
});

/* ============================== Tchat ============================== */

test('le tchat est relayé aux autres et jamais renvoyé à son auteur', async () => {
  const room = 'chat';
  const a = await connect(PORT, 'alice');
  const b = await connect(PORT, 'bob');
  await joinRoom(a, room, { ip: '10.0.0.1', nick: 'alice' });
  await joinRoom(b, room, { ip: '10.0.0.2', nick: 'bob' });
  await a.waitForType('presence', (m) => m.action === 'join');

  a.send({ type: 'chat', text: 'salut Bob', fromName: '10.0.0.1(alice)' });

  const msg = await b.waitForType('chat');
  assertEqual(msg.text, 'salut Bob', 'contenu');
  assertEqual(msg.fromName, '10.0.0.1(alice)', 'nom affiché');
  assertEqual(msg.from, a.peerId, 'émetteur');

  await a.expectNothing((e) => e.json?.type === 'chat', 300, 'écho de son propre chat');
  await a.close(); await b.close();
});

/* =========================== Transfert binaire ====================== */

test('le transfert binaire relaie méta, données puis fin', async () => {
  const room = 'binaire';
  const a = await connect(PORT, 'alice');
  const b = await connect(PORT, 'bob');
  await joinRoom(a, room, { ip: '10.0.0.1' });
  await joinRoom(b, room, { ip: '10.0.0.2' });
  await a.waitForType('presence', (m) => m.action === 'join');

  const payload = Buffer.from('des octets de test');
  a.send({ type: 'binary-meta', filename: 'clip.mp4', size: payload.length, mime: 'video/mp4', kind: 'video', fileId: 'f1' });
  await sleep(50);
  a.sendBinary(payload);

  const meta = await b.waitForType('binary-meta');
  assertEqual(meta.filename, 'clip.mp4', 'nom de fichier');
  assertEqual(meta.mime, 'video/mp4', 'type MIME');
  assertEqual(meta.kind, 'video', 'nature du média');
  assertEqual(meta.size, payload.length, 'taille');

  const bin = await b.waitFor((e) => !!e.binary, { label: 'trame binaire' });
  assert(bin.binary.equals(payload), 'les octets reçus diffèrent des octets envoyés');

  a.send({ type: 'binary-end', fileId: 'f1' });
  const end = await b.waitForType('binary-end');
  assertEqual(end.fileId, 'f1', 'fileId de fin');

  await a.close(); await b.close();
});

test('la méta binaire n\'est annoncée qu\'une seule fois par transfert', async () => {
  const room = 'binaire-unique';
  const a = await connect(PORT, 'alice');
  const b = await connect(PORT, 'bob');
  await joinRoom(a, room, { ip: '10.0.0.1' });
  await joinRoom(b, room, { ip: '10.0.0.2' });
  await a.waitForType('presence', (m) => m.action === 'join');

  a.send({ type: 'binary-meta', filename: 'gros.bin', size: 6, mime: 'application/octet-stream', kind: 'file', fileId: 'f2' });
  await sleep(50);
  a.sendBinary(Buffer.from('abc'));
  a.sendBinary(Buffer.from('def'));
  await sleep(300);

  const metas = b.received.filter((e) => e.json?.type === 'binary-meta');
  assertEqual(metas.length, 1, 'nombre d\'annonces binary-meta');
  const chunks = b.received.filter((e) => e.binary);
  assertEqual(chunks.length, 2, 'nombre de morceaux relayés');

  await a.close(); await b.close();
});

/* ========================= Signalisation WebRTC ===================== */

test('offer/answer/ice sont routés vers le destinataire uniquement', async () => {
  const room = 'rtc';
  const a = await connect(PORT, 'alice');
  const b = await connect(PORT, 'bob');
  const c = await connect(PORT, 'carol');
  await joinRoom(a, room, { ip: '10.0.0.1' });
  await joinRoom(b, room, { ip: '10.0.0.2' });
  await joinRoom(c, room, { ip: '10.0.0.3' });
  await sleep(200);

  a.send({ type: 'offer', to: b.peerId, sdp: 'v=0-faux-sdp' });

  const offer = await b.waitForType('offer');
  assertEqual(offer.sdp, 'v=0-faux-sdp', 'SDP transmis');
  assertEqual(offer.from, a.peerId, 'émetteur');
  await c.expectNothing((e) => e.json?.type === 'offer', 300, 'offre destinée à quelqu\'un d\'autre');

  await a.close(); await b.close(); await c.close();
});

/* ============================== Départ ============================= */

test('la fermeture de socket diffuse un "presence leave"', async () => {
  const room = 'depart';
  const a = await connect(PORT, 'alice');
  const b = await connect(PORT, 'bob');
  await joinRoom(a, room, { ip: '10.0.0.1' });
  await joinRoom(b, room, { ip: '10.0.0.2', nick: 'bob' });
  await a.waitForType('presence', (m) => m.action === 'join');

  await b.close();

  const leave = await a.waitForType('presence', (m) => m.action === 'leave');
  assertEqual(leave.peerId, b.peerId, 'pair parti');
  assertEqual(leave.ip, '10.0.0.2', 'IP conservée au départ');

  await a.close();
});

/* ============================== Runner ============================= */

(async () => {
  console.log(`\nTests de signalisation (port ${PORT})\n`);
  try {
    server = await startServer(PORT);
  } catch (e) {
    console.error('Impossible de démarrer le serveur de test :', e.message);
    process.exit(1);
  }

  let failed = 1;
  try {
    failed = await run();
  } finally {
    await server.stop();
  }
  process.exit(failed ? 1 : 0);
})();
