// src/renderer/youtube.js
// Liens YouTube : lus par le lecteur intégré de YouTube chez chacun, rien
// n'est téléchargé ni relayé. Seul l'identifiant de la vidéo circule.
//
// Le lecteur est enveloppé pour ressembler à un <video> (play, pause,
// currentTime, readyState, loadedmetadata) : la synchronisation existante
// s'y applique telle quelle.
//
// Dans l'application (page file://), YouTube refuse son lecteur sans en-tête
// Referer (erreur 153, mesuré) : main.js en pose un qui nomme l'application.
// Ne pas passer `origin` au lecteur : « file:// » le bloque (mesuré).

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOTES = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be']);

/** « 90 », « 1m30s », « 1h2m3s » → secondes (0 si illisible). */
function lireDebut(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || !m[0]) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/**
 * Vidéo YouTube désignée par une URL : { id, debut } (debut en secondes),
 * ou null si ce n'en est pas une.
 */
export function videoYoutube(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !HOTES.has(u.hostname.toLowerCase())) return null;
  let id = null;
  if (u.hostname.toLowerCase() === 'youtu.be') {
    id = u.pathname.split('/')[1];
  } else if (u.pathname === '/watch') {
    id = u.searchParams.get('v');
  } else {
    const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
    if (m) id = m[1];
  }
  if (!id || !ID.test(id)) return null;
  return { id, debut: lireDebut(u.searchParams.get('t') || u.searchParams.get('start')) };
}

let api = null;
/** Charge l'API du lecteur YouTube, une seule fois par page. */
export function chargerApiYoutube(win = window) {
  if (api) return api;
  api = new Promise((resolve, reject) => {
    if (win.YT?.Player) { resolve(win.YT); return; }
    const precedent = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => { try { precedent?.(); } catch {} resolve(win.YT); };
    const s = win.document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { api = null; reject(new Error('lecteur YouTube injoignable (pas d’accès Internet ?)')); };
    win.document.head.append(s);
  });
  return api;
}

/**
 * Lecteur YouTube dans `conteneur`, présenté comme un élément média.
 * @param {object} o
 * @param {string} o.id
 * @param {number} [o.debut]
 * @param {boolean} [o.auto]          lancer la lecture dès que possible
 * @param {(action:'play'|'pause'|'seek', temps:number) => void} [o.surAction]
 *        ce que l'utilisateur fait du lecteur (pour l'émetteur : la synchronisation)
 * @param {(message:string) => void} [o.surErreur]
 */
export function creerLecteurYoutube(conteneur, { id, debut = 0, auto = true, surAction = () => {}, surErreur = () => {} } = {}) {
  const doc = conteneur.ownerDocument;
  const cible = doc.createElement('div');
  conteneur.replaceChildren(cible);

  let lecteur = null;
  let pret = false;
  let detruit = false;
  let lectureVoulue = auto;
  let tempsVoulu = null;
  const auPret = [];
  // Ce que la page vient de demander (synchronisation reçue) ne doit pas
  // repartir comme une action de l'utilisateur.
  let silenceJusqua = 0;
  const silence = () => { silenceJusqua = Date.now() + 1200; };
  let dernierEtat = -1;
  let dernierTemps = 0;

  const erreurs = {
    2: 'identifiant de vidéo invalide',
    5: 'vidéo illisible dans ce lecteur',
    100: 'vidéo introuvable ou privée',
    101: 'le propriétaire interdit la lecture intégrée',
    150: 'le propriétaire interdit la lecture intégrée',
    153: 'lecteur refusé par YouTube (en-tête Referer manquant)'
  };

  chargerApiYoutube(doc.defaultView).then((YT) => {
    if (detruit) return;
    lecteur = new YT.Player(cible, {
      width: '100%',
      videoId: id,
      playerVars: { playsinline: 1, rel: 0, start: Math.floor(debut) || undefined },
      events: {
        onReady: () => {
          if (detruit) return;
          pret = true;
          if (tempsVoulu !== null) lecteur.seekTo(tempsVoulu, true);
          if (lectureVoulue) lecteur.playVideo();
          for (const f of auPret.splice(0)) { try { f(); } catch {} }
        },
        onStateChange: (e) => {
          const temps = lecteur.getCurrentTime?.() || 0;
          const precedent = dernierEtat;
          dernierEtat = e.data;
          if (Date.now() < silenceJusqua) { dernierTemps = temps; return; }
          // 1 lecture, 2 pause, 3 chargement (après un déplacement).
          if (e.data === 1) {
            if (precedent === 3 || Math.abs(temps - dernierTemps) > 2) surAction('seek', temps);
            surAction('play', temps);
          } else if (e.data === 2) {
            surAction('pause', temps);
          }
          dernierTemps = temps;
        },
        onError: (e) => surErreur(`YouTube : ${erreurs[e.data] || `erreur ${e.data}`}.`)
      }
    });
  }, (e) => surErreur(e.message));

  return {
    estYoutube: true,
    id,
    /** Le lecteur de YouTube lui-même (tests : agir comme l'utilisateur). */
    get brut() { return pret ? lecteur : null; },
    get readyState() { return pret ? 1 : 0; },
    get paused() { return !pret || lecteur.getPlayerState?.() !== 1; },
    get currentTime() { return pret ? (lecteur.getCurrentTime?.() || 0) : (tempsVoulu ?? debut); },
    set currentTime(t) {
      silence();
      if (pret) lecteur.seekTo(Number(t) || 0, true); else tempsVoulu = Number(t) || 0;
    },
    play() {
      silence();
      lectureVoulue = true;
      if (pret) lecteur.playVideo();
      return Promise.resolve();
    },
    pause() {
      silence();
      lectureVoulue = false;
      if (pret) lecteur.pauseVideo();
    },
    addEventListener(type, f) {
      if (type !== 'loadedmetadata') return;
      if (pret) f(); else auPret.push(f);
    },
    detruire() {
      detruit = true;
      try { lecteur?.destroy(); } catch {}
      conteneur.replaceChildren();
    }
  };
}
