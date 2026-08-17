// src/renderer/media-receiver.js
// Machine à états de réception d'un média : annonce -> morceaux -> fin.
//
// Elle était écrite deux fois, une par transport (WebSocket et WebRTC), avec
// deux jeux de variables et des comportements qui avaient divergé. Un seul
// exemplaire, piloté par le transport, et chaque correctif profite aux deux.
//
// Aucune dépendance au DOM : tout ce qui touche à l'écran est injecté.

import { pickRenderTarget } from './protocol.js';

/**
 * @param {object} deps
 * @param {(url:string, target:string, info:{mime:string,filename:string}) => void} deps.render
 *        Affiche le média ('video' | 'audio' | 'image').
 * @param {(url:string, filename:string) => void} deps.download
 * @param {(blob:Blob) => string} [deps.createUrl]   par défaut URL.createObjectURL
 * @param {(url:string) => void}  [deps.revokeUrl]   par défaut URL.revokeObjectURL
 * @param {(mime:string) => boolean} [deps.canPlayVideo]
 * @param {(text:string) => void} [deps.log]
 * @param {(text:string) => void} [deps.confirm]     accusé de réception à l'émetteur
 * @param {() => void} [deps.stopPlayback]           interrompt la lecture en cours
 * @param {string} [deps.label]                      'WS' ou 'RTC', pour les messages
 */
export function createMediaReceiver(deps = {}) {
  const {
    render,
    download,
    createUrl = (blob) => URL.createObjectURL(blob),
    revokeUrl = (url) => { try { URL.revokeObjectURL(url); } catch {} },
    canPlayVideo,
    log = () => {},
    confirm = () => {},
    stopPlayback = () => {},
    label = ''
  } = deps;

  const via = label ? ` (${label})` : '';

  let chunks = [];
  let mime = '';
  let kind = '';
  let filename = '';
  let dropping = false;      // on jette le flux en cours (stop / annulation / récepteur off)
  let lastUrl = null;        // libéré au média suivant, sinon la mémoire ne redescend jamais

  function clear() {
    chunks = [];
    mime = '';
    kind = '';
    filename = '';
  }

  return {
    /** Annonce d'un média à venir. */
    begin(meta = {}) {
      clear();
      mime = meta.mime || '';
      kind = meta.kind || '';
      filename = meta.filename || '';
      dropping = false;
      log(`[${label || 'média'}] annonce : ${filename || 'sans nom'} (${mime || 'type inconnu'})`);
    },

    /** Un morceau de données binaires. */
    push(data) {
      if (dropping || !data) return;
      chunks.push(data);
    },

    /** L'émetteur a annulé son envoi. */
    cancel({ silent = false } = {}) {
      clear();
      dropping = true;
      if (!silent) confirm(`Envoi annulé${via}`);
    },

    /**
     * Ordre d'arrêt : la lecture s'interrompt AUSSI côté WebRTC, ce que
     * l'ancien chemin RTC ne faisait pas.
     */
    stop() {
      clear();
      dropping = true;
      stopPlayback();
      confirm(`Stop reçu${via}`);
    },

    /** Le récepteur est désactivé : on ignore le flux annoncé. */
    discard() {
      clear();
      dropping = true;
    },

    /** Fin du transfert : on assemble et on décide quoi en faire. */
    end() {
      if (dropping || !chunks.length) {
        clear();
        dropping = false;
        return null;
      }

      const effMime = mime || 'application/octet-stream';
      const name = filename || 'fichier';
      const blob = new Blob(chunks, { type: effMime });
      const url = createUrl(blob);

      if (lastUrl) revokeUrl(lastUrl);
      lastUrl = url;

      const target = pickRenderTarget({ mime: effMime, kind, canPlayVideo });
      if (target === 'download') {
        download(url, name);
        const why = (kind === 'file') ? '' : ' (non lisible ici)';
        confirm(`Fichier reçu${via} : ${name}${why}`);
      } else {
        render(url, target, { mime: effMime, filename: name });
        confirm(`Média reçu${via} : ${name} (${effMime})`);
      }

      clear();
      dropping = false;
      return { url, target, mime: effMime, filename: name };
    },

    /** Pour les tests et le diagnostic. */
    get state() {
      return { chunks: chunks.length, mime, kind, filename, dropping };
    }
  };
}
