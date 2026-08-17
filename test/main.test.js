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
const { app, ipcMain } = require('electron');

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
  // Charge main.js : il enregistre ses gestionnaires IPC et ouvre sa fenêtre.
  require(path.join(PROJECT, 'main.js'));
  await new Promise((r) => setTimeout(r, 1200));

  console.log('\nTests du processus principal\n');

  await check('les canaux attendus par l\'interface sont enregistrés', () => {
    for (const canal of ['server-start', 'server-stop', 'server-status', 'server-discover']) {
      assert(ipcMain._invokeHandlers.has(canal), `canal manquant : ${canal}`);
    }
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
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('ECHEC DU HARNAIS:', e); app.exit(1); });
