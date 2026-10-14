// src/renderer/rtc-mesh.js
// Maillage WebRTC : une connexion par pair de la room.
//
// La page tenait UNE connexion (`pc`, `dc`, `peerId`). À trois, le troisième
// n'était jamais en P2P — et ne recevait d'ailleurs rien : tout partait sur le
// seul canal ouvert. Ici, chaque pair a son lien, avec sa propre négociation
// (« perfect negotiation »), sa file de candidats ICE et ses reprises après
// échec. Les règles sont celles, testées, de rtc-negotiation.js.
//
// Aucune dépendance au DOM : RTCPeerConnection et le reste sont injectés.

import { createIceQueue, describeIncoming, isPolitePeer } from './rtc-negotiation.js';

/**
 * @param {object} deps
 * @param {Function} deps.RTCPeerConnection  constructeur (celui du navigateur)
 * @param {() => string|null} deps.myId       notre identifiant de signalisation
 * @param {(id:string) => boolean} deps.disponible  RTC permis avec ce pair
 * @param {() => object} deps.config          configuration ICE (STUN, relais, politique)
 * @param {() => object} deps.configSecours   la même, sans relais, si la première est refusée
 * @param {() => Promise} deps.preparer       relais connu et identifiants valables
 * @param {(msg:object) => boolean} deps.signal  envoi de signalisation adressée
 */
export function createMesh(deps = {}) {
  const {
    RTCPeerConnection: RTC = globalThis.RTCPeerConnection,
    myId = () => null,
    disponible = () => true,
    config = () => ({}),
    configSecours = () => ({}),
    preparer = async () => {},
    signal = () => false,
    label = (id) => id,
    log = () => {},
    report = () => {},
    onChange = () => {},     // l'état d'un lien a changé : la pastille se recalcule
    onOpen = () => {},       // canal de données ouvert
    onConnected = () => {},  // ICE connecté : le chemin peut être journalisé
    onMessage = () => {},    // donnée reçue sur un canal
    onTrack = () => {},      // piste média reçue
    // Une offre arrive alors que le RTC est impossible ici : on prévient
    // l'autre, qui bascule aussitôt sur le WebSocket au lieu d'attendre.
    refuser = () => {},
    // Notre offre est restée sans réponse : le pair ne fait pas de P2P.
    sansReponse = () => {},
    delais = { recreation: 3000, canalFerme: 2000, reponse: 15000 }
  } = deps;

  const liens = new Map();      // peerId -> lien
  const orphelins = new Map();  // peerId -> candidats arrivés avant le lien

  const poli = (id) => isPolitePeer(myId(), id);
  const ouvert = (lien) => lien?.dc?.readyState === 'open';

  function fileDe(id) {
    let f = orphelins.get(id);
    if (!f) { f = createIceQueue(); orphelins.set(id, f); }
    return f;
  }

  function planifier(lien, ms, fn) {
    const t = setTimeout(() => {
      lien.minuteurs.delete(t);
      if (!lien.ferme) fn();
    }, ms);
    lien.minuteurs.add(t);
  }

  function creer(id) {
    let pc;
    try {
      pc = new RTC(config());
    } catch (e) {
      // Un relais mal configuré ne doit pas priver de la connexion directe.
      report('configuration du relais TURN (connexion sans relais)', e);
      pc = new RTC(configSecours());
    }
    const lien = {
      id,
      pc,
      dc: null,
      // Les candidats arrivés avant le lien deviennent les siens.
      iceQueue: fileDe(id),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      chemin: null,   // renseigné par la page une fois connecté
      collecte: [],   // candidats trouvés localement (le seul témoin fiable)
      minuteurs: new Set(),
      ferme: false
    };
    orphelins.delete(id);
    liens.set(id, lien);

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      lien.collecte.push({ type: e.candidate.type, address: e.candidate.address });
      signal({ type: 'ice', to: id, candidate: e.candidate });
    };

    // Toute modification du lien (canal créé, piste ajoutée ou retirée,
    // redémarrage ICE) passe par ici : une seule fabrique d'offres.
    pc.onnegotiationneeded = async () => {
      try {
        lien.makingOffer = true;
        await pc.setLocalDescription();
        signal({ type: 'offer', to: id, sdp: pc.localDescription.sdp });
      } catch (e) {
        report(`négociation RTC avec ${label(id)}`, e);
      } finally {
        lien.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      if (lien.ferme) return;
      const s = pc.connectionState;
      log(`[RTC] PeerConnection: ${s} (${label(id)})`);
      onChange(id);
      if (s === 'connected') onConnected(id, lien);
      else if (s === 'failed') echec(lien);
    };

    pc.ondatachannel = (ev) => {
      lien.dc = ev.channel;
      brancher(lien);
    };
    pc.ontrack = (ev) => { if (!lien.ferme) onTrack(id, ev); };

    onChange(id);
    return lien;
  }

  function brancher(lien) {
    const dc = lien.dc;
    try { dc.binaryType = 'arraybuffer'; } catch {}
    dc.bufferedAmountLowThreshold = 512 * 1024;
    dc.onopen = () => { onChange(lien.id); onOpen(lien.id); };
    dc.onclose = () => {
      if (lien.ferme) return;
      onChange(lien.id);
      // Une seule partie reconstruit : l'impolie. Sinon les deux repartent
      // ensemble et leurs offres se croisent.
      if (poli(lien.id)) return;
      planifier(lien, delais.canalFerme, () => {
        if (ouvert(liens.get(lien.id))) return;
        log(`[RTC] Canal fermé avec ${label(lien.id)}, reconnexion…`);
        relancer(lien.id);
      });
    };
    dc.onmessage = (ev) => onMessage(lien.id, ev.data);
  }

  function echec(lien) {
    if (poli(lien.id)) {
      log(`[RTC] Échec avec ${label(lien.id)} — on attend que le pair relance.`);
      return;
    }
    log(`[RTC] Échec avec ${label(lien.id)} — restartIce…`);
    // restartIce demande une renégociation, que onnegotiationneeded transforme
    // en nouvelle offre.
    try { lien.pc.restartIce(); } catch {}
    planifier(lien, delais.recreation, () => {
      if (ouvert(liens.get(lien.id))) return;
      log(`[RTC] Recréation complète du lien avec ${label(lien.id)}…`);
      relancer(lien.id);
    });
  }

  function relancer(id) {
    fermer(id, { silencieux: true });
    connecter(id);
  }

  /**
   * Ouvre un lien vers un pair (côté qui mène la négociation) : créer le
   * canal de données déclenche l'offre.
   */
  async function connecter(id) {
    if (!disponible(id)) return null;
    if (!liens.has(id)) await preparer();
    if (!disponible(id)) return null;
    const lien = liens.get(id) || creer(id);
    if (!lien.dc) {
      lien.dc = lien.pc.createDataChannel('file', { ordered: true });
      brancher(lien);
      // Filet : un pair qui ne répond jamais (sans WebRTC, ancienne version)
      // laissait le lien sur « connexion… » à vie, sans échec ni repli.
      planifier(lien, delais.reponse ?? 15000, () => {
        if (lien.pc.remoteDescription) return;
        log(`[RTC] ${label(id)} ne répond pas à notre offre : lien abandonné.`);
        fermer(id);
        sansReponse(id);
      });
    }
    return lien;
  }

  async function vider(lien) {
    const enAttente = lien.iceQueue.take();
    if (!enAttente.length) return;
    let refuses = 0;
    for (const c of enAttente) {
      try { await lien.pc.addIceCandidate(c); } catch { refuses++; }
    }
    log(`[RTC] ${enAttente.length - refuses}/${enAttente.length} candidat(s) ICE en attente appliqué(s) (${label(lien.id)}).`);
  }

  /** Offre ou réponse reçue d'un pair. */
  async function recevoirDescription(id, type, sdp) {
    if (!liens.has(id)) {
      // Réponse à un lien qu'on a fermé entre-temps : hors sujet.
      if (type === 'answer') return;
      if (!disponible(id)) { refuser(id); return; }
      await preparer();
      if (!disponible(id)) return;
    }
    const lien = liens.get(id) || creer(id);

    const decision = describeIncoming({
      type,
      polite: poli(id),
      makingOffer: lien.makingOffer,
      signalingState: lien.pc.signalingState,
      settingRemoteAnswer: lien.settingRemoteAnswer
    });
    lien.ignoreOffer = decision.ignore;
    if (decision.ignore) {
      log(`[RTC] Offre croisée de ${label(id)} ignorée : c’est nous qui menons.`);
      return;
    }
    if (decision.rollback) log(`[RTC] Offre croisée de ${label(id)} : on range la nôtre et on accepte.`);

    try {
      lien.settingRemoteAnswer = (type === 'answer');
      await lien.pc.setRemoteDescription({ type, sdp });
      lien.settingRemoteAnswer = false;
      await vider(lien);
      if (type === 'offer') {
        await lien.pc.setLocalDescription();
        signal({ type: 'answer', to: id, sdp: lien.pc.localDescription.sdp });
      }
    } catch (e) {
      lien.settingRemoteAnswer = false;
      report(`application d’une ${type === 'offer' ? 'offre' : 'réponse'} RTC (${label(id)})`, e);
    }
  }

  /** Candidat ICE reçu : appliqué si possible, rangé sinon — jamais jeté. */
  function recevoirCandidat(id, candidate) {
    const lien = liens.get(id);
    if (!lien || !lien.pc.remoteDescription) {
      const file = lien ? lien.iceQueue : fileDe(id);
      if (!file.push(candidate)) log(`[RTC] File de candidats pleine (${label(id)}) : candidat abandonné.`);
      return;
    }
    lien.pc.addIceCandidate(candidate).catch((e) => {
      // Après une offre refusée, ses candidats n'ont plus de sens : attendu.
      if (!lien.ignoreOffer) report(`ajout d’un candidat ICE (${label(id)})`, e);
    });
  }

  function fermer(id, { silencieux = false } = {}) {
    orphelins.delete(id);
    const lien = liens.get(id);
    if (!lien) return;
    lien.ferme = true;
    for (const t of lien.minuteurs) clearTimeout(t);
    lien.minuteurs.clear();
    try { lien.dc?.close(); } catch {}
    try { lien.pc.close(); } catch {}
    liens.delete(id);
    if (!silencieux) onChange(id);
  }

  function fermerTout() {
    for (const id of [...liens.keys()]) fermer(id);
    orphelins.clear();
  }

  return {
    connecter,
    recevoirDescription,
    recevoirCandidat,
    fermer,
    fermerTout,
    lien: (id) => liens.get(id) || null,
    liens: () => [...liens.values()],
    estOuvert: (id) => ouvert(liens.get(id)),
    /** Pairs dont le canal de données est ouvert. */
    ouverts: () => [...liens.values()].filter(ouvert).map((l) => l.id),

    /** Envoi sur le canal d'un pair. false si le canal n'est pas ouvert. */
    envoyer(id, donnees) {
      const lien = liens.get(id);
      if (!ouvert(lien)) return false;
      try {
        lien.dc.send(donnees);
        return true;
      } catch (e) {
        report(`envoi RTC à ${label(id)}`, e);
        return false;
      }
    },

    /** Ajoute les pistes d'un flux au lien d'un pair (la renégociation suit). */
    ajouterPistes(id, flux) {
      const lien = liens.get(id);
      if (!lien || !flux) return false;
      const deja = new Set(lien.pc.getSenders().map((s) => s.track).filter(Boolean));
      for (const piste of flux.getTracks()) {
        if (!deja.has(piste)) lien.pc.addTrack(piste, flux);
      }
      return true;
    },

    /** Retire les pistes audio et vidéo envoyées à un pair. */
    retirerPistes(id) {
      const lien = liens.get(id);
      if (!lien) return;
      for (const s of lien.pc.getSenders()) {
        if (s.track && (s.track.kind === 'audio' || s.track.kind === 'video')) {
          try { lien.pc.removeTrack(s); } catch {}
        }
      }
    }
  };
}
