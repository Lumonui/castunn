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