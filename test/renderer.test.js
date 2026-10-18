// test/renderer.test.js
// Tests d'interface : on charge la VRAIE page dans Electron, on lui branche un
// vrai serveur, et on vérifie ce que l'utilisateur lit à l'écran.
//
//   npm run test:ui
//
// Couvre le cas rapporté : un pair qui ne transmet pas son IP (vieille version,
// pas d'accès Internet, reverse proxy sans X-Forwarded-For) ne doit pas
// s'afficher sous la forme d'un identifiant brut, et la ligne doit se corriger
// dès que son identité arrive.

const path = require('path');
const { app, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const { startServer, VERSION } = require('./helpers');

// Port dédié aux tests : Castunn peut tourner en parallèle avec son serveur
// local sur 8080, les tests ne doivent pas en dépendre.
const PORT = Number(process.env.TEST_UI_PORT || 8098);
const PROJECT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 8000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`"${label}" jamais atteint après ${timeout}ms`);
}

const results = [];
let fenetre = null; // renseignée après création, pour le diagnostic d'échec

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${e.message}`);
    // Un test d'interface qui échoue sans montrer l'état de la page est
    // très pénible à diagnostiquer : on affiche ce que la page en dit.
    if (fenetre) {
      try {
        const etat = await fenetre.webContents.executeJavaScript(`({
          url: window.__castunnSignalUrl || '(aucune)',
          statut: document.getElementById('wsStatus').textContent,
          pairs: document.getElementById('peersCount').textContent,
          console: document.getElementById('consoleLog').textContent.split('\\n').slice(-6).join(' | ')
        })`);
        console.log(`       serveur : ${etat.url} | statut : ${etat.statut} | pairs : ${etat.pairs}`);
        console.log(`       console : ${etat.console}`);
      } catch { /* la page peut être fermée */ }
    }
  }
}

app.whenReady().then(async () => {
  let server;
  try {
    server = await startServer(PORT);
  } catch (e) {
    console.error(`\nImpossible de démarrer le serveur de test sur ${PORT} : ${e.message}`);
    console.error('(Castunn est peut-être déjà lancé et occupe le port.)');
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  fenetre = win;
  const pageErrors = [];
  // Electron 35+ : un objet évènement, `level` en toutes lettres. Avant :
  // arguments positionnels, `level` numérique (2 avertissement, 3 erreur),
  // encore transmis mais dépréciés. On accepte les deux : le jour où les
  // anciens disparaîtront, un collecteur muet rendrait le test des erreurs
  // vide — et vert.
  win.webContents.on('console-message', (e, niveauAncien, messageAncien) => {
    const level = e?.level ?? niveauAncien;
    const message = String(e?.message ?? messageAncien ?? '');
    const grave = level === 'warning' || level === 'error' || level >= 2;
    if (grave && !message.includes('Security Warning')) pageErrors.push(message);
  });

  await win.loadFile(path.join(PROJECT, 'castunn.html'));

  // On inscrit l'hôte de test comme "dernier serveur connu", puis on recharge :
  // c'est le chemin qu'emprunte l'application au démarrage suivant, quand elle
  // évite un balayage réseau complet.
  await win.webContents.executeJavaScript(
    `localStorage.setItem('castunn.signalHost', '127.0.0.1:${PORT}'); true`
  );
  pageErrors.length = 0;
  await win.webContents.reload();
  await new Promise((r) => {
    win.webContents.once('did-finish-load', r);
  });

  const chatText = () => win.webContents.executeJavaScript('document.getElementById("chatLog").textContent');
  const peersTitle = () => win.webContents.executeJavaScript('document.getElementById("peersPill").title');
  const peersCount = () => win.webContents.executeJavaScript('document.getElementById("peersCount").textContent');

  console.log('\nTests d\'interface\n');

  // La page doit se connecter d'elle-même au serveur local.
  // "Connecté" ne doit s'afficher qu'une fois le join envoyé : avant, la page
  // n'est pas dans la room et rate les arrivées.
  await check('la page rejoint la room via le dernier serveur connu, sans balayage', async () => {
    await waitUntil(
      async () => {
        const t = await win.webContents.executeJavaScript('document.getElementById("wsStatus").textContent');
        return t === 'Connecté' ? t : null;
      },
      { label: 'wsStatus = Connecté' }
    );
    const log = await win.webContents.executeJavaScript('document.getElementById("consoleLog").textContent');
    if (!log.includes('join envoyé')) {
      throw new Error('"Connecté" est affiché alors que le join n\'est pas parti');
    }
  });

  // Un pair "muet" : il rejoint sans annoncer d'IP (le cas alwaysdata).
  const mute = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((r) => mute.once('open', r));
  let mutePeerId = null;
  mute.on('message', (d) => {
    try { const j = JSON.parse(d.toString()); if (j.type === 'hello') mutePeerId = j.peerId; } catch {}
  });
  await waitUntil(async () => mutePeerId, { label: 'hello du pair muet' });
  mute.send(JSON.stringify({ type: 'join', room: 'default', version: VERSION })); // ni ip ni nick

  await check('un pair sans identité n\'affiche jamais un identifiant brut ni ::1', async () => {
    const text = await waitUntil(
      async () => { const t = await chatText(); return t.includes('Connexion de') ? t : null; },
      { label: 'ligne de connexion' }
    );
    if (text.includes('::1') || text.includes('127.0.0.1')) throw new Error(`adresse loopback affichée : ${text}`);
    if (text.includes(`Connexion de ${mutePeerId}`)) throw new Error(`identifiant brut affiché : ${text}`);
    if (!text.includes('un pair (')) throw new Error(`étiquette de repli attendue, reçu : ${text}`);
  });

  await check('le compteur de pairs monte à 1', async () => {
    const n = await waitUntil(async () => (await peersCount()) === '1' ? '1' : null, { label: 'peersCount = 1' });
    if (n !== '1') throw new Error('compteur = ' + n);
  });

  // Le pair annonce enfin son identité (ipify a fini par répondre chez lui).
  mute.send(JSON.stringify({ type: 'announce', ip: '90.11.22.33', nick: 'bob' }));

  await check('la ligne déjà affichée est corrigée quand l\'identité arrive', async () => {
    const text = await waitUntil(
      async () => { const t = await chatText(); return t.includes('90.11.22.33') ? t : null; },
      { label: 'ligne corrigée' }
    );
    if (!text.includes('Connexion de 90.11.22.33 (bob)')) throw new Error(`ligne inattendue : ${text}`);
    if (text.includes('un pair (')) throw new Error(`l'ancienne étiquette subsiste : ${text}`);
    const occurrences = (text.match(/Connexion de/g) || []).length;
    if (occurrences !== 1) throw new Error(`la ligne a été dupliquée (${occurrences} occurrences) au lieu d'être corrigée`);
  });

  await check('l\'infobulle des pairs reprend l\'identité complète', async () => {
    const title = await waitUntil(
      async () => { const t = await peersTitle(); return t.includes('90.11.22.33') ? t : null; },
      { label: 'infobulle à jour' }
    );
    if (!title.includes('90.11.22.33 (bob)')) throw new Error('infobulle : ' + title);
  });

  // Les accusés de réception repartent vers l'émetteur : on les collecte.
  const muteMessages = [];
  mute.on('message', (d) => {
    try { muteMessages.push(JSON.parse(d.toString())); } catch {}
  });

  // Le récepteur est volontairement désactivé au démarrage : on l'active comme
  // le ferait l'utilisateur (et ça vérifie que les boutons répondent toujours
  // après le passage du script en module ES).
  await check('le bouton Activer rend le récepteur réceptif', async () => {
    await win.webContents.executeJavaScript('document.getElementById("btnActivate").click()');
    const status = await waitUntil(
      async () => {
        const t = await win.webContents.executeJavaScript('document.getElementById("activationStatus").textContent');
        return t && t.toLowerCase().includes('activ') && !t.toLowerCase().includes('désactiv') ? t : null;
      },
      { label: 'récepteur activé' }
    );
    if (!status) throw new Error('statut : ' + status);
  });

  // Transfert binaire de bout en bout : c'est le pipeline unifié qui travaille.
  await check('une image reçue par morceaux est affichée', async () => {
    // PNG 1x1 valide
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    mute.send(JSON.stringify({
      type: 'binary-meta', filename: 'point.png', size: png.length,
      mime: 'image/png', kind: 'image', fileId: 'img1'
    }));
    await sleep(120);
    mute.send(png);            // ws envoie en binaire par défaut pour un Buffer
    await sleep(120);
    mute.send(JSON.stringify({ type: 'binary-end', fileId: 'img1' }));

    const src = await waitUntil(
      async () => {
        const v = await win.webContents.executeJavaScript('document.querySelector("#receptions .tuile-image")?.src || ""');
        return v.startsWith('blob:') ? v : null;
      },
      { label: 'image affichée' }
    );
    if (!src.startsWith('blob:')) throw new Error('source inattendue : ' + src);
  });

  await check('un envoi marqué "fichier" est téléchargé, jamais affiché', async () => {
    // kind:'file' => jamais envoyé au lecteur, quel que soit le type MIME
    const before = await win.webContents.executeJavaScript('document.querySelector("#receptions .tuile-image")?.src || ""');
    muteMessages.length = 0;
    mute.send(JSON.stringify({
      type: 'binary-meta', filename: 'archive.bin', size: 3,
      mime: 'image/png', kind: 'file', fileId: 'f9'
    }));
    await sleep(120);
    mute.send(Buffer.from([1, 2, 3]));
    await sleep(120);
    mute.send(JSON.stringify({ type: 'binary-end', fileId: 'f9' }));

    // L'accusé de réception prouve que le transfert a bien été traité.
    const confirmation = await waitUntil(
      async () => muteMessages.find((m) => m.type === 'confirmation' && String(m.text || '').includes('archive.bin')),
      { label: 'accusé de réception du fichier' }
    );
    if (!/re.u/i.test(confirmation.text)) throw new Error('accusé inattendu : ' + confirmation.text);

    const after = await win.webContents.executeJavaScript('document.querySelector("#receptions .tuile-image")?.src || ""');
    if (after !== before) throw new Error('le fichier a été affiché alors qu\'il devait être téléchargé');
  });

  // Départ : l'identité connue doit être conservée dans le message.
  mute.close();
  await check('le départ est annoncé avec l\'identité connue', async () => {
    const text = await waitUntil(
      async () => { const t = await chatText(); return t.includes('Déconnexion de') ? t : null; },
      { label: 'ligne de déconnexion' }
    );
    if (!text.includes('Déconnexion de 90.11.22.33 (bob)')) throw new Error(`ligne inattendue : ${text}`);
  });

  await check('le compteur de pairs redescend à 0', async () => {
    const n = await waitUntil(async () => (await peersCount()) === '0' ? '0' : null, { label: 'peersCount = 0' });
    if (n !== '0') throw new Error('compteur = ' + n);
  });

  // Un pair arrivé en IPv6 (le serveur le constate via le proxy) mais qui
  // déclare son IPv4 : c'est le cas d'un contact hors du réseau local.
  const dual = new WebSocket(`ws://127.0.0.1:${PORT}`, {
    headers: { 'x-forwarded-for': '2001:863:294:3d9b:a0c:ca63:d094:b080' }
  });
  await new Promise((r) => dual.once('open', r));
  dual.send(JSON.stringify({ type: 'join', room: 'default', version: VERSION, ip: '80.214.20.117', nick: 'sir' }));

  const ligneDe = (fragment) => win.webContents.executeJavaScript(`
    (() => {
      const l = [...document.querySelectorAll("#chatLog div")]
        .find((d) => d.textContent.includes(${JSON.stringify(fragment)}));
      return l ? { texte: l.textContent, title: l.title } : null;
    })()`);

  await check("un pair venu en IPv6 est affiché sous son IPv4, l'IPv6 au survol", async () => {
    const ligne = await waitUntil(async () => ligneDe('80.214.20.117'), { label: 'ligne du pair IPv6' });
    if (!ligne.texte.includes('Connexion de 80.214.20.117 (sir)')) {
      throw new Error(`ligne inattendue : ${ligne.texte}`);
    }
    if (ligne.texte.includes('2001:863:294:3d9b:a0c:ca63:d094:b080')) {
      throw new Error(`l'IPv6 encombre la ligne : ${ligne.texte}`);
    }
    if (ligne.title !== 'IPv6 : 2001:863:294:3d9b:a0c:ca63:d094:b080') {
      throw new Error(`infobulle de ligne : ${JSON.stringify(ligne.title)}`);
    }
  });

  await check("l'infobulle des pairs donne les deux adresses", async () => {
    const title = await waitUntil(
      async () => { const t = await peersTitle(); return t.includes('80.214.20.117') ? t : null; },
      { label: 'infobulle à deux adresses' }
    );
    if (!title.includes('80.214.20.117 (sir) · 2001:863:294:3d9b:a0c:ca63:d094:b080')) {
      throw new Error('infobulle : ' + title);
    }
  });

  // On le fait repartir : la suite des tests compte sur un seul pair.
  dual.close();

  // Témoin : une erreur volontaire doit être captée. Sinon, « aucune erreur »
  // ne voudrait rien dire.
  await check('le collecteur d’erreurs de la page fonctionne', async () => {
    await win.webContents.executeJavaScript('console.error("témoin du collecteur"); true');
    await waitUntil(async () => pageErrors.some((m) => m.includes('témoin du collecteur')),
      { label: 'erreur témoin captée', timeout: 3000 });
    const sansTemoin = pageErrors.filter((m) => !m.includes('témoin du collecteur'));
    pageErrors.length = 0;
    pageErrors.push(...sansTemoin);
  });

  await check('aucune erreur JavaScript dans la page', async () => {
    if (pageErrors.length) throw new Error(pageErrors.join(' | '));
  });

  await check('les modules se chargent et le garde-fou reste invisible', async () => {
    const ready = await win.webContents.executeJavaScript('window.__castunnReady === true');
    if (!ready) throw new Error('les modules ES ne se sont pas chargés');
    // Le garde-fou se déclenche à 2 s : on lui laisse le temps de ne rien faire.
    await sleep(2300);
    const alerte = await win.webContents.executeJavaScript(
      'document.querySelectorAll(\'[role="alert"]\').length'
    );
    if (alerte !== 0) throw new Error('le garde-fou s\'est déclenché à tort');
  });

  // Volontairement en dernier : ce test provoque une erreur, qui fausserait
  // le contrôle "aucune erreur JavaScript" s'il tournait avant.
  await check('une erreur non capturée devient visible dans la console de l\'app', async () => {
    await win.webContents.executeJavaScript(
      'setTimeout(() => { throw new Error("panne simulée"); }, 0); true'
    );
    await waitUntil(
      async () => {
        const t = await win.webContents.executeJavaScript('document.getElementById("consoleLog").textContent');
        return t.includes('panne simulée') ? t : null;
      },
      { label: 'erreur affichée dans la console de l\'app' }
    );
  });

  await check('une promesse rejetée devient visible dans la console de l\'app', async () => {
    await win.webContents.executeJavaScript(
      'Promise.reject(new Error("promesse cassée")); true'
    );
    await waitUntil(
      async () => {
        const t = await win.webContents.executeJavaScript('document.getElementById("consoleLog").textContent');
        return t.includes('promesse cassée') ? t : null;
      },
      { label: 'rejet affiché dans la console de l\'app' }
    );
  });

  await check('la version réelle et sa date sont affichées', async () => {
    const t = await win.webContents.executeJavaScript('document.getElementById("appVersion").textContent');
    if (!new RegExp(`^Castunn v${VERSION.replace(/\./g, '\\.')} du \\d\\d-\\d\\d-\\d{4}$`).test(t)) throw new Error('affiché : ' + t);
  });

  // Un serveur d'une autre version : la page doit refuser net, le dire
  // clairement, et ne plus réessayer d'elle-même.
  await check('serveur d’une autre version : erreur fatale claire, sans nouvel essai', async () => {
    const PORT_AUTRE = PORT - 7;
    const autre = new WebSocket.Server({ port: PORT_AUTRE, host: '127.0.0.1' });
    let connexions = 0;
    autre.on('connection', (ws) => { connexions++; ws.send(JSON.stringify({ type: 'hello', peerId: 'zz', version: '0.0.1' })); });
    const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    try {
      await page.loadFile(path.join(PROJECT, 'castunn.html'));
      await page.webContents.executeJavaScript(`localStorage.setItem('castunn.signalHost', '127.0.0.1:${PORT_AUTRE}'); true`);
      await page.webContents.reload();
      await new Promise((r) => page.webContents.once('did-finish-load', r));
      const bandeau = await waitUntil(async () => page.webContents.executeJavaScript(
        `(() => { const b = document.getElementById('bandeauFatal'); return b.hidden ? null : b.textContent; })()`),
        { label: 'bandeau d’erreur fatale' });
      if (!bandeau.includes(`v${VERSION}`) || !bandeau.includes('v0.0.1') || !bandeau.includes('même version')) {
        throw new Error('message : ' + bandeau);
      }
      const statut = await page.webContents.executeJavaScript('document.getElementById("wsStatus").textContent');
      if (statut !== 'Version incompatible') throw new Error('statut : ' + statut);
      await sleep(4500); // au-delà du réessai automatique (3 s)
      if (connexions !== 1) throw new Error(`${connexions} connexions : la page a réessayé`);
    } finally {
      page.destroy();
      await new Promise((r) => autre.close(r));
    }
  });

  /* --- Salles privées, sur un serveur public (étape 6) ---------------------- */
  // 8086 : 8090 est pris sur la machine de développement (Wondershare écoute
  // sur 127.0.0.1:8090 ; les connexions locales allaient chez lui).
  const PORT_PUBLIC = Number(process.env.TEST_UI_PUBLIC_PORT || 8086);
  const publique = await startServer(PORT_PUBLIC, { env: { CASTUNN_SALLE_LIBRE: null } });
  const pagesSalle = [];
  async function pagePublique(hash = '') {
    const p = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    pagesSalle.push(p);
    // Le stockage est partagé avec les autres pages du test : une écriture peut
    // n'être visible qu'un instant plus tard. On recharge jusqu'à ce que la
    // page parle bien au serveur public.
    for (let essai = 0; essai < 5; essai++) {
      await p.loadFile(path.join(PROJECT, 'castunn.html'));
      await p.webContents.executeJavaScript(`localStorage.clear(); localStorage.setItem('castunn.signalHost', '127.0.0.1:${PORT_PUBLIC}'); true`);
      await sleep(300);
      await p.loadFile(path.join(PROJECT, 'castunn.html'), hash ? { hash } : {});
      const url = await waitUntil(() => p.webContents.executeJavaScript('window.__castunnSignalUrl || ""'), { label: 'adresse du serveur' });
      if (url === `ws://127.0.0.1:${PORT_PUBLIC}`) return p;
    }
    throw new Error('la page ne joint pas le serveur public');
  }
  const lire = (p, js) => p.webContents.executeJavaScript(js);
  const statutDe = (p) => lire(p, 'document.getElementById("wsStatus").textContent');
  const bandeauDe = (p) => lire(p, `(() => { const b = document.getElementById('bandeauFatal'); return b.hidden ? '' : b.textContent; })()`);
  let code = '';

  await check('serveur public sans code de salle : erreur claire, sans nouvel essai', async () => {
    const p = await pagePublique();
    const texte = await waitUntil(() => bandeauDe(p), { label: 'bandeau' }).catch(async (e) => {
      throw new Error(`${e.message} — page : ${(await lire(p, 'document.getElementById("consoleLog").textContent')).split('\n').slice(-6).join(' | ')}`
        + ` — serveur : ${publique.sortie().split('\n').slice(-4).join(' | ')}`);
    });
    if (!/n’accepte que les salles privées/.test(texte)) throw new Error('bandeau : ' + texte);
    if ((await statutDe(p)) !== 'Salle requise') throw new Error('statut : ' + await statutDe(p));
    const refus = () => (publique.sortie().match(/refusé : salle/g) || []).length;
    const avant = refus();
    await sleep(4000);
    if (refus() !== avant) throw new Error('la page a réessayé seule');
  });

  await check('« Nouvelle salle » puis Enregistrer : on entre, et le code est mémorisé', async () => {
    const p = pagesSalle[0];
    code = await lire(p, `document.getElementById('settingsBtn').click();
      document.getElementById('btnNouvelleSalle').click();
      const c = document.getElementById('salleCode').value;
      document.getElementById('settingsForm').requestSubmit(); c`);
    await waitUntil(async () => (await statutDe(p)) === 'Connecté' && !(await bandeauDe(p)), { label: 'connecté, bandeau levé' });
    const memorise = await lire(p, `localStorage.getItem('castunn.salle')`);
    if (memorise !== code.replace(/-/g, '')) throw new Error(`mémorisé : ${memorise}, attendu ${code}`);
    if (!(await lire(p, 'document.getElementById("consoleLog").textContent')).includes('salle privée')) throw new Error('console');
    if ((await lire(p, 'document.getElementById("consoleLog").textContent')).includes(code)) throw new Error('le code ne doit pas s’afficher dans la console');
  });

  await check('un lien #salle=<code> rejoint la même salle ; un autre code, une autre salle', async () => {
    const meme = await pagePublique(`salle=${code}`);
    await waitUntil(async () => (await statutDe(meme)) === 'Connecté', { label: 'page du lien connectée' });
    await waitUntil(async () => (await lire(pagesSalle[0], 'document.getElementById("peersCount").textContent')) === '1',
      { label: 'les deux se voient' });
    const autre = await pagePublique('salle=zzzz-zzzz-zzzz-zzzz-zzzz');
    await waitUntil(async () => (await statutDe(autre)) === 'Connecté', { label: 'autre salle connectée' }).catch(async (e) => {
      throw new Error(`${e.message} — statut ${await statutDe(autre)} — page : ${(await lire(autre, 'document.getElementById("consoleLog").textContent')).split('\n').slice(-5).join(' | ')}`);
    });
    await sleep(800);
    if ((await lire(pagesSalle[0], 'document.getElementById("peersCount").textContent')) !== '1') {
      throw new Error('une autre salle est visible');
    }
  });
  for (const p of pagesSalle.splice(0)) p.destroy();
  await publique.stop();

  await check('serveur plein : le refus est expliqué, et la page attend avant de réessayer', async () => {
    const plein = await startServer(PORT_PUBLIC, { env: { CASTUNN_MAX_CLIENTS: '1' } });
    const occupant = new WebSocket(`ws://127.0.0.1:${PORT_PUBLIC}`);
    await new Promise((r) => occupant.once('open', r));
    try {
      const p = await pagePublique();
      const texte = await waitUntil(() => bandeauDe(p), { label: 'bandeau de refus' });
      if (!/serveur est plein/.test(texte) || !/Nouvel essai automatique dans \d+ s/.test(texte)) throw new Error('bandeau : ' + texte);
      if ((await statutDe(p)) !== 'Refusé') throw new Error('statut : ' + await statutDe(p));
      const refus = () => (plein.sortie().match(/connexion refusée/g) || []).length;
      const avant = refus();
      await sleep(4500);   // au-delà du réessai habituel de 3 s
      if (refus() !== avant) throw new Error('la page a réessayé avant le délai indiqué');
    } finally {
      occupant.close();
      for (const p of pagesSalle.splice(0)) p.destroy();
      await plein.stop();
    }
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} tests passés.`);

  await server.stop();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('ECHEC DU HARNAIS:', e); app.exit(1); });
