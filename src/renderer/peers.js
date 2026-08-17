// src/renderer/peers.js
// Registre des pairs connectés : qui est là, sous quelle identité.
// Aucune dépendance au DOM — l'affichage est branché par l'appelant.

import { cleanPeerIp, formatPeerLabel } from './protocol.js';

export function createPeerRegistry({ onChange = () => {} } = {}) {
  const peers = new Map(); // peerId -> { ip, nick }

  /** Fusionne une identité partielle sans écraser ce qu'on savait déjà. */
  function merge(peerId, info = {}) {
    if (!peerId) return false;
    const prev = peers.get(peerId) || { ip: '', nick: '' };
    const next = {
      ip: cleanPeerIp(info.ip) || prev.ip || '',
      nick: String(info.nick || '').trim() || prev.nick || ''
    };
    const changed = !peers.has(peerId) || next.ip !== prev.ip || next.nick !== prev.nick;
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

    /** Liste des étiquettes, pour l'infobulle. */
    labels() {
      return [...peers.entries()].map(([id, info]) => formatPeerLabel(id, info));
    },

    ids() { return [...peers.keys()]; }
  };
}
