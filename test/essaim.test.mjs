// test/essaim.test.mjs
// Moteur d'essaim (src/renderer/essaim.js) sur un faux réseau en mémoire :
// des canaux avec débit, latence et tampon, qu'on peut couper en cours de route.
//   npm run test:essaim

import {
  createEssaim, encoderPiece, decoderPiece, enPlages, dePlages, TAILLE_PIECE, RELAYER, SIMPLE
} from '../src/renderer/essaim.js';
import { createFluxLecture, lirePlage, entetesReponse } from '../src/renderer/flux-lecture.js';

const cases = [];
const results = [];
function test(name, fn) { cases.push({ name, fn }); }
function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || ''} — attendu ${y}, reçu ${x}`);
}
function ok(c, msg) { if (!c) throw new Error(msg || 'assertion échouée'); }
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------ */
/* Faux réseau                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Un canal par sens et par paire reliée. `debit` en octets par milliseconde :
 * les messages partent l'un après l'autre, comme sur un vrai canal ordonné.
 */
function reseau({ debit = 256 * 1024, latence = 1 } = {}) {
  const noeuds = new Map();
  const canaux = new Map();    // "a>b" -> { tampon, libreA, ouvert }
  const cle = (a, b) => `${a}>${b}`;

  function noeud(id, opts = {}) {
    const n = { id, recus: [], complets: [], abandons: [], annonces: [] };
    n.essaim = createEssaim({
      moi: () => id,
      ouvert: (vers) => !!canaux.get(cle(id, vers))?.ouvert,
      tampon: (vers) => canaux.get(cle(id, vers))?.tampon ?? Infinity,
      envoyer: (vers, donnees) => envoyer(id, vers, donnees),
      surAnnonce: (t) => { n.annonces.push(t.num); return opts.refuser ? false : true; },
      surComplet: (t, blob) => n.complets.push({ t, blob }),
      surAbandon: (t, raison) => n.abandons.push(raison),
      topMs: 15,
      delaiDemande: 300
    });
    noeuds.set(id, n);
    return n;
  }

  function relier(a, b) {
    for (const [x, y] of [[a, b], [b, a]]) canaux.set(cle(x, y), { tampon: 0, libre: 0, ouvert: true });
  }

  function couper(a, b) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const c = canaux.get(cle(x, y));
      if (c) c.ouvert = false;
    }
    noeuds.get(a)?.essaim.voisinParti(b);
    noeuds.get(b)?.essaim.voisinParti(a);
  }

  /** Coupe un nœud de tout le monde (départ). */
  function partir(id) {
    for (const k of canaux.keys()) {
      const [x, y] = k.split('>');
      if (x === id) couper(x, y);
    }
  }

  function envoyer(de, vers, donnees) {
    const c = canaux.get(cle(de, vers));
    if (!c?.ouvert) return false;
    const taille = typeof donnees === 'string' ? donnees.length : donnees.byteLength;
    c.tampon += taille;
    const depart = Math.max(performance.now(), c.libre);
    c.libre = depart + taille / debit;
    const delai = c.libre - performance.now() + latence;
    setTimeout(() => {
      c.tampon -= taille;
      if (!c.ouvert) return;
      noeuds.get(vers)?.essaim.recevoir(de, donnees);
      // « bufferedamountlow »
      if (c.tampon < 256 * 1024) noeuds.get(de)?.essaim.pomper(vers);
    }, Math.max(0, delai));
    return true;
  }

  return { noeud, relier, couper, partir, noeuds };
}

function relierTous(r, ids) {
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) r.relier(ids[i], ids[j]);
}

function fichier(taille, graine = 7) {
  const octets = new Uint8Array(taille);
  let x = graine;
  for (let i = 0; i < taille; i++) { x = (x * 1103515245 + 12345) >>> 0; octets[i] = x >>> 24; }
  return new Blob([octets], { type: 'video/mp4' });
}

async function memesOctets(a, b) {
  const [x, y] = [new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer())];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

async function attendre(cond, ms = 8000, label = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`${label} jamais atteinte en ${ms} ms`);
    await pause(10);
  }
}

const meta = { nom: 'film.mp4', mime: 'video/mp4', kind: 'video' };

/* ------------------------------------------------------------------------ */

console.log('\nEssaim\n');

test('les morceaux et les plages se codent et se décodent', () => {
  const p = decoderPiece(encoderPiece(RELAYER, 0xdeadbeef, 70000, new Uint8Array([1, 2, 3]).buffer));
  eq([p.type, p.num, p.index, [...new Uint8Array(p.donnees)]], [RELAYER, 0xdeadbeef, 70000, [1, 2, 3]]);
  eq(decoderPiece(new Uint8Array([1, 2, 3]).buffer), null, 'trop court');
  eq(decoderPiece(new ArrayBuffer(12)), null, 'mauvais octet magique');
  const possede = new Uint8Array([1, 1, 0, 1, 0, 0, 1, 1, 1]);
  eq(enPlages(possede), [[0, 1], [3, 3], [6, 8]]);
  eq([...dePlages(enPlages(possede), 9)], [...possede]);
  eq([...dePlages([[-5, 2], [7, 999], ['x', 'y'], null], 9)], [1, 1, 1, 0, 0, 0, 0, 1, 1],
    'des plages hors bornes ou farfelues sont bornées, jamais crues');
});

test('à deux : le récepteur a le fichier exact, l’émetteur l’envoie une fois', async () => {
  const r = reseau();
  const a = r.noeud('a'), b = r.noeud('b');
  r.relier('a', 'b');
  const f = fichier(20 * TAILLE_PIECE + 123);
  a.essaim.partager(f, meta, ['b']);
  await attendre(() => b.complets.length, 8000, 'fichier complet');
  ok(await memesOctets(b.complets[0].blob, f), 'octets identiques');
  eq(b.complets[0].blob.type, 'video/mp4');
  ok(a.essaim.stats.octetsEnvoyes <= f.size * 1.05, `envoyé ${a.essaim.stats.octetsEnvoyes} pour ${f.size}`);
});

test('à cinq en maillage complet : chacun a tout, l’émetteur n’envoie qu’environ une copie', async () => {
  const r = reseau();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const n = Object.fromEntries(ids.map((id) => [id, r.noeud(id)]));
  relierTous(r, ids);
  const f = fichier(64 * TAILLE_PIECE);
  n.a.essaim.partager(f, meta, ['b', 'c', 'd', 'e']);
  await attendre(() => ['b', 'c', 'd', 'e'].every((id) => n[id].complets.length), 15000, 'tous complets');
  for (const id of ['b', 'c', 'd', 'e']) ok(await memesOctets(n[id].complets[0].blob, f), `octets de ${id}`);
  const source = n.a.essaim.stats.octetsEnvoyes / f.size;
  ok(source < 1.5, `l’émetteur a envoyé ${source.toFixed(2)} copies (sans essaim : 4)`);
  const doublons = ids.reduce((s, id) => s + n[id].essaim.stats.doublons, 0);
  ok(doublons < 64, `${doublons} morceaux reçus en double`);
});

test('un lien manquant entre deux récepteurs : l’essaim le contourne', async () => {
  const r = reseau();
  const ids = ['a', 'b', 'c', 'd'];
  const n = Object.fromEntries(ids.map((id) => [id, r.noeud(id)]));
  relierTous(r, ids);
  r.couper('c', 'd');   // deux pairs en 4G, derrière des NAT symétriques
  const f = fichier(40 * TAILLE_PIECE);
  n.a.essaim.partager(f, meta, ['b', 'c', 'd']);
  await attendre(() => ['b', 'c', 'd'].every((id) => n[id].complets.length), 15000, 'tous complets');
  for (const id of ['b', 'c', 'd']) ok(await memesOctets(n[id].complets[0].blob, f), `octets de ${id}`);
});

test('un récepteur part en cours de route : les autres finissent quand même', async () => {
  const r = reseau({ debit: 64 * 1024 });
  const ids = ['a', 'b', 'c', 'd'];
  const n = Object.fromEntries(ids.map((id) => [id, r.noeud(id)]));
  relierTous(r, ids);
  const f = fichier(60 * TAILLE_PIECE);
  n.a.essaim.partager(f, meta, ['b', 'c', 'd']);
  await attendre(() => (n.c.essaim.transferts()[0]?.nbRecus || 0) > 15, 8000, 'transfert entamé');
  r.partir('b');
  await attendre(() => n.c.complets.length && n.d.complets.length, 20000, 'c et d complets');
  ok(await memesOctets(n.c.complets[0].blob, f) && await memesOctets(n.d.complets[0].blob, f), 'octets');
  eq(n.b.complets.length, 0, 'b, parti, n’a pas fini');
});

test('un pair qui arrive en cours d’envoi le reçoit en entier', async () => {
  const r = reseau({ debit: 64 * 1024 });
  const n = { a: r.noeud('a'), b: r.noeud('b'), c: r.noeud('c') };
  r.relier('a', 'b');
  const f = fichier(48 * TAILLE_PIECE);
  const t = n.a.essaim.partager(f, meta, ['b']);
  await attendre(() => t.frontiere > 20, 8000, 'poussée entamée');
  r.relier('a', 'c'); r.relier('b', 'c');
  n.a.essaim.ajouterMembre(t.num, 'c');
  await attendre(() => n.b.complets.length && n.c.complets.length, 15000, 'b et c complets');
  ok(await memesOctets(n.c.complets[0].blob, f), 'octets du retardataire');
});

test('l’émetteur annule : les récepteurs abandonnent, rien n’est affiché', async () => {
  const r = reseau({ debit: 32 * 1024 });
  const n = { a: r.noeud('a'), b: r.noeud('b'), c: r.noeud('c') };
  relierTous(r, ['a', 'b', 'c']);
  const t = n.a.essaim.partager(fichier(80 * TAILLE_PIECE), meta, ['b', 'c']);
  await attendre(() => t.frontiere > 10, 8000, 'poussée entamée');
  n.a.essaim.annuler(t.num);
  await attendre(() => n.b.abandons.length && n.c.abandons.length, 3000, 'abandons');
  eq(n.b.abandons[0], 'annulé par l’émetteur');
  await pause(200);
  eq(n.b.complets.length + n.c.complets.length, 0);
  eq(n.b.essaim.transferts().length + n.a.essaim.transferts().length, 0, 'plus rien en mémoire');
  ok(await t.termine === false, 'la poussée s’arrête');
});

test('la source part avant la fin et personne n’a le reste : abandon, avec la raison', async () => {
  const r = reseau({ debit: 32 * 1024 });
  const n = { a: r.noeud('a'), b: r.noeud('b'), c: r.noeud('c') };
  relierTous(r, ['a', 'b', 'c']);
  const t = n.a.essaim.partager(fichier(80 * TAILLE_PIECE), meta, ['b', 'c']);
  await attendre(() => t.frontiere > 10, 8000, 'poussée entamée');
  r.partir('a');
  await attendre(() => n.b.abandons.length && n.c.abandons.length, 3000, 'abandons');
  eq(n.b.abandons[0], 'la source est partie avant la fin');
});

test('un récepteur qui refuse (désactivé) n’entre pas dans l’essaim', async () => {
  const r = reseau();
  const n = { a: r.noeud('a'), b: r.noeud('b'), c: r.noeud('c', { refuser: true }) };
  relierTous(r, ['a', 'b', 'c']);
  const f = fichier(24 * TAILLE_PIECE);
  const t = n.a.essaim.partager(f, meta, ['b', 'c']);
  await attendre(() => n.b.complets.length, 8000, 'b complet');
  eq(n.c.complets.length, 0);
  eq(n.c.essaim.stats.recus, 0, 'c ne reçoit aucun morceau');
  ok(!t.membres.has('c'), 'retiré des membres');
});

test('un morceau tronqué est ignoré, puis redemandé', async () => {
  const r = reseau();
  const n = { a: r.noeud('a'), b: r.noeud('b') };
  r.relier('a', 'b');
  const f = fichier(30 * TAILLE_PIECE);
  const t = n.a.essaim.partager(f, meta, ['b']);
  // Un morceau faux, glissé avant la poussée : mauvaise taille.
  n.b.essaim.recevoir('a', encoderPiece(SIMPLE, t.num, 0, new ArrayBuffer(10)));
  await attendre(() => n.b.complets.length, 8000, 'b complet');
  ok(await memesOctets(n.b.complets[0].blob, f), 'octets exacts malgré le morceau faux');
});

test('un fichier vide passe aussi', async () => {
  const r = reseau();
  const n = { a: r.noeud('a'), b: r.noeud('b') };
  r.relier('a', 'b');
  n.a.essaim.partager(new Blob([]), { nom: 'vide.txt', mime: 'text/plain', kind: 'file' }, ['b']);
  await attendre(() => n.b.complets.length, 3000, 'b complet');
  eq(n.b.complets[0].blob.size, 0);
});

test('« stop » de l’émetteur : le récepteur oublie son transfert', async () => {
  const r = reseau({ debit: 32 * 1024 });
  const n = { a: r.noeud('a'), b: r.noeud('b') };
  r.relier('a', 'b');
  const t = n.a.essaim.partager(fichier(80 * TAILLE_PIECE), meta, ['b']);
  await attendre(() => t.frontiere > 5, 8000, 'poussée entamée');
  n.b.essaim.oublierSource('a');
  eq(n.b.essaim.transferts().length, 0);
  eq(n.b.abandons, ['stop']);
  n.a.essaim.annuler(t.num);
});

/* --------------------- lecture pendant le téléchargement ----------------- */

test('les plages HTTP du lecteur sont lues et bornées', () => {
  eq(lirePlage(null, 1000), { debut: 0, fin: 999, partielle: false }, 'sans Range : tout');
  eq(lirePlage('bytes=0-', 1000), { debut: 0, fin: 999, partielle: true });
  eq(lirePlage('bytes=900-5000', 1000), { debut: 900, fin: 999, partielle: true }, 'fin bornée');
  eq(lirePlage('bytes=-100', 1000), { debut: 900, fin: 999, partielle: true }, 'les 100 derniers');
  eq(lirePlage('bytes=1000-', 1000), null, 'au-delà du fichier');
  eq(lirePlage('bytes=5-2', 1000), null);
  eq(lirePlage('octets=0-', 1000), null, 'unité inconnue');
  const e = entetesReponse({ debut: 10, fin: 19, partielle: true }, { taille: 100, mime: 'video/mp4' });
  eq([e.status, e.headers['Content-Range'], e.headers['Content-Length']], [206, 'bytes 10-19/100', '10']);
});

/** Deux pairs, débit faible : la poussée met plusieurs secondes à tout livrer. */
function lectureLente() {
  const r = reseau({ debit: 16 * 1024 });
  const a = r.noeud('a'), b = r.noeud('b');
  r.relier('a', 'b');
  const f = fichier(120 * TAILLE_PIECE + 77);
  const t = a.essaim.partager(f, meta, ['b']);
  const lecture = createFluxLecture({ essaim: b.essaim });
  lecture.ouvrir(t.num, { taille: f.size, mime: 'video/mp4', taillePiece: TAILLE_PIECE });
  return { r, a, b, f, t, lecture };
}

test('le lecteur obtient tout de suite une plage loin devant la poussée (navigation)', async () => {
  const { a, b, f, t, lecture } = lectureLente();
  await attendre(() => b.essaim.transfert(t.num), 3000, 'annonce reçue');
  const pos = 110 * TAILLE_PIECE + 5;           // l'index d'un MP4, en fin de fichier
  const t0 = Date.now();
  const octets = await lecture.octets(t.num, pos);
  const duree = Date.now() - t0;
  ok(t.frontiere < 100, `la poussée n’y était pas encore (frontière ${t.frontiere})`);
  ok(duree < 1500, `obtenu en ${duree} ms`);
  const attendu = new Uint8Array(await f.slice(pos, 111 * TAILLE_PIECE).arrayBuffer());
  eq([...new Uint8Array(octets)].slice(0, 32), [...attendu].slice(0, 32), 'bons octets');
  eq(octets.byteLength, attendu.length, 'jusqu’à la fin du morceau');
  a.essaim.annuler(t.num);
});

test('une fois complet, le lecteur est servi depuis le fichier, même l’essaim terminé', async () => {
  const r = reseau();
  const a = r.noeud('a'), b = r.noeud('b');
  r.relier('a', 'b');
  const f = fichier(10 * TAILLE_PIECE);
  const t = a.essaim.partager(f, meta, ['b']);
  const lecture = createFluxLecture({ essaim: b.essaim });
  lecture.ouvrir(t.num, { taille: f.size, mime: 'video/mp4', taillePiece: TAILLE_PIECE });
  await attendre(() => b.complets.length, 5000, 'complet');
  lecture.terminer(t.num, b.complets[0].blob);
  await attendre(() => !b.essaim.transfert(t.num), 5000, 'essaim terminé et oublié');
  const octets = await lecture.octets(t.num, 3 * TAILLE_PIECE + 10, 3 * TAILLE_PIECE + 19);
  eq([...new Uint8Array(octets)], [...new Uint8Array(await f.slice(3 * TAILLE_PIECE + 10, 3 * TAILLE_PIECE + 20).arrayBuffer())]);
});

test('transfert abandonné pendant la lecture : le lecteur reçoit « fin », sans rester suspendu', async () => {
  const { a, b, t, lecture } = lectureLente();
  await attendre(() => b.essaim.transfert(t.num), 3000, 'annonce reçue');
  const enAttente = lecture.octets(t.num, 100 * TAILLE_PIECE);
  b.essaim.oublierSource('a');     // « stop » de l'émetteur
  eq(await enAttente, null);
  eq(await lecture.octets(t.num, 0).then((o) => o?.byteLength ?? null), null, 'plus rien à lire');
  a.essaim.annuler(t.num);
});

/* ------------------------------------------------------------------------ */

for (const c of cases) {
  try {
    await c.fn();
    results.push(true);
    console.log(`  ok   ${c.name}`);
  } catch (e) {
    results.push(false);
    console.log(`  FAIL ${c.name}\n       ${e.message}`);
  }
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} tests passés.`);
process.exit(failed ? 1 : 0);
