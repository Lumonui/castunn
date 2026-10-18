// test/unit.test.mjs
// Tests unitaires des modules du renderer (aucun DOM requis).
//   npm run test:unit

import { cleanPeerIp, formatPeerLabel, formatSelfName, pickRenderTarget, guessMimeByExt,
         isIPv4, peerAddresses, formatPeerDetail, formatPeerAltAddress }
  from '../src/renderer/protocol.js';
import { createMediaReceiver } from '../src/renderer/media-receiver.js';
import { createPeerRegistry } from '../src/renderer/peers.js';
import { etatPair, resumerMaillage } from '../src/renderer/mesh-status.js';
import { buildWsUrl, resolveSignalUrl } from '../src/renderer/signal-url.js';
import { STUN_URLS, buildIceServers, createIceQueue, describeIncoming, isPolitePeer }
  from '../src/renderer/rtc-negotiation.js';
import { describeRtcPath, formatRtcPath, describeCollectes, summarizeGathered } from '../src/renderer/rtc-stats.js';
import { sanitizeTurnServers, credentialsExpiring, turnFailureReason, explainNoRtc }
  from '../src/renderer/turn-config.js';
import { VERSION, DATE_VERSION } from '../src/renderer/version.js';
import { ALPHABET, nouveauCode, normaliserCode, formaterCode, identifiantSalle } from '../src/renderer/salle.js';
import { readFileSync } from 'node:fs';

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

/* -------------------------------- version ------------------------------- */

test('la page annonce la version de package.json (le serveur refuse toute autre)', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  eq(VERSION, version, 'src/renderer/version.js en retard : lancez « npm run version:sync »');
  ok(/^\d\d-\d\d-\d{4}$/.test(DATE_VERSION), 'date : ' + DATE_VERSION);
});

/* -------------------------------- salles -------------------------------- */

test('un code de salle : 20 caractères lisibles, en groupes, jamais deux fois le même', () => {
  const codes = Array.from({ length: 50 }, () => nouveauCode());
  ok(codes.every((c) => /^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/.test(c)), codes[0]);
  ok(codes.every((c) => ![...c.replace(/-/g, '')].some((x) => '01lo'.includes(x))), 'ni 0, 1, l, o');
  eq(new Set(codes).size, 50, 'distincts');
  eq(256 % ALPHABET.length, 0, 'tirage sans biais');
});

test('un code saisi est normalisé ; une saisie douteuse est refusée', () => {
  eq(normaliserCode(' ABCD-efgh ijkm-npqr-STUV '), 'abcdefghijkmnpqrstuv');
  eq(normaliserCode('abcd-efgh-ijkm-npqr-stu'), null, 'trop court');
  eq(normaliserCode('abcd-efgh-ijkm-npqr-stu0'), null, 'caractère ambigu');
  eq(normaliserCode(''), null);
  eq(formaterCode('abcdefghijkmnpqrstuv'), 'abcd-efgh-ijkm-npqr-stuv');
});

test('le serveur ne reçoit qu’une empreinte du code, la même pour tous ceux qui l’ont', async () => {
  const id = await identifiantSalle('abcd-efgh-ijkm-npqr-stuv');
  ok(/^[A-Za-z0-9_-]{43}$/.test(id), 'format exigé par le serveur : ' + id);
  eq(await identifiantSalle('ABCDEFGHIJKMNPQRSTUV'), id, 'même salle quelle que soit la saisie');
  ok(!id.includes('abcd'), 'le code n’y figure pas');
  ok((await identifiantSalle('abcd-efgh-ijkm-npqr-stuw')) !== id, 'un caractère de plus : autre salle');
  let erreur = null;
  try { await identifiantSalle('abcd-efgh-ijkm-npqr-stuv', null); } catch (e) { erreur = e.message; }
  ok(/non sécurisée/.test(erreur || ''), 'sans crypto.subtle (http) : erreur explicite');
});

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

/* --------------------- double adresse (IPv4 + IPv6) --------------------- */

test('isIPv4 distingue les deux familles', () => {
  ok(isIPv4('80.214.20.117'), 'IPv4 en notation pointée');
  ok(!isIPv4('2001:863:294:3d9b:a0c:ca63:d094:b080'), 'IPv6');
  ok(!isIPv4('80.214.20'), 'quatre octets exigés');
  ok(!isIPv4('80.214.20.999'), 'octets bornés à 255');
  ok(!isIPv4(''), 'chaîne vide');
});

test("l'IPv4 passe devant quand le pair est arrivé en IPv6", () => {
  const vu = { ip: '2001:863:294:3d9b:a0c:ca63:d094:b080', ipDeclared: '80.214.20.117' };
  eq(peerAddresses(vu), { principale: '80.214.20.117', secondaire: '2001:863:294:3d9b:a0c:ca63:d094:b080' });
  eq(formatPeerLabel('abc12345', { ...vu, nick: 'sir' }), '80.214.20.117 (sir)');
});

test('une seule adresse connue ne produit aucune adresse secondaire', () => {
  eq(peerAddresses({ ip: '2001:863:294:3d9b:a0c:ca63:d094:b080' }), { principale: '2001:863:294:3d9b:a0c:ca63:d094:b080', secondaire: '' });
  eq(formatPeerAltAddress({ ip: '2001:863:294:3d9b:a0c:ca63:d094:b080' }), '', 'IPv6 seule : affichée, rien au survol');
  // Derrière un reverse proxy, constatée et déclarée sont la même adresse.
  const double = { ip: '80.214.20.117', ipDeclared: '80.214.20.117' };
  eq(peerAddresses(double), { principale: '80.214.20.117', secondaire: '' });
  eq(formatPeerAltAddress(double), '', 'pas de bulle pour un doublon');
});

test("l'adresse reléguée est annoncée pour ce qu'elle est", () => {
  const vu = { ip: '2001:863:294:3d9b:a0c:ca63:d094:b080', ipDeclared: '80.214.20.117', nick: 'sir' };
  eq(formatPeerAltAddress(vu), 'IPv6 : 2001:863:294:3d9b:a0c:ca63:d094:b080');
  eq(formatPeerDetail('abc12345', vu), '80.214.20.117 (sir) · 2001:863:294:3d9b:a0c:ca63:d094:b080');
});

test('une adresse loopback ne compte pour aucune des deux', () => {
  eq(peerAddresses({ ip: '::1', ipDeclared: '80.214.20.117' }),
     { principale: '80.214.20.117', secondaire: '' });
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

test('le registre retient les deux adresses du pair', () => {
  const reg = createPeerRegistry();
  reg.add('p1', { ip: '2001:863:294:3d9b:a0c:ca63:d094:b080' });
  eq(reg.label('p1'), '2001:863:294:3d9b:a0c:ca63:d094:b080', "l'IPv6 seule reste affichée");
  reg.upsert('p1', { ipDeclared: '80.214.20.117', nick: 'sir' });
  eq(reg.label('p1'), '80.214.20.117 (sir)', "l'IPv4 déclarée prend la place");
  eq(reg.altAddress('p1'), 'IPv6 : 2001:863:294:3d9b:a0c:ca63:d094:b080');
  eq(reg.details(), ['80.214.20.117 (sir) · 2001:863:294:3d9b:a0c:ca63:d094:b080']);
});

test("altAddress d'un pair inconnu ne lève pas", () => {
  const reg = createPeerRegistry();
  eq(reg.altAddress('fantome'), '');
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

/* --------------------------- rtc-negotiation ----------------------------- */

test('le plus grand identifiant mène la négociation', () => {
  ok(isPolitePeer('aaa', 'zzz'), 'le plus petit cède');
  ok(!isPolitePeer('zzz', 'aaa'), 'le plus grand garde la main');
  ok(isPolitePeer(null, 'zzz'), 'sans identifiant local, on cède');
  ok(isPolitePeer('aaa', null), 'sans identifiant distant, on cède');
});

test('une offre reçue au repos est toujours acceptée', () => {
  const au = (o) => describeIncoming({ type: 'offer', signalingState: 'stable', ...o });
  eq(au({ polite: true }),  { collision: false, ignore: false, rollback: false });
  eq(au({ polite: false }), { collision: false, ignore: false, rollback: false });
});

test("une collision d'offres se règle sans fermer la connexion", () => {
  // Collision : on a une offre en vol et il en arrive une autre.
  const enVol = { type: 'offer', makingOffer: true, signalingState: 'have-local-offer' };
  const poli   = describeIncoming({ ...enVol, polite: true });
  const impoli = describeIncoming({ ...enVol, polite: false });

  ok(poli.collision && impoli.collision, 'les deux constatent la collision');
  ok(poli.rollback && !poli.ignore, 'le poli recule et accepte');
  ok(impoli.ignore && !impoli.rollback, 'l’impoli ignore et poursuit');
});

test('une réponse en cours de pose ne bloque pas une offre', () => {
  const d = describeIncoming({
    type: 'offer', polite: false,
    signalingState: 'have-local-offer', settingRemoteAnswer: true
  });
  ok(!d.collision, 'l’état transitoire ne compte pas comme une collision');
});

test('une réponse n’est jamais traitée comme une collision', () => {
  const d = describeIncoming({
    type: 'answer', polite: false, makingOffer: true, signalingState: 'have-local-offer'
  });
  eq(d, { collision: false, ignore: false, rollback: false });
});

test('les candidats ICE arrivés trop tôt sont rendus une seule fois', () => {
  const file = createIceQueue();
  ok(file.push({ candidate: 'a' }), 'rangé');
  ok(file.push({ candidate: 'b' }), 'rangé');
  eq(file.size, 2);
  eq(file.take(), [{ candidate: 'a' }, { candidate: 'b' }]);
  eq(file.size, 0, 'la file se vide en rendant son contenu');
  eq(file.take(), [], 'et ne rend pas deux fois la même chose');
});

test('la file de candidats ne grossit pas sans fin', () => {
  const file = createIceQueue({ max: 2 });
  ok(file.push({ candidate: 'a' }));
  ok(file.push({ candidate: 'b' }));
  ok(!file.push({ candidate: 'c' }), 'au-delà du plafond, on le signale');
  eq(file.size, 2);
  file.clear();
  eq(file.size, 0);
  ok(!file.push(null), 'un candidat vide n’est pas rangé');
});

test('la configuration ICE porte deux STUN indépendants', () => {
  const servers = buildIceServers();
  eq(servers[0].urls.length, 2, 'deux STUN');
  ok(STUN_URLS.every((u) => u.startsWith('stun:')), 'des STUN, pas autre chose');
  ok(!/google/.test(STUN_URLS[1]), 'le second est indépendant du premier');

  const avecTurn = buildIceServers([{ urls: 'turn:exemple:3478', username: 'u', credential: 'c' }]);
  eq(avecTurn.length, 2, 'le point d’entrée TURN est prêt');
  eq(avecTurn[1].urls, 'turn:exemple:3478');
  eq(buildIceServers(null).length, 1, 'une valeur absente ne casse rien');
});

/* ------------------------------ rtc-stats -------------------------------- */

// Rapport getStats minimal : une paire retenue entre deux candidats.
function rapport({ local, distant, viaTransport = true, autres = [] }) {
  return [
    ...(viaTransport ? [{ id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1' }] : []),
    { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1',
      nominated: true, state: 'succeeded' },
    { id: 'L1', type: 'local-candidate', protocol: 'udp', ...local },
    { id: 'R1', type: 'remote-candidate', ...distant },
    ...autres
  ];
}

test('un chemin direct n’est pas dégradé', () => {
  const c = describeRtcPath(rapport({
    local: { candidateType: 'srflx', port: 26103, address: '83.194.1.2' },
    distant: { candidateType: 'prflx' }
  }));
  eq([c.trouve, c.relaye, c.port], [true, false, 26103]);
  eq(formatRtcPath(c), 'srflx ↔ prflx (UDP), port local 26103');
});

test('un relais d’un côté ou de l’autre rend la connexion dégradée', () => {
  ok(describeRtcPath(rapport({ local: { candidateType: 'relay' }, distant: { candidateType: 'host' } })).relaye);
  ok(describeRtcPath(rapport({ local: { candidateType: 'host' }, distant: { candidateType: 'relay' } })).relaye);
});

test('sans champ transport, la paire nominée sert de repli', () => {
  const c = describeRtcPath(rapport({ viaTransport: false,
    local: { candidateType: 'host' }, distant: { candidateType: 'host' } }));
  eq([c.trouve, c.typeLocal], [true, 'host']);
  eq(describeRtcPath([]).trouve, false, 'rapport vide');
  eq(describeRtcPath(null).trouve, false, 'pas de rapport du tout');
});

test('les candidats collectés révèlent l’absence de STUN et d’IPv6', () => {
  const c = describeRtcPath(rapport({
    local: { candidateType: 'host', address: '192.168.1.16' },
    distant: { candidateType: 'host' },
    autres: [{ id: 'L2', type: 'local-candidate', candidateType: 'host', address: '10.0.0.4' }]
  }));
  eq(describeCollectes(c), 'host — aucune adresse publique obtenue par STUN, pas d’IPv6');

  const v6 = describeRtcPath(rapport({
    local: { candidateType: 'host', address: '2001:db8::1' },
    distant: { candidateType: 'host' },
    autres: [{ id: 'L2', type: 'local-candidate', candidateType: 'srflx', address: '83.194.1.2' }]
  }));
  eq(describeCollectes(v6), 'host, srflx', 'rien à signaler');

  const mdns = describeRtcPath(rapport({ local: { candidateType: 'host', address: 'a1b2.local' },
    distant: { candidateType: 'host' } }));
  eq(mdns.ipv6, null, 'adresse masquée par mDNS : on ne conclut rien');
});

test('la collecte se lit dans les candidats émis, pas dans getStats', () => {
  const s = summarizeGathered([
    { type: 'host', address: '192.168.1.16' }, { type: 'srflx', address: '83.194.1.2' },
    { type: 'relay', address: '51.15.0.9' }, { type: 'host', address: '2001:db8::1' }
  ]);
  eq(s, { collectes: ['host', 'srflx', 'relay'], ipv6: true });
  eq(summarizeGathered([{ type: 'host', address: 'x.local' }]).ipv6, null, 'mDNS : on ne conclut rien');
  eq(summarizeGathered().collectes, [], 'rien de collecté');
});

test('une collecte écourtée par une connexion directe n’accuse pas STUN', () => {
  const seulHost = { collectes: ['host'], ipv6: false };
  eq(describeCollectes(seulHost, { ecourtee: true }), 'host (collecte arrêtée : connexion directe déjà établie)');
  eq(describeCollectes(seulHost, { complete: false }), 'host (collecte inachevée après 10 s)');
  ok(describeCollectes(seulHost).includes('aucune adresse publique'), 'collecte complète sans direct : là, c’est un vrai signal');
});

/* ------------------------------ turn-config ------------------------------ */

test('seules les entrées TURN bien formées sont gardées', () => {
  const bon = { urls: ['turn:r.test:3478?transport=udp', 'turns:r.test:443?transport=tcp'], username: '1:a', credential: 'c' };
  eq(sanitizeTurnServers([bon]), [bon]);
  eq(sanitizeTurnServers([{ ...bon, urls: 'turn:seul.test:3478' }])[0].urls, ['turn:seul.test:3478'], 'URL seule acceptée');
  eq(sanitizeTurnServers([{ ...bon, urls: ['http://x.test', 'turn:ok.test'] }])[0].urls, ['turn:ok.test'], 'URL non TURN écartée');
  eq(sanitizeTurnServers([{ urls: 'turn:x.test' }]), [], 'sans identifiants : refusé par tout relais');
  eq(sanitizeTurnServers([{ ...bon, urls: ['stun:s.test'] }]), [], 'un STUN n’est pas un relais');
  eq(sanitizeTurnServers([null, 42, 'turn:x']), [], 'déchets ignorés');
  eq(sanitizeTurnServers(undefined), [], 'champ absent : aucun relais');
});

test('les identifiants sont renouvelés un peu avant leur échéance', () => {
  const maintenant = 1_000_000_000_000;
  ok(!credentialsExpiring(maintenant + 3600e3, maintenant), 'une heure devant soi');
  ok(credentialsExpiring(maintenant + 60e3, maintenant), 'une minute : trop juste pour négocier');
  ok(credentialsExpiring(maintenant - 1, maintenant), 'déjà expirés');
  ok(!credentialsExpiring(null, maintenant), 'échéance inconnue : rien à renouveler');
});

test('l’absence de P2P est expliquée selon le relais et les pairs', () => {
  eq(explainNoRtc({ pairPresent: false, turnAnnonce: true, turnJoignable: true }), 'aucun pair dans la room',
    'sans pair, le relais est hors sujet');
  ok(explainNoRtc({ turnAnnonce: false }).startsWith('aucun relais TURN proposé'));
  ok(explainNoRtc({ turnAnnonce: true, turnJoignable: false }).includes('injoignable'));
  ok(explainNoRtc({ turnAnnonce: true, turnJoignable: true }).startsWith('un relais TURN était pourtant disponible'));
  ok(explainNoRtc({ turnAnnonce: true }).includes('vérification en cours'), 'sonde pas encore finie');
});

test('l’échec d’un relais est expliqué', () => {
  ok(turnFailureReason([{ code: 701 }, { code: 401, texte: 'Unauthorized' }]).startsWith('identifiants refusés (401)'));
  eq(turnFailureReason([{ code: 701, texte: 'STUN host lookup received error.' }]), 'serveur injoignable (701)');
  eq(turnFailureReason([{ texte: 'boum' }]), 'boum');
  eq(turnFailureReason([]), 'aucun candidat relais en 3 s');
});

/* ----------------------------- mesh-status -------------------------------- */

const DIRECT = { trouve: true, typeLocal: 'host', typeDistant: 'srflx', protocole: 'UDP', port: 26100, relaye: false };
const RELAIS = { trouve: true, typeLocal: 'relay', typeDistant: 'relay', protocole: 'UDP', port: 26101, relaye: true };
const pair = (label, lien) => ({ label, lien });

test('l’état d’un pair : direct, relais, connexion en cours ou WebSocket', () => {
  eq(etatPair({ ouvert: true, chemin: DIRECT }), 'direct');
  eq(etatPair({ ouvert: true, chemin: RELAIS }), 'relais');
  eq(etatPair({ ouvert: true }), 'direct', 'ouvert, chemin pas encore lu');
  eq(etatPair({ ouvert: false, connectionState: 'connecting' }), 'connexion');
  eq(etatPair({ ouvert: false, connectionState: 'failed' }), 'websocket');
  eq(etatPair(null), 'websocket', 'aucun lien : servi par le WebSocket');
});

test('à deux, la pastille parle comme avant', () => {
  eq(resumerMaillage([]), { texte: 'Déconnecté', classe: 'ko', titre: '' });
  const direct = resumerMaillage([pair('bob', { ouvert: true, chemin: DIRECT })]);
  eq([direct.texte, direct.classe], ['Connecté', 'ok']);
  ok(direct.titre.startsWith('Connexion directe :'), direct.titre);
  const relais = resumerMaillage([pair('bob', { ouvert: true, chemin: RELAIS })]);
  eq([relais.texte, relais.classe], ['Connecté (dégradé)', 'warn']);
  ok(relais.titre.startsWith('Relayé par un serveur TURN'), relais.titre);
  eq(resumerMaillage([pair('bob', { ouvert: false, connectionState: 'checking' })]).texte, 'Connexion...');
  eq(resumerMaillage([pair('bob', null)]).texte, 'Déconnecté');
});

test('à partir de trois, la pastille compte les liens et détaille chaque pair', () => {
  const tous = resumerMaillage([pair('bob', { ouvert: true, chemin: DIRECT }), pair('carol', { ouvert: true, chemin: DIRECT })]);
  eq([tous.texte, tous.classe], ['2/2', 'ok']);
  eq(tous.titre.split('\n').length, 2);
  ok(/^bob : direct \(host ↔ srflx/.test(tous.titre), tous.titre);

  const mixte = resumerMaillage([pair('bob', { ouvert: true, chemin: DIRECT }), pair('carol', null)]);
  eq([mixte.texte, mixte.classe], ['1/2', 'warn']);
  ok(mixte.titre.includes('carol : WebSocket (pas de P2P)'), mixte.titre);

  const relaye = resumerMaillage([pair('bob', { ouvert: true, chemin: RELAIS }), pair('carol', { ouvert: true, chemin: DIRECT })]);
  eq([relaye.texte, relaye.classe], ['2/2 (dégradé)', 'warn'], 'un relais suffit à passer en orangé');

  const aucun = resumerMaillage([pair('bob', null), pair('carol', { ouvert: false, connectionState: 'new' })]);
  eq([aucun.texte, aucun.classe], ['0/2', 'ko']);
  ok(aucun.titre.includes('carol : connexion…'), aucun.titre);
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
