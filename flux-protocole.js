// flux-protocole.js
// Lecture pendant le téléchargement, dans l'application : un protocole maison,
// castunn-flux://p<id de la page>/<numéro de transfert>, que le lecteur vidéo
// de la page interroge comme un serveur HTTP (plages d'octets, navigation).
//
// Le processus principal ne sait rien du fichier : il pose deux questions à
// la page qui le reçoit (src/renderer/flux-lecture.js) — « ouvrir » (statut et
// en-têtes pour la plage demandée) puis « octets » au fil de la lecture — et
// relaie les réponses dans un flux. Mesuré : métadonnées en ~0,1 s, navigation
// loin devant en ~0,4 s, index MP4 en fin de fichier compris.
//
// Pourquoi pas un service worker comme dans le navigateur : il imposerait de
// quitter file:// (autre origine, réglages à migrer, harnais de test à revoir).
//
// À la racine (CommonJS) : chargé par main.js et par les harnais de test.

const SCHEMA = 'castunn-flux';

/**
 * À appeler AVANT app.whenReady() : un schéma privilégié se déclare tôt.
 * Trop tard (main.js chargé par un harnais déjà démarré, qui l'a déclaré
 * lui-même) : rien, plutôt qu'une exception qui empêcherait tout le reste.
 */
function declarerSchema(protocol, app = null) {
  if (app?.isReady()) return false;
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEMA,
    // stream : le lecteur vidéo peut lire au fil de l'eau et naviguer.
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
  }]);
  return true;
}

/**
 * Sert le schéma (après app.whenReady()). `webContents` donne la page par son
 * identifiant (webContents.fromId d'Electron).
 */
function servirFlux({ protocol, ipcMain, webContents }) {
  let compteur = 0;
  const enAttente = new Map(); // id -> { ok, ko, wc }

  ipcMain.on('flux-reponse', (_e, { id, reponse }) => {
    const a = enAttente.get(id);
    if (!a) return;
    enAttente.delete(id);
    a.ok(reponse);
  });
  // La page s'inscrit : elle apprend l'identifiant à mettre dans ses adresses.
  ipcMain.handle('flux-inscription', (e) => e.sender.id);

  // Une page fermée ne répondra plus : ses questions en attente échouent.
  // Un seul écouteur par page (un par question s'accumulerait : des milliers
  // pendant un film).
  const suivies = new WeakSet();
  function suivre(wc) {
    if (suivies.has(wc)) return;
    suivies.add(wc);
    wc.once('destroyed', () => {
      for (const [id, a] of enAttente) {
        if (a.wc === wc) { enAttente.delete(id); a.ko(new Error('page fermée')); }
      }
    });
  }

  function question(wc, q) {
    return new Promise((ok, ko) => {
      if (!wc || wc.isDestroyed()) { ko(new Error('page fermée')); return; }
      suivre(wc);
      const id = ++compteur;
      enAttente.set(id, { ok, ko, wc });
      wc.send('flux-question', { id, ...q });
    });
  }

  protocol.handle(SCHEMA, async (requete) => {
    const url = new URL(requete.url);
    const wc = webContents.fromId(Number(url.hostname.replace(/^p/, '')));
    const num = Number(url.pathname.replace(/^\//, ''));
    let tete;
    try {
      tete = await question(wc, { type: 'ouvrir', num, plage: requete.headers.get('range') });
    } catch {
      tete = null;
    }
    if (!tete) return new Response(null, { status: 404 });
    if (tete.status === 416) return new Response(null, tete);

    let pos = tete.debut;
    const corps = new ReadableStream({
      async pull(ctrl) {
        if (pos > tete.fin) { ctrl.close(); return; }
        let octets;
        try { octets = await question(wc, { type: 'octets', num, pos, fin: tete.fin }); } catch { octets = null; }
        if (!octets || !octets.byteLength) { ctrl.error(new Error('flux interrompu')); return; }
        pos += octets.byteLength;
        ctrl.enqueue(new Uint8Array(octets));
      }
    });
    return new Response(corps, { status: tete.status, headers: tete.headers });
  });
}

module.exports = { SCHEMA, declarerSchema, servirFlux };
