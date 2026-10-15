// port-forwarding.js
// Ouverture automatique des ports UDP de WebRTC sur le routeur, par fenêtres.
//
// nat-mapper.js sait parler au routeur ; ce fichier décide quoi lui dire.
// Règle d'or : aucun port fantôme.
//  - Les ports sont toujours les mêmes (webrtc-ports.js) : un nouveau lancement
//    réécrit les mêmes redirections au lieu d'en créer d'autres.
//  - Bail d'une heure, renouvelé toutes les 30 min : si l'appli plante, les
//    redirections expirent seules.
//  - Routeur qui refuse les baux limités : repli sur un bail permanent, et le
//    nettoyage (démarrage et fermeture) devient la seule protection.
//  - Jamais un autre port externe que le port interne, jamais une redirection
//    d'un autre programme (description exactement « Castunn »).
//
// Fenêtres : la plage 26100-26159 se découpe en cinq fenêtres de 12 ports.
//  - Au démarrage, la machine prend la première fenêtre libre sur la box : une
//    autre machine Castunn du foyer, ou n'importe quel programme, peut tenir
//    les précédentes. Le port pris n'est pas contourné un par un : la fenêtre
//    entière passe à la suivante, car Chromium veut une plage d'un seul tenant.
//  - Toutes les 5 s, une sonde compte les ports que la machine occupe dans ses
//    fenêtres. Presque pleines : une fenêtre de plus, si la suivante est libre.
//    Celle du haut vide (Chromium reprend toujours le port libre le plus bas) :
//    rendue. Jamais les 60 ports d'un coup.
//  - Fenêtre suivante prise : rien d'autre n'est tenté. Les connexions en plus
//    débordent sur des ports non redirigés, qui passent par STUN ou TURN.
//
// Rien ici ne doit retarder le démarrage ni empêcher Castunn de fonctionner :
// toute erreur devient un état « indisponible », jamais une exception.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { UPNP } = require('./nat-mapper.js');
const {
  WEBRTC_UDP_PORTS, TAILLE_FENETRE, plageChromium, portsOccupes
} = require('./webrtc-ports.js');

const DESCRIPTION = 'Castunn';
const BAIL_SECONDES = 3600;
const RENOUVELLEMENT_MS = 30 * 60 * 1000;
const SONDE_MS = 5000;
// Une fenêtre de plus quand il ne reste que 2 ports libres : une connexion qui
// arrive et un redémarrage ICE tiennent encore pendant qu'on agrandit.
const AGRANDIR_SOUS = 2;
// Rendre la fenêtre du haut seulement s'il resterait 6 ports libres en
// dessous : l'écart avec le seuil d'agrandissement évite les allers-retours.
const REDUIRE_DES = 6;
// Aucun routeur n'a répondu : on réessaie, de plus en plus espacé. Une vraie
// box reste muette quelques instants juste après la suppression de
// redirections (constaté) : un relancement rapide de Castunn tombait dans ce
// trou et restait « indisponible » jusqu'au lancement suivant.
const REESSAIS_MS = [5000, 15000, 30000, 60000];
const REESSAI_LONG_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------------ */
/* Décisions pures (testées sans réseau)                                     */
/* ------------------------------------------------------------------------ */

/** La plage découpée en fenêtres. */
function decouper(plage, taille = TAILLE_FENETRE) {
  const fenetres = [];
  for (let min = plage.min; min + taille - 1 <= plage.max; min += taille) {
    fenetres.push({ min, max: min + taille - 1 });
  }
  return fenetres;
}

function portsDe({ min, max }) {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/** Une redirection Castunn que l'on considère comme nôtre (actuelle ou ancienne adresse). */
function estANous(e, { adresseLocale, ancienneAdresse, description = DESCRIPTION }) {
  return e.description === description
    && (e.client === adresseLocale || (!!ancienneAdresse && e.client === ancienneAdresse));
}

/**
 * Redirections Castunn à supprimer.
 *
 * Seulement celles décrites « Castunn », en UDP, et qui sont à nous :
 *  - pointant vers notre adresse actuelle, mais hors de `plage` (nos fenêtres
 *    ont changé depuis le dernier lancement) ;
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

/**
 * Une fenêtre est-elle prise sur la box ? Oui dès qu'un de ses ports UDP est
 * redirigé vers autre chose que nous : une autre machine Castunn, un décodeur,
 * une redirection posée à la main — même vers notre machine, car on ne
 * réécrit jamais la redirection d'un autre programme.
 */
function fenetrePrise(entrees, f, { adresseLocale, ancienneAdresse }) {
  return (entrees || []).some((e) => e.protocole === 'UDP'
    && e.port >= f.min && e.port <= f.max
    && !estANous(e, { adresseLocale, ancienneAdresse }));
}

/**
 * Que faire de nos fenêtres, d'après les ports occupés sur la machine ?
 * @param {number} libres  ports libres dans nos fenêtres
 * @param {number} occupesEnHaut  ports occupés dans la fenêtre du haut
 * @returns {'agrandir'|'reduire'|''}
 */
function decisionFenetres({ nb, nbMax, libres, occupesEnHaut, taille = TAILLE_FENETRE }) {
  if (libres <= AGRANDIR_SOUS) return nb < nbMax ? 'agrandir' : '';
  if (nb > 1 && occupesEnHaut === 0 && libres - taille >= REDUIRE_DES) return 'reduire';
  return '';
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
    case 'delegue':
      return 'UPnP : géré par la première instance de Castunn (même machine, mêmes ports redirigés)';
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
   * @param {{min:number,max:number}} o.plage        ports redirigeables (webrtc-ports.js)
   * @param {string} o.fichierReglages               JSON du profil
   * @param {Function} o.trouverPasserelle           () => passerelle | null
   * @param {Function} o.adresseLocaleVers           (hote) => adresse | null
   * @param {Function} [o.sonder]                    (adresse, ports) => ports occupés
   * @param {boolean} [o.delegue]                    instance secondaire : la première parle au routeur
   */
  constructor({
    plage = WEBRTC_UDP_PORTS, fichierReglages, trouverPasserelle, adresseLocaleVers,
    sonder = portsOccupes, taille = TAILLE_FENETRE, intervalleSonde = SONDE_MS,
    log = console, bail = BAIL_SECONDES, renouvellement = RENOUVELLEMENT_MS,
    delegue = false, reessais = REESSAIS_MS, reessaiLong = REESSAI_LONG_MS
  }) {
    super();
    // Deux instances sur la même machine ont la même adresse locale : la
    // seconde « réécrirait » les redirections de la première sans conflit, et
    // la première à quitter rendrait des ports dont l’autre se sert encore.
    // La seconde ne parle donc pas au routeur ; ses connexions passent par les
    // fenêtres de la première, dont la sonde compte aussi ses ports.
    this.delegue = delegue;
    this.reessais = reessais;
    this.reessaiLong = reessaiLong;
    this.essaisRates = 0;
    this.plage = plage;
    this.fenetres = decouper(plage, taille);
    this.taille = taille;
    this.fichier = fichierReglages;
    this.trouverPasserelle = trouverPasserelle;
    this.adresseLocaleVers = adresseLocaleVers;
    this.sonder = sonder;
    this.intervalleSonde = intervalleSonde;
    this.log = log;
    this.bail = bail;
    this.renouvellement = renouvellement;

    const r = lireReglages(this.fichier).ouverturePorts || {};
    this.reglages = { actif: r.actif !== false, derniereAdresse: r.derniereAdresse || '', debutPlage: r.debutPlage };

    this.passerelle = null;
    this.client = '';
    this.premiere = 0;          // indice de notre première fenêtre
    this.nb = 0;                // nombre de fenêtres tenues (0 : aucune)
    this.bloque = false;        // fenêtre suivante prise : on cesse d'agrandir
    this.accordes = [];
    this.permanent = false;
    this.generation = 0;        // change à chaque arrêt : une opération en vol se sait périmée
    this.cycleEnCours = null;
    this.minuteur = null;
    this.minuteurSonde = null;
    this.debut = plage.min;     // début de la plage donnée à Chromium
    this.etat = { statut: delegue ? 'delegue' : this.reglages.actif ? 'inactif' : 'desactive' };
  }

  get actif() { return this.reglages.actif; }

  /** Y a-t-il quelque chose à rendre au routeur avant de quitter ? */
  aDesRedirections() { return this.accordes.length > 0 || !!this.cycleEnCours; }

  /** Nos fenêtres, d'un seul tenant (la première seule tant qu'on n'en tient aucune). */
  plageTenue() {
    const n = Math.max(1, this.nb);
    return { min: this.fenetres[this.premiere].min, max: this.fenetres[this.premiere + n - 1].max };
  }

  /** Plage à donner à Chromium (voir webrtc-ports.js). */
  plageChromium() { return plageChromium(this.debut); }

  etatPublic() {
    const { min, max } = this.plageTenue();
    const e = {
      actif: this.reglages.actif,
      min,
      max,
      total: max - min + 1,
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

  /** Republie l'état courant, recalculé sur les fenêtres tenues. */
  _publierBilan(extra = {}) {
    const { statut, raison } = bilanOuverture({
      total: this.nb * this.taille, accordes: this.accordes, conflits: [], erreurs: extra.erreurs || []
    });
    this._publier({ ...this.etat, statut, raison: extra.raison ?? raison, accordes: this.accordes });
  }

  /** Chromium suit le début de nos fenêtres ; les instances secondaires le lisent dans les réglages. */
  _definirDebut(debut) {
    // Comparé au fichier, pas seulement à l'état courant : un lancement
    // précédent a pu y laisser une autre fenêtre, que les instances
    // secondaires suivraient à tort.
    if (this.reglages.debutPlage !== debut) {
      this.reglages.debutPlage = debut;
      this._sauverReglages();
    }
    if (debut === this.debut) return;
    this.debut = debut;
    this.emit('plage', this.plageChromium());
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
    if (this.delegue) {
      this._publier({ statut: 'delegue' });
      return Promise.resolve(this.etatPublic());
    }
    if (!this.reglages.actif) {
      this._publier({ statut: 'desactive' });
      return Promise.resolve(this.etatPublic());
    }
    return this._cycle({ silencieux: false });
  }

  /** Une seule conversation avec le routeur à la fois : ouverture, renouvellement, fenêtres. */
  _exclusif(fn) {
    if (this.cycleEnCours) return this.cycleEnCours;
    const generation = this.generation;
    this.cycleEnCours = (async () => {
      try {
        await fn(generation);
      } catch (e) {
        if (generation === this.generation) this._publier({ statut: 'indisponible', raison: e.message });
      } finally {
        this.cycleEnCours = null;
      }
      return this.etatPublic();
    })();
    return this.cycleEnCours;
  }

  _cycle({ silencieux }) {
    return this._exclusif((generation) => this._ouvrir(generation, { silencieux }));
  }

  /**
   * Redirige `ports` un par un : certaines box saturent sous les requêtes en
   * parallèle, et l'échec d'un port ne doit pas emporter les autres.
   * Renvoie null si l'opération est devenue périmée (tout ce qu'elle avait
   * pris est alors déjà rendu).
   */
  async _ajouter(passerelle, client, ports, perime) {
    const accordes = [];
    const conflits = [];
    const erreurs = [];
    // Désactivé ou fermeture pendant l'ouverture : on rend ce qu'on vient de
    // prendre, sinon ces ports resteraient ouverts sans propriétaire.
    const rendreSiPerime = async () => {
      if (!perime()) return false;
      await Promise.allSettled(accordes.map((p) => passerelle.supprimer({ port: p })));
      return true;
    };
    for (const port of ports) {
      if (await rendreSiPerime()) return null;
      try {
        await passerelle.ajouter({ port, client, description: DESCRIPTION, bail: this.permanent ? 0 : this.bail });
        accordes.push(port);
      } catch (e) {
        let err = e;
        if (e.code === UPNP.BAIL_PERMANENT_SEUL && !this.permanent) {
          this.permanent = true;
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
    if (await rendreSiPerime()) return null;
    return { accordes, conflits, erreurs };
  }

  async _supprimerListe(passerelle, entrees) {
    let n = 0;
    for (const e of entrees) {
      try { await passerelle.supprimer({ port: e.port }); n++; } catch { /* au mieux */ }
    }
    return n;
  }

  async _ouvrir(generation, { silencieux }) {
    const perime = () => generation !== this.generation;
    if (!silencieux) this._publier({ statut: 'en-cours' });

    const passerelle = await this.trouverPasserelle();
    if (perime()) return;
    if (!passerelle) {
      this._publier({ statut: 'indisponible', raison: 'aucun routeur UPnP ni NAT-PMP n’a répondu' });
      this._reessayer();
      return;
    }

    const client = await this.adresseLocaleVers(passerelle.hote);
    if (perime()) return;
    if (!client) {
      this._publier({ statut: 'indisponible', raison: 'adresse locale introuvable', methode: passerelle.methode });
      return;
    }
    const nous = { adresseLocale: client, ancienneAdresse: this.reglages.derniereAdresse };

    // Liste des redirections : UPnP seulement, NAT-PMP ne sait pas lister.
    let liste = null;
    try {
      liste = await passerelle.lister();
    } catch (e) {
      this.log.warn('[UPnP] liste des redirections illisible, nettoyage sauté :', e.message);
    }
    if (perime()) return;

    // Nettoyage, d'abord hors de toute fenêtre : ancienne adresse, ports
    // internes différents, ancienne plage. Avant de choisir une fenêtre : une
    // redirection vers notre ancienne adresse ferait conflit avec la nouvelle.
    let nettoyees = 0;
    if (liste) {
      const perimees = redirectionsPerimees(liste, { plage: this.plage, ...nous });
      nettoyees += await this._supprimerListe(passerelle, perimees);
      liste = liste.filter((e) => !perimees.includes(e));
    }

    let resultat;
    if (this.nb > 0) {
      // Renouvellement : les mêmes fenêtres.
      resultat = await this._ajouter(passerelle, client, portsDe(this.plageTenue()), perime);
      if (!resultat) return;
    } else {
      resultat = await this._reserver(passerelle, client, liste, nous, perime);
      if (!resultat) return;
    }

    // Puis nos redirections hors des fenêtres retenues (un lancement précédent
    // en tenait d'autres).
    if (liste && this.nb > 0) {
      nettoyees += await this._supprimerListe(passerelle,
        redirectionsPerimees(liste, { plage: this.plageTenue(), ...nous }));
    }
    if (nettoyees) this.log.log(`[UPnP] ${nettoyees} redirection(s) Castunn périmée(s) supprimée(s).`);
    if (perime()) {
      await Promise.allSettled(resultat.accordes.map((p) => passerelle.supprimer({ port: p })));
      return;
    }

    const { accordes } = resultat;
    this.passerelle = passerelle;
    this.client = client;
    this.accordes = accordes;
    this.bloque = false;
    if (accordes.length && this.reglages.derniereAdresse !== client) {
      this.reglages.derniereAdresse = client;
      this._sauverReglages();
    }
    if (this.nb > 0) this._definirDebut(this.fenetres[this.premiere].min);

    // Des ports ouverts sur une box sans adresse publique ne servent à rien :
    // mieux vaut le savoir que de croire le problème réglé.
    let nonRoutable = false;
    if (accordes.length) {
      try { nonRoutable = adresseRoutable(await passerelle.ipExterne()) === false; } catch { /* inconnu */ }
    }

    const total = Math.max(1, this.nb) * this.taille;
    const { statut, raison } = bilanOuverture({ total, ...resultat });
    this._publier({ statut, raison, methode: passerelle.methode, accordes, permanent: this.permanent, nonRoutable });

    if (accordes.length) {
      this.essaisRates = 0;
      // Un bail permanent ne se renouvelle pas ; un bail limité, si.
      if (!this.permanent) this._planifier();
      this._planifierSonde();
    }
  }

  /**
   * Première fenêtre libre. Avec la liste du routeur, les fenêtres prises
   * sont sautées sans rien demander ; sans elle (NAT-PMP), c'est le conflit
   * à l'ajout qui le révèle : la fenêtre est alors rendue entière, et l'on
   * passe à la suivante.
   */
  async _reserver(passerelle, client, liste, nous, perime) {
    const conflits = [];
    let dernier = null;
    for (let i = 0; i < this.fenetres.length; i++) {
      const f = this.fenetres[i];
      if (liste && fenetrePrise(liste, f, nous)) { conflits.push(...portsDe(f)); continue; }
      const r = await this._ajouter(passerelle, client, portsDe(f), perime);
      if (!r) return null;
      if (r.conflits.length) {
        await Promise.allSettled(r.accordes.map((p) => passerelle.supprimer({ port: p })));
        conflits.push(...portsDe(f));
        continue;
      }
      dernier = r;
      if (r.accordes.length) {
        this.premiere = i;
        this.nb = 1;
        return r;
      }
      break; // rien d'accordé sans conflit : le routeur refuse, inutile d'insister ailleurs
    }
    // Aucune fenêtre : toutes prises, ou le routeur refuse tout.
    this.premiere = 0;
    this.nb = 0;
    return dernier && !conflits.length
      ? dernier
      : { accordes: [], conflits: conflits.length ? portsDe(this.fenetres[0]) : [], erreurs: dernier ? dernier.erreurs : [] };
  }

  _planifier() {
    clearTimeout(this.minuteur);
    this.minuteur = setTimeout(() => { this._cycle({ silencieux: true }); }, this.renouvellement);
    this.minuteur.unref?.();
  }

  /** Nouvelle tentative silencieuse : l'état ne change qu'au succès. */
  _reessayer() {
    clearTimeout(this.minuteur);
    const delai = this.reessais[this.essaisRates] ?? this.reessaiLong;
    this.essaisRates++;
    this.minuteur = setTimeout(() => { this._cycle({ silencieux: true }); }, delai);
    this.minuteur.unref?.();
  }

  _planifierSonde() {
    clearTimeout(this.minuteurSonde);
    this.minuteurSonde = setTimeout(() => {
      this.ajusterFenetres().finally(() => { if (this.accordes.length) this._planifierSonde(); });
    }, this.intervalleSonde);
    this.minuteurSonde.unref?.();
  }

  /**
   * Compte les ports occupés sur la machine dans nos fenêtres, et en ajoute ou
   * en rend une si besoin. Publique pour les tests ; appelée par la sonde.
   */
  ajusterFenetres() {
    if (!this.accordes.length || !this.client || this.cycleEnCours) return Promise.resolve(this.etatPublic());
    return this._exclusif(async (generation) => {
      const perime = () => generation !== this.generation;
      const tenue = this.plageTenue();
      const occupes = await this.sonder(this.client, portsDe(tenue));
      if (perime()) return;
      const haut = this.fenetres[this.premiere + this.nb - 1];
      const decision = decisionFenetres({
        nb: this.nb,
        nbMax: this.bloque ? this.nb : this.fenetres.length - this.premiere,
        libres: (tenue.max - tenue.min + 1) - occupes.length,
        occupesEnHaut: occupes.filter((p) => p >= haut.min && p <= haut.max).length,
        taille: this.taille
      });
      if (decision === 'agrandir') await this._agrandir(perime, occupes.length);
      else if (decision === 'reduire') await this._reduire(perime, haut);
    });
  }

  async _agrandir(perime, occupes) {
    const { passerelle, client } = this;
    const f = this.fenetres[this.premiere + this.nb];
    const nous = { adresseLocale: client, ancienneAdresse: this.reglages.derniereAdresse };
    let liste = null;
    try { liste = await passerelle.lister(); } catch { /* NAT-PMP, ou liste refusée : l'ajout tranchera */ }
    if (perime()) return;
    const prise = () => {
      this.bloque = true;
      this.log.log(`[UPnP] ports ${f.min}-${f.max} déjà redirigés ailleurs : les connexions en plus`
        + ' passeront sans redirection (STUN ou relais).');
    };
    if (liste && fenetrePrise(liste, f, nous)) { prise(); return; }
    const r = await this._ajouter(passerelle, client, portsDe(f), perime);
    if (!r) return;
    if (r.conflits.length) {
      await Promise.allSettled(r.accordes.map((p) => passerelle.supprimer({ port: p })));
      prise();
      return;
    }
    if (!r.accordes.length) { this.bloque = true; return; } // le routeur n'en accorde plus
    this.nb++;
    this.accordes = [...this.accordes, ...r.accordes];
    this.log.log(`[UPnP] ${occupes} port(s) occupé(s) : fenêtre ${f.min}-${f.max} ajoutée.`);
    this._publierBilan({ erreurs: r.erreurs });
  }

  async _reduire(perime, haut) {
    const { passerelle } = this;
    const aRendre = this.accordes.filter((p) => p >= haut.min && p <= haut.max);
    // Retirée de nos comptes d'abord : si l'arrêt tombe pendant la suppression,
    // il ne la rend pas une seconde fois.
    this.nb--;
    this.accordes = this.accordes.filter((p) => !aRendre.includes(p));
    this.bloque = false;
    await Promise.allSettled(aRendre.map((port) => passerelle.supprimer({ port })));
    if (perime()) return;
    this.log.log(`[UPnP] fenêtre ${haut.min}-${haut.max} inutilisée : rendue.`);
    this._publierBilan();
  }

  /**
   * Rend tous les ports au routeur, en `delaiMax` ms au plus : à la fermeture,
   * mieux vaut un port qui expire seul qu'une application qui ne quitte pas.
   */
  async arreter({ delaiMax = 3000 } = {}) {
    this.generation++;
    clearTimeout(this.minuteur);
    clearTimeout(this.minuteurSonde);
    this.minuteur = null;
    this.minuteurSonde = null;
    const { passerelle, accordes } = this;
    this.accordes = [];
    this.nb = 0;
    this.premiere = 0;
    this.bloque = false;
    const rendre = passerelle && accordes.length
      ? Promise.allSettled(accordes.map((port) => passerelle.supprimer({ port }, { delai: delaiMax })))
      : null;
    // Une opération en vol voit la génération changer et rend elle-même ses ports.
    await borner(Promise.all([rendre, this.cycleEnCours]), delaiMax);
    return accordes.length;
  }

  /** Case à cocher des Paramètres. Désactiver rend les ports immédiatement. */
  async definirActif(actif) {
    actif = !!actif;
    if (this.delegue || actif === this.reglages.actif) return this.etatPublic();
    this.reglages.actif = actif;
    this._sauverReglages();
    if (!actif) {
      await this.arreter({ delaiMax: 5000 });
      this._definirDebut(this.plage.min);
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
  fenetrePrise,
  decisionFenetres,
  decouper,
  bilanOuverture,
  messageEtat,
  adresseRoutable
};
