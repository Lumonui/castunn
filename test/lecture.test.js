// test/lecture.test.js
// Lecture pendant le téléchargement, de bout en bout : une vraie vidéo (index
// MP4 en fin de fichier, le cas difficile) envoyée par essaim, lue et
// parcourue chez le récepteur par ses deux transports :
//  - application : vrai preload.js, vrai protocole castunn-flux:// ;
//  - navigateur : page servie en http://127.0.0.1 (contexte sûr), donc
//    service worker sw-flux.js — le même port relaie le WebSocket vers le
//    serveur de signalisation, comme un hébergeur.
//
//   npm run test:lecture

const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { app, BrowserWindow, protocol, ipcMain, webContents } = require('electron');
const { declarerSchema, servirFlux } = require('../flux-protocole.js');
const { startServer } = require('./helpers');

declarerSchema(protocol);   // avant whenReady, comme dans main.js
app.on('window-all-closed', () => {});

const PORT = Number(process.env.TEST_LECTURE_PORT || 8091);
const PORT_HTTP = PORT + 100;
const PROJECT = path.join(__dirname, '..');
const VIDEO = fs.readFileSync(path.join(__dirname, 'fixtures', 'index-en-fin.mp4'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await sleep(interval); }
  throw new Error(`"${label}" jamais atteint après ${timeout} ms`);
}
const results = [];
const pages = [];
const js = (p, code) => p.win.webContents.executeJavaScript(code, true);
const consoleDe = (p) => js(p, 'document.getElementById("consoleLog").textContent');
async function check(nom, fn) {
  try { await fn(); results.push(true); console.log(`  ok   ${nom}`); }
  catch (e) {
    results.push(false);
    console.log(`  FAIL ${nom}\n       ${e.message}`);
    for (const p of pages) {
      try { console.log(`       ${p.nom} — ${(await consoleDe(p)).split('\n').filter(Boolean).slice(-4).join(' | ')}`); } catch {}
    }
  }
}

// Ce que preload.js interroge au démarrage, sans le reste de main.js.
ipcMain.handle('webrtc-ports', () => null);
ipcMain.handle('port-forwarding-status', () => null);
ipcMain.handle('server-status', () => ({ running: false, port: 8080, addresses: [] }));
ipcMain.handle('server-discover', () => []);

/** Le projet servi en http, WebSocket relayé vers le serveur de signalisation. */
function serveurStatique() {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    const chemin = path.normalize(path.join(PROJECT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!chemin.startsWith(PROJECT) || !fs.existsSync(chemin) || fs.statSync(chemin).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(chemin)] || 'application/octet-stream' });
    fs.createReadStream(chemin).pipe(res);
  });
  srv.on('upgrade', (req, socket, tete) => {
    const amont = net.connect(PORT, '127.0.0.1', () => {
      amont.write(`${req.method} ${req.url} HTTP/1.1\r\n`
        + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (tete?.length) amont.write(tete);
      socket.pipe(amont).pipe(socket);
    });
    amont.on('error', () => socket.destroy());
    socket.on('error', () => amont.destroy());
  });
  return new Promise((r) => srv.listen(PORT_HTTP, '127.0.0.1', () => r(srv)));
}

async function ouvrir(nom, { navigateur }) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, ...(navigateur ? {} : { preload: path.join(PROJECT, 'preload.js') }) }
  });
  const p = { nom, win };
  pages.push(p);
  if (navigateur) {
    await win.loadURL(`http://127.0.0.1:${PORT_HTTP}/castunn.html`);
  } else {
    await win.loadFile(path.join(PROJECT, 'castunn.html'));
    await js(p, `localStorage.setItem('castunn.signalHost', '127.0.0.1:${PORT}'); true`);
    await win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  await js(p, `window.__nickname = ${JSON.stringify(nom)}; true`);
  await waitUntil(async () => (await js(p, 'document.getElementById("wsStatus").textContent')) === 'Connecté',
    { label: `${nom} connecté` });
  await js(p, 'document.getElementById("btnActivate").click(); true');
  p.id = await js(p, `(document.getElementById('consoleLog').textContent.match(/myId=([a-z0-9]+)/) || [])[1]`);
  return p;
}

/** Envoie la vidéo de test depuis la page `p`. */
function envoyerVideo(p) {
  return js(p, `(() => {
    const octets = Uint8Array.from(atob(${JSON.stringify(VIDEO.toString('base64'))}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([octets], 'court.mp4', { type: 'video/mp4' }));
    document.getElementById('mediaFile').files = dt.files;
    document.getElementById('btnSendMediaFile').click(); return true; })()`);
}

/** Lecture et navigation dans la vignette de l'émetteur `de`, chez `p`. */
async function lireEtNaviguer(p, de, prefixe) {
  const src = await waitUntil(() => js(p, `document.querySelector('#receptions .tuile[data-de="${de}"] video')?.src || ''`),
    { label: `${p.nom} : vignette vidéo` });
  if (!src.startsWith(prefixe)) throw new Error(`adresse de lecture : ${src}`);
  const r = await js(p, `(async () => {
    const v = document.querySelector('#receptions .tuile[data-de="${de}"] video');
    v.muted = true;
    const ev = (n) => new Promise((ok, ko) => {
      v.addEventListener(n, ok, { once: true });
      v.addEventListener('error', () => ko(new Error('erreur média ' + (v.error && v.error.message))), { once: true });
      setTimeout(() => ko(new Error(n + ' jamais reçu')), 10000);
    });
    if (v.readyState < 1) await ev('loadedmetadata');
    const duree = v.duration;
    v.currentTime = 9; await ev('seeked');
    await v.play().catch(() => {});
    const avant = v.currentTime; await new Promise((ok) => setTimeout(ok, 1200));
    return { duree, apresNavigation: avant, avance: v.currentTime - avant };
  })()`);
  if (Math.round(r.duree) !== 12) throw new Error('durée : ' + r.duree);
  if (r.apresNavigation < 8.9) throw new Error('navigation : ' + r.apresNavigation);
  if (r.avance < 0.5) throw new Error(`la lecture n’avance pas (${r.avance.toFixed(2)} s)`);
}

app.whenReady().then(async () => {
  servirFlux({ protocol, ipcMain, webContents });
  let serveur, statique;
  try {
    serveur = await startServer(PORT, { env: { TURN_URLS: null, TURN_SECRET: null } });
    statique = await serveurStatique();
  } catch (e) { console.error(`Serveurs de test impossibles : ${e.message}`); app.exit(1); return; }

  console.log('\nLecture pendant le téléchargement\n');

  const a = await ouvrir('ana', { navigateur: false });
  const b = await ouvrir('bea', { navigateur: false });
  await check('application : la vidéo se lit et se parcourt par castunn-flux://', async () => {
    await waitUntil(async () => (await js(a, 'document.getElementById("rtcStatus").textContent')) === 'Connecté',
      { label: 'lien P2P', timeout: 20000 });
    await sleep(500);
    await envoyerVideo(a);
    await lireEtNaviguer(b, a.id, 'castunn-flux://');
    if (!(await consoleDe(b)).includes('[essaim] lecture pendant le téléchargement : court.mp4')) throw new Error('non annoncé');
    await waitUntil(async () => /Média reçu \(essaim\) : court\.mp4/.test(await consoleDe(a)), { label: 'accusé de réception' });
  });
  await check('application : une fois reçue, la vidéo se parcourt toujours (servie depuis le fichier)', async () => {
    await sleep(1500);
    const t = await js(b, `(async () => {
      const v = document.querySelector('#receptions .tuile[data-de="${a.id}"] video');
      v.currentTime = 2; await new Promise((ok, ko) => { v.addEventListener('seeked', ok, { once: true }); setTimeout(() => ko(new Error('seeked')), 8000); });
      return v.currentTime; })()`);
    if (Math.abs(t - 2) > 0.2) throw new Error('position : ' + t);
  });
  await check('application : après un stop, le fichier reçu quitte la mémoire', async () => {
    if ((await js(b, 'window.__castunnFluxOuverts()')) !== 1) throw new Error('le flux devait être ouvert avant le stop');
    await js(a, 'document.getElementById("btnStop").click(); true');
    await waitUntil(async () => !(await js(b, `!!document.querySelector('#receptions .tuile[data-de="${a.id}"]')`)),
      { label: 'vignette retirée' });
    // Constaté : 1,3 Go restaient occupés après un stop. Le flux est fermé,
    // son fichier n'est plus retenu.
    const restants = await js(b, 'window.__castunnFluxOuverts()');
    if (restants !== 0) throw new Error(`${restants} flux toujours gardé(s) en mémoire après le stop`);
  });
  for (const p of pages.splice(0)) p.win.destroy();

  const c = await ouvrir('cleo', { navigateur: true });
  const d = await ouvrir('dina', { navigateur: true });
  await check('navigateur : la vidéo se lit et se parcourt par le service worker', async () => {
    await waitUntil(() => js(d, '!!navigator.serviceWorker.controller'), { label: 'service worker actif' });
    await waitUntil(async () => (await js(c, 'document.getElementById("rtcStatus").textContent')) === 'Connecté',
      { label: 'lien P2P', timeout: 20000 });
    await sleep(500);
    await envoyerVideo(c);
    await lireEtNaviguer(d, c.id, `http://127.0.0.1:${PORT_HTTP}/flux-essaim/`);
  });
  for (const p of pages.splice(0)) p.win.destroy();

  const echecs = results.filter((x) => !x).length;
  console.log(`\n${results.length - echecs}/${results.length} tests passés.`);
  statique.close();
  await serveur.stop();
  app.exit(echecs ? 1 : 0);
});
