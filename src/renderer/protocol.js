// src/renderer/protocol.js
// Fonctions sans effet de bord partagées par toute l'interface.
// Aucune dépendance au DOM : ce fichier est testable tel quel.

/**
 * Nettoie une IP reçue du serveur.
 *  - "::ffff:1.2.3.4" -> "1.2.3.4"
 *  - loopback -> "" : derrière un reverse proxy c'est l'adresse du proxy,
 *    jamais celle du pair.
 */
export function cleanPeerIp(ip) {
  if (typeof ip !== 'string') return '';
  let v = ip.trim();
  if (!v) return '';
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (v === '::1' || v === '127.0.0.1' || v === '0.0.0.0' || v === '::') return '';
  return v;
}

/**
 * Étiquette lisible d'un pair : IP et pseudo quand on les connaît, sinon
 * l'un des deux, et en dernier recours un identifiant court — jamais une
 * adresse loopback ni un identifiant brut de huit caractères.
 */
export function formatPeerLabel(peerId, info = {}) {
  const ip = cleanPeerIp(info.ip);
  const nick = String(info.nick || '').trim();
  if (ip && nick) return `${ip} (${nick})`;
  if (ip) return ip;
  if (nick) return nick;
  return `un pair (${String(peerId || '?').slice(0, 6)})`;
}

/** Nom affiché pour soi-même dans le tchat. */
export function formatSelfName({ ip, nick } = {}) {
  const cleanIp = cleanPeerIp(ip);
  const cleanNick = String(nick || '').trim();
  if (cleanIp && cleanNick) return `${cleanIp}(${cleanNick})`;
  if (cleanIp) return cleanIp;
  if (cleanNick) return cleanNick;
  return 'un pair';
}

/** Type MIME déduit de l'extension, pour les fichiers qui n'en déclarent pas. */
export function guessMimeByExt(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'mkv') return 'video/x-matroska';
  return 'application/octet-stream';
}

/**
 * Décide de ce qu'on fait d'un média reçu : le lire ou le télécharger.
 *
 * Cette décision était écrite deux fois — une par transport — et les deux
 * versions divergeaient : le chemin WebRTC ne consultait pas canPlayVideo et
 * envoyait au lecteur des vidéos qu'il ne savait pas décoder (écran noir).
 *
 * @param {{mime?:string, kind?:string, canPlayVideo?:(mime:string)=>boolean}} o
 * @returns {'video'|'audio'|'image'|'download'}
 */
export function pickRenderTarget({ mime = '', kind = '', canPlayVideo } = {}) {
  const m = String(mime || '').toLowerCase();

  // Un envoi explicitement marqué "fichier" n'est jamais joué.
  if (kind === 'file') return 'download';

  const family = m.startsWith('video') ? 'video'
    : m.startsWith('audio') ? 'audio'
    : m.startsWith('image') ? 'image'
    : (kind === 'video' || kind === 'audio' || kind === 'image') ? kind
    : '';

  if (!family) return 'download';
  // Vidéo que le lecteur ne sait pas décoder : on la propose au téléchargement
  // plutôt que d'afficher un cadre noir.
  if (family === 'video' && typeof canPlayVideo === 'function' && m && !canPlayVideo(m)) {
    return 'download';
  }
  return family;
}
