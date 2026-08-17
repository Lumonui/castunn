// test/unit.test.mjs
// Tests unitaires des modules du renderer (aucun DOM requis).
//   npm run test:unit

import { cleanPeerIp, formatPeerLabel, formatSelfName, pickRenderTarget, guessMimeByExt }
  from '../src/renderer/protocol.js';
import { createMediaReceiver } from '../src/renderer/media-receiver.js';
import { createPeerRegistry } from '../src/renderer/peers.js';
import { buildWsUrl, resolveSignalUrl } from '../src/renderer/signal-url.js';

// Les cas sont collectés puis exécutés en séquence : un test asynchrone doit
// être attendu, sinon son échec partirait en promesse rejetée et le test
// s'afficherait "ok" à tort.
const cases = [];
const results = [];
function test(name, fn) { cases.push({ name, fn }); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || ''} — attendu ${b}, reçu ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion échouée'); }

console.log('\nTests unitaires\n');

/* ------------------------------- protocol ------------------------------- */

test('cleanPeerIp démasque les adresses IPv4 encapsulées', () => {
  eq(cleanPeerIp('::ffff:192.168.1.20'), '192.168.1.20');
});

test('cleanPeerIp rejette les adresses loopback', () => {
  for (const v of ['::1', '127.0.0.1', '0.0.0.0', '::', '', '   ', null, undefined, 42]) {
    eq(cleanPeerIp(v), '', `pour ${JSON.stringify(v)}`);
  }
});

test('formatPeerLabel préfère IP + pseudo', () => {
  eq(formatPeerLabel('abc12345', { ip: '90.11.22.33', nick: 'bob' }), '90.11.22.33 (bob)');
});

test('formatPeerLabel se rabat sur le pseudo puis sur un identifiant court', () => {
  eq(formatPeerLabel('abc12345', { ip: '::1', nick: 'bob' }), 'bob');
  eq(formatPeerLabel('abc12345', { ip: '::1' }), 'un pair (abc123)');
  eq(formatPeerLabel(undefined, {}), 'un pair (?)');
});

test('formatPeerLabel n\'expose jamais un identifiant brut complet', () => {
  const label = formatPeerLabel('1caiskg9', {});
  ok(!label.includes('1caiskg9'), `identifiant complet exposé : ${label}`);
});

test('formatSelfName suit le format IP(pseudo) attendu par le tchat', () => {
  eq(formatSelfName({ ip: '90.11.22.33', nick: 'bob' }), '90.11.22.33(bob)');
  eq(formatSelfName({ ip: '90.11.22.33' }), '90.11.22.33');
  eq(formatSelfName({ nick: 'bob' }), 'bob');
  eq(formatSelfName({}), 'un pair');
});

test('guessMimeByExt reconnaît les extensions vidéo courantes', () => {
  eq(guessMimeByExt('film.mp4'), 'video/mp4');
  eq(guessMimeByExt('FILM.MKV'), 'video/x-matroska');
  eq(guessMimeByExt('note.txt'), 'application/octet-stream');
  eq(guessMimeByExt(''), 'application/octet-stream');
});

/* ---------------------------- pickRenderTarget --------------------------- */

test('pickRenderTarget joue les médias selon leur type MIME', () => {
  const canPlayVideo = () => true;
  eq(pickRenderTarget({ mime: 'video/mp4', canPlayVideo }), 'video');
  eq(pickRenderTarget({ mime: 'audio/mpeg', canPlayVideo }), 'audio');
  eq(pickRenderTarget({ mime: 'image/png', canPlayVideo }), 'image');
});

test('pickRenderTarget télécharge ce qui est marqué comme fichier', () => {
  eq(pickRenderTarget({ mime: 'video/mp4', kind: 'file', canPlayVideo: () => true }), 'download');
});

test('pickRenderTarget télécharge une vidéo que le lecteur ne sait pas décoder', () => {
  // Divergence historique : le chemin WebRTC ignorait cette vérification.
  eq(pickRenderTarget({ mime: 'video/x-matroska', canPlayVideo: () => false }), 'download');
});

test('pickRenderTarget se rabat sur kind quand le MIME est absent', () => {
  eq(pickRenderTarget({ kind: 'image' }), 'image');
  eq(pickRenderTarget({ mime: '', kind: '' }), 'download');
});

/* --------------------------- createMediaReceiver ------------------------- */

function makeReceiver(over = {}) {
  const calls = { render: [], download: [], confirm: [], stopPlayback: 0, revoked: [] };
  const rx = createMediaReceiver({
    render: (url, target, info) => calls.render.push({ url, target, info }),
    download: (url, filename) => calls.download.push({ url, filename }),
    createUrl: (blob) => `blob:${blob.size}`,
    revokeUrl: (url) => calls.revoked.push(url),
    canPlayVideo: () => true,
    confirm: (t) => calls.confirm.push(t),
    stopPlayback: () => { calls.stopPlayback++; },
    label: 'WS',
    ...over
  });
  return { rx, calls };
}

test('le récepteur assemble les morceaux et affiche le média', () => {
  const { rx, calls } = makeReceiver();
  rx.begin({ mime: 'video/mp4', kind: 'video', filename: 'clip.mp4' });
  rx.push(new Uint8Array([1, 2, 3]));
  rx.push(new Uint8Array([4, 5]));
  const out = rx.end();
  eq(calls.render.length, 1, 'un seul rendu');
  eq(calls.render[0].target, 'video');
  eq(out.filename, 'clip.mp4');
  eq(rx.state.chunks, 0, 'état remis à zéro');
});

test('le récepteur télécharge une vidéo non décodable', () => {
  const { rx, calls } = makeReceiver({ canPlayVideo: () => false });
  rx.begin({ mime: 'video/x-matroska', kind: 'video', filename: 'film.mkv' });
  rx.push(new Uint8Array([1]));
  rx.end();
  eq(calls.download.length, 1, 'téléchargé');
  eq(calls.render.length, 0, 'jamais envoyé au lecteur');
});

test('stop interrompt la lecture et jette le flux (corrige le chemin RTC)', () => {
  const { rx, calls } = makeReceiver({ label: 'RTC' });
  rx.begin({ mime: 'video/mp4', kind: 'video', filename: 'clip.mp4' });
  rx.push(new Uint8Array([1, 2]));
  rx.stop();
  eq(calls.stopPlayback, 1, 'la lecture doit être stoppée');
  eq(rx.state.chunks, 0);
  eq(rx.end(), null, 'plus rien à assembler après un stop');
  eq(calls.render.length, 0);
});

test('une annulation jette les morceaux déjà reçus', () => {
  const { rx, calls } = makeReceiver();
  rx.begin({ mime: 'image/png', kind: 'image', filename: 'a.png' });
  rx.push(new Uint8Array([1]));
  rx.cancel();
  eq(rx.end(), null);
  eq(calls.render.length, 0);
  eq(calls.download.length, 0);
});

test('les morceaux arrivés après une annulation sont ignorés', () => {
  const { rx } = makeReceiver();
  rx.begin({ mime: 'image/png', kind: 'image', filename: 'a.png' });
  rx.cancel();
  rx.push(new Uint8Array([1, 2, 3]));
  eq(rx.state.chunks, 0, 'aucun morceau ne doit être accumulé');
});

test('une fin sans données ne produit rien', () => {
  const { rx, calls } = makeReceiver();
  rx.begin({ mime: 'video/mp4', kind: 'video', filename: 'vide.mp4' });
  eq(rx.end(), null);
  eq(calls.render.length + calls.download.length, 0);
});

test('un nouveau transfert est possible juste après un stop', () => {
  const { rx, calls } = makeReceiver();
  rx.begin({ mime: 'video/mp4', kind: 'video', filename: 'a.mp4' });
  rx.push(new Uint8Array([1]));
  rx.stop();
  rx.begin({ mime: 'image/png', kind: 'image', filename: 'b.png' });
  rx.push(new Uint8Array([2]));
  rx.end();
  eq(calls.render.length, 1, 'le transfert suivant doit aboutir');
  eq(calls.render[0].target, 'image');
});

test('l\'URL du média précédent est libérée', () => {
  const { rx, calls } = makeReceiver();
  rx.begin({ mime: 'image/png', kind: 'image', filename: 'a.png' });
  rx.push(new Uint8Array([1]));
  const first = rx.end();
  rx.begin({ mime: 'image/png', kind: 'image', filename: 'b.png' });
  rx.push(new Uint8Array([1, 2]));
  rx.end();
  eq(calls.revoked, [first.url], 'la première URL doit être révoquée');
});

test('un transfert sans annonce préalable reste exploitable', () => {
  const { rx, calls } = makeReceiver();
  rx.push(new Uint8Array([1, 2, 3]));
  const out = rx.end();
  eq(calls.download.length, 1, 'sans type connu, on télécharge');
  eq(out.filename, 'fichier');
});

/* ------------------------------- peers ---------------------------------- */

test('le registre complète une identité sans perdre ce qu\'il savait', () => {
  const reg = createPeerRegistry();
  reg.add('p1', { ip: '', nick: '' });
  eq(reg.label('p1'), 'un pair (p1)');
  reg.upsert('p1', { ip: '90.11.22.33' });          // l'IP arrive plus tard
  eq(reg.label('p1'), '90.11.22.33');
  reg.upsert('p1', { nick: 'bob' });                 // le pseudo aussi
  eq(reg.label('p1'), '90.11.22.33 (bob)');
  reg.upsert('p1', { ip: '::1' });                   // une adresse loopback n'écrase rien
  eq(reg.label('p1'), '90.11.22.33 (bob)');
});

test('le registre notifie uniquement les changements réels', () => {
  let n = 0;
  const reg = createPeerRegistry({ onChange: () => { n++; } });
  reg.add('p1', { ip: '10.0.0.1' });
  eq(n, 1, 'ajout');
  reg.upsert('p1', { ip: '10.0.0.1' });
  eq(n, 1, 'identité identique : aucune notification');
  reg.upsert('p1', { nick: 'bob' });
  eq(n, 2, 'changement de pseudo');
  reg.remove('p1');
  eq(n, 3, 'départ');
  reg.remove('p1');
  eq(n, 3, 'départ d\'un absent : aucune notification');
});

test('add ne recrée pas un pair déjà connu', () => {
  const reg = createPeerRegistry();
  reg.add('p1', { ip: '10.0.0.1', nick: 'bob' });
  eq(reg.add('p1', { ip: '10.0.0.9' }), false);
  eq(reg.label('p1'), '10.0.0.1 (bob)');
});

test('clear vide le registre (reconnexion)', () => {
  let n = 0;
  const reg = createPeerRegistry({ onChange: () => { n++; } });
  reg.add('p1', {}); reg.add('p2', {});
  reg.clear();
  eq(reg.size, 0);
  eq(reg.labels(), []);
  const before = n;
  reg.clear();
  eq(n, before, 'vider un registre vide ne notifie pas');
});

/* ----------------------------- signal-url -------------------------------- */

test('buildWsUrl accepte les formes saisies par l\'utilisateur', () => {
  eq(buildWsUrl('wss://exemple.org'), 'wss://exemple.org');
  eq(buildWsUrl('https://exemple.org'), 'wss://exemple.org');
  eq(buildWsUrl('http://exemple.org'), 'ws://exemple.org');
  eq(buildWsUrl('192.168.1.42:8080'), 'ws://192.168.1.42:8080');
  eq(buildWsUrl('  '), null);
  eq(buildWsUrl(undefined), null);
});

test('buildWsUrl chiffre la liaison quand la page est en https', () => {
  eq(buildWsUrl('exemple.org:8080', { pageProtocol: 'https:' }), 'wss://exemple.org:8080');
});

test('la saisie utilisateur prime sur tout le reste', async () => {
  let discoverCalled = false;
  const r = await resolveSignalUrl({
    typed: 'mnmt-serv.alwaysdata.com',
    knownHost: '192.168.1.42:8080',
    discover: async () => { discoverCalled = true; return ['192.168.1.42:8080']; }
  });
  eq(r.url, 'ws://mnmt-serv.alwaysdata.com');
  eq(discoverCalled, false, 'aucune découverte ne doit être lancée');
});

test('la découverte réseau sert quand rien n\'est saisi', async () => {
  const r = await resolveSignalUrl({ discover: async () => ['192.168.1.42:8080'] });
  eq(r.url, 'ws://192.168.1.42:8080');
  eq(r.source, 'découverte');
});

test('l\'hôte mémorisé évite un nouveau balayage', async () => {
  let calls = 0;
  const r = await resolveSignalUrl({
    knownHost: '192.168.1.42:8080',
    discover: async () => { calls++; return []; }
  });
  eq(r.source, 'hôte mémorisé');
  eq(calls, 0);
});

test('l\'hôte mémorisé sert même sans découverte disponible', async () => {
  // Sinon on retombe sur 127.0.0.1 alors qu'on sait où joindre le serveur.
  const r = await resolveSignalUrl({ knownHost: '192.168.1.42:8080', discover: null });
  eq(r.url, 'ws://192.168.1.42:8080');
  eq(r.source, 'hôte mémorisé');
});

test('rescan force un nouveau balayage', async () => {
  let calls = 0;
  const r = await resolveSignalUrl({
    knownHost: '192.168.1.42:8080',
    rescan: true,
    discover: async () => { calls++; return ['192.168.1.50:8080']; }
  });
  eq(calls, 1);
  eq(r.url, 'ws://192.168.1.50:8080');
});

test('sans serveur trouvé, on retombe sur la machine locale', async () => {
  const r = await resolveSignalUrl({ discover: async () => [] });
  eq(r.url, 'ws://127.0.0.1:8080');
  eq(r.source, 'machine locale');
});

test('une découverte en échec ne fait pas échouer la résolution', async () => {
  const messages = [];
  const r = await resolveSignalUrl({
    discover: async () => { throw new Error('réseau injoignable'); },
    log: (m) => messages.push(m)
  });
  eq(r.url, 'ws://127.0.0.1:8080');
  ok(messages.some((m) => m.includes('réseau injoignable')), 'l\'échec doit être signalé');
});

test('servie en http, la page parle à son propre hôte', async () => {
  const r = await resolveSignalUrl({ pageProtocol: 'http:', pageHost: 'monserveur:3000' });
  eq(r.url, 'ws://monserveur:3000');
});

test('aucune adresse de repli n\'est codée en dur', async () => {
  const r = await resolveSignalUrl({ localPort: 9999, discover: async () => [] });
  ok(!r.url.includes('192.168.1.16'), 'ancienne IP en dur détectée : ' + r.url);
  eq(r.url, 'ws://127.0.0.1:9999');
});

for (const { name, fn } of cases) {
  try {
    await fn();
    results.push(true);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} tests passés.`);
process.exit(failed ? 1 : 0);
