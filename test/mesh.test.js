// test/mesh.test.js
// Maillage : trois et quatre vraies pages Castunn, un vrai serveur, de vraies
// connexions WebRTC entre chaque paire.
//
//   npm run test:mesh
//
// Rejoue les scénarios qui motivaient le maillage : à trois, chacun en P2P
// avec chacun (K3) ; deux émetteurs à la fois, une vignette chacun ; le
// « stop » de A n'arrête que ce qui vient de A ; un pair sans P2P servi par
// le WebSocket sans doublon chez les autres.

const path = require('path');
const { app, BrowserWindow } = require('electron');
const { startServer, connect, joinRoom } = require('./helpers');

const PORT = Number(process.env.TEST_MESH_PORT || 8093);
const PROJECT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, { timeout = 15000, interval = 200, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`"${label}" jamais atteint après ${timeout} ms`);
}

const results = [];
const pages = []; // { nom, win }
async function check(nom, fn) {
  try { await fn(); results.push(true); console.log(`  ok   ${nom}`); }
  catch (e) {
    results.push(false);
    console.log(`  FAIL ${nom}\n       ${e.message}`);
    for (const p of pages) {
      try {
        const etat = await js(p, `({ rtc: document.getElementById('rtcStatus').textContent,
          console: document.getElementById('consoleLog').textContent.split('\\n').filter(Boolean).slice(-5).join(' | ') })`);
        console.log(`       ${p.nom} — RTC ${etat.rtc} — ${etat.console}`);
      } catch { /* fermée */ }
    }
  }
}

// Les pages se ferment entre deux scénarios : sans cet écouteur, Electron
// quitterait de lui-même, en silence et avec le code 0.
app.on('window-all-closed', () => {});

const js = (p, code, geste = false) => p.win.webContents.executeJavaScript(code, geste);
const consoleDe = (p) => js(p, 'document.getElementById("consoleLog").textContent');
const pastille = (p) => js(p, `({ texte: document.getElementById('rtcStatus').textContent,
  classes: document.getElementById('rtcStatus').className, titre: document.getElementById('rtcStatus').title })`);
const vignettes = (p) => js(p, `[...document.querySelectorAll('#receptions .tuile')].map((t) => ({
  de: t.dataset.de, titre: t.querySelector('figcaption').textContent,
  image: t.querySelector('.tuile-image').getAttribute('src') || '',
  audio: t.querySelector('.tuile-audio').getAttribute('src') || '' }))`);

async function ouvrirPage(nom, query = {}) {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const p = { nom, win };
  pages.push(p);
  await win.loadFile(path.join(PROJECT, 'castunn.html'), { query });
  await win.webContents.executeJavaScript(`localStorage.setItem('castunn.signalHost', '127.0.0.1:${PORT}'); true`);
  await win.webContents.reload();
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await win.webContents.executeJavaScript(`window.__nickname = ${JSON.stringify(nom)}; true`);
  await waitUntil(async () => (await js(p, 'document.getElementById("wsStatus").textContent')) === 'Connecté',
    { label: `${nom} connecté au serveur` });
  // Récepteur activé, comme le ferait l'utilisateur.
  await js(p, 'document.getElementById("btnActivate").click(); true');
  p.id = await js(p, `(document.getElementById('consoleLog').textContent.match(/myId=([a-z0-9]+)/) || [])[1]`);
  return p;
}
const fermerPages = () => { for (const p of pages.splice(0)) { try { p.win.destroy(); } catch {} } };
const fermerPage = (p) => { pages.splice(pages.indexOf(p), 1); try { p.win.destroy(); } catch {} };

/**
 * Une page qui doit mener : rouverte jusqu'à obtenir un identifiant qui
 * commence au-delà de « k ». Un identifiant tout petit rendrait presque
 * impossible de trouver un autre pair en dessous.
 */
async function ouvrirMeneur(nom) {
  for (let essai = 0; essai < 20; essai++) {
    const p = await ouvrirPage(nom);
    if (p.id >= 'k') return p;
    fermerPage(p);
  }
  throw new Error('aucun identifiant assez grand en 20 essais');
}

async function envoyerUrl(p, type, url) {
  await js(p, `document.getElementById('${type}Url').value = ${JSON.stringify(url)};
    document.getElementById('btnSend${type[0].toUpperCase() + type.slice(1)}Url').click(); true`);
}
const compter = (texte, motif) => (texte.match(motif) || []).length;

app.whenReady().then(async () => {
  let serveur;
  try { serveur = await startServer(PORT, { env: { TURN_URLS: null, TURN_SECRET: null } }); }
  catch (e) { console.error(`Serveur de test impossible sur ${PORT} : ${e.message}`); app.exit(1); return; }

  console.log('\nMaillage (trois et quatre pages)\n');

  /* --- 1. K3 : chacun en P2P avec chacun ------------------------------------ */
  const a = await ouvrirPage('alice');
  const b = await ouvrirPage('bob');
  const c = await ouvrirPage('carol');

  await check('à trois, chaque page a deux liens P2P ouverts (K3)', async () => {
    for (const p of [a, b, c]) {
      const e = await waitUntil(async () => { const s = await pastille(p); return s.texte === '2/2' ? s : null; },
        { label: `${p.nom} : pastille 2/2`, timeout: 20000 });
      if (!/\bok\b/.test(e.classes)) throw new Error(`${p.nom} : classes ${e.classes}`);
      const lignes = e.titre.split('\n');
      if (lignes.length !== 2 || !lignes.every((l) => / : direct/.test(l))) throw new Error(`${p.nom} : infobulle ${e.titre}`);
    }
  });

  await check('une URL envoyée par A atteint B et C, chacun par son lien P2P', async () => {
    await envoyerUrl(a, 'audio', 'https://example.invalid/k3.mp3');
    await waitUntil(async () => compter(await consoleDe(a), /a reçu l'audio \(URL via RTC\)/g) >= 2,
      { label: 'deux accusés de réception P2P' });
    const log = await consoleDe(a);
    if (/a reçu l'audio \(URL via WS\)/.test(log)) throw new Error('un pair a été servi par le WebSocket');
    for (const p of [b, c]) {
      const v = await vignettes(p);
      if (!v.some((t) => t.de === a.id && t.audio.includes('k3.mp3'))) throw new Error(`${p.nom} : vignette de A absente`);
    }
  });

  await check('deux émetteurs à la fois : une vignette chacun, titrée de son nom', async () => {
    await envoyerUrl(b, 'image', 'https://example.invalid/de-bob.png');
    await envoyerUrl(c, 'image', 'https://example.invalid/de-carol.png');
    const v = await waitUntil(async () => {
      const t = await vignettes(a);
      return t.some((x) => x.image.includes('de-bob')) && t.some((x) => x.image.includes('de-carol')) ? t : null;
    }, { label: 'deux vignettes chez A' });
    const deBob = v.find((x) => x.image.includes('de-bob'));
    const deCarol = v.find((x) => x.image.includes('de-carol'));
    if (deBob.de !== b.id || deCarol.de !== c.id) throw new Error('vignettes mal attribuées : ' + JSON.stringify(v));
    if (!deBob.titre.includes('bob') || !deCarol.titre.includes('carol')) throw new Error('titres : ' + JSON.stringify(v));
    const plusieurs = await js(a, 'document.getElementById("receptions").classList.contains("plusieurs")');
    if (!plusieurs) throw new Error('la grille à plusieurs vignettes n’est pas activée');
  });

  // Point 3 du planning : A et B diffusent tous deux chez C ; le stop de A
  // ne doit couper que ce qui vient de A.
  await check('le « stop » de A n’arrête que ce qui vient de A', async () => {
    await envoyerUrl(a, 'image', 'https://example.invalid/de-alice.png');
    await waitUntil(async () => (await vignettes(c)).some((t) => t.de === a.id && t.image.includes('de-alice')),
      { label: 'vignette de A chez C' });
    await js(a, 'document.getElementById("btnStop").click(); true');
    await waitUntil(async () => !(await vignettes(c)).some((t) => t.de === a.id), { label: 'vignette de A retirée chez C' });
    const reste = await vignettes(c);
    if (!reste.some((t) => t.de === b.id && t.image.includes('de-bob'))) {
      throw new Error('la vignette de B a été coupée par le stop de A : ' + JSON.stringify(reste));
    }
  });

  await check('un départ ferme son lien ; la pastille revient au cas à deux', async () => {
    const idC = c.id;
    pages.splice(pages.indexOf(c), 1);
    c.win.destroy();
    for (const p of [a, b]) {
      await waitUntil(async () => (await pastille(p)).texte === 'Connecté', { label: `${p.nom} : retour à « Connecté »` });
      const log = await consoleDe(p);
      if (!log.includes(`fermé : départ du pair`)) throw new Error(`${p.nom} : fermeture du lien non journalisée`);
      const v = await vignettes(p);
      if (!v.some((t) => t.de === idC)) throw new Error(`${p.nom} : ce que C avait montré doit rester affiché`);
    }
  });
  fermerPages();

  /* --- 2. Groupe mixte : un pair sans P2P ----------------------------------- */
  const m1 = await ouvrirPage('mona');
  const m2 = await ouvrirPage('noah');
  const m3 = await ouvrirPage('oscar-sans-p2p', { rtc: 'off' });

  await check('un pair sans P2P : la pastille le compte à part (1/2, orangé)', async () => {
    const e = await waitUntil(async () => { const s = await pastille(m1); return s.texte === '1/2' ? s : null; },
      { label: 'pastille 1/2', timeout: 20000 });
    if (!/\bwarn\b/.test(e.classes)) throw new Error('classes : ' + e.classes);
    if (!/oscar-sans-p2p\)? : WebSocket \(pas de P2P\)/.test(e.titre)) throw new Error('infobulle : ' + e.titre);
  });

  await check('une URL part en P2P vers l’un, par le WebSocket vers l’autre, sans doublon', async () => {
    await envoyerUrl(m1, 'audio', 'https://example.invalid/mixte.mp3');
    await waitUntil(async () => {
      const t = await consoleDe(m1);
      return /a reçu l'audio \(URL via RTC\)/.test(t) && /a reçu l'audio \(URL via WS\)/.test(t);
    }, { label: 'un accusé P2P et un accusé WebSocket' });
    await sleep(800);
    // Le pair servi en P2P ne doit pas l'avoir reçu une seconde fois.
    const chezNoah = compter(await consoleDe(m2), /a reçu l'audio/g);
    if (chezNoah !== 1) throw new Error(`noah a traité le message ${chezNoah} fois`);
  });

  await check('un fichier part aux deux à la fois, par leurs chemins respectifs', async () => {
    // Petit PNG (1 pixel) fabriqué dans la page, déposé dans le champ fichier.
    await js(m1, `(() => {
      const octets = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([octets], 'point.png', { type: 'image/png' }));
      document.getElementById('mediaFile').files = dt.files;
      document.getElementById('btnSendMediaFile').click();
      return true; })()`);
    for (const p of [m2, m3]) {
      await waitUntil(async () => (await vignettes(p)).some((t) => t.de === m1.id && t.image.startsWith('blob:')),
        { label: `${p.nom} : image reçue de mona` });
    }
    const log = await consoleDe(m1);
    if (!/Envoi de point\.png : 1 par essaim, 1 par WebSocket/.test(log)) throw new Error('répartition non journalisée');
  });
  fermerPages();

  /* --- 3. Un pair sans P2P, quand c'est l'autre qui mène -------------------
   * Les identifiants sont tirés au hasard par le serveur : on rouvre la page
   * sans P2P jusqu'à ce que son identifiant soit le plus petit, pour que ce
   * soit bien l'autre qui lui envoie une offre — et reçoive le refus.
   * ---------------------------------------------------------------------- */
  const meneur = await ouvrirMeneur('pia');
  let sansP2p = null;
  for (let essai = 0; essai < 20; essai++) {
    sansP2p = await ouvrirPage('quentin-sans-p2p', { rtc: 'off' });
    if (sansP2p.id < meneur.id) break;
    fermerPage(sansP2p);
    sansP2p = null;
  }
  await check('le pair sans P2P refuse l’offre : l’autre bascule aussitôt sur le WebSocket', async () => {
    if (!sansP2p) throw new Error('impossible d’obtenir l’ordre voulu des identifiants');
    await waitUntil(async () => (await consoleDe(meneur)).includes('n’a pas de P2P : servi par le WebSocket'),
      { label: 'refus reçu', timeout: 8000 });
    const e = await pastille(meneur);
    if (e.texte !== 'Déconnecté') throw new Error('pastille : ' + e.texte);
    await envoyerUrl(meneur, 'audio', 'https://example.invalid/refus.mp3');
    await waitUntil(async () => /a reçu l'audio \(URL via WS\)/.test(await consoleDe(meneur)),
      { label: 'URL servie par le WebSocket' });
  });
  fermerPages();

  /* --- 4. Un pair muet : notre offre reste sans réponse --------------------
   * Ancienne version sans WebRTC : elle ne répond rien. Le lien ne doit pas
   * rester sur « connexion… » à vie.
   * ---------------------------------------------------------------------- */
  const page = await ouvrirMeneur('rita');
  let muet = null;
  for (let essai = 0; essai < 30; essai++) {
    muet = await connect(PORT, 'muet');
    if (muet.peerId < page.id) break;
    await muet.close();
    muet = null;
  }
  await check('une offre restée 15 s sans réponse : lien abandonné, pair servi par le WebSocket', async () => {
    if (!muet) throw new Error('impossible d’obtenir l’ordre voulu des identifiants');
    await joinRoom(muet, 'default', { nick: 'muet' });
    await waitUntil(async () => (await pastille(page)).texte === 'Connexion...', { label: 'lien en cours' });
    await waitUntil(async () => (await consoleDe(page)).includes('ne répond pas en P2P : servi par le WebSocket'),
      { label: 'abandon du lien', timeout: 25000 });
    const e = await pastille(page);
    if (e.texte !== 'Déconnecté') throw new Error('pastille : ' + e.texte);
  });
  if (muet) await muet.close();
  fermerPages();

  /* --- 5. Une ancienne version dans le groupe (sans essaim) ---------------- */
  const e1 = await ouvrirPage('sam');
  const e2 = await ouvrirPage('tina');
  const e3 = await ouvrirPage('ugo-ancien', { essaim: 'off' });
  await check('une ancienne version sans essaim reçoit le fichier entier, les autres par essaim', async () => {
    await waitUntil(async () => (await pastille(e1)).texte === '2/2', { label: 'sam : 2/2', timeout: 20000 });
    await sleep(500);
    await js(e1, `(() => {
      const octets = new Uint8Array(1024 * 1024).map((_, i) => (i * 7) & 255);
      const dt = new DataTransfer(); dt.items.add(new File([octets], 'mixte.png', { type: 'image/png' }));
      document.getElementById('mediaFile').files = dt.files;
      document.getElementById('btnSendMediaFile').click(); return true; })()`);
    for (const [p, via] of [[e2, 'essaim'], [e3, 'RTC']]) {
      const url = await waitUntil(async () => (await vignettes(p)).find((t) => t.de === e1.id && t.image.startsWith('blob:'))?.image,
        { label: `${p.nom} : fichier reçu`, timeout: 20000 });
      const taille = await js(p, `fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`);
      if (taille !== 1024 * 1024) throw new Error(`${p.nom} : ${taille} octets`);
      await waitUntil(async () => new RegExp(`Média reçu \\(${via}\\)`).test(await consoleDe(e1)),
        { label: `accusé « ${via} »` });
    }
    if (!/Envoi de mixte\.png : 1 par essaim, 1 en P2P/.test(await consoleDe(e1))) throw new Error('répartition non journalisée');
    if (!(await consoleDe(e3)).includes('[TEST] essaim désactivé')) throw new Error('mode de test non annoncé');
  });
  fermerPages();

  /* --- 6. Partage d'écran ---------------------------------------------------
   * La capture est remplacée par un canvas animé : le reste (pistes, liens,
   * renégociation, vignette) est le vrai chemin.
   * ---------------------------------------------------------------------- */
  const s1 = await ouvrirPage('vera');
  const s2 = await ouvrirPage('wim');
  const CAPTURE = `navigator.mediaDevices.getDisplayMedia = async (contraintes) => {
    window.__contraintesPartage = contraintes;
    const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const g = c.getContext('2d'); let i = 0;
    setInterval(() => { g.fillStyle = 'hsl(' + (i++ % 360) + ',80%,50%)'; g.fillRect(0, 0, 160, 90); }, 50);
    return c.captureStream(20);
  }; true`;
  const fluxChez = (p, de) => js(p, `(() => { const t = document.querySelector('#receptions .tuile[data-de="${de}"] video');
    return !!(t && t.srcObject && t.srcObject.getTracks().length); })()`);
  await check('partage d’écran vers un récepteur désactivé : l’émetteur est prévenu « non lu »', async () => {
    await waitUntil(async () => (await pastille(s1)).texte === 'Connecté', { label: 'vera reliée', timeout: 20000 });
    await js(s2, 'document.getElementById("btnDeactivate").click(); true');
    await js(s1, CAPTURE);
    await js(s1, 'document.getElementById("btnShareScreen").click(); true');
    await waitUntil(async () => /flux écran en direct \(RTC\) mais Récepteur désactivé \(non lu\)/.test(await consoleDe(s1)),
      { label: 'accusé « non lu »' });
    await sleep(500);
    if (await fluxChez(s2, s1.id)) throw new Error('le flux est affiché malgré le récepteur désactivé');
    if (compter(await consoleDe(s1), /flux écran en direct/g) !== 1) throw new Error('accusé en double');
    if (!(await js(s1, 'document.getElementById("localClose").hidden'))) throw new Error('« Fermer » visible pendant le partage');
    const video = (await js(s1, 'window.__contraintesPartage')).video;
    if (video?.width?.max !== 1920 || video?.height?.max !== 1080 || video?.frameRate?.max !== 30) {
      throw new Error('qualité par défaut : ' + JSON.stringify(video));
    }
    await js(s1, 'document.getElementById("btnStop").click(); true');
    if (await js(s1, 'document.getElementById("localClose").hidden')) throw new Error('« Fermer » toujours masqué après Stop');
  });

  await check('fichier vers un récepteur désactivé : l’émetteur le sait, et sa page reste vivante', async () => {
    // Constaté : la page émettrice tournait en boucle sans rendre la main
    // (8 Go de mémoire, puis page blanche).
    await js(s1, `(() => {
      const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(2 * 1024 * 1024)], 'refuse.mkv', { type: 'video/x-matroska' }));
      document.getElementById('mediaFile').files = dt.files;
      document.getElementById('btnSendMediaFile').click(); return true; })()`);
    await waitUntil(async () => /refuse\.mkv : aucun récepteur ne l’a accepté/.test(await consoleDe(s1)),
      { label: 'émetteur informé que personne n’a accepté' });
    if (!/a reçu video \(essaim\) mais Récepteur désactivé \(non lu\)/.test(await consoleDe(s1))) {
      throw new Error('l’accusé « non lu » du récepteur n’est pas arrivé chez l’émetteur');
    }
    await sleep(1500);
    const t0 = Date.now();
    await js(s1, '1');
    if (Date.now() - t0 > 1000) throw new Error(`page émettrice figée (${Date.now() - t0} ms pour répondre)`);
    if (await js(s1, 'document.getElementById("btnSendMediaFile").disabled')) throw new Error('bouton d’envoi resté bloqué');
  });

  await check('le direct s’arrête chez le récepteur dès que la capture cesse, même sans Stop', async () => {
    await js(s2, 'document.getElementById("btnActivate").click(); true');
    // Qualité « Natif » choisie dans les Paramètres : aucune limite demandée.
    await js(s1, `const q = document.getElementById('qualitePartage'); q.value = 'natif';
      q.dispatchEvent(new Event('change')); true`);
    await js(s1, 'document.getElementById("btnShareScreen").click(); true');
    await waitUntil(() => fluxChez(s2, s1.id), { label: 'flux affiché chez wim' });
    const video = (await js(s1, 'window.__contraintesPartage')).video;
    if (video !== true) throw new Error('qualité native : ' + JSON.stringify(video));
    if ((await js(s1, `localStorage.getItem('castunn.qualitePartage')`)) !== 'natif') throw new Error('choix non mémorisé');
    await js(s1, `localStorage.removeItem('castunn.qualitePartage'); true`);
    // L'ancien piège : « Fermer » (ou un autre média) coupait la capture sans
    // retirer les pistes, et le récepteur gardait une image figée.
    await js(s1, 'document.getElementById("localClose").click(); true');
    await waitUntil(async () => !(await fluxChez(s2, s1.id)), { label: 'vignette du direct retirée chez wim' });
  });

  await check('l’émetteur d’un direct s’en va : sa vignette disparaît, celle d’un média reçu reste', async () => {
    const s3 = await ouvrirPage('xena');
    await waitUntil(async () => (await pastille(s2)).texte === '2/2', { label: 'wim : 2/2', timeout: 20000 });
    await envoyerUrl(s3, 'image', 'https://example.invalid/de-xena.png');
    await js(s1, 'document.getElementById("btnShareScreen").click(); true');
    await waitUntil(() => fluxChez(s2, s1.id), { label: 'direct de vera chez wim' });
    await waitUntil(async () => (await vignettes(s2)).some((t) => t.de === s3.id), { label: 'image de xena chez wim' });
    const idS1 = s1.id;
    fermerPage(s1);   // fenêtre fermée net, sans « Stop »
    fermerPage(s3);
    await waitUntil(async () => !(await vignettes(s2)).some((t) => t.de === idS1), { label: 'vignette du direct retirée' });
    if (!(await vignettes(s2)).some((t) => t.de === s3.id)) throw new Error('l’image de xena a disparu avec son émetteur');
  });
  fermerPages();

  /* --- 7. Quatre pages : K4 ------------------------------------------------ */
  const k = [];
  for (const nom of ['p1', 'p2', 'p3', 'p4']) k.push(await ouvrirPage(nom));
  await check('à quatre, chaque page a trois liens P2P ouverts (K4)', async () => {
    for (const p of k) {
      await waitUntil(async () => (await pastille(p)).texte === '3/3', { label: `${p.nom} : 3/3`, timeout: 25000 });
    }
  });

  // Empreinte d'un blob affiché dans une page (file:// : crypto.subtle disponible).
  const EMPREINTE = `async (url) => {
    const octets = await (await fetch(url)).arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', octets))].map((x) => x.toString(16).padStart(2, '0')).join('');
  }`;

  await check('essaim à quatre : chacun reçoit le fichier exact, l’émetteur n’en envoie qu’environ une copie', async () => {
    await sleep(500); // canaux « essaim » ouverts juste après les liens
    const [source, ...recepteurs] = k;
    const TAILLE = 3 * 1024 * 1024;
    const attendu = await js(source, `(async () => {
      const octets = new Uint8Array(${TAILLE});
      let x = 12345; for (let i = 0; i < octets.length; i++) { x = (x * 1103515245 + 12345) >>> 0; octets[i] = x >>> 24; }
      const fichier = new File([octets], 'essaim.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(fichier);
      document.getElementById('mediaFile').files = dt.files;
      document.getElementById('btnSendMediaFile').click();
      return (${EMPREINTE})(URL.createObjectURL(fichier));
    })()`);
    for (const p of recepteurs) {
      const url = await waitUntil(async () => (await vignettes(p)).find((t) => t.de === source.id && t.image.startsWith('blob:'))?.image,
        { label: `${p.nom} : fichier reçu par essaim`, timeout: 30000 });
      const recu = await js(p, `(${EMPREINTE})(${JSON.stringify(url)})`);
      if (recu !== attendu) throw new Error(`${p.nom} : empreinte différente`);
      if (!/Média reçu \(essaim\)/.test(await consoleDe(source))) throw new Error('accusé « essaim » absent');
    }
    const log = await consoleDe(source);
    if (!/Envoi de essaim\.png : 3 par essaim/.test(log)) throw new Error('répartition : ' + log.split('\n').filter((l) => l.includes('Envoi de')).join(' | '));
    const stats = await js(source, 'window.__castunnEssaim');
    const copies = stats.octetsEnvoyes / TAILLE;
    console.log(`       (l’émetteur a envoyé ${copies.toFixed(2)} copie(s) ; sans essaim : 3)`);
    if (copies > 1.6) throw new Error(`l’émetteur a envoyé ${copies.toFixed(2)} copies`);
  });
  fermerPages();

  const echecs = results.filter((r) => !r).length;
  console.log(`\n${results.length - echecs}/${results.length} tests passés.`);
  await serveur.stop();
  app.exit(echecs ? 1 : 0);
});
