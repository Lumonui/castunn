// src/renderer/peers.js
// Registre des pairs connectés : qui est là, sous quelle identité.
// Aucune dépendance au DOM — l'affichage est branché par l'appelant.

import { cleanPeerIp, formatPeerLabel, formatPeerDetail, formatPeerAltAddress }
  from './protocol.js';

export function createPeerRegistry({ onChange = () => {} } = {}) {
  const peers = new Map(); // peerId -> { ip, ipDeclared, nick }

  /** Fusionne une identité partielle sans écraser ce qu'on savait déjà. */
  function merge(peerId, info = {}) {
    if (!peerId) return false;
    const prev = peers.get(peerId) || { ip: '', ipDeclared: '', nick: '' };
    const next = {
      ip: cleanPeerIp(info.ip) || prev.ip || '',
      // Adresse que le pair annonce lui-même : elle complète celle que le
      // serveur constate, sans jamais la remplacer.
      ipDeclared: cleanPeerIp(info.ipDeclared) || prev.ipDeclared || '',
      nick: String(info.nick || '').trim() || prev.nick || ''
    };
    const changed = !peers.has(peerId)
      || next.ip !== prev.ip
      || next.ipDeclared !== prev.ipDeclared
      || next.nick !== prev.nick;
    peers.set(peerId, next);
    if (changed) onChange();
    return changed;
  }

  return {
    /** Ajoute ou complète un pair. Renvoie true si l'identité a bougé. */
    upsert: merge,

    /** Ajoute un pair seulement s'il est inconnu. Renvoie true si créé. */
    add(peerId, info = {}) {
      if (!peerId || peers.has(peerId)) return false;
      merge(peerId, info);
      return true;
    },

    remove(peerId) {
      const existed = peers.delete(peerId);
      if (existed) onChange();
      return existed;
    },

    clear() {
      if (!peers.size) return;
      peers.clear();
      onChange();
    },

    has: (peerId) => peers.has(peerId),
    get: (peerId) => peers.get(peerId) || null,
    get size() { return peers.size; },

    /** Étiquette lisible d'un pair, connu ou non. */
    label(peerId, info) {
      return formatPeerLabel(peerId, info || peers.get(peerId) || {});
    },

    /** Liste des étiquettes courtes. */
    labels() {
      return [...peers.entries()].map(([id, info]) => formatPeerLabel(id, info));
    },

    /** Idem, mais avec l'adresse secondaire : pour l'infobulle du compteur. */
    details() {
      return [...peers.entries()].map(([id, info]) => formatPeerDetail(id, info));
    },

    /** Mention de l'adresse secondaire d'un pair, ou '' s'il n'en a qu'une. */
    altAddress(peerId) {
      return formatPeerAltAddress(peers.get(peerId) || {});
    },

    ids() { return [...peers.keys()]; }
  };
}
