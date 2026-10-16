// test/signal.test.js
// Tests d'intégration du serveur de signalisation.
// Objectif : figer le contrat réseau (découverte, identité des pairs, rooms,
// tchat, transfert binaire) AVANT de refactorer le renderer, pour que toute
// régression se voie immédiatement.
//
//   npm test

const {
  VERSION, startServer, httpGet, connect, joinRoom, sleep,
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

test("le pair venu en IPv6 voit son IPv4 déclarée relayée à côté", async () => {
  // Cas réel : le serveur publie un AAAA, le pair arrive donc en IPv6, mais
  // les services d'IP publique ne répondent qu'en IPv4. Le serveur garde
  // l'adresse qu'il constate et relaie celle que le pair déclare, sans la
  // croire : c'est l'interface qui choisit laquelle montrer.
  const room = 'double-adresse';
  const a = await connect(PORT, 'alice');
  await joinRoom(a, room, { ip: '88.120.5.7', nick: 'alice' });

  const b = await connect(PORT, 'bob', { headers: { 'x-forwarded-for': '2001:863:294:3d9b:a0c:ca63:d094:b080' } });
  await joinRoom(b, room, { ip: '80.214.20.117', nick: 'bob' });

  const presence = await a.waitForType('presence', (m) => m.action === 'join');
  assertEqual(presence.ip, '2001:863:294:3d9b:a0c:ca63:d094:b080', 'adresse constatée par le serveur');
  assertEqual(presence.ipDeclared, '80.214.20.117', 'adresse déclarée par le pair');

  // Et la même chose sur announce, qui corrige une identité tardive.
  b.send({ type: 'announce', ip: '80.214.20.117', nick: 'bobby' });
  const ann = await a.waitForType('announce');
  assertEqual(ann.ip, '2001:863:294:3d9b:a0c:ca63:d094:b080', "l'adresse constatée n'est jamais écrasée");
  assertEqual(ann.ipDeclared, '80.214.20.117', 'adresse déclarée relayée');

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

/* ============================ Relais TURN (B1) =========================== */

const crypto = require('crypto');
const TURN_PORT = Number(process.env.TEST_TURN_PORT || 8096);
const SECRET = 'secret-de-test-a-ne-jamais-diffuser';
const URLS = 'turn:turn.exemple.test:3478?transport=udp, turns:turn.exemple.test:443?transport=tcp';
const URLS_ATTENDUES = ['turn:turn.exemple.test:3478?transport=udp', 'turns:turn.exemple.test:443?transport=tcp'];
const ENV_TURN = { TURN_URLS: URLS, TURN_SECRET: SECRET, TURN_TTL: '3600' };

const helloDe = (client) => client.received.find((e) => e.json && e.json.type === 'hello').json;

/** Vérifie le contrat « TURN REST API » : c'est ce que coturn recalculera. */
function verifierIdentifiants(cfg, peerId, ttl) {
  assert(Array.isArray(cfg.iceServers) && cfg.iceServers.length === 1, 'un serveur ICE : ' + JSON.stringify(cfg));
  const s = cfg.iceServers[0];
  assertEqual(JSON.stringify(s.urls), JSON.stringify(URLS_ATTENDUES), 'URL du relais');
  const [expiration, id] = s.username.split(':');
  assertEqual(id, peerId, 'le username porte le peerId');
  const attendue = Math.floor(Date.now() / 1000) + ttl;
  assert(Math.abs(Number(expiration) - attendue) <= 5, `expiration ${expiration}, attendue ≈ ${attendue}`);
  assertEqual(cfg.iceExpiresAt, Number(expiration) * 1000, 'iceExpiresAt cohérent avec le username');
  const hmac = crypto.createHmac('sha1', SECRET).update(s.username).digest('base64');
  assertEqual(s.credential, hmac, 'credential = base64(HMAC-SHA1(secret, username))');
}

test('avec TURN_URLS et TURN_SECRET, le hello porte des identifiants temporaires', async () => {
  const srv = await startServer(TURN_PORT, { env: ENV_TURN });
  try {
    const a = await connect(TURN_PORT, 'alice');
    verifierIdentifiants(helloDe(a), a.peerId, 3600);
    assert(!JSON.stringify(a.received).includes(SECRET), 'le secret ne sort jamais du serveur');
    await sleep(100);
    assert(srv.sortie().includes('[TURN] relais annoncé'), 'annonce journalisée au démarrage');
    assert(!srv.sortie().includes(SECRET), 'le secret n’apparaît pas dans les journaux');
    await a.close();
  } finally { await srv.stop(); }
});

test('ice-config renouvelle les identifiants, pour l’émetteur seul, sans se laisser marteler', async () => {
  const srv = await startServer(TURN_PORT, { env: ENV_TURN });
  try {
    const a = await connect(TURN_PORT, 'alice');
    await joinRoom(a, 'turn', {});
    const b = await connect(TURN_PORT, 'bob');
    await joinRoom(b, 'turn', {});

    a.send({ type: 'ice-config' });
    const cfg = await a.waitForType('ice-config');
    assert(!cfg.from, 'réponse du serveur lui-même, pas un message relayé');
    verifierIdentifiants(cfg, a.peerId, 3600);
    await b.expectNothing((e) => e.json && e.json.type === 'ice-config', 300, 'demande relayée à la room');

    a.send({ type: 'ice-config' });          // aussitôt après : ignorée
    await sleep(400);
    const reponses = a.received.filter((e) => e.json && e.json.type === 'ice-config').length;
    assertEqual(reponses, 1, 'une seconde demande dans les 10 s est ignorée');
    await a.close(); await b.close();
  } finally { await srv.stop(); }
});

test('sans configuration TURN, le hello est inchangé et ice-config répond vide', async () => {
  const a = await connect(PORT, 'alice');      // serveur principal : sans TURN_*
  const hello = helloDe(a);
  assert(!('iceServers' in hello) && !('iceExpiresAt' in hello), 'rien d’annoncé : ' + JSON.stringify(hello));
  a.send({ type: 'ice-config' });
  const cfg = await a.waitForType('ice-config');
  assertEqual(JSON.stringify(cfg.iceServers), '[]', 'aucun relais');
  await a.close();
});

test('configuration TURN incomplète ou invalide : rien d’annoncé, et le journal le dit', async () => {
  const sansSecret = await startServer(TURN_PORT, { env: { TURN_URLS: URLS, TURN_SECRET: null } });
  try {
    const a = await connect(TURN_PORT, 'alice');
    assert(!('iceServers' in helloDe(a)), 'sans secret, aucun relais');
    await sleep(100);
    assert(sansSecret.sortie().includes('TURN_URLS sans TURN_SECRET'), 'avertissement attendu');
    await a.close();
  } finally { await sansSecret.stop(); }

  const urlInvalide = await startServer(TURN_PORT, {
    env: { TURN_URLS: 'http://pas-un-relais.test, turn:ok.test:3478', TURN_SECRET: SECRET }
  });
  try {
    const a = await connect(TURN_PORT, 'alice');
    assertEqual(JSON.stringify(helloDe(a).iceServers[0].urls), '["turn:ok.test:3478"]', 'URL non TURN écartée');
    await sleep(100);
    assert(urlInvalide.sortie().includes('URL ignorée'), 'avertissement attendu');
    await a.close();
  } finally { await urlInvalide.stop(); }
});

test('la durée de validité des identifiants est bornée', async () => {
  const srv = await startServer(TURN_PORT, { env: { ...ENV_TURN, TURN_TTL: '5' } });
  try {
    const a = await connect(TURN_PORT, 'alice');
    const exp = Number(helloDe(a).iceServers[0].username.split(':')[0]);
    const ttl = exp - Math.floor(Date.now() / 1000);
    assert(ttl >= 295 && ttl <= 300, `5 s demandées, plancher de 300 s attendu (obtenu ${ttl})`);
    await a.close();
  } finally { await srv.stop(); }
});

/* ======================= Maillage : adressage (serveur) ======================= */

const SIGNE = { capacites: ['binaire-signe'] };

/** Sépare un envoi binaire signé : [0xCA, longueur, identifiant, données]. */
function lireSigne(buf) {
  assertEqual(buf[0], 0xCA, 'marqueur de signature');
  const n = buf[1];
  return { de: buf.slice(2, 2 + n).toString('ascii'), donnees: buf.slice(2 + n) };
}

test('le hello annonce les capacités du serveur', async () => {
  const a = await connect(PORT, 'alice');
  const hello = a.received.find((e) => e.json && e.json.type === 'hello').json;
  assert(Array.isArray(hello.capacites), 'capacites : ' + JSON.stringify(hello));
  assert(hello.capacites.includes('adressage') && hello.capacites.includes('binaire-signe'), JSON.stringify(hello.capacites));
  await a.close();
});

/* ============================== Version ============================== */

test('le serveur annonce sa version (hello et découverte)', async () => {
  const a = await connect(PORT, 'alice');
  assertEqual(a.received.find((e) => e.json?.type === 'hello').json.version, VERSION, 'hello');
  assertEqual(JSON.parse((await httpGet(PORT, '/castunn')).body).versionCastunn, VERSION, 'découverte');
  await a.close();
});

for (const [cas, version] of [['sans version (1.2.1 et avant)', undefined], ['d’une autre version', '0.0.1']]) {
  test(`un client ${cas} est refusé, déconnecté, et n’entre jamais dans la room`, async () => {
    const temoin = await connect(PORT, 'témoin'); await joinRoom(temoin, 'version', {});
    const vieux = await connect(PORT, 'vieux');
    const ferme = new Promise((r) => vieux.ws.once('close', (code, raison) => r({ code, raison: String(raison) })));
    vieux.send({ type: 'join', room: 'version', ...(version ? { version } : {}) });
    const refus = await vieux.waitForType('version-refusee');
    assertEqual(refus.serveur, VERSION, 'version du serveur');
    assertEqual(refus.client, version ?? null, 'version du client');
    const { code, raison } = await ferme;
    assertEqual(code, 4009, 'code de fermeture');
    assert(raison.includes(VERSION), 'raison : ' + raison);
    assert(!vieux.received.some((e) => e.json?.type === 'peers'), 'il ne doit pas recevoir la liste des pairs');
    await temoin.expectNothing((e) => e.json?.type === 'presence' && e.json.action === 'join', 300, 'arrivée du client refusé');
    await temoin.close();
  });
}

test('un message adressé ne va qu’aux pairs désignés, et jamais hors de la room', async () => {
  const room = 'adressage';
  const a = await connect(PORT, 'alice'); await joinRoom(a, room, {});
  const b = await connect(PORT, 'bob');   await joinRoom(b, room, {});
  const c = await connect(PORT, 'carol'); await joinRoom(c, room, {});
  const d = await connect(PORT, 'dave');  await joinRoom(d, 'autre-room', {});

  a.send({ type: 'audio', url: 'https://x.test/a.mp3', to: [c.peerId, d.peerId] });
  const recu = await c.waitForType('audio');
  assertEqual(recu.from, a.peerId, 'émetteur');
  await b.expectNothing((e) => e.json && e.json.type === 'audio', 300, 'audio chez un pair non désigné');
  await d.expectNothing((e) => e.json && e.json.type === 'audio', 100, 'audio franchissant la room');
  await a.close(); await b.close(); await c.close(); await d.close();
});

test('le champ from ne peut pas être usurpé', async () => {
  const room = 'usurpation';
  const a = await connect(PORT, 'alice'); await joinRoom(a, room, {});
  const b = await connect(PORT, 'bob');   await joinRoom(b, room, {});
  a.send({ type: 'stop', from: 'quelqu-un-d-autre' });
  const stop = await b.waitForType('stop');
  assertEqual(stop.from, a.peerId, 'le serveur impose le vrai émetteur');
  await a.close(); await b.close();
});

test('un envoi binaire adressé n’atteint que ses destinataires, signé de son émetteur', async () => {
  const room = 'binaire-adresse';
  const a = await connect(PORT, 'alice'); await joinRoom(a, room, SIGNE);
  const b = await connect(PORT, 'bob');   await joinRoom(b, room, SIGNE);
  const c = await connect(PORT, 'carol'); await joinRoom(c, room, SIGNE);

  a.send({ type: 'binary-meta', filename: 'f.bin', size: 3, mime: 'application/octet-stream', kind: 'file', fileId: 'F1', to: [c.peerId] });
  a.sendBinary(Buffer.from([1, 2, 3]));
  a.send({ type: 'binary-end', fileId: 'F1' });

  const meta = await c.waitForType('binary-meta');
  assertEqual(meta.from, a.peerId, 'annonce attribuée à son émetteur');
  const bin = await c.waitFor((e) => e.binary, { label: 'binaire' });
  const lu = lireSigne(bin.binary);
  assertEqual(lu.de, a.peerId, 'signature');
  assertEqual(JSON.stringify([...lu.donnees]), '[1,2,3]', 'données intactes');
  const fin = await c.waitForType('binary-end');
  assertEqual(fin.from, a.peerId, 'fin attribuée');

  await b.expectNothing((e) => e.binary || (e.json && /^binary-/.test(e.json.type)), 300, 'transfert chez un pair non désigné');
  await a.close(); await b.close(); await c.close();
});

test('deux envois simultanés par le WebSocket restent démêlables', async () => {
  const room = 'deux-emetteurs';
  const a = await connect(PORT, 'alice'); await joinRoom(a, room, SIGNE);
  const b = await connect(PORT, 'bob');   await joinRoom(b, room, SIGNE);
  const c = await connect(PORT, 'carol'); await joinRoom(c, room, SIGNE);

  a.send({ type: 'binary-meta', filename: 'a', size: 2, kind: 'file', fileId: 'A', to: [c.peerId] });
  b.send({ type: 'binary-meta', filename: 'b', size: 2, kind: 'file', fileId: 'B', to: [c.peerId] });
  a.sendBinary(Buffer.from([0xA1])); b.sendBinary(Buffer.from([0xB1]));
  a.sendBinary(Buffer.from([0xA2])); b.sendBinary(Buffer.from([0xB2]));

  const parEmetteur = {};
  for (let i = 0; i < 4; i++) {
    const e = await c.waitFor((x) => x.binary && !x.__lu, { label: 'binaire ' + (i + 1) });
    e.__lu = true;
    const { de, donnees } = lireSigne(e.binary);
    (parEmetteur[de] ||= []).push(donnees[0]);
  }
  assertEqual(JSON.stringify(parEmetteur[a.peerId]), JSON.stringify([0xA1, 0xA2]), 'flux de A');
  assertEqual(JSON.stringify(parEmetteur[b.peerId]), JSON.stringify([0xB1, 0xB2]), 'flux de B');
  await a.close(); await b.close(); await c.close();
});

test('un client ancien reçoit les envois binaires bruts, comme avant', async () => {
  const room = 'client-ancien';
  const a = await connect(PORT, 'alice'); await joinRoom(a, room, SIGNE);
  const b = await connect(PORT, 'bob');   await joinRoom(b, room, {});  // sans capacité
  a.send({ type: 'binary-meta', filename: 'f', size: 2, kind: 'file', fileId: 'X' });
  a.sendBinary(Buffer.from([7, 8]));
  const bin = await b.waitFor((e) => e.binary, { label: 'binaire brut' });
  assertEqual(JSON.stringify([...bin.binary]), '[7,8]', 'aucun en-tête pour un client qui ne l’a pas demandé');
  await a.close(); await b.close();
});

test('une annulation adressée suit le même chemin que l’envoi', async () => {
  const room = 'annulation';
  const a = await connect(PORT, 'alice'); await joinRoom(a, room, SIGNE);
  const b = await connect(PORT, 'bob');   await joinRoom(b, room, SIGNE);
  const c = await connect(PORT, 'carol'); await joinRoom(c, room, SIGNE);
  a.send({ type: 'binary-meta', filename: 'f', size: 9, kind: 'file', fileId: 'Z', to: [c.peerId] });
  a.sendBinary(Buffer.from([1]));
  a.send({ type: 'binary-cancel', fileId: 'Z' });
  const annul = await c.waitForType('binary-cancel');
  assertEqual(annul.from, a.peerId, 'annulation attribuée');
  await b.expectNothing((e) => e.json && e.json.type === 'binary-cancel', 300, 'annulation chez un pair non désigné');
  // L'envoi est clos : un binaire égaré ensuite n'est plus annoncé à personne.
  a.sendBinary(Buffer.from([2]));
  await c.expectNothing((e) => e.json && e.json.type === 'binary-meta' && e.json.fileId !== 'Z', 300, 'réannonce après annulation');
  await a.close(); await b.close(); await c.close();
});

(async () => {
  console.log(`\nTests de signalisation (port ${PORT})\n`);
  try {
    // Un TURN_* présent sur la machine de test fausserait les attentes.
    server = await startServer(PORT, { env: { TURN_URLS: null, TURN_SECRET: null } });
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
