// test/youtube.test.js
// Lien YouTube : deux vraies pages, le vrai lecteur de YouTube (Internet
// nécessaire ; sans accès, le test se saute et le dit).
//
//   npm run test:youtube
//
// Vérifie que le lecteur est accepté dans une page file:// (en-tête Referer
// de youtube-referer.js, sinon erreur 153), et que le lecteur de l'émetteur
// pilote celui du récepteur : pause, déplacement, reprise.

const path = require('path');
const https = require('https');
const { app, BrowserWindow, session } = require('electron');
const { startServer } = require('./helpers');
const { autoriserLecteurYoutube } = require('../youtube-referer.js');

const PORT = Number(process.env.TEST_YOUTUBE_PORT || 8092);
const PROJECT = path.join(__dirname, '..');
// Vidéo d'exemple de la documentation de l'API YouTube.
const VIDEO = 'M7lc1UVf-VE';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`"${label}" jamais atteint après ${timeout} ms`);
}

const results = [];
const pages = [];
const js = (p, code) => p.win.webContents.executeJavaScript(code);
const consoleDe = (p) => js(p, 'document.getElementById("consoleLog").textContent');
async function check(nom, fn) {
  try { await fn(); results.push(true); console.log(`  ok   ${nom}`); }
  catch (e) {
    results.push(false);
    console.log(`  FAIL ${nom}\n       ${e.message}`);
    for (const p of pages) {
      try {
        const etat = await js(p, `({ console: document.getElementById('consoleLog').textContent.split('\\n').filter(Boolean).slice(-4).join(' | '),
          erreurs: document.getElementById('recvError').textContent + ' ' + document.getElementById('localErr').textContent })`);
        console.log(`       ${p.nom} — ${etat.console} — ${etat.erreurs}`);
      } catch { /* fermée */ }
    }
  }
}

// Sans cet écouteur, Electron quitte de lui-même (code 0) quand les pages se
// ferment, avant le bilan.
app.on('window-all-closed', () => {});

function youtubeJoignable() {
  return new Promise((resolve) => {
    const req = https.get('https://www.youtube.com/iframe_api', { timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function ouvrirPage(nom) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' }
  });
  const p = { nom, win };
  pages.push(p);
  await win.loadFile(path.join(PROJECT, 'castunn.html'));
  await js(p, `localStorage.setItem('castunn.signalHost', '127.0.0.1:${PORT}'); localStorage.removeItem('castunn.sansReception'); true`);
  await win.webContents.reload();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await waitUntil(async () => (await js(p, 'document.getElementById("wsStatus").textContent')) === 'Connecté',
    { label: `${nom} connecté` });
  p.id = await js(p, `(document.getElementById('consoleLog').textContent.match(/myId=([a-z0-9]+)/) || [])[1]`);
  return p;
}

app.whenReady().then(async () => {
  console.log('\nLien YouTube (deux pages, vrai lecteur)\n');
  if (!(await youtubeJoignable())) {
    console.log('  (YouTube injoignable depuis cette machine : test sauté)\n');
    app.exit(0);
    return;
  }
  if (!process.env.YT_SANS_REFERER) autoriserLecteurYoutube(session.defaultSession);

  let serveur;
  try { serveur = await startServer(PORT, { env: { TURN_URLS: null, TURN_SECRET: null } }); }
  catch (e) { console.error(`Serveur de test impossible sur ${PORT} : ${e.message}`); app.exit(1); return; }

  const a = await ouvrirPage('alice');
  const b = await ouvrirPage('bob');
  await waitUntil(async () => (await js(a, 'document.getElementById("peersCount").textContent')) === '1', { label: 'pair présent' });

  // Temps et état du lecteur YouTube : le nôtre (émetteur) ou celui d'une vignette.
  const lecteurDe = (p, de) => js(p, `(() => {
    const l = ${de ? `window.__castunnYoutube.de(${JSON.stringify(de)})` : 'window.__castunnYoutube.local()'};
    const y = l?.brut; if (!y) return null;
    return { etat: y.getPlayerState(), temps: y.getCurrentTime() };
  })()`);

  await check('le lien part, et les deux lecteurs YouTube lisent (page file:// acceptée)', async () => {
    await js(a, `document.getElementById('mediaUrl').value = 'https://www.youtube.com/watch?v=${VIDEO}';
      document.getElementById('btnSendMediaUrl').click(); true`);
    await waitUntil(async () => /a reçu la vidéo YouTube/.test(await consoleDe(a)), { label: 'accusé du récepteur' });
    for (const [p, de] of [[a, null], [b, a.id]]) {
      await waitUntil(async () => (await lecteurDe(p, de))?.etat === 1, { label: `${p.nom} : lecture en cours`, timeout: 30000 });
    }
    // Muets : le test n'a pas à faire de bruit.
    await js(a, 'window.__castunnYoutube.local().brut.mute(); true');
    await js(b, `window.__castunnYoutube.de(${JSON.stringify(a.id)}).brut.mute(); true`);
  });

  await check('pause chez l’émetteur → pause chez le récepteur', async () => {
    await js(a, 'window.__castunnYoutube.local().brut.pauseVideo(); true');
    await waitUntil(async () => (await lecteurDe(b, a.id))?.etat === 2, { label: 'bob en pause' });
  });

  await check('déplacement puis reprise chez l’émetteur → suivis chez le récepteur', async () => {
    await js(a, 'const y = window.__castunnYoutube.local().brut; y.seekTo(60, true); y.playVideo(); true');
    const l = await waitUntil(async () => {
      const x = await lecteurDe(b, a.id);
      return x?.etat === 1 && x.temps > 58 ? x : null;
    }, { label: 'bob vers 60 s, en lecture', timeout: 30000 });
    if (l.temps > 75) throw new Error(`bob à ${l.temps.toFixed(1)} s`);
  });

  await check('« Stop » de l’émetteur : la vignette YouTube disparaît chez le récepteur', async () => {
    await js(a, 'document.getElementById("btnStop").click(); true');
    await waitUntil(async () => !(await js(b, `!!document.querySelector('#receptions .tuile iframe')`)), { label: 'iframe retirée' });
    if (await js(a, '!!window.__castunnYoutube.local()')) throw new Error('le lecteur de l’émetteur reste ouvert');
  });

  for (const p of pages.splice(0)) { try { p.win.destroy(); } catch {} }
  await serveur.stop();
  const echecs = results.filter((x) => !x).length;
  console.log(`\n${results.length - echecs}/${results.length} tests passés.`);
  app.exit(echecs ? 1 : 0);
});
