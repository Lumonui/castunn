// port-forwarding.js
// Ouverture automatique de la plage UDP de WebRTC sur le routeur.
//
// nat-mapper.js sait parler au routeur ; ce fichier décide quoi lui dire.
// Règle d'or : aucun port fantôme.
//  - Les ports sont toujours les mêmes (webrtc-ports.js) : un nouveau lancement
//    réécrit les mêmes redirections au lieu d'en créer d'autres.
//  - Bail d'une heure, renouvelé toutes les 30 min : si l'appli plante, les
//    redirections expirent seules.
//  - Routeur qui refuse les baux limités : repli sur un bail permanent, et le
//    nettoyage (démarrage et fermeture) devient la seule protection.
//  - Port déjà redirigé vers une autre machine : on ne cherche PAS d'autre
//    port. On le dit, et la connexion passera par STUN ou TURN.
//
// Rien ici ne doit retarder le démarrage ni empêcher Castunn de fonctionner :
// toute erreur devient un état « indisponible », jamais une exception.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { UPNP } = require('./nat-mapper.js');

const DESCRIPTION = 'Castunn';
const BAIL_SECONDES = 3600;
const RENOUVELLEMENT_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------------ */
/* Décisions pures (testées sans réseau)                                     */
/* ------------------------------------------------------------------------ */

/**
 * Redirections Castunn à supprimer au démarrage.
 *
 * Seulement celles décrites « Castunn », en UDP, et qui sont à nous :
 *  - pointant vers notre adresse actuelle, mais hors de la plage en vigueur
 *    (la plage a changé depuis le dernier lancement) ;
 *  - pointant vers notre ANCIENNE adresse, quand la box nous en a donné une
 *    autre entre-temps — d'où l'adresse mémorisée dans les réglages.
 * Une redirection Castunn vers une autre adresse inconnue appartient sans
 * doute à une autre machine du foyer : on n'y touche pas.
 */
function redirectionsPerimees(entrees, { plage, adresseLocale, ancienneAdresse, description = DESCRIPTION }) {
  return (entrees || []).filter((e) => {
    if (e.description !== description || e.protocole !== 'UDP') return false;
    if (e.client === adresseLocale) {
      return e.port < plage.min || e.port > plage.max || e.portInterne !== e.port;
    }
    return !!ancienneAdresse && ancienneAdresse !== adresseLocale && e.client === ancienneAdresse;
  });
}

/** Statut global à partir de ce que le routeur a accordé. */
function bilanOuverture({ total, accordes, conflits, erreurs }) {
  let raison = '';
  if (conflits.length) {
    raison = conflits.length === total
      ? 'ports déjà redirigés vers une autre machine'
      : `${conflits.length} port(s) déjà redirigé(s) vers une autre machine`;
  } else if (erreurs.length) {
    raison = erreurs[0];
  }
  const statut = accordes.length === total ? 'ouvert' : accordes.length ? 'partiel' : 'indisponible';
  return { statut, raison };
}

/**
 * L'adresse « externe » que donne le routeur est-elle joignable depuis
 * Internet ? Non si elle est privée (box derrière une autre box) ou dans la
 * plage partagée 100.64.0.0/10 (CGNAT de l'opérateur) : les redirections ne
 * concernent alors que ce premier routeur, pas Internet.
 */
function adresseRoutable(ip) {
  const o = String(ip || '').split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null; // inconnue
  const [a, b] = o;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  return true;
}

const SANS_EFFET = ' — mais la box n’a pas d’adresse publique (CGNAT ou double NAT) :'
  + ' sans effet depuis Internet';

/** Ligne affichée dans la console de l'application. */
function messageEtat(etat) {
  const methode = etat.methode || 'UPnP';
  const cascade = etat.nonRoutable ? SANS_EFFET : '';
  switch (etat.statut) {
    case 'ouvert':
      return `${methode} : ports ${etat.min}-${etat.max} ouverts`
        + (etat.permanent ? ' (bail permanent : le routeur refuse les baux limités)' : '') + cascade;
    case 'partiel':
      return `${methode} partiel (${etat.accordes.length}/${etat.total})`
        + (etat.raison ? ` — ${etat.raison}` : '') + cascade;
    case 'indisponible':
      return `UPnP indisponible (${etat.raison || 'raison inconnue'})`;
    case 'desactive':
      return 'UPnP désactivé : aucune redirection';
    case 'en-cours':
      return 'UPnP : ouverture des ports…';
    default:
      return 'UPnP : inactif';
  }
}

/* ------------------------------------------------------------------------ */
/* Réglages persistants (un fichier par profil, donc par instance)           */
/* ------------------------------------------------------------------------ */

function lireReglages(fichier) {
  try { return JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch { return {}; }
}

function ecrireReglages(fichier, reglages) {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, JSON.stringify(reglages, null, 2));
}

/** Attend `promesse`, mais jamais plus de `ms` : la fermeture ne doit pas bloquer. */
function borner(promesse, ms) {
  let minuteur;
  return Promise.race([
    Promise.resolve(promesse).catch(() => {}),
    new Promise((r) => { minuteur = setTimeout(r, ms); })
  ]).finally(() => clearTimeout(minuteur));
}

/* ------------------------------------------------------------------------ */
/* Orchestration                                                              */
/* ------------------------------------------------------------------------ */

class OuverturePorts extends EventEmitter {
  /**
   * @param {object} o
   * @param {{min:number,max:number}} o.plage        plage UDP (webrtc-ports.js)
   * @param {string} o.fichierReglages               JSON du profil
   * @param {Function} o.trouverPasserelle           () => passerelle | null
   * @param {Function} o.adresseLocaleVers           (hote) => adresse | null
   */
  constructor({
    plage, fichierReglages, trouverPasserelle, adresseLocaleVers,
    log = console, bail = BAIL_SECONDES, renouvellement = RENOUVELLEMENT_MS
  }) {
    super();
    this.plage = plage;
    this.total = plage.max - plage.min + 1;
    this.fichier = fichierReglages;
    this.trouverPasserelle = trouverPasserelle;
    this.adresseLocaleVers = adresseLocaleVers;
    this.log = log;
    this.bail = bail;
    this.renouvellement = renouvellement;

    const r = lireReglages(this.fichier).ouverturePorts || {};
    this.reglages = { actif: r.actif !== false, derniereAdresse: r.derniereAdresse || '' };

    this.passerelle = null;
    this.accordes = [];
    this.permanent = false;
    this.generation = 0;        // change à chaque arrêt : un cycle en vol se sait périmé
    this.cycleEnCours = null;
    this.minuteur = null;
    this.etat = { statut: this.reglages.actif ? 'inactif' : 'desactive' };
  }

  get actif() { return this.reglages.actif; }

  /** Y a-t-il quelque chose à rendre au routeur avant de quitter ? */
  aDesRedirections() { return this.accordes.length > 0 || !!this.cycleEnCours; }

  etatPublic() {
    const e = {
      actif: this.reglages.actif,
      min: this.plage.min,
      max: this.plage.max,
      total: this.total,
      accordes: [],
      permanent: false,
      methode: '',
      raison: '',
      ...this.etat
    };
    return { ...e, message: messageEtat(e) };
  }

  _publier(etat) {
    const avant = this.etatPublic().message;
    this.etat = etat;
    const apres = this.etatPublic();
    if (apres.message !== avant) this.emit('etat', apres);
  }

  _sauverReglages() {
    try {
      const tout = lireReglages(this.fichier);
      tout.ouverturePorts = { ...this.reglages };
      ecrireReglages(this.fichier, tout);
    } catch (e) {
      this.log.warn('[UPnP] réglages non enregistrés :', e.message);
    }
  }

  /** Lance l'ouverture si elle est activée. Ne lève jamais. */
  demarrer() {
    if (!this.reglages.actif) {
      this._publier({ statut: 'desactive' });
      return Promise.resolve(this.etatPublic());
    }
    return this._cycle({ silencieux: false });
  }

  _cycle({ silencieux }) {
    if (this.cycleEnCours) return this.cycleEnCours;
    const generation = this.generation;
    this.cycleEnCours = (async () => {
      try {
        await this._ouvrir(generation, { silencieux });
      } catch (e) {
        if (generation === this.generation) this._publier({ statut: 'indisponible', raison: e.message });
      } finally {
        this.cycleEnCours = null;
      }
      return this.etatPublic();
    })();
    return this.cycleEnCours;
  }

  async _ouvrir(generation, { silencieux }) {
    const perime = () => generation !== this.generation;
    if (!silencieux) this._publier({ statut: 'en-cours' });

    const passerelle = await this.trouverPasserelle();
    if (perime()) return;
    if (!passerelle) {
      this._publier({ statut: 'indisponible', raison: 'aucun routeur UPnP ni NAT-PMP n’a répondu' });
      return;
    }

    const client = await this.adresseLocaleVers(passerelle.hote);
    if (perime()) return;
    if (!client) {
      this._publier({ statut: 'indisponible', raison: 'adresse locale introuvable', methode: passerelle.methode });
      return;
    }

    // Nettoyage : UPnP seulement, NAT-PMP ne sait pas lister.
    let nettoyees = 0;
    try {
      const liste = await passerelle.lister();
      const aSupprimer = redirectionsPerimees(liste, {
        plage: this.plage,
        adresseLocale: client,
        ancienneAdresse: this.reglages.derniereAdresse
      });
      for (const e of aSupprimer) {
        try { await passerelle.supprimer({ port: e.port }); nettoyees++; } catch { /* au mieux */ }
      }
    } catch (e) {
      this.log.warn('[UPnP] liste des redirections illisible, nettoyage sauté :', e.message);
    }
    if (nettoyees) this.log.log(`[UPnP] ${nettoyees} redirection(s) Castunn périmée(s) supprimée(s).`);

    // Ouverture, port par port : certaines box saturent sous les requêtes en
    // parallèle, et l'échec d'un port ne doit pas emporter les autres.
    const accordes = [];
    const conflits = [];
    const erreurs = [];
    let permanent = this.permanent;
    // Désactivé ou fermeture pendant l'ouverture : on rend ce qu'on vient de
    // prendre, sinon ces ports resteraient ouverts sans propriétaire.
    const rendreSiPerime = async () => {
      if (!perime()) return false;
      await Promise.allSettled(accordes.map((p) => passerelle.supprimer({ port: p })));
      return true;
    };
    for (let port = this.plage.min; port <= this.plage.max; port++) {
      if (await rendreSiPerime()) return;
      try {
        await passerelle.ajouter({ port, client, description: DESCRIPTION, bail: permanent ? 0 : this.bail });
        accordes.push(port);
      } catch (e) {
        let err = e;
        if (e.code === UPNP.BAIL_PERMANENT_SEUL && !permanent) {
          permanent = true;
          this.log.warn('[UPnP] le routeur refuse les baux limités : repli sur des redirections permanentes.');
          try {
            await passerelle.ajouter({ port, client, description: DESCRIPTION, bail: 0 });
            accordes.push(port);
            continue;
          } catch (e2) { err = e2; }
        }
        if (err.code === UPNP.CONFLIT) conflits.push(port);
        else erreurs.push(err.message);
      }
    }
    // L'arrêt a pu tomber pendant le tout dernier ajout.
    if (await rendreSiPerime()) return;

    this.passerelle = passerelle;
    this.accordes = accordes;
    this.permanent = permanent;
    if (accordes.length && this.reglages.derniereAdresse !== client) {
      this.reglages.derniereAdresse = client;
      this._sauverReglages();
    }

    // Des ports ouverts sur une box sans adresse publique ne servent à rien :
    // mieux vaut le savoir que de croire le problème réglé.
    let nonRoutable = false;
    if (accordes.length) {
      try { nonRoutable = adresseRoutable(await passerelle.ipExterne()) === false; } catch { /* inconnu */ }
    }

    const { statut, raison } = bilanOuverture({ total: this.total, accordes, conflits, erreurs });
    this._publier({ statut, raison, methode: passerelle.methode, accordes, permanent, nonRoutable });

    // Un bail permanent ne se renouvelle pas ; un bail limité, si.
    if (accordes.length && !permanent) this._planifier();
  }

  _planifier() {
    clearTimeout(this.minuteur);
    this.minuteur = setTimeout(() => { this._cycle({ silencieux: true }); }, this.renouvellement);
    this.minuteur.unref?.();
  }

  /**
   * Rend tous les ports au routeur, en `delaiMax` ms au plus : à la fermeture,
   * mieux vaut un port qui expire seul qu'une application qui ne quitte pas.
   */
  async arreter({ delaiMax = 3000 } = {}) {
    this.generation++;
    clearTimeout(this.minuteur);
    this.minuteur = null;
    const { passerelle, accordes } = this;
    this.accordes = [];
    const rendre = passerelle && accordes.length
      ? Promise.allSettled(accordes.map((port) => passerelle.supprimer({ port }, { delai: delaiMax })))
      : null;
    // Un cycle en vol voit la génération changer et rend lui-même ses ports.
    await borner(Promise.all([rendre, this.cycleEnCours]), delaiMax);
    return accordes.length;
  }

  /** Case à cocher des Paramètres. Désactiver rend les ports immédiatement. */
  async definirActif(actif) {
    actif = !!actif;
    if (actif === this.reglages.actif) return this.etatPublic();
    this.reglages.actif = actif;
    this._sauverReglages();
    if (!actif) {
      await this.arreter({ delaiMax: 5000 });
      this._publier({ statut: 'desactive' });
      return this.etatPublic();
    }
    this._publier({ statut: 'inactif' });
    return this.demarrer();
  }
}

module.exports = {
  OuverturePorts,
  DESCRIPTION,
  BAIL_SECONDES,
  RENOUVELLEMENT_MS,
  // exposés pour les tests
  redirectionsPerimees,
  bilanOuverture,
  messageEtat,
  adresseRoutable
};
