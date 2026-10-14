// test/main.test.js
// Vérifie le processus principal : les canaux IPC que l'interface appelle
// existent et répondent, et le serveur local démarre pour de bon.
//
//   npm run test:main
//
// Ces canaux n'étaient couverts par aucun test : une fonction supprimée par
// erreur dans main.js n'a été découverte qu'à l'usage, l'application signalant
// « ensureFirewallRule is not defined » au clic sur « Lancer le serveur ».

const path = require('path');
const net = require('net');
const { app, ipcMain, BrowserWindow } = require('electron');

const PROJECT = path.join(__dirname, '..');
const results = [];

async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`  ok   ${name}`); }
  catch (e) { results.push(false); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion échouée'); }

/** Le port répond-il ? */
function portOuvert(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const fin = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, '127.0.0.1');
  });
}

// Appelle un canal IPC comme le ferait le renderer.
function invoke(canal, ...args) {
  const h = ipcMain._invokeHandlers.get(canal);
  if (!h) throw new Error(`aucun gestionnaire pour "${canal}"`);
  return h({}, ...args);
}

app.whenReady().then(async () => {
  // Le vrai main.js ouvrirait des ports sur le routeur de la machine de test.
  process.env.CASTUNN_SANS_UPNP = '1';
  // Ni règle de pare-feu : la vérification vise le programme exact, et
  // l'Electron de développement n'en a pas — l'élévation bloquerait la suite.
  process.env.CASTUNN_SANS_PAREFEU = '1';
  // Vérifie au passage que main.js transmet les modes de test à la page.
  // Sans effet sur les autres vérifications : aucune ne passe par le P2P.
  process.env.CASTUNN_FORCE_RELAY = '1';
  // Charge main.js : il enregistre ses gestionnaires IPC et ouvre sa fenêtre.
  require(path.join(PROJECT, 'main.js'));
  await new Promise((r) => setTimeout(r, 1200));

  console.log('\nTests du processus principal\n');

  await check('les canaux attendus par l\'interface sont enregistrés', () => {
    for (const canal of ['server-start', 'server-stop', 'server-status', 'server-discover',
                         'webrtc-ports', 'port-forwarding-status', 'port-forwarding-set']) {
      assert(ipcMain._invokeHandlers.has(canal), `canal manquant : ${canal}`);
    }
  });

  await check('l’ouverture de ports répond, neutralisée pendant les tests', async () => {
    const e = await invoke('port-forwarding-status');
    assert(e.min === 26100 && e.max === 26129 && e.total === 30, 'plage : ' + JSON.stringify(e));
    assert(typeof e.message === 'string' && e.message.startsWith('UPnP'), 'message : ' + e.message);
    assert(!/ouverts|partiel/.test(e.message), 'aucun port ne doit avoir été ouvert : ' + e.message);
  });

  await check('webrtc-ports décrit la plage réservée', async () => {
    const p = await invoke('webrtc-ports');
    assert(p.total === 30 && p.libres >= 0 && p.libres <= 30, JSON.stringify(p));
  });

  // La vraie fenêtre, avec le vrai preload : la case des Paramètres doit
  // refléter l'état du processus principal, et le piloter.
  const fenetre = BrowserWindow.getAllWindows()[0];
  const page = (js) => fenetre.webContents.executeJavaScript(js);
  const attendre = async (fn, label, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`"${label}" jamais atteint`);
  };

  await check('la case « ports du routeur » apparaît et reflète l’état', async () => {
    await attendre(() => page('window.__castunnReady === true'), 'page chargée');
    const visible = await page(`document.getElementById('portForwardingRow').style.display !== 'none'`);
    assert(visible, 'la ligne doit être visible sous Electron');
    assert(await page(`document.getElementById('chkPortForwarding').checked`), 'cochée par défaut');
    const statut = await attendre(async () => {
      const t = await page(`document.getElementById('portForwardingStatus').textContent`);
      return t.includes('CASTUNN_SANS_UPNP') ? t : null;
    }, 'état affiché');
    const label = await page(`document.getElementById('portForwardingLabel').textContent`);
    assert(label.includes('26100-26129'), 'plage affichée : ' + label);
    const log = await page(`document.getElementById('consoleLog').textContent`);
    assert(log.includes(statut), 'l’état figure aussi dans la console de l’app');
  });

  await check('une variable CASTUNN_* atteint la page comme mode de test', async () => {
    const url = await page('location.search');
    assert(url.includes('forceRelay=1'), 'paramètre absent de l’URL : ' + url);
    const log = await page(`document.getElementById('consoleLog').textContent`);
    assert(log.includes('[TEST] relais forcé'), 'mode non annoncé dans la console');
  });

  await check('décocher la case passe par le processus principal', async () => {
    await page(`document.getElementById('chkPortForwarding').click(); true`);
    await attendre(async () => (await invoke('port-forwarding-status')).statut === 'desactive', 'désactivé côté main');
    await attendre(async () => (await page(`document.getElementById('portForwardingStatus').textContent`))
      === 'UPnP désactivé : aucune redirection', 'texte « désactivé »');
    await page(`document.getElementById('chkPortForwarding').click(); true`);
    await attendre(async () => (await invoke('port-forwarding-status')).actif === true, 'réactivé');
  });

  await check('server-status répond avec le port et les adresses', async () => {
    const s = await invoke('server-status');
    assert(typeof s.running === 'boolean', 'champ running');
    assert(s.port > 0, 'champ port');
    assert(Array.isArray(s.addresses), 'champ addresses');
  });

  await check('server-discover répond une liste', async () => {
    // Port sans rien derrière : on veut une réponse, pas une découverte.
    const hosts = await invoke('server-discover', { port: 8123, overallTimeout: 20000 });
    assert(Array.isArray(hosts), 'une liste est attendue, reçu : ' + JSON.stringify(hosts));
  });

  await check('server-start démarre réellement le serveur local', async () => {
    const dejaPris = await portOuvert(8080);
    if (dejaPris) {
      throw new Error('le port 8080 est déjà occupé (Castunn est-il lancé ?)');
    }
    const res = await invoke('server-start');
    assert(res && res.ok, 'démarrage refusé : ' + JSON.stringify(res));
    assert(await portOuvert(8080), 'le port 8080 n\'écoute pas après server-start');
  });

  await check('server-stop arrête le serveur', async () => {
    await invoke('server-stop');
    await new Promise((r) => setTimeout(r, 500));
    const s = await invoke('server-status');
    assert(s.running === false, 'le serveur est toujours signalé actif');
  });

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} tests passés.`);
  // Réglages jetables du mode neutralisé (voir creerOuverturePorts).
  require('fs').rmSync(path.join(require('os').tmpdir(), `castunn-test-${process.pid}`),
    { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('ECHEC DU HARNAIS:', e); app.exit(1); });
