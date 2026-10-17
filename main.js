const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog, protocol, webContents } = require('electron');
const { declarerSchema, servirFlux } = require('./flux-protocole.js');
const { fork, execFile } = require('child_process');
const {
  WEBRTC_UDP_PORTS, etatPortsWebRTC, appliquerPlageWebRTC, plageChromium, debutValide
} = require('./webrtc-ports.js');
const { OuverturePorts } = require('./port-forwarding.js');
const { trouverPasserelle, adresseLocaleVers } = require('./nat-mapper.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { autoUpdater } = require('electron-updater');

let serverProcess = null;
const SERVER_PORT = 8080;

/* ==========================================================================
 * Un profil par instance.
 *
 * Deux instances de Castunn lancées en même temps partageaient le même dossier
 * userData. Le premier `localStorage.getItem` de la seconde attendait alors le
 * verrou LevelDB détenu par la première : mesuré à 5,7 s, soit la quasi-totalité
 * des « 6 s avant interface prête » (contre ~0,3 s pour une instance seule).
 * Le cache disque et le cache GPU souffraient du même conflit
 * (« Unable to move the cache: Accès refusé »).
 *
 * On détecte l'occupation avec le verrou d'instance d'Electron — qui porte
 * justement sur le dossier userData — et on se décale sur « userData-2 », « -3 »…
 * Les noms sont stables d'un lancement à l'autre : chaque instance retrouve donc
 * son hôte de signalisation et son pseudo mémorisés.
 *
 * À faire AVANT app.whenReady() : après, le profil est déjà ouvert.
 * ========================================================================== */
/** Renvoie true pour l’instance principale (celle du profil de base). */
// Profil de la première instance : les autres y lisent sa fenêtre de ports.
const profilDeBase = app.getPath('userData');

function claimOwnUserDataDir() {
  const base = profilDeBase;
  for (let n = 2; !app.requestSingleInstanceLock(); n++) {
    if (n > 8) { // garde-fou : jamais de boucle infinie au démarrage
      console.warn('[profil] aucun profil libre, profil partagé (démarrage lent possible)');
      return false;
    }
    app.setPath('userData', `${base}-${n}`);
  }
  const chosen = app.getPath('userData');
  if (chosen !== base) console.log('[profil] instance secondaire :', chosen);
  return chosen === base;
}

const instancePrincipale = claimOwnUserDataDir();

// Lecture pendant le téléchargement : schéma castunn-flux://, privilégié, donc
// déclaré avant whenReady (voir flux-protocole.js).
declarerSchema(protocol, app);

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

/**
 * Une règle Castunn couvre-t-elle CE programme ?
 *
 * Chercher la règle par son seul nom ne suffisait pas : elle est liée au
 * programme qui l'a créée. Sur une machine où l'application installée l'avait
 * posée, la version de développement la trouvait, concluait « déjà en place »,
 * et son serveur restait bloqué — de même après une réinstallation ailleurs.
 *
 * PowerShell plutôt que netsh : netsh répond dans la langue du système, avec
 * des accents mal encodés. Ici, ni texte à lire (le verdict est le code de
 * sortie), ni chemin à mettre entre guillemets (il passe par l'environnement).
 */
async function firewallRuleExists(programme = process.execPath) {
  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue`
        + ' | Get-NetFirewallApplicationFilter'
        + ' | Where-Object { $_.Program -ieq $env:CASTUNN_PROGRAMME }) { exit 0 } else { exit 1 }'
    ], {
      windowsHide: true,
      env: { ...process.env, CASTUNN_PROGRAMME: programme }
    }, (err) => resolve(!err));
  });
}

/**
 * S'assure que le port de signalisation est joignable depuis le réseau local.
 * Ne bloque jamais le démarrage du serveur : si l'utilisateur refuse
 * l'élévation, Windows proposera sa propre autorisation à la première écoute.
 */
async function ensureFirewallRule() {
  if (process.platform !== 'win32') return { ok: true, reason: 'hors Windows' };
  // Les tests chargent le vrai main.js : jamais de demande d’élévation au
  // milieu d’une suite, qui resterait bloquée sur la fenêtre de Windows.
  if (process.env.CASTUNN_SANS_PAREFEU === '1') return { ok: true, reason: 'neutralisée (CASTUNN_SANS_PAREFEU)' };

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

      // Serveur du réseau local : un relais TURN n'y servirait à rien, et des
      // variables TURN_* traînant dans l'environnement de la machine ne
      // doivent pas lui en faire annoncer un.
      // CASTUNN_VERSION : installé, server.js est copié hors de l'archive et
      // n'y trouverait pas package.json. Le serveur local a toujours la
      // version de l'application qui le lance.
      const env = {
        ...process.env, PORT: '8080', NODE_PATH: nodeModulesPath,
        CASTUNN_VERSION: require('./package.json').version
      };
      delete env.TURN_URLS;
      delete env.TURN_SECRET;
      delete env.TURN_TTL;

      serverProcess = fork(srvPath, [], { env, silent: true });

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

let ouverturePorts = null;

/**
 * Orchestrateur d’ouverture de ports, réglages rangés dans le profil de
 * l’instance. `CASTUNN_SANS_UPNP=1` le neutralise : les tests chargent le
 * vrai main.js et ne doivent toucher ni au routeur de la machine, ni aux
 * réglages de son profil — d’où un fichier de réglages jetable.
 */
function creerOuverturePorts() {
  const neutralise = process.env.CASTUNN_SANS_UPNP === '1';
  const dossier = neutralise
    ? path.join(os.tmpdir(), `castunn-test-${process.pid}`)
    : app.getPath('userData');
  return new OuverturePorts({
    plage: WEBRTC_UDP_PORTS,
    fichierReglages: path.join(dossier, 'castunn-settings.json'),
    trouverPasserelle: neutralise
      ? async () => { throw new Error('désactivé par CASTUNN_SANS_UPNP'); }
      : () => trouverPasserelle(),
    adresseLocaleVers,
    // Une seule instance par machine parle au routeur : celle du profil de base
    // (voir port-forwarding.js).
    delegue: !neutralise && !instancePrincipale
  });
}

/* ==========================================================================
 * Plage UDP de Chromium.
 *
 * Elle suit le début de la fenêtre de ports que la machine tient sur la box
 * (voir webrtc-ports.js et port-forwarding.js), et se change à chaud : les
 * connexions suivantes la prennent, les autres gardent leur port.
 * ========================================================================== */
let plageCourante = plageChromium();

function appliquerPlagePartout(plage) {
  if (plage.min === plageCourante.min && plage.max === plageCourante.max) return;
  plageCourante = plage;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) appliquerPlageWebRTC(w.webContents, plage);
  }
  console.log(`[webrtc] plage UDP ${plage.min}-${plage.max} appliquée.`);
}

/**
 * Instance secondaire : elle ne parle pas au routeur, mais ses connexions
 * passent par la même box. Elle prend donc la fenêtre de la première instance,
 * notée dans les réglages de celle-ci, et la suit si elle change.
 */
function suivrePlageDeLaPremiereInstance() {
  const fichier = path.join(profilDeBase, 'castunn-settings.json');
  const lire = () => {
    try {
      const d = JSON.parse(fs.readFileSync(fichier, 'utf8')).ouverturePorts?.debutPlage;
      return debutValide(d) ? d : WEBRTC_UDP_PORTS.min;
    } catch { return WEBRTC_UDP_PORTS.min; }
  };
  const suivre = () => appliquerPlagePartout(plageChromium(lire()));
  suivre();
  fs.watchFile(fichier, { interval: 2000, persistent: false }, suivre);
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

  // Plage UDP fixe : sans elle, Chromium pioche au hasard dans les ports
  // éphémères et aucune ouverture de routeur ne peut viser juste.
  if (appliquerPlageWebRTC(win.webContents, plageCourante)) {
    console.log(`[webrtc] plage UDP ${plageCourante.min}-${plageCourante.max} appliquée.`);
  }

  // Modes de test de la page (voir castunn.html) : on ne tape pas d'URL dans
  // une application, d'où ces variables d'environnement.
  const query = {};
  if (process.env.CASTUNN_FORCE_RELAY === '1') query.forceRelay = '1';
  if (process.env.CASTUNN_SANS_RTC === '1') query.rtc = 'off';
  if (process.env.CASTUNN_SANS_ESSAIM === '1') query.essaim = 'off';

  win.loadFile(path.join(__dirname, 'castunn.html'), { query });
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

  // Le lecteur vidéo lit un fichier encore en cours de réception.
  servirFlux({ protocol, ipcMain, webContents });

  // État de la plage UDP, pour que la console de l’app puisse le dire.
  ipcMain.handle('webrtc-ports', () => etatPortsWebRTC(plageCourante));

  // Ouverture automatique de la plage UDP sur le routeur (UPnP / NAT-PMP).
  ouverturePorts = creerOuverturePorts();
  ouverturePorts.on('plage', appliquerPlagePartout);
  if (!instancePrincipale && process.env.CASTUNN_SANS_UPNP !== '1') suivrePlageDeLaPremiereInstance();
  ouverturePorts.on('etat', (etat) => {
    console.log('[UPnP]', etat.message);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('port-forwarding-state', etat);
    }
  });
  ipcMain.handle('port-forwarding-status', () => ouverturePorts.etatPublic());
  ipcMain.handle('port-forwarding-set', (_evt, actif) => ouverturePorts.definirActif(actif));
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

  // Diagnostic différé : sonder soixante ports prend un instant, et rien
  // n’en dépend pour démarrer.
  etatPortsWebRTC(plageCourante).then((e) => {
    const ligne = `[webrtc] ports UDP ${e.min}-${e.max} : ${e.libres}/${e.total} inutilisés sur cette machine`;
    if (e.suffisant) console.log(ligne);
    else console.warn(`${ligne} — trop peu, d’autres programmes occupent la plage.`);
  }).catch((err) => console.warn('[webrtc] sondage des ports impossible :', err.message));

  // Jamais attendu : un routeur lent ou muet ne doit rien retarder.
  ouverturePorts.demarrer();

  // L'auto-update ne fonctionne (et n'a de sens) qu'une fois l'app installée/packagée.
  if (app.isPackaged) {
    setupAutoUpdater();
  }
});

// Tue le serveur enfant proprement à la fermeture
/* ==========================================================================
 * Fermeture : rendre les ports au routeur.
 *
 * Indispensable quand le routeur n’accepte que des baux permanents ; utile
 * sinon, pour ne pas laisser une heure de redirection sans propriétaire. On
 * suspend la fermeture le temps de le faire, trois secondes au plus : une
 * application qui ne quitte pas serait pire qu’un port qui expire seul.
 * ========================================================================== */
let portsRendus = false;

app.on('before-quit', (event) => {
  killServer();
  if (portsRendus || !ouverturePorts?.aDesRedirections()) return;
  event.preventDefault();
  portsRendus = true;
  ouverturePorts.arreter({ delaiMax: 3000 })
    .catch((e) => console.warn('[UPnP] ports non rendus :', e.message))
    .finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});