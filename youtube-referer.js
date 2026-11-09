// youtube-referer.js
// Le lecteur intégré de YouTube exige de savoir qui l'intègre : sans en-tête
// Referer, il refuse de lire (erreur 153, mesuré). Une page file:// n'en
// envoie pas ; on en pose un qui nomme l'application, comme YouTube le
// demande aux applications (https://<identifiant de l'application>).
// Seules les requêtes vers YouTube sont touchées, et seulement si elles n'ont
// pas déjà de Referer.

const ADRESSES = [
  'https://www.youtube.com/*',
  'https://youtube.com/*',
  'https://www.youtube-nocookie.com/*'
];

function autoriserLecteurYoutube(session, appId = 'com.lumonui.castunn') {
  const referer = `https://${appId}/`;
  session.webRequest.onBeforeSendHeaders({ urls: ADRESSES }, (details, callback) => {
    const entetes = details.requestHeaders;
    if (!entetes.Referer && !entetes.referer) entetes.Referer = referer;
    callback({ requestHeaders: entetes });
  });
}

module.exports = { autoriserLecteurYoutube };
