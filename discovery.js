// discovery.js
// Recherche d'un serveur Castunn sur le réseau local.
//
// Ce travail s'exécute dans un processus séparé, jamais dans le processus
// principal d'Electron : celui-ci gère la fenêtre, et le balayage ouvre des
// centaines de connexions TCP en quelques secondes. Fait au mauvais endroit,
// il fige l'interface au démarrage — c'est exactement ce qui se produisait.
//
// Utilisable de deux façons :
//   - comme module     : require('./discovery').discoverLanServers(opts)
//   - comme processus  : fork(...) puis process.send({ cmd:'discover', opts })

const os = require('os');
const net = require('net');
const http = require('http');

const DEFAULT_PORT = 8080;

const ipToInt = (ip) => ip.split('.').reduce((acc, o) => (acc << 8) + (Number(o) & 255), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** Adresses IPv4 locales de cette machine (hors loopback). */
function localIPv4s() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * Hôtes à tester, dérivés des interfaces IPv4 actives.
 * Les adresses proches de la nôtre viennent en premier : sur un réseau
 * domestique, les machines sont presque toujours voisines dans le plan
 * d'adressage, ce qui raccourcit beaucoup la recherche en pratique.
 */
function candidateHosts() {
  const hosts = [];
  const seen = new Set();

  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;

      const mask = ipToInt(a.netmask);
      // Nombre de bits d'hôte ; au-delà d'un /22 (1022 hôtes) on renonce.
      const hostBits = 32 - mask.toString(2).split('').filter((b) => b === '1').length;
      if (hostBits < 1 || hostBits > 10) continue;

      const self = ipToInt(a.address);
      const network = (self & mask) >>> 0;
      const broadcast = (network | (~mask >>> 0)) >>> 0;

      const locaux = [];
      for (let n = network + 1; n < broadcast; n++) {
        if (n === self) continue; // notre propre serveur est testé via 127.0.0.1
        locaux.push(n);
      }
      // tri par distance à notre propre adresse
      locaux.sort((x, y) => Math.abs(x - self) - Math.abs(y - self));

      for (const n of locaux) {
        const ip = intToIp(n);
        if (seen.has(ip)) continue;
        seen.add(ip);
        hosts.push(ip);
      }
    }
  }
  return hosts;
}

/** Test TCP rapide : le port est-il ouvert ? */
function tcpProbe(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Confirme qu'un port ouvert est bien un serveur Castunn (et pas autre chose). */
function castunnProbe(host, port, timeout) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/castunn', timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy(); // garde-fou
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body).app === 'castunn'); }
        catch { resolve(false); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function isCastunnHost(host, port, timeout) {
  if (!(await tcpProbe(host, port, timeout))) return false;
  return castunnProbe(host, port, timeout * 2);
}

/**
 * Balaye le réseau local. Renvoie la liste des "ip:port" trouvés.
 * @param {{port?:number, timeout?:number, concurrency?:number, stopAtFirst?:boolean, hosts?:string[]}} opts
 */
async function discoverLanServers(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const timeout = opts.timeout || 400;
  const concurrency = opts.concurrency || 64;
  const stopAtFirst = opts.stopAtFirst !== false;

  const found = [];

  // 1) Notre propre machine d'abord : cas le plus fréquent, et instantané.
  if (await isCastunnHost('127.0.0.1', port, timeout)) {
    found.push(`127.0.0.1:${port}`);
    if (stopAtFirst) return found;
  }

  // 2) Le reste du sous-réseau, en parallèle borné.
  const hosts = opts.hosts || candidateHosts();
  let cursor = 0;
  let done = false;

  const worker = async () => {
    while (!done) {
      const i = cursor++;
      if (i >= hosts.length) return;
      if (await isCastunnHost(hosts[i], port, timeout)) {
        found.push(`${hosts[i]}:${port}`);
        if (stopAtFirst) done = true;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

module.exports = { discoverLanServers, candidateHosts, localIPv4s, isCastunnHost };

// --- Mode processus détaché ------------------------------------------------
if (require.main === module || process.send) {
  process.on('message', async (msg) => {
    if (!msg || msg.cmd !== 'discover') return;
    try {
      const hosts = await discoverLanServers(msg.opts || {});
      process.send({ id: msg.id, ok: true, hosts });
    } catch (e) {
      process.send({ id: msg.id, ok: false, error: e.message });
    }
  });
}
