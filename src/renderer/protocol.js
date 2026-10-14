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

/** Vrai pour une IPv4 en notation pointée. */
export function isIPv4(ip) {
  const parties = String(ip || '').split('.');
  return parties.length === 4
    && parties.every((p) => /^[0-9]{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Les adresses connues d'un pair, triées pour l'affichage.
 *
 * Un pair joignable en IPv6 arrive souvent par là (les systèmes la
 * privilégient quand le serveur publie un AAAA), alors que l'adresse qu'il
 * annonce lui-même vient d'un service qui ne répond qu'en IPv4. On reçoit
 * donc deux adresses valides pour la même personne : `principale` est celle
 * qu'on montre (l'IPv4, qu'on reconnaît et qu'on s'échange), `secondaire`
 * l'autre, reléguée à l'infobulle.
 */
export function peerAddresses(info = {}) {
  const vues = [cleanPeerIp(info.ip), cleanPeerIp(info.ipDeclared)]
    .filter(Boolean)
    .filter((v, i, t) => t.indexOf(v) === i);
  const principale = vues.find(isIPv4) || vues[0] || '';
  const secondaire = vues.find((v) => v !== principale) || '';
  return { principale, secondaire };
}

/**
 * Étiquette lisible d'un pair : IP et pseudo quand on les connaît, sinon
 * l'un des deux, et en dernier recours un identifiant court — jamais une
 * adresse loopback ni un identifiant brut de huit caractères.
 */
export function formatPeerLabel(peerId, info = {}) {
  const ip = peerAddresses(info).principale;
  const nick = String(info.nick || '').trim();
  if (ip && nick) return `${ip} (${nick})`;
  if (ip) return ip;
  if (nick) return nick;
  return `un pair (${String(peerId || '?').slice(0, 6)})`;
}

/**
 * Mention de l'adresse secondaire, pour une infobulle. Chaîne vide quand on
 * ne connaît qu'une seule adresse : il n'y a alors rien à révéler au survol.
 */
export function formatPeerAltAddress(info = {}) {
  const { secondaire } = peerAddresses(info);
  if (!secondaire) return '';
  return `${isIPv4(secondaire) ? 'Autre adresse' : 'IPv6'} : ${secondaire}`;
}

/** Ligne d'un pair pour l'infobulle du compteur : étiquette + adresse secondaire. */
export function formatPeerDetail(peerId, info = {}) {
  const label = formatPeerLabel(peerId, info);
  const { secondaire } = peerAddresses(info);
  return secondaire ? `${label} · ${secondaire}` : label;
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
