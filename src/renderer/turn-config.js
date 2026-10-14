// src/renderer/turn-config.js
// Relais TURN annoncé par le serveur de signalisation : ce qu'on en accepte,
// quand renouveler ses identifiants, et comment lire un échec.
// Sans dépendance au DOM ni à l'API RTC.

/**
 * Ne garde que des entrées TURN bien formées.
 *
 * Le serveur est de confiance, mais une entrée invalide (URL mal formée,
 * identifiants absents) ferait lever le constructeur RTCPeerConnection — et
 * avec lui toute connexion directe. Mieux vaut perdre le relais que tout.
 */
export function sanitizeTurnServers(liste) {
  if (!Array.isArray(liste)) return [];
  const propres = [];
  for (const s of liste) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
      .filter((u) => typeof u === 'string' && /^turns?:\S+$/i.test(u));
    // Un relais TURN exige des identifiants : sans eux, il refuserait tout.
    if (!urls.length || typeof s.username !== 'string' || typeof s.credential !== 'string') continue;
    propres.push({ urls, username: s.username, credential: s.credential });
  }
  return propres;
}

/**
 * Les identifiants expirent-ils bientôt ? La marge couvre le temps d'établir
 * la connexion : des identifiants valables au départ mais expirés en cours de
 * négociation feraient échouer l'allocation au pire moment.
 */
export function credentialsExpiring(expiresAt, now = Date.now(), marge = 5 * 60 * 1000) {
  if (!expiresAt) return false;          // pas d'échéance connue : rien à renouveler
  return Number(expiresAt) - now < marge;
}

/**
 * Pourquoi il n'y a pas de connexion P2P, en une phrase à ajouter au message
 * d'erreur du partage d'écran ou au repli WebSocket. Savoir si un relais
 * existait change tout : sans relais, certains réseaux ne laissent aucune
 * chance au direct ; avec un relais joignable, c'est le pair qui manque.
 *
 * `turnJoignable` vaut true / false une fois la sonde faite, undefined avant.
 */
export function explainNoRtc({ pairPresent = true, turnAnnonce = false, turnJoignable } = {}) {
  if (!pairPresent) return 'aucun pair dans la room';
  if (!turnAnnonce) return 'aucun relais TURN proposé par ce serveur : seule une connexion directe pouvait être tentée';
  if (turnJoignable === false) return 'le relais TURN annoncé par le serveur est injoignable';
  if (turnJoignable === true) {
    return 'un relais TURN était pourtant disponible : le pair est peut-être injoignable, ou la connexion encore en cours';
  }
  return 'un relais TURN est annoncé (vérification en cours)';
}

/**
 * Raison lisible d'un relais injoignable, d'après les erreurs ICE relevées
 * (événement icecandidateerror) pendant la sonde.
 */
export function turnFailureReason(erreurs = []) {
  const codes = erreurs.map((e) => Number(e?.code)).filter(Boolean);
  if (codes.includes(401)) return 'identifiants refusés (401) — secret différent de celui du relais ?';
  if (codes.includes(701)) return 'serveur injoignable (701)';
  const premiere = erreurs.find((e) => e?.texte || e?.code);
  if (premiere) return [premiere.code, premiere.texte].filter(Boolean).join(' ');
  return 'aucun candidat relais en 3 s';
}
