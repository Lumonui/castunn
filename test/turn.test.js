// test/turn.test.js
// Relais TURN de bout en bout : un vrai relais (node-turn), le vrai serveur de
// signalisation configuré pour l'annoncer, et de vraies pages Castunn.
//
//   npm run test:turn
//
// Le relais authentifie comme coturn en mode use-auth-secret : il recalcule
// HMAC-SHA1(secret, username) et refuse les identifiants expirés.
//
// Chromium ignore les relais TURN joignables seulement par 127.0.0.1 : relais
// et signalisation écoutent donc sur l'adresse du réseau local. Sans adresse
// de ce type (machine hors réseau), le test est sauté, et il le dit.

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');
const Turn = require('node-turn');
const { startServer } = require('./helpers');

const PROJECT = path.join(__dirname, '..');
const PORT_SIGNAL = Number(process.env.TEST_TURN_SIGNAL_PORT || 8094);
const PORT_RELAIS = Number(process.env.TEST_TURN_RELAY_PORT || 34780);
const SECRET = 'secret-du-relais-de-test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, { timeout = 10000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`"${label}" jamais atteint après ${timeout} ms`);
}

const results = [];
const fenetres = [];
async function check(nom, fn) {
  try { await fn(); results.push(true); console.log(`  ok   ${nom}`); }
  catch (e) {
    results.push(false);
    console.log(`  FAIL ${nom}\n       ${e.message}`);
    for (const [i, w] of fenetres.entries()) {
      try {
        const t = await w.webContents.executeJavaScript('document.getElementById("consoleLog").textContent');
        console.log(`       page ${i + 1} : ${t.split('\n').filter(Boolean).slice(-6).join(' | ')}`);
      } catch { /* fenêtre fermée */ }
    }
  }
}

function adresseLan() {
  for (const a of Object.values(os.networkInterfaces()).flat()) {
    if (a && a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/** Relais qui authentifie comme coturn « use-auth-secret ». */
function demarrerRelais(ip) {
  const credentials = new Proxy({}, {
    get: (_, username) => {
      if (typeof username !== 'string') return undefined;
      const expiration = Number(username.split(':')[0]);
      if (!expiration || expiration * 1000 < Date.now()) return undefined; // expiré : 401
      return crypto.createHmac('sha1', SECRET).update(username).digest('base64');
    }
  });
  const relais = new Turn({
    listeningPort: PORT_RELAIS,
    listeningIps: [ip],
    relayIps: [ip],
    authMech: 'long-term',
    realm: 'castunn.test',
    credentials,
    debugLevel: 'OFF'
  });
  relais.start();
  return relais;
}

async function ouvrirPage(ip, query = {}) {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  fenetres.push(win);
  await win.loadFile(path.join(PROJECT, 'castunn.html'), { query });
  await win.webContents.executeJavaScript(`localStorage.setItem('castunn.signalHost', '${ip}:${PORT_SIGNAL}'); true`);
  await win.webContents.reload();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  return win;
}

// Entre deux scénarios, toutes les pages sont fermées. Par défaut, Electron
// quitte alors de lui-même avec le code 0 : les scénarios suivants ne
// tournaient jamais, et la suite paraissait réussie.
app.on('window-all-closed', () => { /* on reste : la suite décide quand sortir */ });

const consoleDe = (w) => w.webContents.executeJavaScript('document.getElementById("consoleLog").textContent');
const fermerPages = () => { for (const w of fenetres.splice(0)) { try { w.destroy(); } catch {} } };

app.whenReady().then(async () => {
  console.log('\nRelais TURN (B1 → B3) contre un vrai relais\n');

  const ip = adresseLan();
  if (!ip) {
    console.log('  --   aucune adresse de réseau local : test sauté (Chromium ignore les relais en 127.0.0.1).');
    app.exit(0);
    return;
  }
  const relais = demarrerRelais(ip);
  const url = `turn:${ip}:${PORT_RELAIS}?transport=udp`;

  /* --- 1. Relais joignable, bons identifiants --------------------------- */
  let signal = await startServer(PORT_SIGNAL, { env: { TURN_URLS: url, TURN_SECRET: SECRET } });
  try {
    const a = await ouvrirPage(ip);

    await check('le relais annoncé par le serveur est reçu avec le hello', async () => {
      const log = await waitUntil(async () => {
        const t = await consoleDe(a); return t.includes('[TURN] relais annoncé') ? t : null;
      }, { label: 'annonce du relais' });
      if (!log.includes(url)) throw new Error('URL du relais absente : ' + log);
    });

    await check('la sonde obtient un candidat relais : « TURN disponible »', async () => {
      await waitUntil(async () => (await consoleDe(a)).includes(`[TURN] disponible (${url})`),
        { label: 'TURN disponible', timeout: 6000 });
    });

    const b = await ouvrirPage(ip);
    // Chromium cesse de collecter dès qu’une connexion directe tient : entre
    // deux pages de la même machine, le relais n’est jamais interrogé. On
    // vérifie donc la configuration remise à la vraie connexion ; le passage
    // effectif par le relais se teste en forçant le relais (?forceRelay=1).
    await check('la vraie connexion est créée avec le relais en plus des STUN', async () => {
      const urls = await waitUntil(() => a.webContents.executeJavaScript('window.__castunnIceUrls || null'),
        { label: 'connexion créée', timeout: 15000 });
      if (!urls.includes(url)) throw new Error('relais absent de la configuration : ' + JSON.stringify(urls));
      if (!urls.some((u) => u.startsWith('stun:'))) throw new Error('STUN absents : ' + JSON.stringify(urls));
    });

    await check('une collecte écourtée par le direct n’est pas prise pour une panne de STUN', async () => {
      const ligne = await waitUntil(async () => {
        const t = await consoleDe(a);
        return t.split('\n').find((l) => l.includes('[RTC] candidats locaux :')) || null;
      }, { label: 'ligne des candidats', timeout: 15000 });
      if (/aucune adresse publique/.test(ligne)) throw new Error('faux diagnostic : ' + ligne);
      if (!/connexion directe déjà établie/.test(ligne)) throw new Error('écourtement non signalé : ' + ligne);
    });

    await check('le relais disponible ne détourne pas une connexion directe possible', async () => {
      const ligne = (await consoleDe(a)).split('\n').find((l) => l.includes('[RTC] chemin :')) || '';
      if (!ligne) throw new Error('chemin non journalisé');
      if (/relay/.test(ligne)) throw new Error('relais choisi alors que le direct marche : ' + ligne);
      const pastille = await a.webContents.executeJavaScript('document.getElementById("rtcStatus").textContent');
      if (pastille !== 'Connecté') throw new Error('pastille : ' + pastille);
    });
    void b;
  } finally { fermerPages(); await signal.stop(); }

  /* --- 2. Secret différent de celui du relais --------------------------- */
  signal = await startServer(PORT_SIGNAL, { env: { TURN_URLS: url, TURN_SECRET: 'pas-le-bon-secret' } });
  try {
    const a = await ouvrirPage(ip);
    await check('un secret différent est diagnostiqué : identifiants refusés (401)', async () => {
      const log = await waitUntil(async () => {
        const t = await consoleDe(a); return t.includes('[TURN] annoncé mais injoignable') ? t : null;
      }, { label: 'diagnostic d’échec', timeout: 8000 });
      if (!log.includes('401')) throw new Error('le 401 devait être nommé : ' + log.split('\n').filter((l) => l.includes('[TURN]')).join(' | '));
    });
  } finally { fermerPages(); await signal.stop(); }

  /* --- 3. Relais annoncé mais éteint ------------------------------------ */
  signal = await startServer(PORT_SIGNAL, {
    env: { TURN_URLS: `turn:${ip}:${PORT_RELAIS + 1}?transport=udp`, TURN_SECRET: SECRET }
  });
  try {
    const a = await ouvrirPage(ip);
    await check('un relais éteint est signalé injoignable en quelques secondes', async () => {
      const t0 = Date.now();
      await waitUntil(async () => (await consoleDe(a)).includes('[TURN] annoncé mais injoignable'),
        { label: 'diagnostic d’échec', timeout: 8000 });
      const duree = Date.now() - t0;
      if (duree > 6000) throw new Error(`diagnostic trop lent : ${duree} ms`);
    });
    await check('la page reste pleinement utilisable sans relais', async () => {
      const ws = await a.webContents.executeJavaScript('document.getElementById("wsStatus").textContent');
      if (ws !== 'Connecté') throw new Error('WebSocket : ' + ws);
      const erreurs = (await consoleDe(a)).split('\n').filter((l) => /Erreur|erreur non capturée/.test(l));
      if (erreurs.length) throw new Error(erreurs.join(' | '));
    });
  } finally { fermerPages(); await signal.stop(); }

  /* --- 4. Relais forcé : la connexion passe VRAIMENT par le relais ------- */
  signal = await startServer(PORT_SIGNAL, { env: { TURN_URLS: url, TURN_SECRET: SECRET } });
  try {
    const a = await ouvrirPage(ip, { forceRelay: '1' });
    const b = await ouvrirPage(ip, { forceRelay: '1' });

    await check('le mode relais forcé est annoncé dans la console', async () => {
      if (!(await consoleDe(a)).includes('[TEST] relais forcé')) throw new Error('mode de test silencieux');
    });

    await check('avec forceRelay=1, la connexion s’établit par le relais', async () => {
      for (const [i, w] of [a, b].entries()) {
        await waitUntil(async () => (await consoleDe(w)).includes('PeerConnection: connected'),
          { label: `page ${i + 1} connectée`, timeout: 20000 });
      }
      const ligne = await waitUntil(async () =>
        (await consoleDe(a)).split('\n').find((l) => l.includes('[RTC] chemin :')) || null,
        { label: 'chemin journalisé' });
      if (!/relay/.test(ligne)) throw new Error('chemin non relayé : ' + ligne);
    });

    await check('la pastille passe en « Connecté (dégradé) », jaune-orangé', async () => {
      const p = await waitUntil(async () => {
        const e = await a.webContents.executeJavaScript(`({
          texte: document.getElementById('rtcStatus').textContent,
          classes: document.getElementById('rtcStatus').className,
          titre: document.getElementById('rtcStatus').title })`);
        return e.texte === 'Connecté (dégradé)' ? e : null;
      }, { label: 'pastille dégradée' });
      if (!/\bwarn\b/.test(p.classes) || /\bok\b/.test(p.classes)) throw new Error('classes : ' + p.classes);
      if (!p.titre.startsWith('Relayé par un serveur TURN')) throw new Error('infobulle : ' + p.titre);
    });

    await check('les données transitent par le relais (canal P2P, pas le WebSocket)', async () => {
      await b.webContents.executeJavaScript('document.getElementById("btnActivate").click(); true');
      await a.webContents.executeJavaScript(`
        document.getElementById('audioUrl').value = 'https://example.invalid/relais.mp3';
        document.getElementById('btnSendAudioUrl').click(); true`);
      const log = await waitUntil(async () => {
        const t = await consoleDe(a); return t.includes('a reçu l\'audio') ? t : null;
      }, { label: 'accusé de réception' });
      if (!log.includes('(URL via RTC)')) throw new Error('transport inattendu');
    });
  } finally { fermerPages(); await signal.stop(); }

  /* --- 5. RTC désactivé : tout passe par le WebSocket, et on dit pourquoi */
  signal = await startServer(PORT_SIGNAL, { env: { TURN_URLS: null, TURN_SECRET: null } });
  try {
    const a = await ouvrirPage(ip, { rtc: 'off' });
    const b = await ouvrirPage(ip, { rtc: 'off' });

    await check('avec rtc=off, une URL part par le WebSocket', async () => {
      await waitUntil(async () => (await a.webContents.executeJavaScript('document.getElementById("peersCount").textContent')) === '1',
        { label: 'pair présent' });
      await b.webContents.executeJavaScript('document.getElementById("btnActivate").click(); true');
      await a.webContents.executeJavaScript(`
        document.getElementById('audioUrl').value = 'https://example.invalid/ws.mp3';
        document.getElementById('btnSendAudioUrl').click(); true`);
      const log = await waitUntil(async () => {
        const t = await consoleDe(a); return t.includes('a reçu l\'audio') ? t : null;
      }, { label: 'accusé de réception' });
      if (!log.includes('(URL via WS)')) throw new Error('le repli WebSocket n’a pas joué');
      if (!log.includes('[TEST] RTC désactivé (rtc=off)')) throw new Error('mode de test non annoncé');
    });

    await check('sans P2P, le partage d’écran dit s’il existait un relais', async () => {
      await a.webContents.executeJavaScript('document.getElementById("btnShareScreen").click(); true');
      const msg = await waitUntil(async () => {
        const t = await a.webContents.executeJavaScript('document.getElementById("ctrlError").textContent');
        return t || null;
      }, { label: 'message d’erreur' });
      if (!msg.includes('aucun relais TURN proposé par ce serveur')) throw new Error('message : ' + msg);
    });
  } finally { fermerPages(); await signal.stop(); }

  relais.stop();
  const echecs = results.filter((r) => !r).length;
  console.log(`\n${results.length - echecs}/${results.length} tests passés.`);
  app.exit(echecs ? 1 : 0);
});
