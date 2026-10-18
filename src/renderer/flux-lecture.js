// src/renderer/flux-lecture.js
// Lecture pendant le téléchargement : la page fournit au lecteur vidéo les
// octets d'un fichier encore en cours de réception par l'essaim.
//
// Le lecteur (balise <video>) demande des plages d'octets — le début, puis la
// fin pour l'index d'un MP4, puis là où l'on navigue. Un transport les lui
// apporte : un protocole maison servi par le processus principal (application)
// ou un service worker (navigateur, en https). Les deux posent la même
// question à ce module : « les octets à partir de `pos` ». La réponse attend
// le morceau qui les contient, après l'avoir demandé en priorité, ainsi que
// les suivants : la lecture avance sans attendre la poussée de l'essaim.
//
// Aucune dépendance au DOM ni au transport : l'essaim est injecté.

/** Morceaux demandés d'avance devant la position de lecture. */
const FENETRE = 16;

/**
 * @param {object} deps
 * @param {object} deps.essaim   lirePiece(num, i), prioriser(num, indices)
 */
export function createFluxLecture({ essaim, fenetre = FENETRE } = {}) {
  const flux = new Map(); // num -> { taille, mime, taillePiece, blob }

  return {
    /** Rend un transfert lisible (taille et type connus dès l'annonce). */
    ouvrir(num, { taille, mime, taillePiece }) {
      flux.set(num, { taille, mime: mime || 'application/octet-stream', taillePiece, blob: null });
    },

    /** Transfert complet : on sert désormais depuis le fichier entier, qui survit à l'essaim. */
    terminer(num, blob) {
      const f = flux.get(num);
      if (f) f.blob = blob;
    },

    fermer(num) { flux.delete(num); },
    ouvert: (num) => flux.has(num),
    /** Flux encore servis (et leurs fichiers gardés en mémoire) : diagnostic et tests. */
    nombre: () => flux.size,

    /** Ce que le transport met dans les en-têtes, ou null si inconnu. */
    info(num) {
      const f = flux.get(num);
      return f ? { taille: f.taille, mime: f.mime } : null;
    },

    /**
     * Octets à partir de `pos`, jusqu'à la fin du morceau qui le contient (et
     * jamais au-delà de `fin`, incluse). null si le flux n'existe plus ou si
     * la position est hors du fichier.
     */
    async octets(num, pos, fin = Infinity) {
      const f = flux.get(num);
      if (!f || !(pos >= 0) || pos >= f.taille) return null;
      const borne = Math.min(fin, f.taille - 1);
      const P = f.taillePiece;
      const i = Math.floor(pos / P);
      const finPiece = Math.min((i + 1) * P, f.taille) - 1;
      const jusque = Math.min(borne, finPiece);

      if (f.blob) return f.blob.slice(pos, jusque + 1).arrayBuffer();

      const n = Math.ceil(f.taille / P);
      const indices = [];
      for (let k = i; k < Math.min(n, i + fenetre); k++) indices.push(k);
      essaim.prioriser(num, indices);
      let piece;
      try { piece = await essaim.lirePiece(num, i); } catch { piece = null; }
      // L'essaim a pu finir (et oublier le transfert) pendant l'attente.
      if (!piece) {
        const g = flux.get(num);
        return g?.blob ? g.blob.slice(pos, jusque + 1).arrayBuffer() : null;
      }
      return piece.slice(pos - i * P, jusque - i * P + 1);
    }
  };
}

/** Plage HTTP demandée -> { debut, fin, partielle } bornée au fichier, ou null si invalide. */
export function lirePlage(entete, taille) {
  if (!entete) return { debut: 0, fin: taille - 1, partielle: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(entete).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let debut, fin;
  if (m[1] === '') {                 // « bytes=-500 » : les 500 derniers
    debut = Math.max(0, taille - Number(m[2]));
    fin = taille - 1;
  } else {
    debut = Number(m[1]);
    fin = m[2] === '' ? taille - 1 : Math.min(Number(m[2]), taille - 1);
  }
  if (debut >= taille || fin < debut) return null;
  return { debut, fin, partielle: true };
}

/** En-têtes de la réponse au lecteur. */
export function entetesReponse({ debut, fin, partielle }, { taille, mime }) {
  return {
    status: partielle ? 206 : 200,
    headers: {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(fin - debut + 1),
      'Cache-Control': 'no-store',
      ...(partielle ? { 'Content-Range': `bytes ${debut}-${fin}/${taille}` } : {})
    }
  };
}
