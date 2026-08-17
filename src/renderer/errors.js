// src/renderer/errors.js
// Acheminement des erreurs vers la console visible dans l'application.
//
// Convention du projet :
//   - `catch {}` reste acceptable pour une opération "au mieux" dont l'échec
//     n'a aucune conséquence (fermer un flux déjà fermé, libérer une URL,
//     écrire dans localStorage quand il est indisponible...).
//   - dès qu'un échec change ce que voit ou obtient l'utilisateur, il passe
//     par reportError() pour être lisible sans ouvrir les outils de debug.

let sink = null;

/** Branche la console de l'application (appelée une fois au démarrage). */
export function setErrorSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

/** Signale une erreur à l'utilisateur ET au journal du navigateur. */
export function reportError(scope, err) {
  const detail = (err && err.message) ? err.message : String(err ?? 'erreur inconnue');
  const line = `[erreur] ${scope} : ${detail}`;
  try { if (sink) sink(line); } catch { /* la console d'affichage ne doit jamais casser le flux */ }
  console.error(`[${scope}]`, err);
  return line;
}

/**
 * Exécute une opération dont l'échec doit rester visible, sans propager
 * l'exception. Renvoie `fallback` en cas d'échec.
 */
export function attempt(scope, fn, fallback = undefined) {
  try {
    return fn();
  } catch (e) {
    reportError(scope, e);
    return fallback;
  }
}

/**
 * Installe les filets globaux : sans eux, une erreur non capturée (y compris
 * dans un module) n'apparaît nulle part pour l'utilisateur.
 */
export function installGlobalErrorHandlers(target = window) {
  target.addEventListener('error', (ev) => {
    // Les erreurs de chargement de ressources n'ont pas d'objet Error.
    if (ev.error) reportError('non capturée', ev.error);
    else if (ev.message) reportError('non capturée', ev.message);
  });
  target.addEventListener('unhandledrejection', (ev) => {
    reportError('promesse rejetée', ev.reason);
  });
}
