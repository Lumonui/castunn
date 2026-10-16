// server.js
// HTTP + WS pour Render + Signalisation WebRTC + Fallback binaire existant

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
// Code de fermeture d'une connexion refusée pour version différente.
const FERMETURE_VERSION = 4009;

const app = express();

// Petit endpoint santé (utile pour Render)
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
const wss = new WebSocketServer({ noServer: true });

/** Etat serveur **/
const clients = new Map(); // ws -> { id, room, awaitingBinaryMeta, blobAnnounced, isAlive }
const byId = new Map();    // id -> ws
const rooms = new Map();   // room -> Set<ws>

/* ==========================================================================
 * Relais TURN (facultatif)
 *
 * Quand la connexion directe échoue (NAT symétrique, 4G, réseau
 * d'entreprise…), un relais TURN fait transiter le flux. Ce serveur n'en
 * héberge pas : il distribue des identifiants temporaires pour celui qu'on
 * lui indique.
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
 * identifiants interceptés expirent seuls.
 *
 * Sans TURN_URLS ET TURN_SECRET, rien n'est annoncé — c'est le cas du
 * serveur local du réseau domestique, où un relais ne servirait à rien.
 *
 * Un Cloudflare Worker ne peut pas héberger de TURN (pas d'UDP). Pour en
 * servir un depuis un Worker, il faudrait un service TURN managé dont le
 * Worker obtiendrait les identifiants par API : non implémenté, mais le
 * format envoyé au client (iceServers, iceExpiresAt) serait le même.
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

// Génère un ID simple si le client n’en fournit pas
const makeId = () => Math.random().toString(36).slice(2, 10);

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

/** Adresse client la plus fiable disponible côté serveur. */
function clientIpFromRequest(req) {
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
  wss.clients.forEach((c) => {
    if (c !== excludeWs && c.readyState === WebSocket.OPEN && roomOf(c) === room) {
      if (forceBinary) c.send(data, { binary: true });
      else c.send(data);
    }
  });
}
/**
 * Pairs désignés par `to` (un identifiant ou une liste), limités à la room
 * de l'émetteur : un message adressé ne doit jamais franchir une room.
 */
function destinataires(ws, to) {
  const room = roomOf(ws);
  if (!room) return [];
  const ids = (Array.isArray(to) ? to : [to]).map(String);
  return ids
    .map((id) => byId.get(id))
    .filter((c) => c && c !== ws && c.readyState === WebSocket.OPEN && roomOf(c) === room);
}

/**
 * Envoi binaire relayé, signé de son émetteur pour les clients qui l’ont
 * demandé : [0xCA, longueur, identifiant ASCII…, données]. Sans signature,
 * deux envois simultanés par le WebSocket se mélangeaient chez le
 * récepteur, sans moyen de les démêler. Un client ancien, qui ne l’a pas
 * demandé, reçoit les données brutes comme avant.
 */
function relayerBinaire(c, payload, emetteurId) {
  if (!c.__binaireSigne) { c.send(payload, { binary: true }); return; }
  const id = Buffer.from(String(emetteurId), 'ascii');
  c.send(Buffer.concat([Buffer.from([0xCA, id.length]), id, payload]), { binary: true });
}

// Ce que ce serveur sait faire en plus du protocole d’origine. Un client
// récent s’y adapte, un ancien ignore le champ.
const CAPACITES = ['adressage', 'binaire-signe'];

// Types que le serveur traite lui-même : jamais routés par `to` génériquement.
const TYPES_SERVEUR = new Set([
  'join', 'announce', 'leave', 'ice-config', 'chat',
  'offer', 'answer', 'ice', 'ping', 'pong',
  'binary-meta', 'binary-end', 'binary-cancel'
]);

function sendToId(id, data) {
  const target = byId.get(id);
  if (target && target.readyState === WebSocket.OPEN) target.send(data);
}
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

// Heartbeat (utile sur Render pour couper les zombies)
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

// Upgrade HTTP -> WS (obligatoire sur Render)
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

wss.on('connection', (ws, req) => {
  const id = makeId();
  ws.__id = id;
  clients.set(ws, { id, room: null, awaitingBinaryMeta: null, blobAnnounced: false, isAlive: true });
  byId.set(id, ws);

  // IP vue par le serveur : IP LAN en direct, IP publique derrière un proxy.
  // null si on ne voit que du loopback (reverse proxy sans X-Forwarded-For) :
  // dans ce cas on attend que le client annonce lui-même son IP (join/announce).
  const ip = clientIpFromRequest(req);
  ws.__ip = ip || '';
  ws.__ipTrusted = !!ip; // une IP annoncée par le client ne doit pas écraser celle-ci
  // Adresse que le client dit avoir. Elle ne remplace jamais `__ip` (elle est
  // déclarative, donc falsifiable), mais elle est relayée telle quelle : un pair
  // arrivé en IPv6 annonce son IPv4, et les interfaces préfèrent montrer celle-ci.
  ws.__ipDeclared = '';

  // Accuse réception
  // Le relais TURN voyage avec le hello : le client le connaît avant même
  // d'entrer dans la room, donc avant toute connexion à établir.
  ws.send(JSON.stringify({
    type: 'hello', peerId: id, version: VERSION, capacites: CAPACITES, ...(configIce(id) || {})
  }));

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

    // === BINAIRE : conserve le comportement actuel (diffusion) ===
    if (isBinary) {
      const room = roomOf(ws);
      const payload = message; // Buffer
      // Envoi adressé (maillage) : seulement aux pairs que le P2P ne dessert pas.
      const cibles = meta.awaitingBinaryMeta?.to ? destinataires(ws, meta.awaitingBinaryMeta.to) : null;
      // Si un méta binaire a été annoncé, l'envoyer d'abord (une seule fois)
      if (meta.awaitingBinaryMeta && !meta.blobAnnounced) {
	    const announce = JSON.stringify({
		  type: 'binary-meta',
		  from: meta.id,  // le récepteur range le transfert par émetteur
		  filename: meta.awaitingBinaryMeta.filename,  // <- clé normalisée
		  size: meta.awaitingBinaryMeta.size,
		  mime: meta.awaitingBinaryMeta.mime,
		  kind: meta.awaitingBinaryMeta.kind,
		  fileId: meta.awaitingBinaryMeta.fileId,
		  offset: meta.awaitingBinaryMeta.offset
	  });
	  if (cibles) cibles.forEach((c) => c.send(announce));
	  else if (room) broadcastToRoom(room, announce, ws);
	  else {
		wss.clients.forEach((c) => {
		  if (c !== ws && c.readyState === WebSocket.OPEN) c.send(announce);
		});
	  }
	  meta.blobAnnounced = true;
	  clients.set(ws, meta);
        console.log('[BINAIRE] Annonce envoyée');
      }
      if (cibles) {
        cibles.forEach((c) => relayerBinaire(c, payload, meta.id));
      } else if (room) {
        wss.clients.forEach((c) => {
          if (c !== ws && c.readyState === WebSocket.OPEN && roomOf(c) === room) relayerBinaire(c, payload, meta.id);
        });
		} else {
		  wss.clients.forEach((c) => {
			if (c !== ws && c.readyState === WebSocket.OPEN) c.send(payload, { binary: true }); // déjà ok
		  });
		}
      return;
    }

    // === TEXTE JSON ===
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      // Si ce n’est pas du JSON, on peut diffuser comme avant (tchat global)
      wss.clients.forEach((c) => {
        if (c !== ws && c.readyState === WebSocket.OPEN) c.send(message);
      });
      return;
    }

    // L'émetteur est celui de la socket, jamais celui que le message prétend :
    // sinon n’importe qui pourrait envoyer un « stop » au nom d’un autre.
    data.from = meta.id;

    // Message applicatif adressé (maillage) : seulement aux pairs désignés.
    if (data.to !== undefined && data.to !== null && !TYPES_SERVEUR.has(data.type)) {
      const out = JSON.stringify(data);
      destinataires(ws, data.to).forEach((c) => c.send(out));
      return;
    }

    switch (data.type) {
      // --- Gestion "app" existante ---
      case 'binary-meta': {
		  meta.awaitingBinaryMeta = {
			filename: data.filename || 'fichier',   // <- clé normalisée
			size: data.size || 0,
			mime: data.mime || 'application/octet-stream',
			kind: data.kind || 'file',
			fileId: data.fileId,
			offset: data.offset || 0,
			// Destinataires de l’envoi (maillage) ; null = toute la room, comme avant.
			to: (data.to === undefined || data.to === null) ? null
			  : (Array.isArray(data.to) ? data.to : [data.to]).map(String),
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
        const room = roomOf(ws);
        const endMsg = JSON.stringify({ type: data.type, fileId: data.fileId, from: meta.id });
        if (cibles) cibles.forEach((c) => c.send(endMsg));
        else if (room) broadcastToRoom(room, endMsg, ws);
        else wss.clients.forEach((c) => c !== ws && c.readyState === WebSocket.OPEN && c.send(endMsg));
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
		  ws.close(FERMETURE_VERSION, `Castunn ${VERSION} requis`);
		  break;
		}
		const room = String(data.room || 'default');
		// Mémorise le nick, et l'IP annoncée par le client SEULEMENT si le serveur
		// n'a pas pu déterminer une IP fiable (cas du reverse proxy → "::1").
		if (data.nick) ws.__nick = data.nick;
		// Un client récent demande les envois binaires signés de leur émetteur.
		ws.__binaireSigne = Array.isArray(data.capacites) && data.capacites.includes('binaire-signe');
		if (data.ip) ws.__ipDeclared = normalizeIp(String(data.ip)) || '';
		if (!ws.__ipTrusted && data.ip) ws.__ip = String(data.ip);
		joinRoom(ws, room);
		break;
	  }

      // --- Annonce d'identité (IP publique récupérée tardivement, pseudo modifié) ---
      case 'announce': {
		if (typeof data.nick === 'string') ws.__nick = data.nick;
		if (data.ip) ws.__ipDeclared = normalizeIp(String(data.ip)) || '';
		if (!ws.__ipTrusted && data.ip) ws.__ip = String(data.ip);
		const room = roomOf(ws);
		const out = JSON.stringify({
		  type: 'announce', from: meta.id, ip: ws.__ip || '',
		  ipDeclared: ws.__ipDeclared || '', nick: ws.__nick || ''
		});
		if (room) broadcastToRoom(room, out, ws);
		else wss.clients.forEach((c) => c !== ws && c.readyState === WebSocket.OPEN && c.send(out));
		break;
	  }
      case 'leave': {
		  const ip = ws.__ip;              // <-- capture avant
		  const room = roomOf(ws);
		  if (room && rooms.has(room)) {
			rooms.get(room).delete(ws);
			if (rooms.get(room).size === 0) rooms.delete(room);
			broadcastToRoom(room, JSON.stringify({
			  type: 'presence', action: 'leave',
			  peerId: meta.id, ip: ip, ipDeclared: ws.__ipDeclared || '',
			  nick: ws.__nick || ''
			}), ws);
		  }
		  clients.set(ws, { ...meta, room: null });
		  break;
		}

      // --- Tchat (par room sinon global) ---
      case 'chat': {
		  // data.text : contenu; data.fromName : "IP(pseudo)" envoyé par le client
		  const out = JSON.stringify({
			type: 'chat',
			from: meta.id, // id serveur du sender
			fromName: (typeof data.fromName === 'string' && data.fromName.trim())
			  ? data.fromName.trim()
			  : undefined,
			text: (typeof data.text === 'string' ? data.text : '')
		  });

		  const room = roomOf(ws); // ta fonction qui récupère la room du socket
		  if (room) {
			// Diffuse à la room en EXCLUANT l'émetteur
			broadcastToRoom(room, out, ws);
		  } else {
			// fallback si pas de rooms
			wss.clients.forEach((c) => {
			  if (c !== ws && c.readyState === WebSocket.OPEN) c.send(out);
			});
		  }
		  break;
		}

      // --- Signalisation WebRTC ---
      case 'offer':       // {type:'offer', to, sdp}
      case 'answer':      // {type:'answer', to, sdp}
      case 'ice': {       // {type:'ice', to, candidate}
        if (!data.to) {
          // Si pas de "to", on peut diffuser aux pairs de la room (hors soi), utile pour découverte
          const room = roomOf(ws);
          if (room) {
            broadcastToRoom(room, JSON.stringify(data), ws);
          }
        } else {
          sendToId(data.to, JSON.stringify(data));
        }
        break;
      }

      // --- Ping applicatif (optionnel) ---
      case 'ping': {
		  // relayer aux autres clients de la room, sans renvoyer à l’émetteur
		  const room = roomOf(ws);
		  const out = JSON.stringify({ type:'ping', id: data.id, from: meta.id });
		  if (room) broadcastToRoom(room, out, ws);
		  else wss.clients.forEach(c => c!==ws && c.readyState===WebSocket.OPEN && c.send(out));
		  break;
	  }

	  // --- Identifiants TURN neufs : ceux du hello expirent sur une longue session ---
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

	  case 'pong': {
		  // router au destinataire (champ "to")
		  if (data.to) sendToId(data.to, JSON.stringify({ ...data, from: meta.id }));
		  break;
	  }
	  
	  case 'sync': {
		// { type:'sync', action:'play'|'pause'|'seek', time: number }
		const room = roomOf(ws);
		if (!room) break;
		broadcastToRoom(room, JSON.stringify({ ...data, from: meta.id }), ws);
		break;
	  }

      // Inconnu => diffuse comme avant (compat)
      default: {
        const room = roomOf(ws);
        if (room) broadcastToRoom(room, JSON.stringify(data), ws);
        else wss.clients.forEach((c) => c !== ws && c.readyState === WebSocket.OPEN && c.send(JSON.stringify(data)));
      }
    }
  });

  ws.on('close', () => {
	  const meta = clients.get(ws);
	  const ip = ws.__ip;              // <-- capture avant
	  if (!meta) return;
	  const room = meta.room;
	  if (room && rooms.has(room)) {
		rooms.get(room).delete(ws);
		if (rooms.get(room).size === 0) rooms.delete(room);
		broadcastToRoom(room, JSON.stringify({
		  type: 'presence', action: 'leave',
		  peerId: meta.id, ip: ip, ipDeclared: ws.__ipDeclared || '',
		  nick: ws.__nick || ''
		  }), ws);
	  }
	  clients.delete(ws);
	  byId.delete(meta.id);
	  console.log(`[WS] - Client déconnecté id=${meta.id} ip=${ip}`);
	});
});

const PORT = process.env.PORT || 8080;
// Pas d'hôte précisé => écoute sur toutes les interfaces (LAN inclus).
server.listen(PORT, () => {
  console.log(`Serveur HTTP+WS prêt sur : ${PORT}`);
  for (const addr of localIPv4s()) {
    console.log(`[LAN] joignable sur ws://${addr}:${PORT}`);
  }
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
