// nat-mapper.js
// Dialogue avec le routeur pour ouvrir des ports : UPnP-IGD, puis NAT-PMP.
//
// Écrit sans bibliothèque, après examen des candidates : nat-api et nat-upnp
// reposent sur `request` (abandonné) et un xml2js de 2012 ; la plus récente
// (@achingbrain/nat-port-mapper) n'emploie que AddAnyPortMapping — absent des
// box IGD v1, et qui laisse le routeur choisir un AUTRE port externe en cas de
// conflit — et ne sait ni lister les redirections ni se replier sur un bail
// permanent. Or Castunn exige un port externe égal au port interne, un
// nettoyage fondé sur la liste des redirections, et ce repli.
//
// Ce fichier ne décide de rien : il parle au routeur. La politique (quels
// ports, quand renouveler, quoi nettoyer) vit dans port-forwarding.js.
//
// CommonJS et à la racine, comme main.js : src/ est en modules ES.

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { execFile } = require('child_process');

/* ------------------------------------------------------------------------ */
/* Outils XML : les descriptions IGD et les réponses SOAP sont assez simples */
/* et régulières pour se passer d'un analyseur complet.                       */
/* ------------------------------------------------------------------------ */

function decoderXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encoderXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ------------------------------------------------------------------------ */
/* SSDP : découverte des passerelles UPnP                                    */
/* ------------------------------------------------------------------------ */

const SSDP_ADRESSE = '239.255.255.250';
const SSDP_PORT = 1900;

// On interroge large : certaines box ne répondent qu'au type de service,
// d'autres qu'au type d'équipement, et pas toujours dans la même version.
const CIBLES_SSDP = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
];

/** En-têtes d'une réponse SSDP, ou null si ce n'en est pas une exploitable. */
function lireReponseSsdp(texte) {
  const lignes = String(texte || '').split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200/i.test(lignes[0] || '')) return null;
  const entetes = {};
  for (const ligne of lignes.slice(1)) {
    const i = ligne.indexOf(':');
    if (i > 0) entetes[ligne.slice(0, i).trim().toLowerCase()] = ligne.slice(i + 1).trim();
  }
  if (!entetes.location) return null;
  return { location: entetes.location, st: entetes.st || '', server: entetes.server || '' };
}

/** Diffuse les requêtes M-SEARCH et collecte les adresses de description. */
function chercherPasserellesUpnp({ delai = 3000 } = {}) {
  return new Promise((resolve) => {
    const trouvees = new Set();
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    let fini = false;
    const finir = () => {
      if (fini) return;
      fini = true;
      try { socket.close(); } catch {}
      resolve([...trouvees]);
    };

    socket.on('message', (msg) => {
      const r = lireReponseSsdp(msg.toString());
      if (r) trouvees.add(r.location);
    });
    socket.on('error', finir);
    const envoyer = () => {
      if (fini) return;
      for (const st of CIBLES_SSDP) {
        const requete = [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_ADRESSE}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 2',
          `ST: ${st}`,
          '', ''
        ].join('\r\n');
        socket.send(requete, SSDP_PORT, SSDP_ADRESSE, () => {});
      }
    };
    // Envoyée deux fois : c'est de l'UDP, et une vraie box reste muette
    // quelques instants juste après la suppression de redirections (constaté).
    socket.bind(0, () => {
      envoyer();
      setTimeout(envoyer, Math.min(1000, delai / 3));
    });
    setTimeout(finir, delai);
  });
}

/* ------------------------------------------------------------------------ */
/* Description de l'équipement et requêtes HTTP                              */
/* ------------------------------------------------------------------------ */

function requeteHttp(url, { methode = 'GET', entetes = {}, corps = null, delai = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { ...entetes };
    if (corps) headers['Content-Length'] = Buffer.byteLength(corps);
    // `agent: false` : une connexion neuve par requête. L'agent par défaut de
    // Node garde les sockets ouvertes, or les box ferment la leur après chaque
    // réponse : une requête sur deux partait sur une socket morte (constaté
    // sur une vraie box : « socket hang up » en alternance).
    const req = lib.request(u, { method: methode, headers, timeout: delai, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statut: res.statusCode, corps: data }));
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
    if (corps) req.write(corps);
    req.end();
  });
}

// Par ordre de préférence. AddPortMapping existe dans toutes ces versions :
// c'est la seule action d'ajout que l'on emploie.
const SERVICES_WAN = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
];

/**
 * Services de connexion WAN annoncés par une description d'équipement,
 * avec leur URL de contrôle absolue, triés par préférence.
 */
function lireDescriptionIgd(xml, location) {
  const base = (/<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(xml) || [])[1] || location;
  const services = [];
  const blocs = /<service\b[^>]*>([\s\S]*?)<\/service>/gi;
  let m;
  while ((m = blocs.exec(xml))) {
    const type = ((/<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(m[1]) || [])[1] || '').trim();
    const controle = ((/<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(m[1]) || [])[1] || '').trim();
    if (!controle || !SERVICES_WAN.includes(type)) continue;
    let url;
    try { url = new URL(decoderXml(controle), base).toString(); } catch { continue; }
    services.push({ type, controle: url });
  }
  services.sort((a, b) => SERVICES_WAN.indexOf(a.type) - SERVICES_WAN.indexOf(b.type));
  return services;
}

/* ------------------------------------------------------------------------ */
/* SOAP                                                                      */
/* ------------------------------------------------------------------------ */

function enveloppeSoap(service, action, args = []) {
  const corps = args.map(([k, v]) => `<${k}>${encoderXml(v)}</${k}>`).join('');
  return '<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
    + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${service}">${corps}</u:${action}></s:Body>`
    + '</s:Envelope>';
}

/** Valeurs `New…` d'une réponse SOAP, ou le code d'erreur UPnP qu'elle porte. */
function lireReponseSoap(xml) {
  const texte = String(xml || '');
  const code = /<(?:[\w-]+:)?errorCode>\s*(\d+)\s*</i.exec(texte);
  if (code) {
    const desc = /<(?:[\w-]+:)?errorDescription>([^<]*)</i.exec(texte);
    return { ok: false, code: Number(code[1]), description: decoderXml(desc ? desc[1] : '').trim() };
  }
  if (/<(?:[\w-]+:)?Fault\b/i.test(texte)) return { ok: false, code: 0, description: 'faute SOAP' };
  const valeurs = {};
  const re = /<(?:[\w-]+:)?(New\w+)\b[^>]*>([^<]*)<\/(?:[\w-]+:)?\1>/g;
  let m;
  while ((m = re.exec(texte))) valeurs[m[1]] = decoderXml(m[2]);
  return { ok: true, valeurs };
}

/** Erreur UPnP avec son code normalisé (718 conflit, 725 bail permanent seul…). */
class ErreurUpnp extends Error {
  constructor(code, description) {
    super(description ? `${description} (UPnP ${code})` : `erreur UPnP ${code}`);
    this.code = code;
  }
}

// Codes d'erreur UPnP-IGD dont dépend la politique.
const UPNP = {
  INDEX_INVALIDE: 713,         // fin de la liste des redirections
  ENTREE_INEXISTANTE: 714,
  CONFLIT: 718,                // port externe déjà redirigé vers une autre machine
  BAIL_PERMANENT_SEUL: 725,    // vieux routeurs : pas de bail limité
  PLUS_DE_PLACE: 728
};

class PasserelleUpnp {
  constructor({ location, type, controle }) {
    this.methode = 'UPnP';
    this.location = location;
    this.type = type;
    this.controle = controle;
    this.hote = new URL(controle).hostname;
  }

  async appeler(action, args = [], { delai = 4000 } = {}) {
    const { statut, corps } = await requeteHttp(this.controle, {
      methode: 'POST',
      delai,
      entetes: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${this.type}#${action}"`,
        Connection: 'close'
      },
      corps: enveloppeSoap(this.type, action, args)
    });
    const r = lireReponseSoap(corps);
    if (!r.ok) throw new ErreurUpnp(r.code, r.description);
    if (statut >= 400) throw new ErreurUpnp(0, `HTTP ${statut}`);
    return r.valeurs;
  }

  /** Redirige un port externe vers le MÊME port interne. Bail 0 = permanent. */
  ajouter({ port, client, description, bail, protocole = 'UDP' }) {
    return this.appeler('AddPortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', port],
      ['NewProtocol', protocole],
      ['NewInternalPort', port],
      ['NewInternalClient', client],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', description],
      ['NewLeaseDuration', bail]
    ]);
  }

  supprimer({ port, protocole = 'UDP' }, opts) {
    return this.appeler('DeletePortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', port],
      ['NewProtocol', protocole]
    ], opts);
  }

  /** Toutes les redirections du routeur, tous programmes confondus. */
  async lister({ maximum = 256 } = {}) {
    const entrees = [];
    for (let i = 0; i < maximum; i++) {
      let v;
      try {
        v = await this.appeler('GetGenericPortMappingEntry', [['NewPortMappingIndex', i]]);
      } catch (e) {
        // 713 marque la fin de liste ; certains routeurs répondent 714 ou 402.
        if (e.code === UPNP.INDEX_INVALIDE || e.code === UPNP.ENTREE_INEXISTANTE || e.code === 402) break;
        if (i === 0) throw e; // la liste elle-même est refusée
        break;
      }
      entrees.push({
        port: Number(v.NewExternalPort),
        portInterne: Number(v.NewInternalPort),
        protocole: String(v.NewProtocol || '').toUpperCase(),
        client: v.NewInternalClient || '',
        description: v.NewPortMappingDescription || '',
        bail: Number(v.NewLeaseDuration || 0)
      });
    }
    return entrees;
  }

  async ipExterne() {
    const v = await this.appeler('GetExternalIPAddress');
    return v.NewExternalIPAddress || '';
  }
}

/** Première passerelle UPnP qui expose un service de connexion WAN exploitable. */
async function trouverPasserelleUpnp({ delai = 3000, locations } = {}) {
  const adresses = locations || await chercherPasserellesUpnp({ delai });
  for (const location of adresses) {
    try {
      const { statut, corps } = await requeteHttp(location, { delai: 3000 });
      if (statut !== 200) continue;
      const services = lireDescriptionIgd(corps, location);
      if (services.length) return new PasserelleUpnp({ location, ...services[0] });
    } catch { /* équipement suivant */ }
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* NAT-PMP (RFC 6886) : repli des routeurs Apple et de nombreux autres       */
/* ------------------------------------------------------------------------ */

const PMP_PORT = 5351;

/** Requête d'ouverture : 12 octets. Opcode 1 = UDP. Durée 0 = suppression. */
function encoderDemandePmp({ portInterne, portExterne, duree }) {
  const b = Buffer.alloc(12);
  b.writeUInt8(0, 0);          // version
  b.writeUInt8(1, 1);          // opcode : UDP
  b.writeUInt16BE(0, 2);       // réservé
  b.writeUInt16BE(portInterne, 4);
  b.writeUInt16BE(portExterne, 6);
  b.writeUInt32BE(duree, 8);
  return b;
}

/** Réponse d'ouverture (16 octets) ou d'adresse externe (12 octets). */
function decoderReponsePmp(b) {
  if (!Buffer.isBuffer(b) || b.length < 8) return null;
  const opcode = b.readUInt8(1);
  const r = { version: b.readUInt8(0), opcode, resultat: b.readUInt16BE(2), epoque: b.readUInt32BE(4) };
  if (opcode === 128 && b.length >= 12) {
    r.ipExterne = [8, 9, 10, 11].map((i) => b.readUInt8(i)).join('.');
  } else if ((opcode === 129 || opcode === 130) && b.length >= 16) {
    r.portInterne = b.readUInt16BE(8);
    r.portExterne = b.readUInt16BE(10);
    r.duree = b.readUInt32BE(12);
  }
  return r;
}

const MESSAGES_PMP = {
  1: 'version non prise en charge',
  2: 'refusé par le routeur',
  3: 'routeur sans connexion',
  4: 'plus de ressources',
  5: 'opération non prise en charge'
};

class PasserellePmp {
  constructor({ hote, port = PMP_PORT }) {
    this.methode = 'NAT-PMP';
    this.hote = hote;
    this.port = port;
  }

  // RFC 6886 : 250 ms, puis délai doublé à chaque essai. Quatre essais
  // suffisent sur un réseau local et bornent l'attente à moins de 4 s.
  echanger(requete, { essais = 4 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      let essai = 0;
      let minuteur = null;
      let fini = false;
      const finir = (err, val) => {
        if (fini) return;
        fini = true;
        clearTimeout(minuteur);
        try { socket.close(); } catch {}
        if (err) reject(err); else resolve(val);
      };
      const envoyer = () => {
        if (essai >= essais) return finir(new Error('aucune réponse NAT-PMP'));
        socket.send(requete, this.port, this.hote, () => {});
        minuteur = setTimeout(envoyer, 250 * 2 ** essai++);
      };
      socket.on('message', (msg) => {
        const r = decoderReponsePmp(msg);
        if (r) finir(null, r);
      });
      socket.on('error', (e) => finir(e));
      socket.bind(0, envoyer);
    });
  }

  async ipExterne() {
    const r = await this.echanger(Buffer.from([0, 0]));
    if (r.resultat !== 0) throw new Error(MESSAGES_PMP[r.resultat] || `NAT-PMP ${r.resultat}`);
    return r.ipExterne || '';
  }

  /**
   * NAT-PMP n'a ni description ni liste : le routeur range les redirections
   * par machine. S'il accorde un autre port externe que celui demandé, on le
   * rend aussitôt — Castunn ne travaille qu'avec des ports identiques.
   */
  async ajouter({ port, bail }) {
    const r = await this.echanger(encoderDemandePmp({ portInterne: port, portExterne: port, duree: bail }));
    if (r.resultat !== 0) throw new Error(MESSAGES_PMP[r.resultat] || `NAT-PMP ${r.resultat}`);
    if (r.portExterne !== port) {
      await this.supprimer({ port }).catch(() => {});
      const e = new Error(`port externe ${r.portExterne} proposé au lieu de ${port}`);
      e.code = UPNP.CONFLIT; // même sens que le conflit UPnP : le port est pris
      throw e;
    }
    return { bail: r.duree };
  }

  async supprimer({ port }) {
    await this.echanger(encoderDemandePmp({ portInterne: port, portExterne: 0, duree: 0 }));
  }

  /** Sans liste côté routeur, rien à énumérer : les baux expirent seuls. */
  async lister() { return null; }
}

/* ------------------------------------------------------------------------ */
/* Passerelle par défaut et adresse locale                                    */
/* ------------------------------------------------------------------------ */

function executer(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** Lit la passerelle IPv4 par défaut dans la sortie de `route print` (Windows). */
function lirePasserelleWindows(sortie) {
  let meilleure = null;
  for (const ligne of String(sortie).split(/\r?\n/)) {
    const c = ligne.trim().split(/\s+/);
    if (c.length >= 5 && c[0] === '0.0.0.0' && c[1] === '0.0.0.0' && /^\d+\.\d+\.\d+\.\d+$/.test(c[2])) {
      const metrique = Number(c[c.length - 1]);
      if (!meilleure || metrique < meilleure.metrique) meilleure = { hote: c[2], metrique };
    }
  }
  return meilleure ? meilleure.hote : null;
}

/** Lit la passerelle par défaut dans /proc/net/route (Linux, octets inversés). */
function lirePasserelleLinux(contenu) {
  for (const ligne of String(contenu).split('\n').slice(1)) {
    const c = ligne.trim().split(/\s+/);
    if (c[1] === '00000000' && c[2] && c[2] !== '00000000') {
      const n = parseInt(c[2], 16);
      return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
    }
  }
  return null;
}

async function passerelleParDefaut() {
  try {
    if (process.platform === 'win32') {
      return lirePasserelleWindows(await executer('route', ['print', '-4', '0.0.0.0']));
    }
    if (process.platform === 'linux') {
      return lirePasserelleLinux(fs.readFileSync('/proc/net/route', 'utf8'));
    }
    if (process.platform === 'darwin') {
      const m = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(await executer('route', ['-n', 'get', 'default']));
      return m ? m[1] : null;
    }
  } catch { /* plateforme sans route lisible */ }
  return null;
}

/**
 * Adresse locale de l'interface qui mène à `hote`. « Connecter » une socket
 * UDP n'envoie rien : c'est le système qui choisit l'interface, comme il le
 * fera pour WebRTC — donc la bonne adresse à donner au routeur.
 */
function adresseLocaleVers(hote) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => { try { s.close(); } catch {} resolve(null); });
    s.connect(9, hote, () => {
      let adr = null;
      try { adr = s.address().address; } catch {}
      try { s.close(); } catch {}
      resolve(adr);
    });
  });
}

/**
 * Passerelle exploitable : UPnP d'abord (elle seule sait lister et décrire
 * les redirections), NAT-PMP ensuite. null si le routeur ne coopère pas.
 */
async function trouverPasserelle({ delai = 3000 } = {}) {
  const upnp = await trouverPasserelleUpnp({ delai });
  if (upnp) return upnp;
  const hote = await passerelleParDefaut();
  if (!hote) return null;
  const pmp = new PasserellePmp({ hote });
  try {
    await pmp.ipExterne(); // le routeur parle-t-il NAT-PMP ?
    return pmp;
  } catch {
    return null;
  }
}

module.exports = {
  UPNP,
  ErreurUpnp,
  PasserelleUpnp,
  PasserellePmp,
  trouverPasserelle,
  trouverPasserelleUpnp,
  chercherPasserellesUpnp,
  passerelleParDefaut,
  adresseLocaleVers,
  // exposés pour les tests
  lireReponseSsdp,
  lireDescriptionIgd,
  lireReponseSoap,
  enveloppeSoap,
  encoderDemandePmp,
  decoderReponsePmp,
  lirePasserelleWindows,
  lirePasserelleLinux
};
