// src/renderer/rtc-stats.js
// Lecture des statistiques WebRTC : quel chemin la connexion a-t-elle pris ?
// Sans dépendance au DOM ni à l'API RTC — on lui passe le rapport de
// pc.getStats(), ou n'importe quoi qui ait un forEach (tableau, Map).

/**
 * Description du chemin retenu, et de ce qui a été collecté localement.
 *
 * `relaye` est vrai dès qu'un des deux bouts passe par un serveur TURN : la
 * connexion fonctionne, mais chaque octet fait le détour par ce serveur.
 * host / srflx / prflx sont tous directs — srflx et prflx traversent un NAT,
 * sans intermédiaire.
 */
export function describeRtcPath(stats) {
  const liste = [];
  stats?.forEach?.((s) => { if (s && typeof s === 'object') liste.push(s); });
  const parId = new Map(liste.map((s) => [s.id, s]));

  // Le transport désigne la paire retenue ; à défaut (certains navigateurs ne
  // remplissent pas ce champ), on prend la paire nominée et réussie.
  let paire = null;
  const transport = liste.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
  if (transport) paire = parId.get(transport.selectedCandidatePairId) || null;
  if (!paire) {
    paire = liste.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') || null;
  }

  const locaux = liste.filter((s) => s.type === 'local-candidate');
  const collectes = [...new Set(locaux.map((s) => s.candidateType).filter(Boolean))];
  // Une adresse IPv6 parmi les candidats locaux ? Les noms mDNS (.local)
  // masquent l'adresse : on ne peut alors rien conclure.
  const adresses = locaux.map((s) => s.address || s.ip || '').filter((a) => a && !a.endsWith('.local'));
  const ipv6 = adresses.length ? adresses.some((a) => a.includes(':')) : null;

  if (!paire) return { trouve: false, collectes, ipv6 };

  const local = parId.get(paire.localCandidateId) || {};
  const distant = parId.get(paire.remoteCandidateId) || {};
  const typeLocal = local.candidateType || '?';
  const typeDistant = distant.candidateType || '?';
  return {
    trouve: true,
    typeLocal,
    typeDistant,
    protocole: String(local.protocol || '?').toUpperCase(),
    port: Number(local.port) || null,
    relaye: typeLocal === 'relay' || typeDistant === 'relay',
    collectes,
    ipv6
  };
}

/**
 * Résumé des candidats trouvés localement, tels qu'émis un à un par
 * `onicecandidate` — et non tirés de getStats(), qui n'en garde que ceux
 * encore engagés dans une paire : une fois la paire directe retenue, les
 * candidats STUN et relais disparaissent du rapport, et l'on concluait à
 * tort qu'ils n'avaient jamais été obtenus.
 */
export function summarizeGathered(candidats = []) {
  const collectes = [...new Set(candidats.map((c) => c?.type).filter(Boolean))];
  const adresses = candidats.map((c) => c?.address || '').filter((a) => a && !a.endsWith('.local'));
  return { collectes, ipv6: adresses.length ? adresses.some((a) => a.includes(':')) : null };
}

/** « host ↔ srflx (UDP), port local 26103 » */
export function formatRtcPath(c) {
  if (!c?.trouve) return 'indéterminé (statistiques incomplètes)';
  return `${c.typeLocal} ↔ ${c.typeDistant} (${c.protocole})`
    + (c.port ? `, port local ${c.port}` : '');
}

/**
 * Ce que révèlent les candidats collectés. Sans srflx, le STUN n'a pas
 * répondu (ou un pare-feu bloque l'UDP sortant) : hors du réseau local, il ne
 * restera que le relais. Sans IPv6, on se prive d'un chemin souvent direct.
 *
 * À n'appeler qu'une fois la collecte terminée : avant, une absence ne
 * prouve rien. `complete: false` le signale dans le texte.
 *
 * `ecourtee` : Chromium cesse de collecter dès qu'une connexion directe
 * tient (vérifié : 2 ms après les candidats host entre deux pages de la
 * même machine). STUN et relais ne sont alors jamais interrogés, et leur
 * absence ne dit rien de leur santé.
 */
export function describeCollectes(c, { complete = true, ecourtee = false } = {}) {
  const types = c?.collectes?.length ? c.collectes.join(', ') : 'aucun';
  if (ecourtee) return `${types} (collecte arrêtée : connexion directe déjà établie)`;
  if (!complete) return `${types} (collecte inachevée après 10 s)`;
  const notes = [];
  if (c?.collectes?.length && !c.collectes.includes('srflx')) {
    notes.push('aucune adresse publique obtenue par STUN');
  }
  if (c?.ipv6 === false) notes.push('pas d’IPv6');
  return types + (notes.length ? ` — ${notes.join(', ')}` : '');
}
