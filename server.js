// server.js
// Serveur de signalisation de Castunn : HTTP (santé, découverte) + WebSocket
// (salles, signalisation WebRTC, repli pour les pairs sans P2P).
//
// Il tourne sur le réseau local (lancé par l'application) ET sur un hébergeur
// public : tout client est présumé hostile. Il ne voit jamais les fichiers
// échangés en P2P ; seul le repli WebSocket les fait transiter par lui.

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

/* ==========================================================================
 * Version : une seule admise.
 *
 * Le serveur refuse tout client d'une autre version, et le client refuse tout
 * serveur d'une autre version : pas de cohabitation entre versions, dont les
 * protocoles divergent (un client 1.2.1 accusait un « stop » P2P sans arrêter
 * sa lecture, et ne gérait qu'une connexion P2P).
 *
 * Lue dans package.json, à côté de ce fichier ; l'application installée, où
 * server.js est copié hors de l'archive, la passe par CASTUNN_VERSION.
 * ========================================================================== */
const VERSION = (() => {
  if (process.env.CASTUNN_VERSION) return process.env.CASTUNN_VERSION;
  try { return require('./package.json').version; } catch { return null; }
})();
if (!VERSION) {
  console.error('[Castunn] version inconnue : déployez package.json à côté de server.js'
    + ' (ou définissez CASTUNN_VERSION). Sans elle, aucun client ne peut être accepté.');
  process.exit(1);
}

/* ==========================================================================
 * Limites (réglables par l'environnement)
 *
 * Un serveur public, sur un VPS à 1 Gbit/s : 100 personnes, chacune bridée à
 * 1 Mo/s (8 Mbit/s) de ce qu'elle envoie, tiennent dans 800 Mbit/s. Par
 * adresse IP : 10 connexions à la fois (une famille, un réseau 4G partagé),
 * 10 nouvelles par minute (une reconnexion en boucle, ou un robot, s'y
 * heurte). Un client trop rapide n'est pas coupé : le serveur cesse de lire
 * sa connexion le temps nécessaire, et TCP le ralentit de lui-même.
 * ========================================================================== */
const entier = (v, defaut) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : defaut);
const LIMITES = {
  clients: entier(process.env.CASTUNN_MAX_CLIENTS, 100),
  parIp: entier(process.env.CASTUNN_MAX_PAR_IP, 10),
  arriveesParMinute: entier(process.env.CASTUNN_CONNEXIONS_PAR_MINUTE, 10),
  debit: entier(process.env.CASTUNN_DEBIT_MAX, 1024 * 1024),          // octets/s reçus d'un client
  messages: entier(process.env.CASTUNN_MESSAGES_PAR_SECONDE, 100),     // messages/s d'un client
  // Plus gros message légitime : un morceau de fichier (64 Kio) ou une offre SDP.
  tailleMessage: 256 * 1024,
  // Un destinataire qui ne suit pas : l'émetteur attend qu'il se vide.
  tamponDestinataire: 4 * 1024 * 1024,
  pseudo: 40,
  tchat: 2000
};

// Codes de fermeture (le client les explique à l'utilisateur).
const FERMETURE = {
  version: 4009,
  salle: 4010,
  tropDeConnexions: 4029,
  plein: 4503
};

/* ==========================================================================
 * Salles
 *
 * Sur un serveur public, une salle se rejoint par un code, que le client
 * transforme en identifiant (empreinte SHA-256 en base64url, 43 caractères) :
 * impossible à deviner, et le serveur ne voit jamais le code lui-même — il
 * pourra servir de clé de chiffrement de bout en bout. La salle commune
 * « default » n'existe que si CASTUNN_SALLE_LIBRE=1 : c'est le cas du serveur
 * local que lance l'application, sur un réseau de confiance.
 * ========================================================================== */
const SALLE_LIBRE = process.env.CASTUNN_SALLE_LIBRE === '1';
const FORMAT_SALLE = /^[A-Za-z0-9_-]{43}$/;
const salleValide = (room) => FORMAT_SALLE.test(room) || (SALLE_LIBRE && room === 'default');

/* ==========================================================================
 * Adresse IP des clients
 *
 * Les en-têtes de reverse proxy (X-Forwarded-For…) ne sont crus que s'ils
 * viennent d'un proxy : d'une connexion locale (proxy sur la même machine,
 * cas d'alwaysdata ou d'un nginx devant le serveur), ou d'une adresse listée
 * dans CASTUNN_PROXIES. Sinon n'importe qui choisirait son adresse — et
 * contournerait les limites par IP.
 * ========================================================================== */
const PROXIES = new Set(String(process.env.CASTUNN_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean));

const app = express();

// Petit endpoint santé (utile pour les hébergeurs)
app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

// Signature de découverte : permet aux clients de scanner le réseau local
// et de reconnaître un vrai serveur Castunn (et pas n'importe quel service
// qui traîne sur le port 8080).
app.get('/castunn', (_req, res) => {
  res.status(200).json({
    app: 'castunn',
    role: 'signal',
    version: 1,
    versionCastunn: VERSION,
    ws: true
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITES.tailleMessage });

/** Etat serveur **/
const clients = new Map(); // ws -> { id, room, awaitingBinaryMeta, blobAnnounced, isAlive }
const byId = new Map();    // id -> ws
const rooms = new Map();   // room -> Set<ws>
const connexionsParIp = new Map(); // ip -> connexions ouvertes
const arriveesParIp = new Map();   // ip -> instants des connexions de la dernière minute

/* ==========================================================================
 * Relais TURN (facultatif)
 *
 * Quand la connexion directe échoue (NAT symétrique, 4G, réseau
 * d'entreprise…), un relais TURN fait transiter le flux. Ce serveur n'en
 * héberge pas : il distribue des identifiants temporaires pour celui qu'on
 * lui indique — aux seuls membres d'une salle, jamais à un simple visiteur,
 * qui se servirait sinon du relais comme d'un mandataire gratuit.
 *
 *   TURN_URLS    liste séparée par des virgules, par exemple
 *                turn:turn.exemple.fr:3478?transport=udp,
 *                turns:turn.exemple.fr:443?transport=tcp
 *   TURN_SECRET  secret partagé avec coturn (static-auth-secret) ou eturnal
 *   TURN_TTL     validité des identifiants, en secondes (6 h par défaut)
 *
 * Mécanisme « TURN REST API » : username = "<expiration>:<peerId>",
 * credential = base64(HMAC-SHA1(secret, username)). Le relais refait le
 * calcul de son côté : le secret ne quitte jamais ce serveur, et des
 * identifiants interceptés expirent seuls. Les limites de débit du relais
 * se règlent dans coturn (docs/relais-turn.md).
 *
 * Sans TURN_URLS ET TURN_SECRET, rien n'est annoncé — c'est le cas du
 * serveur local du réseau domestique, où un relais ne servirait à rien.
 * ========================================================================== */
const TURN_URLS_BRUTES = String(process.env.TURN_URLS || '')
  .split(',').map((u) => u.trim()).filter(Boolean);
const TURN_URLS = TURN_URLS_BRUTES.filter((u) => /^turns?:\S+$/i.test(u));
const TURN_SECRET = String(process.env.TURN_SECRET || '');
// Bornée : des identifiants valables des jours rendraient le vol rentable,
// et une durée trop courte casserait les sessions en cours.
const TURN_TTL = Math.min(Math.max(Number(process.env.TURN_TTL) || 6 * 3600, 300), 48 * 3600);
const TURN_ACTIF = TURN_URLS.length > 0 && TURN_SECRET.length > 0;

/** Identifiants TURN temporaires pour un pair, ou null sans relais configuré. */
function configIce(peerId) {
  if (!TURN_ACTIF) return null;
  const expiration = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${expiration}:${peerId}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return {
    iceServers: [{ urls: TURN_URLS, username, credential }],
    iceExpiresAt: expiration * 1000
  };
}

/**
 * Identifiant de pair : 12 caractères [a-z0-9] tirés au hasard (≈ 62 bits).
 * Imprévisible : il entre dans les identifiants TURN et désigne le
 * destinataire des messages adressés.
 */
function makeId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id;
  do {
    id = [...crypto.randomBytes(12)].map((o) => alphabet[o % 36]).join('');
  } while (byId.has(id));
  return id;
}

/**
 * Normalise une adresse socket :
 *  - "::ffff:192.168.1.20" -> "192.168.1.20"
 *  - loopback ("::1", "127.0.0.1") -> null, car derrière un reverse proxy
 *    (alwaysdata, Render, nginx...) c'est l'adresse du proxy, pas celle du client.
 */
function normalizeIp(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let ip = raw.trim();
  if (!ip) return null;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::') return null;
  // Une adresse, rien d'autre : c'est relayé aux pairs et affiché chez eux.
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(ip)) return null;
  return ip;
}

// En-têtes posés par les reverse proxies courants, du plus standard au plus
// spécifique. Tous les hébergeurs ne posent pas le même, et certains n'en
// posent aucun sur la requête d'upgrade WebSocket.
const FORWARD_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',      // Cloudflare
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip'
];

/** La connexion vient-elle d'un proxy dont on croit les en-têtes ? */
function viaProxyDeConfiance(req) {
  const brute = String(req.socket.remoteAddress || '');
  const directe = brute.startsWith('::ffff:') ? brute.slice(7) : brute;
  return directe === '127.0.0.1' || directe === '::1' || PROXIES.has(directe);
}

/** Adresse client la plus fiable disponible côté serveur. */
function clientIpFromRequest(req) {
  if (viaProxyDeConfiance(req)) {
    for (const h of FORWARD_HEADERS) {
      const found = String(req.headers[h] || '')
        .split(',')
        .map(s => normalizeIp(s))
        .find(Boolean);
      if (found) return found;
    }

    // En-tête standardisé (RFC 7239) : Forwarded: for=1.2.3.4;proto=https
    const forwarded = String(req.headers['forwarded'] || '');
    const m = /for=(?:"?\[?)([^;,\]"]+)/i.exec(forwarded);
    if (m) {
      const ip = normalizeIp(m[1].replace(/:\d+$/, ''));
      if (ip) return ip;
    }
  }

  return normalizeIp(req.socket.remoteAddress);
}

/** Liste des adresses IPv4 locales (affichées au démarrage, pratique en LAN). */
function localIPv4s() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// Outils
function roomOf(ws) {
  const meta = clients.get(ws);
  return meta?.room || null;
}
function broadcastToRoom(room, data, excludeWs, forceBinary = false) {
  const membres = rooms.get(room);
  if (!membres) return;
  for (const c of membres) {
    if (c !== excludeWs && c.readyState === WebSocket.OPEN) {
      if (forceBinary) c.send(data, { binary: true });
      else c.send(data);
    }
  }
}
/**
 * Pairs désignés par `to` (un identifiant ou une liste), limités à la room
 * de l'émetteur : un message adressé ne doit jamais franchir une room.
 */
function destinataires(ws, to) {
  const room = roomOf(ws);
  if (!room) return [];
  const ids = (Array.isArray(to) ? to.slice(0, LIMITES.clients) : [to]).map(String);
  return ids
    .map((id) => byId.get(id))
    .filter((c) => c && c !== ws && c.readyState === WebSocket.OPEN && roomOf(c) === room);
}

/**
 * Envoi binaire relayé, signé de son émetteur : [0xCA, longueur,
 * identifiant ASCII…, données]. Sans signature, deux envois simultanés par
 * le WebSocket se mélangeaient chez le récepteur, sans moyen de les démêler.
 */
function relayerBinaire(c, payload, emetteurId) {
  if (!c.__binaireSigne) { c.send(payload, { binary: true }); return; }
  const id = Buffer.from(String(emetteurId), 'ascii');
  c.send(Buffer.concat([Buffer.from([0xCA, id.length]), id, payload]), { binary: true });
}

// Ce que ce serveur sait faire en plus du protocole d’origine.
const CAPACITES = ['adressage', 'binaire-signe'];

// Types que le serveur traite lui-même : jamais routés par `to` génériquement.
const TYPES_SERVEUR = new Set([
  'join', 'announce', 'leave', 'ice-config', 'chat',
  'offer', 'answer', 'ice', 'ping', 'pong',
  'binary-meta', 'binary-end', 'binary-cancel'
]);

/** Texte borné, ou '' : relayé aux pairs, il ne doit pas servir de vecteur d'inondation. */
const borne = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function joinRoom(ws, room) {
  // Quitte l’ancienne room si besoin
  const meta = clients.get(ws);
  if (meta?.room && rooms.has(meta.room)) {
    rooms.get(meta.room).delete(ws);
    if (rooms.get(meta.room).size === 0) rooms.delete(meta.room);
  }
  // Ajoute à la nouvelle room
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  meta.room = room;
  clients.set(ws, meta);
  // Le relais, aux seuls membres d'une salle (avant la liste des pairs : le
  // client le connaît avant d'ouvrir ses premiers liens). Envoyé même vide :
  // le client sait alors qu'il n'y en a pas, et n'attend pas.
  ws.send(JSON.stringify({ type: 'ice-config', initial: true, ...(configIce(meta.id) || { iceServers: [], iceExpiresAt: null }) }));
  // Informe la room de la présence
  broadcastToRoom(room, JSON.stringify({
    type: 'presence', action: 'join',
    peerId: meta.id, ip: ws.__ip, ipDeclared: ws.__ipDeclared || '',
    nick: ws.__nick || ''
  }), ws);
  // Liste des pairs déjà présents
  const peers = [...rooms.get(room)]
    .filter(c => c !== ws)
    .map(c => clients.get(c)?.id)
    .filter(Boolean);
  ws.send(JSON.stringify({ type: 'peers', peers }));
}

function quitterRoom(ws, meta) {
  const room = meta.room;
  if (!room || !rooms.has(room)) return;
  rooms.get(room).delete(ws);
  if (rooms.get(room).size === 0) rooms.delete(room);
  broadcastToRoom(room, JSON.stringify({
    type: 'presence', action: 'leave',
    peerId: meta.id, ip: ws.__ip, ipDeclared: ws.__ipDeclared || '',
    nick: ws.__nick || ''
  }), ws);
}

/* ==========================================================================
 * Admission et débit
 * ========================================================================== */

/**
 * Seau à jetons : `capacite` d'avance, rechargé de `parSeconde`. Renvoie le
 * temps d'attente (ms) que mérite la consommation `cout`, 0 si elle passe.
 */
function seau(capacite, parSeconde) {
  let jetons = capacite;
  let instant = Date.now();
  return (cout) => {
    const maintenant = Date.now();
    jetons = Math.min(capacite, jetons + (maintenant - instant) * parSeconde / 1000);
    instant = maintenant;
    jetons -= cout;
    return jetons >= 0 ? 0 : Math.ceil(-jetons * 1000 / parSeconde);
  };
}

/**
 * Cesse de lire la connexion `ms` millisecondes : ce que le client envoie
 * attend dans les tampons TCP, et il ralentit de lui-même. Rien n'est perdu.
 */
function freiner(ws, ms) {
  if (ms <= 0 || ws.readyState !== WebSocket.OPEN) return;
  const fin = Date.now() + ms;
  if (ws.__frein && ws.__frein >= fin) return;
  ws.__frein = fin;
  ws.pause();
  clearTimeout(ws.__minuteurFrein);
  ws.__minuteurFrein = setTimeout(() => {
    ws.__frein = 0;
    if (ws.readyState === WebSocket.OPEN) ws.resume();
  }, ms);
}

/** Refus clair, puis fermeture : le client l'explique au lieu de réessayer en boucle. */
function refuser(ws, code, raison, message, reessayerDans = null) {
  try { ws.send(JSON.stringify({ type: 'refus-connexion', raison, message, reessayerDans })); } catch {}
  ws.close(code, raison);
}

/**
 * Peut-on accueillir cette connexion ? Le total d'abord, puis l'adresse.
 * `ip` null : client local sans proxy (la machine du serveur elle-même), qui
 * n'a que le plafond global.
 */
function admission(ip) {
  if (clients.size >= LIMITES.clients) {
    return { code: FERMETURE.plein, raison: 'serveur-plein',
      message: `Le serveur est plein (${LIMITES.clients} personnes). Réessayez dans quelques minutes.`, reessayerDans: 60 };
  }
  if (!ip) return null;
  const maintenant = Date.now();
  const recentes = (arriveesParIp.get(ip) || []).filter((t) => maintenant - t < 60000);
  recentes.push(maintenant);   // chaque tentative compte, refusée ou non
  arriveesParIp.set(ip, recentes);
  if ((connexionsParIp.get(ip) || 0) >= LIMITES.parIp) {
    return { code: FERMETURE.tropDeConnexions, raison: 'trop-de-connexions',
      message: `Déjà ${LIMITES.parIp} connexions depuis votre adresse : fermez-en une avant d'en ouvrir une autre.`, reessayerDans: 60 };
  }
  if (recentes.length > LIMITES.arriveesParMinute) {
    const attente = Math.ceil((60000 - (maintenant - recentes[recentes.length - LIMITES.arriveesParMinute - 1])) / 1000);
    return { code: FERMETURE.tropDeConnexions, raison: 'trop-de-connexions',
      message: `Trop de connexions en une minute depuis votre adresse (${LIMITES.arriveesParMinute} au plus). Réessayez dans ${attente} s.`,
      reessayerDans: Math.max(attente, 5) };
  }
  return null;
}

// Les arrivées de plus d'une minute ne comptent plus : on oublie.
setInterval(() => {
  const maintenant = Date.now();
  for (const [ip, instants] of arriveesParIp) {
    const recentes = instants.filter((t) => maintenant - t < 60000);
    if (recentes.length) arriveesParIp.set(ip, recentes); else arriveesParIp.delete(ip);
  }
}, 60000).unref();

// Heartbeat : coupe les connexions mortes (réseau perdu sans fermeture).
function heartbeat() {
  wss.clients.forEach((ws) => {
    const meta = clients.get(ws);
    if (!meta) return;
    if (!meta.isAlive) {
      try { ws.terminate(); } catch (_) {}
      return;
    }
    meta.isAlive = false;
    clients.set(ws, meta);
    try { ws.ping(); } catch (_) {}
  });
}
setInterval(heartbeat, 30000);

// Upgrade HTTP -> WS
server.on('upgrade', (request, socket, head) => {
  // Une connexion coupée en pleine poignée de main ne doit rien faire tomber.
  socket.on('error', () => {});
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

// Dernier filet : une erreur réseau imprévue sur une connexion se journalise,
// elle n'arrête jamais le serveur de tous les autres.
wss.on('error', (e) => console.warn('[WS] erreur du serveur WebSocket :', e.message));
server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch {} });

wss.on('connection', (ws, req) => {
  // Trame invalide, message trop long, UTF-8 malformé : la bibliothèque ferme
  // la connexion et émet une erreur. Sans écouteur, cette erreur arrêtait le
  // serveur entier — une seule trame piégée coupait Castunn pour tout le
  // monde. En premier : une connexion refusée peut aussi en envoyer une.
  ws.on('error', (e) => {
    console.warn(`[WS] connexion id=${ws.__id || '?'} fermée sur erreur : ${e.code || e.message}`);
  });

  // IP vue par le serveur : IP LAN en direct, IP publique derrière un proxy.
  // null si on ne voit que du loopback (reverse proxy sans X-Forwarded-For) :
  // dans ce cas on attend que le client annonce lui-même son IP (join/announce),
  // pour l'affichage seulement — jamais pour les limites.
  const ip = clientIpFromRequest(req);

  const refus = admission(ip);
  if (refus) {
    console.log(`[WS] connexion refusée (${refus.raison}) ip=${ip || '(locale)'}`);
    refuser(ws, refus.code, refus.raison, refus.message, refus.reessayerDans);
    return;
  }
  ws.__ipLimite = ip;   // l'adresse qui compte pour les limites, figée
  if (ip) connexionsParIp.set(ip, (connexionsParIp.get(ip) || 0) + 1);

  const id = makeId();
  ws.__id = id;
  clients.set(ws, { id, room: null, awaitingBinaryMeta: null, blobAnnounced: false, isAlive: true });
  byId.set(id, ws);

  ws.__ip = ip || '';
  ws.__ipTrusted = !!ip; // une IP annoncée par le client ne doit pas écraser celle-ci
  // Adresse que le client dit avoir. Elle ne remplace jamais `__ip` (elle est
  // déclarative, donc falsifiable), mais elle est relayée telle quelle : un pair
  // arrivé en IPv6 annonce son IPv4, et les interfaces préfèrent montrer celle-ci.
  ws.__ipDeclared = '';

  const debitOctets = seau(LIMITES.debit, LIMITES.debit);
  const debitMessages = seau(LIMITES.messages * 3, LIMITES.messages);

  ws.send(JSON.stringify({ type: 'hello', peerId: id, version: VERSION, capacites: CAPACITES }));

  console.log(`[WS] + Client connecté id=${ws.__id} ip=${ip || '(inconnue)'}`);
  if (!ip) {
    // Diagnostic : derrière quel proxy sommes-nous, et que pose-t-il ?
    const seen = Object.keys(req.headers).filter(h => /forward|client-ip|real-ip/i.test(h));
    console.log(`[WS]   pas d'IP côté serveur (socket=${req.socket.remoteAddress}) ; en-têtes de proxy vus : ${seen.length ? seen.join(', ') : 'aucun'} — on attendra celle annoncée par le client.`);
  }

  ws.on('pong', () => {
    const meta = clients.get(ws);
    if (!meta) return;
    meta.isAlive = true;
    clients.set(ws, meta);
  });

  ws.on('message', (message, isBinary) => {
    const meta = clients.get(ws);
    if (!meta) return;

    // Débit : au-delà d'1 Mo/s ou de 100 messages/s, on cesse de lire ce
    // client le temps qu'il faut. Le message reçu est traité normalement.
    freiner(ws, Math.max(debitOctets(message.length), debitMessages(1)));

    const room = roomOf(ws);

    // === BINAIRE : morceaux d'un fichier, relayés aux destinataires annoncés ===
    if (isBinary) {
      if (!room) return;   // rien ne circule hors d'une salle
      const payload = message; // Buffer
      // Envoi adressé (maillage) : seulement aux pairs que le P2P ne dessert pas.
      const cibles = meta.awaitingBinaryMeta?.to
        ? destinataires(ws, meta.awaitingBinaryMeta.to)
        : [...(rooms.get(room) || [])].filter((c) => c !== ws && c.readyState === WebSocket.OPEN);
      // Si un méta binaire a été annoncé, l'envoyer d'abord (une seule fois)
      if (meta.awaitingBinaryMeta && !meta.blobAnnounced) {
        const announce = JSON.stringify({
          type: 'binary-meta',
          from: meta.id,  // le récepteur range le transfert par émetteur
          filename: meta.awaitingBinaryMeta.filename,
          size: meta.awaitingBinaryMeta.size,
          mime: meta.awaitingBinaryMeta.mime,
          kind: meta.awaitingBinaryMeta.kind,
          fileId: meta.awaitingBinaryMeta.fileId,
          offset: meta.awaitingBinaryMeta.offset
        });
        cibles.forEach((c) => c.send(announce));
        meta.blobAnnounced = true;
        clients.set(ws, meta);
      }
      cibles.forEach((c) => relayerBinaire(c, payload, meta.id));
      // Un destinataire lent : l'émetteur attend qu'il rattrape, au lieu de
      // remplir la mémoire du serveur.
      if (cibles.some((c) => c.bufferedAmount > LIMITES.tamponDestinataire)) freiner(ws, 200);
      return;
    }

    // === TEXTE JSON ===
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;   // ce n'est pas du JSON : rien à relayer
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    // L'émetteur est celui de la socket, jamais celui que le message prétend :
    // sinon n’importe qui pourrait envoyer un « stop » au nom d’un autre.
    data.from = meta.id;

    // Hors d'une salle, on ne fait qu'y entrer.
    if (!room && data.type !== 'join') return;

    // Message applicatif adressé (maillage) : seulement aux pairs désignés.
    if (data.to !== undefined && data.to !== null && !TYPES_SERVEUR.has(data.type)) {
      const out = JSON.stringify(data);
      destinataires(ws, data.to).forEach((c) => c.send(out));
      return;
    }

    switch (data.type) {
      case 'binary-meta': {
        meta.awaitingBinaryMeta = {
          filename: borne(data.filename, 255) || 'fichier',
          size: Number(data.size) || 0,
          mime: borne(data.mime, 100) || 'application/octet-stream',
          kind: borne(data.kind, 16) || 'file',
          fileId: borne(String(data.fileId ?? ''), 64),
          offset: Number(data.offset) || 0,
          // Destinataires de l’envoi (maillage) ; null = toute la room.
          to: (data.to === undefined || data.to === null) ? null
            : (Array.isArray(data.to) ? data.to : [data.to]).slice(0, LIMITES.clients).map(String),
        };
        meta.blobAnnounced = false;
        clients.set(ws, meta);
        break;
      }
      case 'binary-end':
      case 'binary-cancel': {
        // Fin ou annulation d’un envoi : aux mêmes destinataires que lui.
        const cibles = meta.awaitingBinaryMeta?.to ? destinataires(ws, meta.awaitingBinaryMeta.to) : null;
        meta.awaitingBinaryMeta = null;
        meta.blobAnnounced = false;
        clients.set(ws, meta);
        const endMsg = JSON.stringify({ type: data.type, fileId: borne(String(data.fileId ?? ''), 64), from: meta.id });
        if (cibles) cibles.forEach((c) => c.send(endMsg));
        else broadcastToRoom(room, endMsg, ws);
        break;
      }

      // --- Présence / rooms ---
      case 'join': {
        // Une seule version admise : un client différent (ou trop ancien pour
        // en annoncer une) est refusé, avec de quoi l'expliquer, puis déconnecté.
        if (data.version !== VERSION) {
          const client = typeof data.version === 'string' ? data.version.slice(0, 32) : null;
          console.log(`[WS] client id=${meta.id} refusé : version ${client || 'non annoncée (trop ancienne)'}, serveur ${VERSION}`);
          ws.send(JSON.stringify({ type: 'version-refusee', serveur: VERSION, client }));
          ws.close(FERMETURE.version, `Castunn ${VERSION} requis`);
          break;
        }
        const salle = typeof data.room === 'string' ? data.room : '';
        if (!salleValide(salle)) {
          console.log(`[WS] client id=${meta.id} refusé : salle ${SALLE_LIBRE ? 'invalide' : 'commune ou invalide'}`);
          ws.send(JSON.stringify({ type: 'salle-refusee', salleLibre: SALLE_LIBRE }));
          ws.close(FERMETURE.salle, 'salle privée requise');
          break;
        }
        // Mémorise le nick, et l'IP annoncée par le client SEULEMENT si le serveur
        // n'a pas pu déterminer une IP fiable (cas du reverse proxy → "::1").
        if (typeof data.nick === 'string') ws.__nick = borne(data.nick.trim(), LIMITES.pseudo);
        // Un client récent demande les envois binaires signés de leur émetteur.
        ws.__binaireSigne = Array.isArray(data.capacites) && data.capacites.includes('binaire-signe');
        if (data.ip) ws.__ipDeclared = normalizeIp(String(data.ip)) || '';
        if (!ws.__ipTrusted && ws.__ipDeclared) ws.__ip = ws.__ipDeclared;
        joinRoom(ws, salle);
        break;
      }

      // --- Annonce d'identité (IP publique récupérée tardivement, pseudo modifié) ---
      case 'announce': {
        if (typeof data.nick === 'string') ws.__nick = borne(data.nick.trim(), LIMITES.pseudo);
        if (data.ip) ws.__ipDeclared = normalizeIp(String(data.ip)) || '';
        if (!ws.__ipTrusted && ws.__ipDeclared) ws.__ip = ws.__ipDeclared;
        broadcastToRoom(room, JSON.stringify({
          type: 'announce', from: meta.id, ip: ws.__ip || '',
          ipDeclared: ws.__ipDeclared || '', nick: ws.__nick || ''
        }), ws);
        break;
      }
      case 'leave': {
        quitterRoom(ws, meta);
        clients.set(ws, { ...meta, room: null });
        break;
      }

      // --- Tchat : à la salle, sans l'émetteur. Le nom affiché est celui que
      // les pairs connaissent (identité relayée par le serveur), jamais un nom
      // choisi par l'émetteur : personne ne parle au nom d'un autre. ---
      case 'chat': {
        broadcastToRoom(room, JSON.stringify({
          type: 'chat', from: meta.id, text: borne(data.text, LIMITES.tchat)
        }), ws);
        break;
      }

      // --- Signalisation WebRTC : toujours adressée, et dans la salle ---
      case 'offer':       // {type:'offer', to, sdp}
      case 'answer':      // {type:'answer', to, sdp}
      case 'ice':         // {type:'ice', to, candidate}
      case 'pong': {      // {type:'pong', to, id}
        if (typeof data.to !== 'string') break;
        const out = JSON.stringify(data);
        destinataires(ws, data.to).forEach((c) => c.send(out));
        break;
      }

      // --- Ping applicatif : à la salle, sans l’émetteur ---
      case 'ping': {
        broadcastToRoom(room, JSON.stringify({ type: 'ping', id: borne(String(data.id ?? ''), 64), from: meta.id }), ws);
        break;
      }

      // --- Identifiants TURN neufs : ceux de l'entrée en salle expirent sur une longue session ---
      case 'ice-config': {
        // Toujours répondu à l’émetteur seul, jamais relayé à la room.
        const maintenant = Date.now();
        // Le calcul est bon marché, mais un client modifié pourrait marteler :
        // une demande toutes les 10 s suffit largement à un usage normal.
        if (maintenant - (ws.__iceConfigAt || 0) < 10000) break;
        ws.__iceConfigAt = maintenant;
        ws.send(JSON.stringify({ type: 'ice-config', ...(configIce(meta.id) || { iceServers: [], iceExpiresAt: null }) }));
        break;
      }

      // Messages d'application (média, sync, stop, confirmation…) : à la salle.
      default: {
        broadcastToRoom(room, JSON.stringify(data), ws);
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(ws.__minuteurFrein);
    const meta = clients.get(ws);
    if (!meta) return;
    quitterRoom(ws, meta);
    clients.delete(ws);
    byId.delete(meta.id);
    if (ws.__ipLimite) {
      const n = (connexionsParIp.get(ws.__ipLimite) || 1) - 1;
      if (n > 0) connexionsParIp.set(ws.__ipLimite, n); else connexionsParIp.delete(ws.__ipLimite);
    }
    console.log(`[WS] - Client déconnecté id=${meta.id} ip=${ws.__ip}`);
  });
});

const PORT = process.env.PORT || 8080;
// Pas d'hôte précisé => écoute sur toutes les interfaces (LAN inclus).
server.listen(PORT, () => {
  console.log(`Serveur HTTP+WS prêt sur : ${PORT}`);
  for (const addr of localIPv4s()) {
    console.log(`[LAN] joignable sur ws://${addr}:${PORT}`);
  }
  console.log(`[Castunn] v${VERSION} — ${SALLE_LIBRE ? 'salle commune « default » permise (réseau de confiance)' : 'salles privées seulement'} ;`
    + ` ${LIMITES.clients} clients au plus, ${LIMITES.parIp} par IP, ${LIMITES.arriveesParMinute} nouvelles connexions/min par IP,`
    + ` ${Math.round(LIMITES.debit / 1024)} Kio/s par client.`);
  // Une configuration à moitié faite ne doit pas échouer en silence.
  const ignorees = TURN_URLS_BRUTES.filter((u) => !TURN_URLS.includes(u));
  if (ignorees.length) console.warn(`[TURN] URL ignorée(s), ni turn: ni turns: : ${ignorees.join(', ')}`);
  if (TURN_ACTIF) {
    console.log(`[TURN] relais annoncé aux clients : ${TURN_URLS.join(', ')} (identifiants valables ${TURN_TTL} s)`);
  } else if (TURN_URLS.length && !TURN_SECRET) {
    console.warn('[TURN] TURN_URLS sans TURN_SECRET : aucun relais annoncé.');
  } else if (TURN_SECRET && !TURN_URLS.length) {
    console.warn('[TURN] TURN_SECRET sans URL valable : aucun relais annoncé.');
  }
});

server.on('error', (err) => {
  console.error(`[FATAL] Impossible d'écouter sur le port ${PORT} : ${err.code || err.message}`);
  process.exit(1);
});
