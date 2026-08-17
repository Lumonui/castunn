// test/helpers.js
// Petite boîte à outils pour les tests d'intégration : aucun framework,
// juste de quoi lancer le serveur, brancher des clients et attendre un message.

const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const WebSocket = require('ws');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

/** Lance server.js sur un port dédié et attend qu'il soit prêt. */
function startServer(port, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(SERVER_PATH, [], {
      env: { ...process.env, PORT: String(port) },
      silent: true
    });

    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Le serveur n'a pas démarré en ${timeout}ms. Sortie :\n${out}`));
    }, timeout);

    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('prêt sur')) {
        clearTimeout(timer);
        resolve({
          child,
          port,
          stop: () => new Promise((r) => {
            if (child.exitCode !== null) return r();
            child.once('exit', () => r());
            child.kill();
          })
        });
      }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** GET HTTP simple -> { status, body }. */
function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * Client WebSocket de test : mémorise tout ce qui arrive et permet
 * d'attendre un message correspondant à un prédicat, y compris s'il est
 * déjà arrivé avant l'appel (d'où la file `received`).
 */
class TestClient {
  constructor(url, name) {
    this.name = name;
    this.received = [];   // { json?, binary? }
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      const entry = isBinary
        ? { binary: Buffer.from(data) }
        : (() => { try { return { json: JSON.parse(data.toString()) }; } catch { return { text: data.toString() }; } })();
      this.received.push(entry);
      this.waiters = this.waiters.filter((w) => !w.tryResolve(entry));
    });
  }

  open(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: connexion trop lente`)), timeout);
      this.ws.once('open', () => { clearTimeout(t); resolve(this); });
      this.ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }
  sendBinary(buf) { this.ws.send(buf, { binary: true }); }

  /** Attend un message satisfaisant `pred`, en regardant d'abord l'historique. */
  waitFor(pred, { timeout = 3000, label = 'message' } = {}) {
    const hit = this.received.find(pred);
    if (hit) return Promise.resolve(hit);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        const seen = this.received
          .map((e) => (e.json ? e.json.type : e.binary ? '<binaire>' : '<texte>'))
          .join(', ') || 'rien';
        reject(new Error(`${this.name}: "${label}" jamais reçu (${timeout}ms). Reçu : ${seen}`));
      }, timeout);

      const waiter = {
        tryResolve(entry) {
          if (!pred(entry)) return false;
          clearTimeout(timer);
          resolve(entry);
          return true;
        }
      };
      this.waiters.push(waiter);
    });
  }

  /** Attend un message JSON d'un type donné. */
  waitForType(type, extraPred = () => true, opts = {}) {
    return this
      .waitFor((e) => e.json && e.json.type === type && extraPred(e.json), { label: type, ...opts })
      .then((e) => e.json);
  }

  /** Vérifie qu'AUCUN message ne satisfait `pred` pendant `ms`. */
  async expectNothing(pred, ms, label) {
    await sleep(ms);
    const hit = this.received.find(pred);
    if (hit) throw new Error(`${this.name}: reçu "${label}" alors que ce ne devait pas arriver : ${JSON.stringify(hit.json || hit)}`);
  }

  close() {
    return new Promise((r) => {
      if (this.ws.readyState === WebSocket.CLOSED) return r();
      this.ws.once('close', () => r());
      this.ws.close();
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connecte un client et récupère son peerId (message `hello`). */
async function connect(port, name) {
  const c = new TestClient(`ws://127.0.0.1:${port}`, name);
  await c.open();
  const hello = await c.waitForType('hello');
  c.peerId = hello.peerId;
  return c;
}

/**
 * Fait entrer un client dans une room ET attend la confirmation du serveur.
 *
 * Indispensable : sans cette attente, deux clients qui rejoignent "en même
 * temps" peuvent s'inverser. Celui qui arrive second reçoit alors le premier
 * dans sa liste `peers` au lieu d'un `presence`, et le test échoue par
 * intermittence — pas le code.
 */
async function joinRoom(client, room, extra = {}) {
  client.send({ type: 'join', room, ...extra });
  await client.waitForType('peers', () => true, { label: `entrée dans ${room}` });
  return client;
}

/* ---- micro-runner : suffisant, et zéro dépendance ---- */

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${e.message.replace(/\n/g, '\n       ')}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passés.`);
  return failed;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion échouée');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'valeurs différentes'} — attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(actual)}`);
  }
}

module.exports = { startServer, httpGet, TestClient, connect, joinRoom, sleep, test, run, assert, assertEqual };
