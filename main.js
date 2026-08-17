const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog } = require('electron');
const { fork, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const https = require('https');
const { autoUpdater } = require('electron-updater');

let serverProcess = null;
const SERVER_PORT = 8080;

// URL FIXE ET PERMANENTE : ce petit fichier "aiguilleur" ne bouge jamais,
// même si l'hébergement des VRAIES mises à jour change plus tard (ex: ton domaine).
// Pour changer la source des mises à jour à l'avenir, il suffit de modifier
// le contenu de ce fichier JSON sur GitHub — aucune republication de l'app requise.
const UPDATE_POINTER_URL = 'https://raw.githubusercontent.com/Lumonui/castunn/main/update-config.json';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  try {
    // cfg attendu : { provider: 'github', owner: '...', repo: '...' }
    // ou plus tard, une fois sur ton domaine :
    // { provider: 'generic', url: 'https://updates.tondomaine.com/castunn/' }
    const cfg = await fetchJson(UPDATE_POINTER_URL);
    autoUpdater.setFeedURL(cfg);
    console.log('[update] Source de mise à jour (distante) :', cfg);
  } catch (e) {
    console.warn('[update] Pointer distant inaccessible, utilisation de la config par défaut (package.json).', e.message);
    // Pas grave : electron-updater retombe sur la config "publish" figée au build (GitHub par défaut).
  }

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Mise à jour disponible',
      message: 'Une nouvelle version de Castunn a été téléchargée.\nRedémarrer maintenant pour l’installer ?',
      buttons: ['Redémarrer', 'Plus tard'],
      defaultId: 0
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[update] erreur autoUpdater:', err);
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    console.error('[update] échec checkForUpdates:', e.message);
  }
}

/* ==========================================================================
 * Découverte d'un serveur Castunn sur le réseau local.
 *
 * Le balayage lui-même vit dans discovery.js et s'exécute dans un processus
 * séparé : il ouvre des centaines de connexions TCP, et le processus principal
 * doit rester libre pour la fenêtre. Exécuté ici, il figeait l'interface
 * plusieurs secondes au démarrage.
 * ========================================================================== */

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

function discoveryScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'discovery.js')
    : path.join(__dirname, 'discovery.js');
}

/**
 * Lance un balayage dans un processus dédié, arrêté dès qu'il a répondu.
 * En cas de pépin (script absent, processus tué), on renvoie une liste vide :
 * l'appelant retombe alors sur la machine locale.
 */
function discoverLanServers(opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = fork(discoveryScriptPath(), [], { silent: true });
    } catch (e) {
      console.error('[discover] processus non démarré :', e.message);
      return resolve([]);
    }

    let fini = false;
    const terminer = (hosts) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      try { child.kill(); } catch {}
      resolve(hosts);
    };

    // Filet : un balayage complet dure quelques secondes, jamais une minute.
    const minuteur = setTimeout(() => {
      console.warn('[discover] délai dépassé, balayage abandonné');
      terminer([]);
    }, opts.overallTimeout || 30000);

    child.on('message', (msg) => {
      if (!msg || msg.id !== 1) return;
      if (!msg.ok) console.error('[discover] échec :', msg.error);
      terminer(msg.ok ? (msg.hosts || []) : []);
    });
    child.on('error', (e) => { console.error('[discover]', e.message); terminer([]); });
    child.on('exit', () => terminer([]));

    child.send({ cmd: 'discover', id: 1, opts: { port: opts.port || SERVER_PORT, ...opts } });
  });
}

/* ==========================================================================
 * Règle de pare-feu Windows.
 * Sans elle, les autres machines du foyer ne peuvent pas joindre le serveur :
 * c'est la cause classique d'une connexion qui ne marche que dans un sens.
 * On la pose une seule fois, au premier démarrage du serveur local, avec une
 * élévation ponctuelle — et jamais au lancement de l'application.
 * Volontairement limitée aux réseaux privés/domaine : sur un réseau public
 * (hôtel, café), n'importe qui pourrait sinon rejoindre la room, qui n'est
 * protégée par aucune authentification.
 * ========================================================================== */

const FIREWALL_RULE = 'Castunn-LAN';

function execFileAsync(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function firewallRuleExists() {
  const { err } = await execFileAsync('netsh', [
    'advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`
  ]);
  return !err; // netsh sort en erreur quand aucune règle ne correspond
}

/**
 * S'assure que le port de signalisation est joignable depuis le réseau local.
 * Ne bloque jamais le démarrage du serveur : si l'utilisateur refuse
 * l'élévation, Windows proposera sa propre autorisation à la première écoute.
 */
async function ensureFirewallRule() {
  if (process.platform !== 'win32') return { ok: true, reason: 'hors Windows' };

  try {
    if (await firewallRuleExists()) return { ok: true, reason: 'déjà en place' };

    const args = [
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${FIREWALL_RULE}`,
      'dir=in', 'action=allow', 'protocol=TCP',
      `localport=${SERVER_PORT}`,
      'profile=private,domain',
      `program=${process.execPath}`,
      'enable=yes'
    ];
    const psArgs = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');

    const { err } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process -FilePath netsh -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @(${psArgs})`
    ]);
    if (err) return { ok: false, reason: 'élévation refusée ou impossible' };

    const created = await firewallRuleExists();
    return created ? { ok: true, reason: 'créée' } : { ok: false, reason: 'non créée' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}


function spawnServer() {
  return new Promise((resolve) => {
    if (serverProcess) return resolve({ ok: true, msg: 'déjà lancé' });
    try {
      const srvPath = app.isPackaged
        ? path.join(process.resourcesPath, 'server.js')
        : path.join(__dirname, 'server.js');

      const nodeModulesPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
        : path.join(__dirname, 'node_modules');

      serverProcess = fork(srvPath, [], {
        env: { ...process.env, PORT: '8080', NODE_PATH: nodeModulesPath }, // ← NODE_PATH ajouté
        silent: true
      });

      let resolved = false;
      let stderrBuf = '';
      const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };

      serverProcess.stdout?.on('data', d => {
        const line = d.toString().trim();
        console.log('[srv]', line);
        if (line.includes('prêt') || line.includes('8080')) done({ ok: true });
      });

      serverProcess.stderr?.on('data', d => {
        const line = d.toString().trim();
        stderrBuf += line + '\n';
        console.error('[srv stderr]', line);
      });

      serverProcess.on('exit', (code) => {
        serverProcess = null;
        const hint = stderrBuf.trim().split('\n').find(l => l.includes('Error') || l.includes('error'))
                     || stderrBuf.trim().split('\n')[0]
                     || '(pas de détails)';
        done({ ok: false, msg: `exit ${code} — ${hint}` });
      });

      setTimeout(() => done({ ok: true }), 2000);
    } catch (e) {
      resolve({ ok: false, msg: e.message });
    }
  });
}

function killServer() {
  if (!serverProcess) return { ok: true, msg: 'pas lancé' };
  serverProcess.kill();
  serverProcess = null;
  return { ok: true };
}

function createWindow() {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'castunn.html'));
}

app.whenReady().then(() => {
  // IPC serveur local
  ipcMain.handle('server-start',  async () => {
    // Avant d'écouter : s'assurer que le pare-feu laisse entrer le LAN.
    const fw = await ensureFirewallRule();
    console.log('[pare-feu]', fw.ok ? `règle ${fw.reason}` : `non posée (${fw.reason})`);
    const res = await spawnServer();
    return { ...res, firewall: fw };
  });
  ipcMain.handle('server-stop',   () => killServer());
  ipcMain.handle('server-status', () => ({
    running: !!serverProcess,
    port: SERVER_PORT,
    // Adresses à communiquer aux autres machines du foyer
    addresses: localIPv4s().map(a => `${a}:${SERVER_PORT}`)
  }));

  // Découverte réseau (une seule à la fois : un scan concurrent ne sert à rien)
  let discoveryInFlight = null;
  ipcMain.handle('server-discover', (_evt, opts) => {
    if (!discoveryInFlight) {
      discoveryInFlight = discoverLanServers(opts || {})
        .catch((e) => { console.error('[discover]', e); return []; })
        .finally(() => { discoveryInFlight = null; });
    }
    return discoveryInFlight;
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(err => {
      console.error('Erreur capture écran Electron:', err);
      callback(null);
    });
  });

  createWindow();

  // L'auto-update ne fonctionne (et n'a de sens) qu'une fois l'app installée/packagée.
  if (app.isPackaged) {
    setupAutoUpdater();
  }
});

// Tue le serveur enfant proprement à la fermeture
app.on('before-quit', () => killServer());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});