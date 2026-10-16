// scripts/sync-version.js
// Recopie la version de package.json dans src/renderer/version.js, que la page
// importe : dans un navigateur, elle n'a aucun autre moyen de connaître sa
// version. La date n'y change que si la version change.
//
//   npm run version:sync             met à jour version.js
//   node scripts/sync-version.js --verifier
//                                    échoue si version.js est en retard (CI)
//
// Lancé tout seul par `npm version 1.2.3` (script « version » de package.json).

const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const CIBLE = path.join(RACINE, 'src', 'renderer', 'version.js');
const { version } = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));

function lire() {
  try {
    const texte = fs.readFileSync(CIBLE, 'utf8');
    return {
      version: (/VERSION = '([^']*)'/.exec(texte) || [])[1] || null,
      date: (/DATE_VERSION = '([^']*)'/.exec(texte) || [])[1] || null
    };
  } catch {
    return { version: null, date: null };
  }
}

const actuel = lire();

if (process.argv.includes('--verifier')) {
  if (actuel.version !== version) {
    console.error(`src/renderer/version.js annonce ${actuel.version || 'rien'}, package.json ${version} :`
      + ' lancez « npm run version:sync » et commitez le résultat.');
    process.exit(1);
  }
  console.log(`Version ${version} du ${actuel.date} : cohérente.`);
  process.exit(0);
}

if (actuel.version === version) {
  console.log(`version.js déjà à ${version} (du ${actuel.date}).`);
  process.exit(0);
}

const j = new Date();
const date = [j.getDate(), j.getMonth() + 1].map((n) => String(n).padStart(2, '0')).join('-') + '-' + j.getFullYear();
fs.writeFileSync(CIBLE, [
  '// src/renderer/version.js',
  '// GÉNÉRÉ par scripts/sync-version.js depuis package.json : ne pas modifier à la main.',
  '// Le serveur refuse tout client d\'une autre version (et inversement).',
  '',
  `export const VERSION = '${version}';`,
  `export const DATE_VERSION = '${date}';`,
  ''
].join('\r\n'));
console.log(`version.js : ${actuel.version || 'rien'} -> ${version} (du ${date}).`);
