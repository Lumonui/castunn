// test/nat.test.js
// Ouverture automatique des ports : protocole (nat-mapper.js) et politique
// (port-forwarding.js), contre de FAUX routeurs — un serveur HTTP qui parle
// UPnP-IGD en SOAP, et un serveur UDP qui parle NAT-PMP.
//
//   npm run test:nat
//
// Aucun paquet n'est envoyé au vrai routeur. Le faux routeur UPnP reprend la
// description d'une vraie box (IGD v1 seulement, chemins identiques) et ses
// redirections préexistantes — celles d'un décodeur TV, que Castunn ne doit
// jamais toucher.

const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nat = require('../nat-mapper.js');
const {
  OuverturePorts, redirectionsPerimees, bilanOuverture, messageEtat, adresseRoutable,
  fenetrePrise, decisionFenetres, decouper
} = require('../port-forwarding.js');
const {
  WEBRTC_UDP_PORTS, plageChromium, debutValide, portsOccupes, udpPortLibre
} = require('../webrtc-ports.js');

const results = [];
async function test(nom, fn) {
  try { await fn(); results.push(true); console.log(`  ok   ${nom}`); }
  catch (e) { results.push(false); console.log(`  FAIL ${nom}\n       ${e.message}`); }
}
function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || ''} — attendu ${y}, reçu ${x}`);
}
function ok(c, msg) { if (!c) throw new Error(msg || 'assertion échouée'); }
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const MOI = '192.168.1.16';
const PLAGE = WEBRTC_UDP_PORTS;
const TOTAL = PLAGE.max - PLAGE.min + 1;   // 60 : toutes les fenêtres
const F = 12;                              // une fenêtre
const ports = (min, n) => Array.from({ length: n }, (_, i) => min + i);

// Redirections relevées sur une vraie box : celles de son décodeur TV.
const DECODEUR = [
  { port: 49409, portInterne: 8443, protocole: 'TCP', client: '192.168.1.10', description: 'STB Remote PVR rule', bail: 2053 },
  { port: 51005, portInterne: 51005, protocole: 'TCP', client: '192.168.1.10', description: 'STB TR069', bail: 2053 },
  { port: 21928, portInterne: 8444, protocole: 'TCP', client: '192.168.1.10', description: 'VHD Notification', bail: 2064 }
];

/* ------------------------------------------------------------------------ */
/* Faux routeur UPnP-IGD                                                      */
/* ------------------------------------------------------------------------ */

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';

// Forme d'une vraie description (box IGD v1) : équipements imbriqués, un
// service sans intérêt avant le bon, controlURL relative, pas d'URLBase.
const DESCRIPTION_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<device>
 <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
 <deviceList><device>
  <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
  <serviceList><service>
   <serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType>
   <controlURL>/fa1a0a5d/upnp/control/WANCommonIFC1</controlURL>
  </service></serviceList>
  <deviceList><device>
   <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
   <serviceList><service>
    <serviceType>${SERVICE}</serviceType>
    <serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId>
    <controlURL>/fa1a0a5d/upnp/control/WANIPConn1</controlURL>
   </service></serviceList>
  </device></deviceList>
 </device></deviceList>
</device>
</root>`;

function routeurUpnp({
  existantes = DECODEUR, permanentSeul = false, limite = Infinity, latence = 0, ipExterne = '83.194.1.2'
} = {}) {
  const table = existantes.map((e) => ({ ...e }));
  const journal = [];

  const enveloppe = (inner) => '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
    + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' + inner + '</s:Body></s:Envelope>';
  const reponse = (action, inner = '') => [200,
    enveloppe(`<u:${action}Response xmlns:u="${SERVICE}">${inner}</u:${action}Response>`)];
  const faute = (code, desc) => [500, enveloppe('<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>'
    + `<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode>`
    + `<errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault>`)];

  function traiter(action, corps) {
    const v = (nom) => (new RegExp('<' + nom + '>([^<]*)</' + nom + '>').exec(corps) || [])[1] ?? '';
    journal.push({ action, port: Number(v('NewExternalPort')) || undefined, bail: v('NewLeaseDuration') });
    switch (action) {
      case 'GetExternalIPAddress':
        return reponse(action, `<NewExternalIPAddress>${ipExterne}</NewExternalIPAddress>`);
      case 'GetGenericPortMappingEntry': {
        const e = table[Number(v('NewPortMappingIndex'))];
        if (!e) return faute(713, 'SpecifiedArrayIndexInvalid');
        return reponse(action, `<NewRemoteHost></NewRemoteHost><NewExternalPort>${e.port}</NewExternalPort>`
          + `<NewProtocol>${e.protocole}</NewProtocol><NewInternalPort>${e.portInterne}</NewInternalPort>`
          + `<NewInternalClient>${e.client}</NewInternalClient><NewEnabled>1</NewEnabled>`
          + `<NewPortMappingDescription>${e.description}</NewPortMappingDescription>`
          + `<NewLeaseDuration>${e.bail}</NewLeaseDuration>`);
      }
      case 'AddPortMapping': {
        const port = Number(v('NewExternalPort'));
        const protocole = v('NewProtocol');
        const bail = Number(v('NewLeaseDuration'));
        const client = v('NewInternalClient');
        if (Number(v('NewInternalPort')) !== port) return faute(724, 'SamePortValuesRequired');
        if (permanentSeul && bail !== 0) return faute(725, 'OnlyPermanentLeasesSupported');
        const i = table.findIndex((e) => e.port === port && e.protocole === protocole);
        if (i >= 0 && table[i].client !== client) return faute(718, 'ConflictInMappingEntry');
        const entree = { port, portInterne: port, protocole, client, description: v('NewPortMappingDescription'), bail };
        if (i >= 0) { table[i] = entree; return reponse(action); } // réécriture : pas de doublon
        const castunn = table.filter((e) => e.description === 'Castunn').length;
        if (castunn >= limite) return faute(728, 'NoPortMapsAvailable');
        table.push(entree);
        return reponse(action);
      }
      case 'DeletePortMapping': {
        const port = Number(v('NewExternalPort'));
        const i = table.findIndex((e) => e.port === port && e.protocole === v('NewProtocol'));
        if (i < 0) return faute(714, 'NoSuchEntryInArray');
        table.splice(i, 1);
        return reponse(action);
      }
      default:
        return faute(401, 'Invalid Action');
    }
  }

  const serveur = http.createServer((req, res) => {
    let corps = '';
    req.on('data', (c) => { corps += c; });
    req.on('end', async () => {
      if (latence) await pause(latence);
      let statut = 200;
      let xml = DESCRIPTION_XML;
      if (req.method === 'POST') {
        const action = (/#(\w+)"?\s*$/.exec(req.headers.soapaction || '') || [])[1];
        [statut, xml] = traiter(action, corps);
      }
      // Comme la vraie box : connexion fermée après chaque réponse.
      res.writeHead(statut, { 'Content-Type': 'text/xml', Connection: 'close' });
      res.end(xml);
    });
  });

  return new Promise((resolve) => {
    serveur.listen(0, '127.0.0.1', () => {
      const { port } = serveur.address();
      resolve({
        table,
        journal,
        location: `http://127.0.0.1:${port}/fa1a0a5d/gatedesc.xml`,
        castunn: () => table.filter((e) => e.description === 'Castunn'),
        fermer: () => new Promise((r) => serveur.close(r))
      });
    });
  });
}

/* ------------------------------------------------------------------------ */
/* Faux routeur NAT-PMP                                                       */
/* ------------------------------------------------------------------------ */

function routeurPmp({ decaler = [] } = {}) {
  const socket = dgram.createSocket('udp4');
  const recues = [];
  socket.on('message', (msg, rinfo) => {
    const op = msg.readUInt8(1);
    if (op === 0) {
      const r = Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 83, 194, 1, 2]);
      socket.send(r, rinfo.port, rinfo.address);
      return;
    }
    const interne = msg.readUInt16BE(4);
    const externe = msg.readUInt16BE(6);
    const duree = msg.readUInt32BE(8);
    recues.push({ interne, externe, duree });
    const r = Buffer.alloc(16);
    r.writeUInt8(0, 0); r.writeUInt8(128 + op, 1); r.writeUInt16BE(0, 2); r.writeUInt32BE(1, 4);
    r.writeUInt16BE(interne, 8);
    r.writeUInt16BE(decaler.includes(interne) && duree ? externe + 1000 : externe, 10);
    r.writeUInt32BE(duree, 12);
    socket.send(r, rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () => resolve({
      port: socket.address().port,
      recues,
      fermer: () => new Promise((r) => socket.close(r))
    }));
  });
}

/* ------------------------------------------------------------------------ */
/* Fabrique d'orchestrateur branché sur un faux routeur                       */
/* ------------------------------------------------------------------------ */

let compteurDossiers = 0;
const dossiersCrees = [];
function dossierReglages() {
  const d = path.join(os.tmpdir(), `castunn-nat-test-${process.pid}-${compteurDossiers++}`);
  dossiersCrees.push(d);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, 'castunn-settings.json');
}

const silencieux = { log() {}, warn() {} };

// Les ports « occupés sur la machine » sont simulés : `machine.occupes` tient
// lieu des connexions WebRTC. La sonde automatique est repoussée très loin ;
// les tests appellent ajusterFenetres() eux-mêmes.
function orchestrateur(routeur, { fichier = dossierReglages(), machine = { occupes: [] }, ...opts } = {}) {
  return new OuverturePorts({
    plage: PLAGE,
    fichierReglages: fichier,
    trouverPasserelle: () => nat.trouverPasserelleUpnp({ locations: [routeur.location] }),
    adresseLocaleVers: async () => MOI,
    sonder: async (_adresse, liste) => liste.filter((p) => machine.occupes.includes(p)),
    intervalleSonde: 1e9,
    log: silencieux,
    ...opts
  });
}

/* ======================================================================== */

(async () => {
  console.log('\nOuverture des ports (UPnP / NAT-PMP)\n');

  /* ------------------------- analyse des messages ------------------------- */

  await test('une réponse SSDP livre l’adresse de description', () => {
    const r = nat.lireReponseSsdp('HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\n'
      + 'LOCATION: http://192.168.1.1:60000/fa1a0a5d/gatedesc.xml\r\n'
      + 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n');
    eq(r.location, 'http://192.168.1.1:60000/fa1a0a5d/gatedesc.xml');
    eq(nat.lireReponseSsdp('NOTIFY * HTTP/1.1\r\nLOCATION: x\r\n'), null, 'une annonce n’est pas une réponse');
    eq(nat.lireReponseSsdp('HTTP/1.1 200 OK\r\nST: x\r\n'), null, 'sans LOCATION, inexploitable');
  });

  await test('la description d’une box IGD v1 donne la bonne URL de contrôle', () => {
    const s = nat.lireDescriptionIgd(DESCRIPTION_XML, 'http://192.168.1.1:60000/fa1a0a5d/gatedesc.xml');
    eq(s.length, 1, 'le service WANCommonInterfaceConfig est écarté');
    eq(s[0].type, SERVICE);
    eq(s[0].controle, 'http://192.168.1.1:60000/fa1a0a5d/upnp/control/WANIPConn1');
  });

  await test('URLBase prime sur l’adresse de la description', () => {
    const xml = DESCRIPTION_XML.replace('<specVersion>', '<URLBase>http://10.0.0.1:5000/</URLBase><specVersion>');
    eq(nat.lireDescriptionIgd(xml, 'http://192.168.1.1/x.xml')[0].controle,
      'http://10.0.0.1:5000/fa1a0a5d/upnp/control/WANIPConn1');
  });

  await test('les réponses et les fautes SOAP sont lues', () => {
    const r = nat.lireReponseSoap('<s:Envelope><s:Body><u:GetExternalIPAddressResponse xmlns:u="x">'
      + '<NewExternalIPAddress>83.194.1.2</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>');
    eq(r, { ok: true, valeurs: { NewExternalIPAddress: '83.194.1.2' } });
    const f = nat.lireReponseSoap('<s:Fault><detail><UPnPError><errorCode>718</errorCode>'
      + '<errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault>');
    eq(f, { ok: false, code: 718, description: 'ConflictInMappingEntry' });
  });

  await test('l’enveloppe SOAP échappe les valeurs', () => {
    const x = nat.enveloppeSoap(SERVICE, 'AddPortMapping', [['NewPortMappingDescription', 'a<b&"c"']]);
    ok(x.includes('<NewPortMappingDescription>a&lt;b&amp;&quot;c&quot;</NewPortMappingDescription>'), x);
    ok(x.includes(`<u:AddPortMapping xmlns:u="${SERVICE}">`), 'action et service');
  });

  await test('les paquets NAT-PMP sont encodés et décodés selon la RFC 6886', () => {
    const d = nat.encoderDemandePmp({ portInterne: 26100, portExterne: 26100, duree: 3600 });
    eq([...d], [0, 1, 0, 0, 0x65, 0xf4, 0x65, 0xf4, 0, 0, 0x0e, 0x10]);
    const r = nat.decoderReponsePmp(Buffer.from([0, 129, 0, 0, 0, 0, 0, 9, 0x65, 0xf4, 0x65, 0xf4, 0, 0, 0x0e, 0x10]));
    eq([r.resultat, r.portInterne, r.portExterne, r.duree], [0, 26100, 26100, 3600]);
    eq(nat.decoderReponsePmp(Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 83, 194, 1, 2])).ipExterne, '83.194.1.2');
  });

  await test('la passerelle par défaut est lue sous Windows et Linux', () => {
    const route = [
      'IPv4 Route Table',
      'Active Routes:',
      'Network Destination        Netmask          Gateway       Interface  Metric',
      '          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.16     25',
      '          0.0.0.0          0.0.0.0       10.8.0.1         10.8.0.2     50',
      '        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331'
    ].join('\r\n');
    eq(nat.lirePasserelleWindows(route), '192.168.1.1', 'la métrique la plus basse l’emporte');
    const proc = 'Iface\tDestination\tGateway \tFlags\nwlan0\t00000000\t0101A8C0\t0003\nwlan0\t0001A8C0\t00000000\t0001\n';
    eq(nat.lirePasserelleLinux(proc), '192.168.1.1');
  });

  /* ------------------------- décisions pures ------------------------------ */

  await test('seules les redirections Castunn périmées et à nous sont nettoyées', () => {
    const c = (port, client, extra = {}) => ({
      port, portInterne: port, protocole: 'UDP', client, description: 'Castunn', bail: 3600, ...extra
    });
    const entrees = [
      ...DECODEUR,                                   // jamais touchées
      c(26105, MOI),                                 // à nous, dans la plage : réécrite, pas supprimée
      c(25000, MOI),                                 // à nous, hors plage : périmée
      c(26110, MOI, { portInterne: 9999 }),          // à nous, ports différents : périmée
      c(26101, '192.168.1.13'),                      // notre ancienne adresse : périmée
      c(26102, '192.168.1.50'),                      // autre machine du foyer : intouchable
      c(26103, MOI, { protocole: 'TCP' }),           // pas de l’UDP : hors sujet
      c(26104, MOI, { description: 'Castunn-autre' })
    ];
    const p = redirectionsPerimees(entrees, { plage: PLAGE, adresseLocale: MOI, ancienneAdresse: '192.168.1.13' });
    eq(p.map((e) => e.port).sort(), [25000, 26101, 26110]);
    eq(redirectionsPerimees(entrees, { plage: PLAGE, adresseLocale: MOI, ancienneAdresse: MOI })
      .map((e) => e.port).sort(), [25000, 26110], 'adresse inchangée : rien d’« ancien »');
  });

  await test('le bilan distingue ouvert, partiel et indisponible', () => {
    eq(bilanOuverture({ total: 3, accordes: [1, 2, 3], conflits: [], erreurs: [] }), { statut: 'ouvert', raison: '' });
    eq(bilanOuverture({ total: 3, accordes: [1], conflits: [2, 3], erreurs: [] }),
      { statut: 'partiel', raison: '2 port(s) déjà redirigé(s) vers une autre machine' });
    eq(bilanOuverture({ total: 3, accordes: [], conflits: [1, 2, 3], erreurs: [] }),
      { statut: 'indisponible', raison: 'ports déjà redirigés vers une autre machine' });
    eq(bilanOuverture({ total: 3, accordes: [], conflits: [], erreurs: ['HTTP 500'] }),
      { statut: 'indisponible', raison: 'HTTP 500' });
  });

  await test('les messages de console suivent la consigne', () => {
    const b = { min: 26100, max: 26129, total: 30 };
    eq(messageEtat({ ...b, statut: 'ouvert', methode: 'UPnP', accordes: [] }), 'UPnP : ports 26100-26129 ouverts');
    eq(messageEtat({ ...b, statut: 'partiel', methode: 'UPnP', accordes: new Array(10).fill(0), raison: '' }),
      'UPnP partiel (10/30)');
    eq(messageEtat({ ...b, statut: 'indisponible', raison: 'aucun routeur' }), 'UPnP indisponible (aucun routeur)');
  });

  await test('une box sans adresse publique est reconnue (CGNAT, double NAT)', () => {
    eq(adresseRoutable('83.194.1.2'), true);
    eq(adresseRoutable('100.72.3.4'), false, 'CGNAT 100.64.0.0/10');
    eq(adresseRoutable('100.128.0.1'), true, 'juste au-delà de la plage CGNAT');
    eq(adresseRoutable('192.168.0.254'), false, 'box derrière une autre box');
    eq(adresseRoutable('10.1.2.3'), false);
    eq(adresseRoutable('172.20.0.1'), false);
    eq(adresseRoutable(''), null, 'inconnue : on ne conclut rien');
  });

  await test('la plage se découpe en cinq fenêtres de 12, et Chromium garde toujours 60 ports', () => {
    eq(decouper(PLAGE).map((f) => `${f.min}-${f.max}`),
      ['26100-26111', '26112-26123', '26124-26135', '26136-26147', '26148-26159']);
    eq(plageChromium(), { min: 26100, max: 26159 });
    eq(plageChromium(26148), { min: 26148, max: 26207 }, 'la dernière fenêtre a aussi 60 ports devant elle');
    ok(debutValide(26112) && !debutValide(26113) && !debutValide(26160) && !debutValide('26112'),
      'un début lu dans un fichier est vérifié');
    eq(plageChromium(26113), { min: 26100, max: 26159 }, 'début invalide : plage par défaut');
  });

  await test('fenêtre prise : tout ce qui n’est pas une redirection Castunn à nous', () => {
    const f = { min: 26100, max: 26111 };
    const nous = { adresseLocale: MOI, ancienneAdresse: '192.168.1.13' };
    const e = (port, client, description = 'Castunn', protocole = 'UDP') =>
      ({ port, portInterne: port, protocole, client, description, bail: 3600 });
    ok(!fenetrePrise(DECODEUR, f, nous), 'le décodeur n’y est pas');
    ok(!fenetrePrise([e(26100, MOI), e(26111, '192.168.1.13')], f, nous), 'les nôtres, actuelles ou anciennes');
    ok(fenetrePrise([e(26111, '192.168.1.50')], f, nous), 'une autre machine Castunn');
    ok(fenetrePrise([e(26105, MOI, 'Mon jeu')], f, nous), 'un autre programme, même vers nous');
    ok(!fenetrePrise([e(26105, '192.168.1.50', 'x', 'TCP'), e(26112, '192.168.1.50')], f, nous),
      'du TCP, ou juste à côté : sans effet');
  });

  await test('agrandir quand il reste 2 ports, rendre la fenêtre du haut quand elle est vide', () => {
    const d = (o) => decisionFenetres({ nb: 1, nbMax: 5, libres: 12, occupesEnHaut: 0, ...o });
    eq(d({ libres: 3 }), '', '3 ports libres : on attend');
    eq(d({ libres: 2 }), 'agrandir');
    eq(d({ libres: 0, nbMax: 1 }), '', 'plus de fenêtre disponible');
    eq(d({ nb: 2, libres: 18, occupesEnHaut: 0 }), 'reduire', '6 libres en dessous');
    eq(d({ nb: 2, libres: 17, occupesEnHaut: 0 }), '', '5 libres en dessous : on garde (pas d’allers-retours)');
    eq(d({ nb: 2, libres: 20, occupesEnHaut: 1 }), '', 'un port encore tenu en haut : on garde');
    eq(d({ nb: 1, libres: 12 }), '', 'jamais moins d’une fenêtre');
  });

  await test('la sonde voit un port tenu sur une adresse précise, comme ceux de Chromium', async () => {
    const s = dgram.createSocket('udp4');
    await new Promise((r) => s.bind(0, '127.0.0.1', r));
    const port = s.address().port;
    try {
      // Mesuré : Chromium lie ses ports interface par interface. Une sonde sur
      // 0.0.0.0 réussit alors quand même — elle les croyait tous libres.
      if (process.platform === 'win32') ok(await udpPortLibre(port, '0.0.0.0'), 'le piège mesuré sous Windows');
      eq(await portsOccupes('127.0.0.1', [port, port + 1].filter((p) => p < 65536)), [port]);
    } finally { s.close(); }
  });

  /* ------------------------- contre un faux routeur UPnP ------------------ */

  await test('ports ouverts derrière un CGNAT : ouverts, mais on prévient que c’est vain', async () => {
    const r = await routeurUpnp({ ipExterne: '100.72.3.4' });
    const o = orchestrateur(r);
    const etat = await o.demarrer();
    try {
      eq(etat.statut, 'ouvert');
      ok(etat.nonRoutable, 'signalé');
      ok(etat.message.endsWith('sans effet depuis Internet'), etat.message);
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('une seule fenêtre de 12 ports au démarrage, port externe = port interne, bail d’une heure', async () => {
    const r = await routeurUpnp();
    const o = orchestrateur(r);
    const etat = await o.demarrer();
    try {
      eq(etat.statut, 'ouvert', etat.message);
      eq(etat.message, 'UPnP : ports 26100-26111 ouverts');
      const c = r.castunn();
      eq(c.length, F, 'jamais les 60 d’un coup');
      ok(c.every((e) => e.portInterne === e.port && e.client === MOI && e.protocole === 'UDP' && e.bail === 3600),
        JSON.stringify(c[0]));
      eq(c.map((e) => e.port), ports(PLAGE.min, F));
      eq(o.plageChromium(), { min: 26100, max: 26159 }, 'Chromium garde 60 ports devant lui');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('la fermeture rend tous les ports, et seulement les nôtres', async () => {
    const r = await routeurUpnp();
    const o = orchestrateur(r);
    await o.demarrer();
    const rendus = await o.arreter();
    try {
      eq(rendus, F);
      eq(r.castunn().length, 0, 'plus aucune redirection Castunn');
      eq(r.table.map((e) => e.description), DECODEUR.map((e) => e.description), 'le décodeur TV est intact');
      ok(!o.aDesRedirections(), 'plus rien à rendre');
    } finally { await r.fermer(); }
  });

  await test('un relancement réécrit les mêmes redirections, sans doublon', async () => {
    const r = await routeurUpnp();
    const fichier = dossierReglages();
    try {
      await orchestrateur(r, { fichier }).demarrer();   // « plantage » : jamais arrêté
      const o2 = orchestrateur(r, { fichier });
      await o2.demarrer();
      eq(r.castunn().length, F, 'toujours 12, pas 24');
      eq(o2.plageTenue(), { min: 26100, max: 26111 }, 'la même fenêtre : nos propres redirections ne la rendent pas « prise »');
      await o2.arreter();
    } finally { await r.fermer(); }
  });

  await test('au démarrage, les redirections périmées sont nettoyées', async () => {
    const fichier = dossierReglages();
    fs.writeFileSync(fichier, JSON.stringify({ ouverturePorts: { actif: true, derniereAdresse: '192.168.1.13' } }));
    const r = await routeurUpnp({
      existantes: [
        ...DECODEUR,
        { port: 25000, portInterne: 25000, protocole: 'UDP', client: MOI, description: 'Castunn', bail: 0 },
        { port: 26101, portInterne: 26101, protocole: 'UDP', client: '192.168.1.13', description: 'Castunn', bail: 0 }
      ]
    });
    const o = orchestrateur(r, { fichier });
    const etat = await o.demarrer();
    try {
      ok(!r.table.some((e) => e.port === 25000), 'plage d’avant supprimée');
      ok(r.table.some((e) => e.port === 26101 && e.client === MOI), 'port repris sur la nouvelle adresse');
      eq(etat.statut, 'ouvert', 'le port de l’ancienne adresse ne fait plus conflit');
      eq(JSON.parse(fs.readFileSync(fichier, 'utf8')).ouverturePorts.derniereAdresse, MOI, 'adresse mémorisée');
      eq(r.table.filter((e) => e.protocole === 'TCP').length, 3, 'décodeur intact');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('une autre machine Castunn du foyer : on prend la fenêtre suivante, et Chromium la suit', async () => {
    const autre = (port) => ({ port, portInterne: port, protocole: 'UDP', client: '192.168.1.50', description: 'Castunn', bail: 3600 });
    const r = await routeurUpnp({ existantes: [...DECODEUR, autre(26105), autre(26106)] });
    const fichier = dossierReglages();
    const o = orchestrateur(r, { fichier });
    const plages = [];
    o.on('plage', (p) => plages.push(p));
    const etat = await o.demarrer();
    try {
      eq(etat.statut, 'ouvert', etat.message);
      eq(etat.message, 'UPnP : ports 26112-26123 ouverts');
      ok(!r.journal.some((j) => j.action === 'AddPortMapping' && j.port < 26112),
        'la fenêtre prise est sautée sans rien demander au routeur');
      ok(r.table.filter((e) => e.client === '192.168.1.50').length === 2, 'l’autre machine garde ses ports');
      eq(plages, [{ min: 26112, max: 26171 }], 'Chromium commence à notre fenêtre');
      eq(JSON.parse(fs.readFileSync(fichier, 'utf8')).ouverturePorts.debutPlage, 26112,
        'noté pour les instances secondaires');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('une redirection posée à la main, même vers nous, rend la fenêtre prise', async () => {
    const r = await routeurUpnp({ existantes: [
      { port: 26103, portInterne: 26103, protocole: 'UDP', client: MOI, description: 'Mon jeu', bail: 0 }
    ] });
    const o = orchestrateur(r);
    const etat = await o.demarrer();
    try {
      eq(etat.message, 'UPnP : ports 26112-26123 ouverts');
      eq(r.table.find((e) => e.port === 26103).description, 'Mon jeu', 'jamais réécrite');
    } finally { await o.arreter(); await r.fermer(); }
    ok(r.table.some((e) => e.port === 26103), 'ni supprimée à la fermeture');
  });

  await test('toute la plage prise ailleurs : indisponible, avec la raison', async () => {
    const autres = Array.from({ length: TOTAL }, (_, i) => ({
      port: PLAGE.min + i, portInterne: PLAGE.min + i, protocole: 'UDP', client: '192.168.1.50', description: 'Castunn', bail: 3600
    }));
    const r = await routeurUpnp({ existantes: autres });
    const o = orchestrateur(r);
    const etat = await o.demarrer();
    try {
      eq(etat.message, 'UPnP indisponible (ports déjà redirigés vers une autre machine)');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('routeur qui refuse les baux limités : repli sur un bail permanent', async () => {
    const r = await routeurUpnp({ permanentSeul: true });
    const o = orchestrateur(r, { renouvellement: 50 });
    const etat = await o.demarrer();
    try {
      eq(etat.statut, 'ouvert');
      ok(etat.permanent, 'bail permanent signalé');
      ok(etat.message.includes('bail permanent'), etat.message);
      ok(r.castunn().every((e) => e.bail === 0), 'toutes permanentes');
      const ajouts = r.journal.filter((j) => j.action === 'AddPortMapping').length;
      await pause(200);
      eq(r.journal.filter((j) => j.action === 'AddPortMapping').length, ajouts, 'pas de renouvellement en bail permanent');
      await o.arreter();
      eq(r.castunn().length, 0, 'permanentes, mais rendues à la fermeture');
    } finally { await r.fermer(); }
  });

  await test('routeur qui n’accorde qu’une partie de la plage : on garde et on le dit', async () => {
    const r = await routeurUpnp({ limite: 10 });
    const o = orchestrateur(r);
    const etat = await o.demarrer();
    try {
      eq(etat.statut, 'partiel');
      ok(etat.message.startsWith('UPnP partiel (10/12)'), etat.message);
      eq(r.castunn().length, 10);
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('le bail est renouvelé, sans bruit dans la console', async () => {
    const r = await routeurUpnp();
    const o = orchestrateur(r, { renouvellement: 150 });
    const evenements = [];
    o.on('etat', (e) => evenements.push(e.statut));
    await o.demarrer();
    const avant = r.journal.filter((j) => j.action === 'AddPortMapping').length;
    await pause(450);
    try {
      const apres = r.journal.filter((j) => j.action === 'AddPortMapping').length;
      ok(apres >= avant + F, `renouvellement attendu (${avant} → ${apres} ajouts)`);
      eq(evenements, ['en-cours', 'ouvert'], 'un renouvellement à l’identique ne republie rien');
      eq(r.castunn().length, F, 'toujours sans doublon');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('décocher la case rend les ports aussitôt et s’en souvient', async () => {
    const r = await routeurUpnp();
    const fichier = dossierReglages();
    const o = orchestrateur(r, { fichier });
    await o.demarrer();
    const etat = await o.definirActif(false);
    try {
      eq(etat.statut, 'desactive');
      eq(r.castunn().length, 0, 'redirections supprimées immédiatement');
      eq(JSON.parse(fs.readFileSync(fichier, 'utf8')).ouverturePorts.actif, false, 'choix mémorisé');

      // Au lancement suivant, rien ne part vers le routeur.
      const appels = r.journal.length;
      const o2 = orchestrateur(r, { fichier });
      eq((await o2.demarrer()).statut, 'desactive');
      eq(r.journal.length, appels, 'aucune requête au routeur');

      // Et recocher rouvre.
      eq((await o2.definirActif(true)).statut, 'ouvert');
      eq(r.castunn().length, F);
      await o2.arreter();
    } finally { await r.fermer(); }
  });

  await test('un arrêt pendant l’ouverture ne laisse aucun port fantôme', async () => {
    const r = await routeurUpnp({ latence: 15 });
    const o = orchestrateur(r);
    const cycle = o.demarrer();
    await pause(150);   // quelques ports déjà ouverts, pas tous
    ok(r.castunn().length > 0 && r.castunn().length < F, `ouverture en cours (${r.castunn().length})`);
    await o.arreter({ delaiMax: 5000 });
    await cycle;
    try {
      eq(r.castunn().length, 0, 'tout rendu, y compris ce qui s’ouvrait');
    } finally { await r.fermer(); }
  });

  await test('la fermeture ne bloque jamais au-delà du délai imparti', async () => {
    const r = await routeurUpnp();
    const o = orchestrateur(r);
    await o.demarrer();
    // Le routeur devient muet : il accepte la connexion et ne répond plus.
    const muet = http.createServer(() => {});
    await new Promise((res) => muet.listen(0, '127.0.0.1', res));
    o.passerelle.controle = `http://127.0.0.1:${muet.address().port}/x`;
    const t0 = Date.now();
    await o.arreter({ delaiMax: 400 });
    const duree = Date.now() - t0;
    try {
      ok(duree < 1200, `arrêt en ${duree} ms`);
    } finally {
      muet.closeAllConnections?.();
      await new Promise((res) => muet.close(res));
      await r.fermer();
    }
  });

  await test('sans routeur coopératif : indisponible, rien d’autre', async () => {
    const o = new OuverturePorts({
      plage: PLAGE,
      fichierReglages: dossierReglages(),
      trouverPasserelle: async () => null,
      adresseLocaleVers: async () => MOI,
      log: silencieux
    });
    const etat = await o.demarrer();
    eq(etat.message, 'UPnP indisponible (aucun routeur UPnP ni NAT-PMP n’a répondu)');
    ok(!o.aDesRedirections());
  });

  await test('routeur muet au démarrage : on réessaie seul, et ça finit par ouvrir', async () => {
    const r = await routeurUpnp();
    let appels = 0;
    const o = orchestrateur(r, {
      // Muet deux fois, comme une box juste après la suppression de redirections.
      trouverPasserelle: async () => (++appels <= 2 ? null : nat.trouverPasserelleUpnp({ locations: [r.location] })),
      reessais: [30, 30]
    });
    const evenements = [];
    o.on('etat', (e) => evenements.push(e.statut));
    try {
      eq((await o.demarrer()).statut, 'indisponible');
      for (let i = 0; i < 200 && o.etatPublic().statut !== 'ouvert'; i++) await pause(10);
      eq(o.etatPublic().message, 'UPnP : ports 26100-26111 ouverts');
      eq(appels, 3);
      eq(evenements, ['en-cours', 'indisponible', 'ouvert'], 'les réessais ratés ne republient rien');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('un arrêt annule les réessais', async () => {
    let appels = 0;
    const o = new OuverturePorts({
      plage: PLAGE, fichierReglages: dossierReglages(), log: silencieux,
      trouverPasserelle: async () => { appels++; return null; },
      adresseLocaleVers: async () => MOI,
      reessais: [20]
    });
    await o.demarrer();
    await o.arreter();
    await pause(100);
    eq(appels, 1);
  });

  await test('instance secondaire : jamais un mot au routeur, et la case ne la change pas', async () => {
    const r = await routeurUpnp();
    const o = orchestrateur(r, { delegue: true });
    try {
      const etat = await o.demarrer();
      eq(etat.statut, 'delegue');
      eq(etat.message, 'UPnP : géré par la première instance de Castunn (même machine, mêmes ports redirigés)');
      eq((await o.definirActif(false)).statut, 'delegue');
      eq(r.journal.length, 0, 'aucune requête');
    } finally { await o.arreter(); await r.fermer(); }
  });

  /* ------------------------- fenêtres qui grandissent --------------------- */

  await test('fenêtre presque pleine : une de plus ; vidée : rendue', async () => {
    const r = await routeurUpnp();
    const machine = { occupes: [] };
    const o = orchestrateur(r, { machine });
    const plages = [];
    o.on('plage', (p) => plages.push(p));
    await o.demarrer();
    try {
      machine.occupes = ports(26100, 9);
      eq((await o.ajusterFenetres()).message, 'UPnP : ports 26100-26111 ouverts', '3 libres : rien');
      machine.occupes = ports(26100, 10);
      eq((await o.ajusterFenetres()).message, 'UPnP : ports 26100-26123 ouverts', '2 libres : agrandie');
      eq(r.castunn().map((e) => e.port), ports(26100, 24));
      ok(r.castunn().every((e) => e.bail === 3600 && e.client === MOI), 'mêmes règles que la première');
      machine.occupes = ports(26100, 6);
      eq((await o.ajusterFenetres()).message, 'UPnP : ports 26100-26111 ouverts', 'vidée : rendue');
      eq(r.castunn().map((e) => e.port), ports(26100, F));
      eq(plages, [], 'le début ne bouge pas : Chromium n’est pas touché');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('jamais au-delà de 60 ports, une fenêtre à la fois', async () => {
    const r = await routeurUpnp();
    const machine = { occupes: ports(26100, 60) };
    const o = orchestrateur(r, { machine });
    await o.demarrer();
    try {
      const vus = [];
      for (let i = 0; i < 6; i++) { await o.ajusterFenetres(); vus.push(r.castunn().length); }
      eq(vus, [24, 36, 48, 60, 60, 60]);
      eq(o.etatPublic().message, 'UPnP : ports 26100-26159 ouverts');
      eq(await o.arreter(), 60, 'tout est rendu');
      eq(r.castunn().length, 0);
    } finally { await r.fermer(); }
  });

  await test('fenêtre suivante prise : on le dit, on n’insiste pas, rien n’est volé', async () => {
    const voisin = { port: 26115, portInterne: 26115, protocole: 'UDP', client: '192.168.1.50', description: 'Castunn', bail: 3600 };
    const r = await routeurUpnp({ existantes: [voisin] });
    const machine = { occupes: ports(26100, 12) };
    const journal = [];
    const o = orchestrateur(r, { machine, log: { log: (m) => journal.push(m), warn() {} } });
    await o.demarrer();
    try {
      await o.ajusterFenetres();
      eq(r.castunn().filter((e) => e.client === MOI).length, F, 'toujours une seule fenêtre');
      ok(journal.some((m) => m.includes('26112-26123 déjà redirigés ailleurs')), journal.join(' | '));
      const requetes = r.journal.length;
      await o.ajusterFenetres();
      eq(r.journal.length, requetes, 'pas une requête de plus à chaque sonde');
      ok(r.table.some((e) => e.port === 26115 && e.client === '192.168.1.50'), 'le voisin garde son port');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('un arrêt pendant l’agrandissement ne laisse aucun port fantôme', async () => {
    const r = await routeurUpnp({ latence: 15 });
    const machine = { occupes: ports(26100, 12) };
    const o = orchestrateur(r, { machine });
    await o.demarrer();
    const ajustement = o.ajusterFenetres();
    // Le routeur relit d'abord sa liste, puis ajoute port par port.
    for (let i = 0; i < 300 && r.castunn().length <= F; i++) await pause(10);
    ok(r.castunn().length > F && r.castunn().length < 2 * F, `agrandissement en cours (${r.castunn().length})`);
    await o.arreter({ delaiMax: 5000 });
    await ajustement;
    try {
      eq(r.castunn().length, 0, 'tout rendu, y compris la fenêtre qui s’ouvrait');
    } finally { await r.fermer(); }
  });

  await test('la fenêtre notée pour les instances secondaires n’est jamais périmée', async () => {
    const fichier = dossierReglages();
    fs.writeFileSync(fichier, JSON.stringify({ ouverturePorts: { actif: true, debutPlage: 26136 } }));
    const r = await routeurUpnp();
    const o = orchestrateur(r, { fichier });
    await o.demarrer();
    try {
      eq(JSON.parse(fs.readFileSync(fichier, 'utf8')).ouverturePorts.debutPlage, 26100,
        'retombé sur la première fenêtre : le fichier le dit');
    } finally { await o.arreter(); await r.fermer(); }
  });

  await test('décocher la case ramène Chromium au début de la plage', async () => {
    const autre = { port: 26100, portInterne: 26100, protocole: 'UDP', client: '192.168.1.50', description: 'Castunn', bail: 3600 };
    const r = await routeurUpnp({ existantes: [autre] });
    const o = orchestrateur(r);
    const plages = [];
    o.on('plage', (p) => plages.push(p.min));
    await o.demarrer();
    await o.definirActif(false);
    try {
      eq(plages, [26112, 26100]);
    } finally { await r.fermer(); }
  });

  /* ------------------------- contre un faux routeur NAT-PMP --------------- */

  await test('NAT-PMP : adresse externe, ouverture et suppression', async () => {
    const r = await routeurPmp();
    const p = new nat.PasserellePmp({ hote: '127.0.0.1', port: r.port });
    try {
      eq(await p.ipExterne(), '83.194.1.2');
      await p.ajouter({ port: 26100, bail: 3600 });
      await p.supprimer({ port: 26100 });
      eq(r.recues, [
        { interne: 26100, externe: 26100, duree: 3600 },
        { interne: 26100, externe: 0, duree: 0 }
      ]);
    } finally { await r.fermer(); }
  });

  await test('NAT-PMP : un port pris révèle la fenêtre prise, rendue entière pour la suivante', async () => {
    const r = await routeurPmp({ decaler: [26101] });
    const o = new OuverturePorts({
      plage: PLAGE,
      fichierReglages: dossierReglages(),
      trouverPasserelle: async () => new nat.PasserellePmp({ hote: '127.0.0.1', port: r.port }),
      adresseLocaleVers: async () => MOI,
      sonder: async () => [],
      log: silencieux
    });
    const etat = await o.demarrer();
    try {
      eq(etat.statut, 'ouvert', etat.message);
      eq(etat.methode, 'NAT-PMP');
      eq(etat.message, 'NAT-PMP : ports 26112-26123 ouverts');
      ok(r.recues.some((q) => q.interne === 26101 && q.duree === 0), 'la redirection décalée est aussitôt rendue');
      ok(r.recues.some((q) => q.interne === 26100 && q.duree === 0), 'et le reste de la fenêtre avec elle');
      await o.arreter();
      const rendus = new Set(r.recues.filter((q) => q.duree === 0).map((q) => q.interne));
      ok(ports(26112, F).every((p) => rendus.has(p)), 'tout est rendu à la fermeture');
    } finally { await r.fermer(); }
  });

  const echecs = results.filter((x) => !x).length;
  console.log(`\n${results.length - echecs}/${results.length} tests passés.`);
  for (const d of dossiersCrees) fs.rmSync(d, { recursive: true, force: true });
  process.exit(echecs ? 1 : 0);
})();
