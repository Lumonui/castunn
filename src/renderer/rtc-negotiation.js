// src/renderer/rtc-negotiation.js
// Règles de négociation WebRTC, sans dépendance au DOM ni à l'API RTC :
// qui mène la négociation, que faire d'une offre qui en croise une autre,
// et où patientent les candidats ICE arrivés trop tôt.
//
// Ces décisions vivaient dispersées dans castunn.html, mêlées aux appels
// asynchrones qu'elles pilotent — donc intestables. Ici, ce sont des fonctions
// pures qu'on peut vérifier cas par cas.

/** Serveurs STUN publics, indépendants l'un de l'autre : si l'un tombe, l'autre répond. */
export const STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
];

/**
 * Configuration ICE : le STUN public, plus les relais annoncés par le serveur
 * de signalisation quand il en a (aucun aujourd'hui, le point d'entrée existe).
 */
export function buildIceServers(turnServers = []) {
  const turn = Array.isArray(turnServers) ? turnServers.filter(Boolean) : [];
  return [{ urls: [...STUN_URLS] }, ...turn];
}

/**
 * Le pair au plus grand identifiant mène la négociation : c'est déjà lui qui
 * lançait l'appel (règle anti-glare existante). On le dit « impoli » au sens du
 * schéma « perfect negotiation » : en cas de collision d'offres, il ignore
 * celle d'en face, tandis que le poli range la sienne et accepte.
 *
 * Sans identifiant des deux côtés, on se déclare poli : deux impolis
 * s'ignoreraient mutuellement et la connexion ne partirait jamais.
 */
export function isPolitePeer(myId, peerId) {
  if (!myId || !peerId) return true;
  return String(myId) < String(peerId);
}

export function isImpolitePeer(myId, peerId) {
  return !isPolitePeer(myId, peerId);
}

/**
 * Que faire d'une description distante qui arrive.
 *
 * `settingRemoteAnswer` couvre le court instant où une réponse distante est en
 * cours d'application : l'état n'est pas encore `stable`, mais on est bien
 * disponible pour une offre.
 */
export function describeIncoming({
  type,
  polite,
  makingOffer = false,
  signalingState = 'stable',
  settingRemoteAnswer = false
} = {}) {
  const readyForOffer = !makingOffer && (signalingState === 'stable' || settingRemoteAnswer);
  const collision = type === 'offer' && !readyForOffer;
  return {
    collision,
    // L'impoli garde la main : il ignore l'offre reçue et la sienne suit son cours.
    ignore: collision && !polite,
    // Le poli recule ; setRemoteDescription(offer) fait le rollback tout seul.
    rollback: collision && polite
  };
}

/**
 * File des candidats ICE arrivés avant qu'on puisse les accepter — soit la
 * connexion n'existe pas encore, soit la description distante n'est pas posée.
 * Les jeter revenait à perdre des chemins de connexion, donc à forcer un relais
 * là où le direct aurait marché.
 */
export function createIceQueue({ max = 200 } = {}) {
  let pending = [];
  return {
    /** Range un candidat. Renvoie false si la file déborde (anormal : à journaliser). */
    push(candidate) {
      if (!candidate) return false;
      if (pending.length >= max) return false;
      pending.push(candidate);
      return true;
    },
    /** Rend les candidats en attente et vide la file. */
    take() {
      const out = pending;
      pending = [];
      return out;
    },
    clear() { pending = []; },
    get size() { return pending.length; }
  };
}
