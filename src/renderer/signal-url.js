// src/renderer/signal-url.js
// Détermination de l'adresse du serveur de signalisation.
// Logique pure : ni DOM, ni réseau — la découverte est injectée.

/**
 * Normalise ce que l'utilisateur a saisi dans les paramètres.
 * Accepte "ws(s)://…", "http(s)://…" ou un simple "hote:port".
 * @returns {string|null} une URL WebSocket, ou null si la saisie est vide.
 */
export function buildWsUrl(raw, { pageProtocol = 'file:' } = {}) {
  const value = String(raw || '').trim();
  if (!value) return null;

  if (/^wss?:\/\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value.replace(/^http/i, 'ws');

  const scheme = (pageProtocol === 'https:') ? 'wss' : 'ws';
  return `${scheme}://${value}`;
}

/**
 * Choisit l'adresse à utiliser, dans l'ordre :
 *   1. la saisie de l'utilisateur (toujours prioritaire) ;
 *   2. une adresse figée à la compilation, si le projet en définit une ;
 *   3. l'hôte courant quand la page est servie en http(s) ;
 *   4. un serveur Castunn détecté sur le réseau local ;
 *   5. la machine locale, en dernier recours.
 *
 * Aucune adresse n'est codée en dur : c'est la découverte qui trouve l'hôte,
 * quel que soit son dernier octet.
 *
 * @param {object} o
 * @param {string} [o.typed]          saisie utilisateur
 * @param {string} [o.fixedUrl]       adresse figée éventuelle (Worker...)
 * @param {string} [o.pageProtocol]   location.protocol
 * @param {string} [o.pageHost]       location.host
 * @param {string} [o.knownHost]      hôte découvert précédemment ("ip:port")
 * @param {boolean} [o.rescan]        ignorer knownHost et rebalayer
 * @param {() => Promise<string[]>} [o.discover] découverte réseau
 * @param {number} [o.localPort]
 * @param {(msg:string) => void} [o.log]
 * @returns {Promise<{url:string, host:string|null, source:string}>}
 */
export async function resolveSignalUrl({
  typed = '',
  fixedUrl = '',
  pageProtocol = 'file:',
  pageHost = '',
  knownHost = null,
  rescan = false,
  discover = null,
  localPort = 8080,
  log = () => {}
} = {}) {
  const fromInput = buildWsUrl(typed, { pageProtocol });
  if (fromInput) return { url: fromInput, host: null, source: 'saisie' };

  if (fixedUrl) return { url: fixedUrl, host: null, source: 'figée' };

  if (pageProtocol !== 'file:' && pageHost) {
    const scheme = (pageProtocol === 'https:') ? 'wss' : 'ws';
    return { url: `${scheme}://${pageHost}`, host: pageHost, source: 'hôte de la page' };
  }

  const fallback = { url: `ws://127.0.0.1:${localPort}`, host: null, source: 'machine locale' };

  // L'hôte déjà connu passe avant tout le reste : il vaut mieux que la
  // découverte (plus lent) comme que le repli local (souvent faux). Il est
  // consulté même quand aucune découverte n'est disponible — le contraire
  // revenait à l'oublier purement et simplement.
  if (knownHost && !rescan) {
    return { url: `ws://${knownHost}`, host: knownHost, source: 'hôte mémorisé' };
  }

  if (typeof discover !== 'function') return fallback;

  log('Recherche d’un serveur Castunn sur le réseau local…');
  try {
    const hosts = await discover({ port: localPort });
    if (hosts && hosts.length) {
      log(`Serveur trouvé : ${hosts[0]}`);
      return { url: `ws://${hosts[0]}`, host: hosts[0], source: 'découverte' };
    }
    log('Aucun serveur trouvé sur le réseau local.');
  } catch (e) {
    log(`Échec de la recherche réseau : ${e?.message || e}`);
  }
  return fallback;
}
