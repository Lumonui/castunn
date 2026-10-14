// src/renderer/reception-tiles.js
// Vignettes de réception : une par émetteur.
//
// Le récepteur n'avait qu'un lecteur : deux émetteurs simultanés s'écrasaient
// l'un l'autre, et un « stop » de l'un coupait l'autre. Chaque émetteur a
// désormais sa vignette ; on n'arrête que la sienne.
//
// Le document est injecté : la fabrique ne suppose rien de la page.

/**
 * @param {object} o
 * @param {HTMLElement} o.conteneur          où ranger les vignettes
 * @param {HTMLElement} [o.vide]             message affiché quand il n'y en a aucune
 * @param {(de:string) => string} o.label    nom affiché d'un émetteur
 * @param {() => boolean} o.actif            le récepteur est-il activé (lecture auto) ?
 */
export function createReceptionTiles({
  conteneur,
  vide = null,
  doc = document,
  label = (de) => de,
  actif = () => false,
  peutLireVideo = () => true,
  estElectron = false,
  telecharger = () => {},
  log = () => {},
  erreur = () => {}
} = {}) {
  const tuiles = new Map(); // émetteur -> { fig, titre, audio, video, image }

  function majConteneur() {
    if (vide) vide.hidden = tuiles.size > 0;
    conteneur.classList.toggle('plusieurs', tuiles.size > 1);
  }

  function lecteurMedia(tag, classe) {
    const el = doc.createElement(tag);
    el.controls = true;
    el.preload = 'metadata';
    el.className = `${classe} hidden`;
    el.setAttribute('controlsList', 'nodownload noplaybackrate noremoteplayback');
    return el;
  }

  function creer(de) {
    const fig = doc.createElement('figure');
    fig.className = 'tuile';
    fig.dataset.de = de;
    const titre = doc.createElement('figcaption');
    titre.textContent = label(de);
    const audio = lecteurMedia('audio', 'tuile-audio');
    const video = lecteurMedia('video', 'tuile-video');
    try { video.disablePictureInPicture = true; } catch {}
    const image = doc.createElement('img');
    image.className = 'tuile-image';
    image.alt = 'Image reçue';
    image.hidden = true;
    fig.append(titre, audio, video, image);
    conteneur.append(fig);
    const t = { de, fig, titre, audio, video, image };
    tuiles.set(de, t);
    majConteneur();
    return t;
  }

  const tuile = (de) => tuiles.get(de) || creer(de);

  /** Coupe la lecture et détache les sources, sans retirer la vignette. */
  function vider(t) {
    for (const el of [t.audio, t.video]) {
      try { el.pause(); } catch {}
      el.removeAttribute('src');
      try { el.srcObject = null; } catch {}
      try { el.load(); } catch {}
      el.classList.add('hidden');
    }
    t.video.onerror = null;
    t.image.removeAttribute('src');
    t.image.hidden = true;
  }

  function lire(el) {
    if (!actif()) return;
    el.play().catch((e) => { if (e.name !== 'AbortError') erreur(e.message); });
  }

  function arreter(de) {
    const t = tuiles.get(de);
    if (!t) return false;
    vider(t);
    t.fig.remove();
    tuiles.delete(de);
    majConteneur();
    return true;
  }

  return {
    afficherAudio(de, url) {
      const t = tuile(de);
      vider(t);
      t.audio.src = url;
      t.audio.classList.remove('hidden');
      lire(t.audio);
    },

    afficherVideo(de, url, { mime = '', nom = 'video.mp4' } = {}) {
      // Hors Electron, un format que le lecteur déclare inconnu part en
      // téléchargement plutôt que d'afficher un lecteur vide.
      if (mime && !estElectron && !peutLireVideo(mime)) {
        log(`Vidéo non supportée (${mime}), téléchargement.`);
        telecharger(url, nom);
        return;
      }
      const t = tuile(de);
      vider(t);
      t.video.src = url;
      t.video.classList.remove('hidden');
      t.video.onerror = () => {
        log(`Lecture impossible (${mime || 'inconnu'}), téléchargement.`);
        telecharger(url, nom);
        t.video.onerror = null;
      };
      if (actif()) {
        t.video.play().catch((e) => {
          erreur(e.message);
          telecharger(url, nom);
        });
      }
    },

    afficherImage(de, url) {
      const t = tuile(de);
      vider(t);
      t.image.src = url;
      t.image.hidden = false;
    },

    /** Flux en direct (partage d'écran). false s'il était déjà affiché. */
    afficherFlux(de, flux) {
      const t = tuile(de);
      if (t.video.srcObject === flux) return false;
      vider(t);
      t.video.srcObject = flux;
      t.video.classList.remove('hidden');
      lire(t.video);
      return true;
    },

    /** Lecteur en cours d'un émetteur, pour appliquer sa synchronisation. */
    lecteur(de) {
      const t = tuiles.get(de);
      if (!t) return null;
      if (!t.video.classList.contains('hidden')) return t.video;
      if (!t.audio.classList.contains('hidden')) return t.audio;
      return null;
    },

    arreter,

    arreterTout() {
      for (const de of [...tuiles.keys()]) arreter(de);
    },

    /** Une identité est arrivée : les titres des vignettes se mettent à jour. */
    majLabels() {
      for (const t of tuiles.values()) t.titre.textContent = label(t.de);
    },

    emetteurs: () => [...tuiles.keys()],
    existe: (de) => tuiles.has(de)
  };
}
