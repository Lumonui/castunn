// src/renderer/essaim.js
// Essaim maison : un fichier circule entre les pairs du maillage, morceau par
// morceau, chacun redistribuant ce qu'il a reçu — le principe du torrent, sur
// les liens P2P existants (un canal « essaim » par lien), sans nouveau réseau.
//
// Pourquoi : en maillage, l'émetteur envoyait une copie entière à chaque pair.
// À cinq, il envoyait quatre fois le fichier ; ici, environ une fois, quel que
// soit le nombre de récepteurs.
//
// Deux mécanismes :
//  - la POUSSÉE : la source envoie chaque morceau, dans l'ordre, à UN membre
//    (à tour de rôle, en sautant ceux dont le canal est plein). Ce membre le
//    relaie aussitôt aux autres membres qui ne l'ont pas. Une seule copie par
//    morceau sort de la source.
//  - la DEMANDE : chacun publie ce qu'il possède ; un morceau qui manque alors
//    que la poussée l'a dépassé (lien absent entre deux membres, relais lent,
//    membre parti, arrivée tardive) est demandé à un voisin qui l'a, la source
//    en dernier recours. L'essaim contourne ainsi les liens manquants.
//
// Seuls les voisins P2P de la source participent : les autres pairs sont
// servis par le WebSocket, par l'ancien chemin. Aucune dépendance au DOM ni au
// réseau : tout est injecté, pour être testé sans navigateur.

/** Taille d'un morceau : un message de canal de données (Chromium accepte 256 Kio). */
export const TAILLE_PIECE = 64 * 1024;

// En-tête des morceaux binaires : [0xE5, type, numéro de transfert (4), indice (4)].
const MAGIQUE = 0xE5;
const ENTETE = 10;
export const RELAYER = 1;   // poussé par la source : à relayer aux autres membres
export const SIMPLE = 2;    // relais ou réponse à une demande : à garder pour soi

// Canal plein au-delà d'1 Mio en attente : on cesse d'y ajouter.
const TAMPON_HAUT = 1024 * 1024;
// File de relais par voisin : au-delà, on ne relaie plus (il demandera).
const FILE_RELAIS_MAX = 48;
// Un morceau dépassé de tant par la poussée et toujours absent : on le demande.
const RETARD_VOISIN = 16;
const RETARD_SOURCE = 64;
const DEMANDES_PAR_VOISIN = 16;
const DELAI_DEMANDE_MS = 4000;
const TOP_MS = 250;

/* ------------------------------------------------------------------------ */
/* Codage                                                                    */
/* ------------------------------------------------------------------------ */

export function encoderPiece(type, num, index, donnees) {
  const corps = new Uint8Array(donnees);
  const sortie = new Uint8Array(ENTETE + corps.byteLength);
  const v = new DataView(sortie.buffer);
  v.setUint8(0, MAGIQUE);
  v.setUint8(1, type);
  v.setUint32(2, num >>> 0);
  v.setUint32(6, index >>> 0);
  sortie.set(corps, ENTETE);
  return sortie.buffer;
}

export function decoderPiece(tampon) {
  if (!(tampon instanceof ArrayBuffer) || tampon.byteLength < ENTETE) return null;
  const v = new DataView(tampon);
  if (v.getUint8(0) !== MAGIQUE) return null;
  return {
    type: v.getUint8(1),
    num: v.getUint32(2),
    index: v.getUint32(6),
    donnees: tampon.slice(ENTETE)
  };
}

/** Indices possédés (tableau d'octets 0/1) -> plages [début, fin] incluses. */
export function enPlages(possede) {
  const plages = [];
  let debut = -1;
  for (let i = 0; i <= possede.length; i++) {
    const a = i < possede.length && possede[i];
    if (a && debut < 0) debut = i;
    else if (!a && debut >= 0) { plages.push([debut, i - 1]); debut = -1; }
  }
  return plages;
}

/** Plages reçues d'un pair -> tableau d'octets ; bornées, jamais crues sur parole. */
export function dePlages(plages, n) {
  const possede = new Uint8Array(n);
  for (const p of Array.isArray(plages) ? plages : []) {
    const a = Math.max(0, Number(p?.[0]) | 0);
    const b = Math.min(n - 1, Number(p?.[1]) | 0);
    for (let i = a; i <= b; i++) possede[i] = 1;
  }
  return possede;
}

/* ------------------------------------------------------------------------ */
/* Moteur                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * @param {object} deps
 * @param {() => string} deps.moi
 * @param {(id:string, donnees:string|ArrayBuffer) => boolean} deps.envoyer  sur le canal essaim du pair
 * @param {(id:string) => number} deps.tampon       octets en attente sur ce canal (Infinity si fermé)
 * @param {(id:string) => boolean} deps.ouvert      canal essaim ouvert avec ce pair ?
 * @param {(t:object) => void} [deps.surAnnonce]    un transfert commence (pair) ; renvoyer false pour refuser
 * @param {(t:object, blob:Blob) => void} [deps.surComplet]
 * @param {(t:object, raison:string) => void} [deps.surAbandon]
 * @param {(t:object) => void} [deps.surProgres]
 */
export function createEssaim(deps = {}) {
  const {
    moi = () => '',
    envoyer = () => false,
    tampon = () => Infinity,
    ouvert = () => false,
    surAnnonce = () => true,
    surComplet = () => {},
    surAbandon = () => {},
    surProgres = () => {},
    log = () => {},
    taillePiece = TAILLE_PIECE,
    topMs = TOP_MS,
    delaiDemande = DELAI_DEMANDE_MS,
    maintenant = () => Date.now()
  } = deps;

  const transferts = new Map();   // num -> transfert
  const files = new Map();        // voisin -> [{ type, num, index }]
  const pompes = new Set();       // voisins dont la pompe tourne
  const attentes = new Set();     // résolveurs de la boucle de poussée
  let minuteur = null;
  const stats = { envoyes: 0, octetsEnvoyes: 0, recus: 0, doublons: 0 };

  const json = (id, msg) => envoyer(id, JSON.stringify(msg));

  function demarrerTop() {
    if (!minuteur) {
      minuteur = setInterval(top, topMs);
      minuteur.unref?.();
    }
  }
  function arreterTopSiInutile() {
    if (minuteur && !transferts.size) { clearInterval(minuteur); minuteur = null; }
  }

  /** Les autres participants d'un transfert : la source et les membres, sauf nous. */
  function voisinsDe(t) {
    const ids = new Set(t.membres);
    ids.add(t.source);
    ids.delete(moi());
    return [...ids].filter((id) => ouvert(id));
  }

  function reveiller() {
    for (const r of [...attentes]) r();
    attentes.clear();
  }

  /* --- Envoi : une file et une pompe par voisin --------------------------- */

  function fileDe(id) {
    let f = files.get(id);
    if (!f) { f = []; files.set(id, f); }
    return f;
  }

  async function donneesPiece(t, index) {
    if (t.pieces?.[index]) return t.pieces[index];
    const source = t.fichier || t.blob;
    if (!source) return null;
    const debut = index * t.taillePiece;
    return source.slice(debut, Math.min(debut + t.taillePiece, t.taille)).arrayBuffer();
  }

  async function pomper(id) {
    if (pompes.has(id)) return;
    pompes.add(id);
    try {
      const f = fileDe(id);
      while (f.length && ouvert(id) && tampon(id) < TAMPON_HAUT) {
        const job = f.shift();
        const t = transferts.get(job.num);
        if (!t || t.annule) continue;
        const donnees = await donneesPiece(t, job.index);
        if (!donnees || !transferts.has(job.num)) continue;
        if (envoyer(id, encoderPiece(job.type, job.num, job.index, donnees))) {
          stats.envoyes++;
          stats.octetsEnvoyes += donnees.byteLength;
        }
      }
    } finally {
      pompes.delete(id);
      reveiller();
    }
  }

  function enfiler(id, job, { max = Infinity } = {}) {
    const f = fileDe(id);
    if (f.length >= max) return false;
    if (f.some((j) => j.num === job.num && j.index === job.index)) return true;
    f.push(job);
    pomper(id);
    return true;
  }

  /* --- Source ------------------------------------------------------------- */

  /**
   * Partage un fichier avec `membres` (voisins P2P qui savent faire l'essaim).
   * Renvoie le transfert ; `t.termine` se résout quand la poussée est finie.
   */
  function partager(fichier, meta, membres) {
    let num;
    do { num = (Math.random() * 0xffffffff) >>> 0; } while (!num || transferts.has(num));
    const n = Math.max(1, Math.ceil(fichier.size / taillePiece));
    const t = {
      num, source: moi(), role: 'source',
      nom: meta.nom || 'fichier', taille: fichier.size, mime: meta.mime || '', kind: meta.kind || 'file',
      n, taillePiece, fichier,
      membres: new Set(membres.filter((id) => id !== moi())),
      possedeDe: new Map(), complets: new Set(),
      frontiere: 0, annule: false, pousses: 0
    };
    transferts.set(num, t);
    for (const id of t.membres) annoncer(t, id);
    demarrerTop();
    t.termine = pousser(t);
    return t;
  }

  function annoncer(t, id) {
    json(id, {
      t: 'annonce', num: t.num, nom: t.nom, taille: t.taille, mime: t.mime, kind: t.kind,
      n: t.n, piece: t.taillePiece, membres: [...t.membres], frontiere: t.frontiere
    });
  }

  /** Un membre de plus en cours de route (lien ouvert pendant l'envoi). */
  function ajouterMembre(num, id) {
    const t = transferts.get(num);
    if (!t || t.role !== 'source' || t.annule || t.membres.has(id) || id === moi()) return;
    t.membres.add(id);
    annoncer(t, id);
    const msg = { t: 'membres', num: t.num, membres: [...t.membres] };
    for (const m of t.membres) if (m !== id) json(m, msg);
  }

  let tourDeRole = 0;
  function choisirCible(t) {
    const membres = [...t.membres].filter((id) => ouvert(id) && !t.complets.has(id));
    if (!membres.length) return { aucun: true };
    for (let k = 0; k < membres.length; k++) {
      const id = membres[(tourDeRole + k) % membres.length];
      if (!fileDe(id).length && tampon(id) < TAMPON_HAUT) {
        tourDeRole = (tourDeRole + k + 1) % membres.length;
        return { id };
      }
    }
    return {};
  }

  async function pousser(t) {
    while (t.frontiere < t.n && !t.annule) {
      const { id, aucun } = choisirCible(t);
      if (aucun) break;                       // plus personne à servir
      if (!id) {                              // tous occupés : on attend qu'un canal se vide
        await new Promise((r) => { attentes.add(r); setTimeout(r, 50); });
        continue;
      }
      enfiler(id, { type: RELAYER, num: t.num, index: t.frontiere });
      t.frontiere++;
      t.pousses++;
      if (t.frontiere % 16 === 0) surProgres(t);
    }
    surProgres(t);
    return !t.annule && t.frontiere >= t.n;
  }

  /* --- Membre ------------------------------------------------------------- */

  function recevoirAnnonce(de, m) {
    if (transferts.has(m.num) || !(m.n > 0) || !(m.piece > 0)) return;
    const t = {
      num: m.num, source: de, role: 'pair',
      nom: String(m.nom || 'fichier'), taille: Number(m.taille) || 0, mime: String(m.mime || ''),
      kind: String(m.kind || 'file'),
      n: m.n | 0, taillePiece: m.piece | 0,
      membres: new Set(Array.isArray(m.membres) ? m.membres : []),
      possedeDe: new Map(), complets: new Set(),
      pieces: new Array(m.n | 0), possede: new Uint8Array(m.n | 0), nbRecus: 0,
      frontiere: Number(m.frontiere) || 0, demandes: new Map(),
      annule: false, complet: false, publie: -1
    };
    if (t.n !== Math.ceil(t.taille / t.taillePiece) && !(t.taille === 0 && t.n === 1)) return;
    if (surAnnonce(t) === false) { json(de, { t: 'refus', num: t.num }); return; }
    transferts.set(t.num, t);
    demarrerTop();
    publier(t, { force: true });
  }

  function stocker(t, index, donnees, type, de) {
    if (index >= t.n) return;
    if (t.possede[index]) { stats.doublons++; return; }
    const attendu = index === t.n - 1 ? t.taille - index * t.taillePiece : t.taillePiece;
    if (donnees.byteLength !== attendu) return;   // morceau tronqué : on l'ignore, il sera redemandé
    t.pieces[index] = donnees;
    t.possede[index] = 1;
    t.nbRecus++;
    stats.recus++;
    t.demandes.delete(index);
    // La source pousse dans l'ordre : un morceau vu, d'où qu'il vienne, prouve
    // qu'elle est passée par là.
    if (index >= t.frontiere) t.frontiere = index + 1;

    // Poussé par la source : on relaie aux autres membres qui ne l'ont pas.
    if (type === RELAYER && de === t.source) {
      for (const id of voisinsDe(t)) {
        if (id === t.source || t.possedeDe.get(id)?.[index]) continue;
        enfiler(id, { type: SIMPLE, num: t.num, index }, { max: FILE_RELAIS_MAX });
      }
    }
    if (t.nbRecus % 16 === 0) surProgres(t);
    if (t.nbRecus === t.n) terminer(t);
  }

  function terminer(t) {
    t.complet = true;
    t.blob = new Blob(t.pieces, { type: t.mime || 'application/octet-stream' });
    t.pieces = null;               // on sert désormais depuis le blob
    publier(t, { force: true });
    surProgres(t);
    surComplet(t, t.blob);
  }

  /** Ce qu'on possède, à tous les participants, quand ça a changé. */
  function publier(t, { force = false } = {}) {
    if (t.role !== 'pair') return;
    if (!force && t.publie === t.nbRecus) return;
    t.publie = t.nbRecus;
    const msg = t.complet
      ? { t: 'possede', num: t.num, complet: true }
      : { t: 'possede', num: t.num, plages: enPlages(t.possede) };
    for (const id of voisinsDe(t)) json(id, msg);
  }

  /** Demande ce qui manque et que la poussée a dépassé. */
  function demander(t) {
    if (t.complet || t.annule) return;
    const now = maintenant();
    for (const [i, d] of t.demandes) if (now - d.t > delaiDemande) t.demandes.delete(i);
    const enCours = new Map();
    for (const d of t.demandes.values()) enCours.set(d.de, (enCours.get(d.de) || 0) + 1);
    const voisins = voisinsDe(t);
    const parVoisin = new Map();
    // Poussée terminée : plus rien ne « dépassera » les derniers morceaux. Après
    // un court délai (le temps que les relais arrivent), tout ce qui manque
    // devient demandable — sinon un morceau perdu en fin de fichier l'était pour
    // toujours.
    if (t.frontiere >= t.n && !t.finPoussee) t.finPoussee = now;
    const queue = t.finPoussee && now - t.finPoussee >= delaiDemande / 2 ? RETARD_SOURCE : 0;

    for (let i = 0; i < t.n; i++) {
      if (t.possede[i] || t.demandes.has(i)) continue;
      const retard = t.frontiere - i + queue;
      if (retard < RETARD_VOISIN) break;          // la poussée n'y est pas encore
      let choix = null;
      for (const id of voisins) {
        if (id === t.source) continue;
        const a = t.possedeDe.get(id);
        if (!a || !a[i] || (enCours.get(id) || 0) >= DEMANDES_PAR_VOISIN) continue;
        if (!choix || tampon(id) < tampon(choix)) choix = id;
      }
      if (!choix && retard >= RETARD_SOURCE && voisins.includes(t.source)
          && (enCours.get(t.source) || 0) < DEMANDES_PAR_VOISIN) choix = t.source;
      if (!choix) continue;
      enCours.set(choix, (enCours.get(choix) || 0) + 1);
      t.demandes.set(i, { de: choix, t: now });
      if (!parVoisin.has(choix)) parVoisin.set(choix, []);
      parVoisin.get(choix).push(i);
    }
    for (const [id, indices] of parVoisin) json(id, { t: 'demande', num: t.num, i: indices });
  }

  /** La source partie avant la fin, et personne n'a ce qui manque : abandon. */
  function verifierOrphelin(t) {
    if (t.complet || t.annule || ouvert(t.source)) return;
    const voisins = voisinsDe(t);
    for (let i = 0; i < t.n; i++) {
      if (t.possede[i]) continue;
      if (!voisins.some((id) => t.possedeDe.get(id)?.[i])) {
        abandonner(t, 'la source est partie avant la fin');
        return;
      }
    }
  }

  function abandonner(t, raison) {
    if (t.annule) return;
    t.annule = true;
    transferts.delete(t.num);
    for (const f of files.values()) {
      for (let k = f.length - 1; k >= 0; k--) if (f[k].num === t.num) f.splice(k, 1);
    }
    reveiller();
    arreterTopSiInutile();
    if (t.role === 'pair' && !t.complet) {
      // La source ne doit plus nous attendre (sinon elle garde le fichier
      // ouvert, à servir, pour un membre qui ne finira jamais).
      if (ouvert(t.source)) json(t.source, { t: 'refus', num: t.num });
      surAbandon(t, raison);
    }
  }

  /* --- Fin de vie ----------------------------------------------------------- */

  /** Tout le monde a tout : plus rien à servir. */
  function nettoyer(t) {
    if (t.role === 'source') {
      if (t.frontiere >= t.n && [...t.membres].every((id) => t.complets.has(id) || !ouvert(id))) {
        abandonner(t, 'terminé');
      }
    } else if (t.complet && [...t.membres, t.source].every((id) => id === moi()
        || t.complets.has(id) || id === t.source || !ouvert(id))) {
      abandonner(t, 'terminé');
    }
  }

  function top() {
    for (const t of [...transferts.values()]) {
      if (t.role === 'pair') {
        publier(t);
        demander(t);
        verifierOrphelin(t);
      } else if (t.frontiere !== t.frontierePubliee) {
        // Où en est la poussée : un membre qui ne reçoit rien (ses relais
        // sont lents ou partis) sait ainsi quoi demander.
        t.frontierePubliee = t.frontiere;
        for (const id of t.membres) if (ouvert(id)) json(id, { t: 'frontiere', num: t.num, f: t.frontiere });
      }
      nettoyer(t);
    }
    for (const id of files.keys()) pomper(id);
  }

  /* --- Réception ----------------------------------------------------------- */

  function recevoir(de, donnees) {
    if (typeof donnees === 'string') {
      let m;
      try { m = JSON.parse(donnees); } catch { return; }
      recevoirMessage(de, m);
      return;
    }
    const p = decoderPiece(donnees);
    if (!p) return;
    const t = transferts.get(p.num);
    if (!t || t.role !== 'pair' || t.annule || t.complet) {
      if (t?.complet) stats.doublons++;
      return;
    }
    stocker(t, p.index, p.donnees, p.type, de);
  }

  function recevoirMessage(de, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'annonce') { recevoirAnnonce(de, m); return; }
    const t = transferts.get(m.num >>> 0);
    if (!t) return;
    switch (m.t) {
      case 'membres':
        if (de === t.source && Array.isArray(m.membres)) t.membres = new Set(m.membres);
        break;
      case 'possede':
        if (m.complet) {
          t.complets.add(de);
          t.possedeDe.set(de, new Uint8Array(t.n).fill(1));
        } else {
          t.possedeDe.set(de, dePlages(m.plages, t.n));
          const derniere = Array.isArray(m.plages) && m.plages.length ? m.plages[m.plages.length - 1] : null;
          if (t.role === 'pair' && derniere) t.frontiere = Math.max(t.frontiere, Math.min(t.n, (Number(derniere[1]) | 0) + 1));
        }
        break;
      case 'frontiere':
        if (de === t.source && t.role === 'pair') t.frontiere = Math.max(t.frontiere, Math.min(t.n, Number(m.f) | 0));
        break;
      case 'demande':
        for (const i of Array.isArray(m.i) ? m.i.slice(0, 64) : []) {
          const index = i >>> 0;
          if (index >= t.n) continue;
          const dispo = t.role === 'source' || t.complet || t.possede?.[index];
          if (dispo) enfiler(de, { type: SIMPLE, num: t.num, index });
        }
        break;
      case 'refus':
        if (t.role === 'source') { t.membres.delete(de); reveiller(); }
        break;
      case 'fin':
        if (de === t.source) abandonner(t, m.annule ? 'annulé par l’émetteur' : 'terminé');
        break;
      default:
    }
  }

  return {
    partager,
    ajouterMembre,
    recevoir,
    /** Un canal essaim s'est vidé ou ouvert : on relance l'envoi. */
    pomper: (id) => { pomper(id); reveiller(); },
    /** Un voisin est parti : ce qu'on lui destinait est abandonné. */
    voisinParti(id) {
      files.delete(id);
      for (const t of transferts.values()) {
        t.possedeDe.delete(id);
        if (t.demandes) for (const [i, d] of t.demandes) if (d.de === id) t.demandes.delete(i);
      }
      reveiller();
    },
    /** Annule un transfert que nous émettons, et prévient les membres. */
    annuler(num) {
      const t = transferts.get(num);
      if (!t || t.role !== 'source') return;
      for (const id of t.membres) json(id, { t: 'fin', num, annule: true });
      abandonner(t, 'annulé');
    },
    /** Notre « stop » : plus rien de ce que nous émettons ne circule. */
    annulerTout() {
      for (const t of [...transferts.values()]) if (t.role === 'source') this.annuler(t.num);
    },
    /** « stop » d'un émetteur : on oublie tout ce qu'il nous envoyait. */
    oublierSource(source) {
      for (const t of [...transferts.values()]) {
        if (t.source === source && t.role === 'pair') abandonner(t, 'stop');
      }
    },
    toutOublier() {
      for (const t of [...transferts.values()]) abandonner(t, 'session terminée');
      files.clear();
    },
    transferts: () => [...transferts.values()],
    transfert: (num) => transferts.get(num) || null,
    stats
  };
}
