// webrtc-ports.js
// Ports UDP de WebRTC — une plage fixe, comme un port réservé.
//
// Par défaut Chromium pioche au hasard dans les ports éphémères : impossible
// d'ouvrir le routeur à l'avance, et chaque lancement repart de zéro. En
// figeant la plage, une redirection UPnP vise toujours les mêmes ports.
//
// Mesuré sous Electron 44 :
//  - une connexion occupe UN port, le même sur toutes les interfaces
//    (192.168.1.16:26170 et 192.168.56.1:26170), et un de plus le temps d'un
//    redémarrage ICE ;
//  - Chromium prend toujours le port libre le plus BAS de sa plage, et reprend
//    un port dès que sa connexion se ferme ;
//  - plage pleine : la connexion n'a aucun candidat UDP et échoue, sans la
//    moindre erreur ;
//  - la plage se change à chaud : les connexions suivantes la suivent, les
//    autres gardent leur port.
//
// D'où le partage des rôles :
//  - sur la BOX, Castunn redirige des fenêtres de 12 ports (port-forwarding.js),
//    une de plus quand la précédente se remplit, 60 ports au plus (26100-26159),
//    et chaque machine du foyer a les siennes ;
//  - CHROMIUM garde toujours 60 ports devant lui, à partir du début de la
//    fenêtre de sa machine. Les premières connexions tombent dans les ports
//    redirigés ; les suivantes débordent sur des ports non redirigés, qui
//    passent par STUN ou TURN comme sans UPnP — mais ne manquent jamais de place.
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
const os = require('os');

/** Ports que Castunn peut rediriger sur la box, toutes machines du foyer confondues. */
const WEBRTC_UDP_PORTS = { min: 26100, max: 26159 };
const WEBRTC_UDP_COUNT = WEBRTC_UDP_PORTS.max - WEBRTC_UDP_PORTS.min + 1;

/** Redirections par paquets de 12 : cinq fenêtres en tout. */
const TAILLE_FENETRE = 12;
const NB_FENETRES = WEBRTC_UDP_COUNT / TAILLE_FENETRE;

// En dessous, une connexion sur plusieurs interfaces peut manquer de place.
const MINIMUM_CONFORTABLE = 10;

/** Fenêtre n° i (0 à 4). */
function fenetre(i) {
  const min = WEBRTC_UDP_PORTS.min + i * TAILLE_FENETRE;
  return { min, max: min + TAILLE_FENETRE - 1 };
}

/** Un début de plage est-il le début d'une fenêtre ? (lu dans un fichier : on vérifie) */
function debutValide(debut) {
  return Number.isInteger(debut)
    && debut >= WEBRTC_UDP_PORTS.min && debut <= WEBRTC_UDP_PORTS.max
    && (debut - WEBRTC_UDP_PORTS.min) % TAILLE_FENETRE === 0;
}

/**
 * Plage donnée à Chromium : 60 ports à partir du début de la fenêtre de la
 * machine. Jamais réduite aux seuls ports redirigés : une plage pleine fait
 * échouer les connexions en silence.
 */
function plageChromium(debut = WEBRTC_UDP_PORTS.min) {
  const min = debutValide(debut) ? debut : WEBRTC_UDP_PORTS.min;
  return { min, max: min + WEBRTC_UDP_COUNT - 1 };
}

/**
 * Tente une liaison UDP : révèle si un autre programme occupe déjà le port.
 *
 * Sur une adresse PRÉCISE : Chromium lie ses ports interface par interface,
 * et une liaison sur 0.0.0.0 réussit alors que le port est pris (mesuré sous
 * Windows) — la sonde « toutes adresses » les voyait toujours libres.
 */
function udpPortLibre(port, adresse = '0.0.0.0') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    socket.once('error', () => { try { socket.close(); } catch {} resolve(false); });
    socket.bind(port, adresse, () => socket.close(() => resolve(true)));
  });
}

/** Ports de la liste déjà liés sur `adresse` (par Chromium ou un autre programme). */
async function portsOccupes(adresse, ports) {
  const occupes = [];
  for (const port of ports) {
    if (!(await udpPortLibre(port, adresse))) occupes.push(port);
  }
  return occupes;
}

/** Adresses IPv4 des interfaces réseau actives, boucle locale exclue. */
function adressesLocalesIPv4() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map((a) => a.address);
}

/**
 * État de la plage, pour la journaliser au démarrage et l'exposer à l'interface.
 * Purement informatif : rien n'est réservé ici, c'est Chromium qui liera les
 * ports au moment de la connexion. Un port n'est libre que s'il l'est sur
 * chaque adresse locale.
 */
async function etatPortsWebRTC(plage = plageChromium(), adresses = adressesLocalesIPv4()) {
  if (!adresses.length) adresses = ['0.0.0.0'];
  let libres = 0;
  for (let p = plage.min; p <= plage.max; p++) {
    let libre = true;
    for (const a of adresses) {
      if (!(await udpPortLibre(p, a))) { libre = false; break; }
    }
    if (libre) libres++;
  }
  return {
    min: plage.min,
    max: plage.max,
    total: plage.max - plage.min + 1,
    libres,
    suffisant: libres >= MINIMUM_CONFORTABLE
  };
}

/**
 * Fixe la plage UDP de WebRTC d'une fenêtre ; rappelée à chaud quand la
 * machine change de fenêtre sur la box.
 *
 * La politique de gestion d'adresses reste `default` : restreindre les
 * interfaces supprimerait les candidats IPv6 et ceux des interfaces
 * secondaires, donc des chemins directs — exactement le contraire du but.
 */
function appliquerPlageWebRTC(webContents, plage = plageChromium(), log = console) {
  if (typeof webContents.setWebRTCUDPPortRange !== 'function') {
    log.warn('[webrtc] setWebRTCUDPPortRange absent de cette version d\'Electron :'
      + ' les ports UDP resteront aléatoires.');
    return false;
  }
  try {
    webContents.setWebRTCUDPPortRange(plage);
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
  TAILLE_FENETRE,
  NB_FENETRES,
  fenetre,
  debutValide,
  plageChromium,
  udpPortLibre,
  portsOccupes,
  adressesLocalesIPv4,
  etatPortsWebRTC,
  appliquerPlageWebRTC
};
