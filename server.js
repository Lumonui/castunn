// server.js
// HTTP + WS pour Render + Signalisation WebRTC + Fallback binaire existant

const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();

// Petit endpoint santé (utile pour Render)
app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/** Etat serveur **/
const clients = new Map(); // ws -> { id, room, awaitingBinaryMeta, blobAnnounced, isAlive }
const byId = new Map();    // id -> ws
const rooms = new Map();   // room -> Set<ws>

// Génère un ID simple si le client n’en fournit pas
const makeId = () => Math.random().toString(36).slice(2, 10);

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
    peerId: meta.id, ip: ws.__ip, nick: ws.__nick || ''
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

  // Accuse réception
  ws.send(JSON.stringify({ type: 'hello', peerId: id }));
  
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  ws.__ip = ip;
  console.log(`[WS] + Client connecté id=${ws.__id} ip=${ip}`);

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
      // Si un méta binaire a été annoncé, l'envoyer d'abord (une seule fois)
      if (meta.awaitingBinaryMeta && !meta.blobAnnounced) {
	    const announce = JSON.stringify({
		  type: 'binary-meta',
		  filename: meta.awaitingBinaryMeta.filename,  // <- clé normalisée
		  size: meta.awaitingBinaryMeta.size,
		  mime: meta.awaitingBinaryMeta.mime,
		  kind: meta.awaitingBinaryMeta.kind,
		  fileId: meta.awaitingBinaryMeta.fileId,
		  offset: meta.awaitingBinaryMeta.offset
	  });
	  if (room) broadcastToRoom(room, announce, ws);
	  else {
		wss.clients.forEach((c) => {
		  if (c !== ws && c.readyState === WebSocket.OPEN) c.send(announce);
		});
	  }
	  meta.blobAnnounced = true;
	  clients.set(ws, meta);
        console.log('[BINAIRE] Annonce envoyée');
      }
      if (room) {
		  broadcastToRoom(room, payload, ws, /*forceBinary=*/true); // ✅
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

    // Ajoute l’id émetteur si absent
    if (!data.from) data.from = meta.id;

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
		  };
		  meta.blobAnnounced = false;
		  clients.set(ws, meta);
		  break;
	  }
      case 'binary-end': {
        // Fin d’un envoi binaire
        meta.awaitingBinaryMeta = null;
        meta.blobAnnounced = false;
        clients.set(ws, meta);
        const room = roomOf(ws);
        const endMsg = JSON.stringify({ type: 'binary-end', fileId: data.fileId });
        if (room) broadcastToRoom(room, endMsg, ws);
        else wss.clients.forEach((c) => c !== ws && c.readyState === WebSocket.OPEN && c.send(endMsg));
        break;
      }

      // --- Présence / rooms ---
      case 'join': {
		const room = String(data.room || 'default');
		// AJOUT : mémoriser le nick et l'IP publique envoyée par le client
		if (data.nick) ws.__nick = data.nick;
		if (data.ip)   ws.__ip   = data.ip;   // préférer l'IP publique connue du client
		joinRoom(ws, room);
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
			  peerId: meta.id, ip: ip, nick: ws.__nick || ''
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
		  peerId: meta.id, ip: ip, nick: ws.__nick || ''
		  }), ws);
	  }
	  clients.delete(ws);
	  byId.delete(meta.id);
	  console.log(`[WS] - Client déconnecté id=${meta.id} ip=${ip}`);
	});
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Serveur HTTP+WS prêt sur : ${PORT}`);
});
