const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const https = require('https');
const { autoUpdater } = require('electron-updater');

let serverProcess = null;

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
  ipcMain.handle('server-start',  () => spawnServer());
  ipcMain.handle('server-stop',   () => killServer());
  ipcMain.handle('server-status', () => ({ running: !!serverProcess }));

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