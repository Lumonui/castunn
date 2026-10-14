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