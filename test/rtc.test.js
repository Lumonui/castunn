// test/rtc.test.js
// Deux vraies pages Castunn dans Electron, un vrai serveur de signalisation,
// et une vraie connexion WebRTC entre les deux.
//
//   npm run test:rtc
//
// Ce que ça prouve, et que les autres tests ne peuvent pas prouver : la
// négociation aboutit, le canal de données s'ouvre, et les données empruntent
// bien le chemin P2P plutôt que le repli WebSocket. Les deux fenêtres tournent
// sur la même machine : le chemin testé est donc le direct (candidats host).

const path = require('path');
const { app, BrowserWindow } = require('electron');
const { startServer } = require('./helpers');
const { appliquerPlageWebRTC, WEBRTC_UDP_PORTS } = require('../webrtc-ports.js');

const PORT = Number(process.env.TEST_RTC_PORT || 8097);
const PROJECT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 15000, interval = 200, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`"${label}" jamais atteint apres ${timeout}ms`);
}

const results = [];
const fenetres = [];

async function check(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`  FAIL ${name}\n       ${e.message}`);
    for (const [i, w] of fenetres.entries()) {
      try {
        const etat = await w.webContents.executeJavaScript(`({
          rtc: document.getElementById('rtcStatus').textContent,
          ws: document.getElementById('wsStatus').textContent,
          console: document.getElementById('consoleLog').textContent.split('\n').filter(Boolean).slice(-8).join(' | ')
        })`);
        console.log(`       page ${i + 1} — WS ${etat.ws} / RTC ${etat.rtc}`);
        console.log(`       page ${i + 1} — ${etat.console}`);
      } catch { /* fenêtre fermée */ }
    }
  }
}

/** Ouvre une page Castunn déjà pointée sur le serveur de test. */
async function ouvrirPage(nom) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  fenetres.push(win);
  // Comme la vraie fenetre de main.js : sans ca, le port local observe plus
  // bas serait un port ephemere quelconque et ne prouverait rien.
  appliquerPlageWebRTC(win.webContents);
  await win.loadFile(path.join(PROJECT, 'castunn.html'));
  await win.webContents.executeJavaScript(
    `localStorage.setItem('castunn.signalHost', '127.0.0.1:${PORT}');`
    + `window.__nickname = ${JSON.stringify(nom)}; true`
  );
  await win.webContents.reload();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`window.__nickname = ${JSON.stringify(nom)}; true`);
  return win;
}

const texteConsole = (win) =>
  win.webContents.executeJavaScript('document.getElementById("consoleLog").textContent');
const statutRtc = (win) =>
  win.webContents.executeJavaScript('document.getElementById("rtcStatus").textContent');

app.whenReady().then(async () => {
  let server;
  try {
    server = await startServer(PORT);
  } catch (e) {
    console.error(`\nImpossible de demarrer le serveur de test sur ${PORT} : ${e.message}`);
    app.exit(1);
    return;
  }

  console.log('\nTests WebRTC (deux pages, un serveur)\n');

  const a = await ouvrirPage('alice');
  const b = await ouvrirPage('bob');

  await check('les deux pages rejoignent la room', async () => {
    for (const [i, w] of [a, b].entries()) {
      await waitUntil(
        async () => (await w.webContents.executeJavaScript(
          'document.getElementById("wsStatus").textContent')) === 'Connecté',
        { label: `page ${i + 1} connectée au serveur` }
      );
    }
  });

  await check('la negociation aboutit : PeerConnection connected des deux cotes', async () => {
    for (const [i, w] of [a, b].entries()) {
      await waitUntil(
        async () => (await texteConsole(w)).includes('PeerConnection: connected'),
        { label: `page ${i + 1} en RTC connected` }
      );
    }
  });

  await check('aucune connexion n\'est detruite par une collision d\'offres', async () => {
    for (const [i, w] of [a, b].entries()) {
      const log = await texteConsole(w);
      if (log.includes('Erreur offer') || log.includes('Erreur answer')) {
        throw new Error(`page ${i + 1} : erreur de negociation dans la console`);
      }
      // Recréation complète = le premier essai avait échoué.
      if (log.includes('Recréation complète')) {
        throw new Error(`page ${i + 1} : la connexion a du etre recreee`);
      }
    }
  });

  await check('le canal de donnees est ouvert (pastille RTC verte)', async () => {
    for (const [i, w] of [a, b].entries()) {
      await waitUntil(async () => (await statutRtc(w)) === 'Connecté',
        { label: `page ${i + 1} : pastille RTC` });
    }
  });

  await check('la pastille indique une connexion directe, en vert', async () => {
    for (const [i, w] of [a, b].entries()) {
      const p = await waitUntil(async () => {
        const e = await w.webContents.executeJavaScript(`({
          titre: document.getElementById('rtcStatus').title,
          classes: document.getElementById('rtcStatus').className })`);
        return e.titre ? e : null;
      }, { label: `page ${i + 1} : infobulle de la pastille` });
      if (!p.titre.startsWith('Connexion directe :')) throw new Error(`page ${i + 1} : ${p.titre}`);
      if (!/\bok\b/.test(p.classes) || /\bwarn\b/.test(p.classes)) {
        throw new Error(`page ${i + 1} : classes ${p.classes}`);
      }
    }
  });

  await check('le chemin emprunte est journalise (type de candidats, port local)', async () => {
    const log = await waitUntil(
      async () => { const t = await texteConsole(a); return t.includes('[RTC] chemin :') ? t : null; },
      { label: 'trace du chemin ICE' }
    );
    const ligne = log.split(String.fromCharCode(10))
      .find((l) => l.includes('[RTC] chemin :'));
    // Deux fenetres sur la meme machine : la paire retenue doit etre directe.
    if (!/host|srflx|prflx/.test(ligne)) throw new Error(`chemin inattendu : ${ligne}`);
    if (/relay/.test(ligne)) throw new Error(`relais utilise sur une connexion locale : ${ligne}`);
    const port = Number((ligne.match(/port local ([0-9]+)/) || [])[1]);
    if (!port) throw new Error(`port local absent : ${ligne}`);
    if (port < WEBRTC_UDP_PORTS.min || port > WEBRTC_UDP_PORTS.max) {
      throw new Error(`port local ${port} hors de la plage reservee `
        + `${WEBRTC_UDP_PORTS.min}-${WEBRTC_UDP_PORTS.max}`);
    }
  });

  // Le vrai juge de paix : la donnee passe-t-elle en P2P ou par le serveur ?
  // Le recepteur annonce lui-meme le transport dans son accuse de reception.
  await check('une URL envoyee emprunte le canal P2P, pas le WebSocket', async () => {
    await b.webContents.executeJavaScript('document.getElementById("btnActivate").click(); true');
    await a.webContents.executeJavaScript(`
      document.getElementById('audioUrl').value = 'https://example.invalid/t.mp3';
      document.getElementById('btnSendAudioUrl').click(); true`);

    const log = await waitUntil(
      async () => { const t = await texteConsole(a); return t.includes('a reçu l\'audio') ? t : null; },
      { label: 'accuse de reception' }
    );
    if (!log.includes('(URL via RTC)')) {
      throw new Error(`transport attendu RTC, console : ${log.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
    }
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} tests passes.`);

  for (const w of fenetres) { try { w.destroy(); } catch {} }
  await server.stop();
  app.exit(failed ? 1 : 0);
});
