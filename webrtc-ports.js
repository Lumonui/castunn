// webrtc-ports.js
// Plage de ports UDP de WebRTC — fixe, comme un port réservé.
//
// Par défaut Chromium pioche au hasard dans les ports éphémères : impossible
// d'ouvrir le routeur à l'avance, et chaque lancement repart de zéro. En
// figeant la plage, une redirection UPnP vise toujours les mêmes ports.
//
// Pourquoi 30 et pas un seul : Chromium ouvre une socket UDP par interface
// (Ethernet, Wi-Fi, IPv6, VPN…), conserve un temps les anciennes lors d'un
// redémarrage ICE, et en consomme pour les allocations TURN.
//
// Pourquoi 26xxx : hors des plages éphémères des systèmes (49152-65535 sous
// Windows et macOS, 32768-60999 sous Linux), pour limiter les collisions avec
// les autres programmes. Un port déjà pris n'est pas réquisitionné — le système
// l'interdit — Chromium en prend simplement un autre dans la plage.
//
// À la racine et non dans src/ : src/ est déclaré en modules ES (pour le
// navigateur), alors que le processus principal est en CommonJS.
// Module à part et non constante dans main.js : le processus principal,
// l'ouverture de ports du routeur et les tests doivent parler de la MÊME plage.

const dgram = require('dgram');

const WEBRTC_UDP_PORTS = { min: 26100, max: 26129 };
const WEBRTC_UDP_COUNT = WEBRTC_UDP_PORTS.max - WEBRTC_UDP_PORTS.min + 1;

// En dessous, une connexion sur plusieurs interfaces peut manquer de place.
const MINIMUM_CONFORTABLE = 10;

/** Tente une liaison UDP : révèle si un autre programme occupe déjà le port. */
function udpPortLibre(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    socket.once('error', () => { try { socket.close(); } catch {} resolve(false); });
    socket.bind(port, '0.0.0.0', () => socket.close(() => resolve(true)));
  });
}

/**
 * État de la plage, pour la journaliser au démarrage et l'exposer à l'interface.
 * Purement informatif : rien n'est réservé ici, c'est Chromium qui liera les
 * ports au moment de la connexion.
 */
async function etatPortsWebRTC() {
  const libres = [];
  for (let p = WEBRTC_UDP_PORTS.min; p <= WEBRTC_UDP_PORTS.max; p++) {
    if (await udpPortLibre(p)) libres.push(p);
  }
  return {
    min: WEBRTC_UDP_PORTS.min,
    max: WEBRTC_UDP_PORTS.max,
    total: WEBRTC_UDP_COUNT,
    libres: libres.length,
    suffisant: libres.length >= MINIMUM_CONFORTABLE
  };
}

/**
 * Fixe la plage UDP de WebRTC sur une fenêtre.
 *
 * La politique de gestion d'adresses reste `default` : restreindre les
 * interfaces supprimerait les candidats IPv6 et ceux des interfaces
 * secondaires, donc des chemins directs — exactement le contraire du but.
 */
function appliquerPlageWebRTC(webContents, log = console) {
  if (typeof webContents.setWebRTCUDPPortRange !== 'function') {
    log.warn('[webrtc] setWebRTCUDPPortRange absent de cette version d\'Electron :'
      + ' les ports UDP resteront aléatoires.');
    return false;
  }
  try {
    webContents.setWebRTCUDPPortRange(WEBRTC_UDP_PORTS);
    if (typeof webContents.setWebRTCIPHandlingPolicy === 'function') {
      webContents.setWebRTCIPHandlingPolicy('default');
    }
    return true;
  } catch (e) {
    log.warn('[webrtc] plage UDP non appliquée :', e.message);
    return false;
  }
}

module.exports = {
  WEBRTC_UDP_PORTS,
  WEBRTC_UDP_COUNT,
  udpPortLibre,
  etatPortsWebRTC,
  appliquerPlageWebRTC
};
