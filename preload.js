const { contextBridge, ipcRenderer } = require('electron');

// Empêche le menu contextuel natif sur les médias
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
}, { capture: true });

// Expose le contrôle du serveur local au renderer
contextBridge.exposeInMainWorld('serverControl', {
  start:  () => ipcRenderer.invoke('server-start'),
  stop:   () => ipcRenderer.invoke('server-stop'),
  status: () => ipcRenderer.invoke('server-status'),
  // Cherche un serveur Castunn sur le réseau local -> ["192.168.1.42:8080", ...]
  discover: (opts) => ipcRenderer.invoke('server-discover', opts || {}),
});

// Lecture pendant le téléchargement (flux-protocole.js) : le lecteur vidéo
// interroge castunn-flux://, le processus principal relaie ses questions à la
// page, qui répond. `servir` renvoie l'identifiant à mettre dans les adresses.
contextBridge.exposeInMainWorld('castunnFlux', {
  servir: (repondre) => {
    ipcRenderer.on('flux-question', async (_e, q) => {
      let reponse = null;
      try { reponse = await repondre(q); } catch { reponse = null; }
      ipcRenderer.send('flux-reponse', { id: q.id, reponse });
    });
    return ipcRenderer.invoke('flux-inscription');
  }
});

// Plage de ports UDP réservée à WebRTC : l’interface la journalise au
// démarrage, pour qu’une plage saturée se voie au lieu de dégrader en silence.
contextBridge.exposeInMainWorld('rtcPorts', {
  status: () => ipcRenderer.invoke('webrtc-ports')
});

// Ouverture automatique de cette plage sur le routeur (UPnP / NAT-PMP).
// L’état évolue seul (découverte, renouvellement) : on s’y abonne.
contextBridge.exposeInMainWorld('portForwarding', {
  status: () => ipcRenderer.invoke('port-forwarding-status'),
  setEnabled: (actif) => ipcRenderer.invoke('port-forwarding-set', !!actif),
  onChange: (rappel) => {
    const h = (_e, etat) => rappel(etat);
    ipcRenderer.on('port-forwarding-state', h);
    return () => ipcRenderer.removeListener('port-forwarding-state', h);
  }
});