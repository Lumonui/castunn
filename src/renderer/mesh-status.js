// src/renderer/mesh-status.js
// La pastille « RTC (P2P) » du maillage : texte, couleur et infobulle.
// Sans dépendance au DOM ni à l'API RTC : testable cas par cas.

import { formatRtcPath } from './rtc-stats.js';

const EN_COURS = new Set(['new', 'connecting', 'checking']);

/**
 * État d'un pair vu de la pastille.
 * @param {{ ouvert:boolean, connectionState?:string, chemin?:object }|null} lien
 */
export function etatPair(lien) {
  if (lien?.ouvert) return lien.chemin?.relaye ? 'relais' : 'direct';
  if (lien && EN_COURS.has(lien.connectionState || 'new')) return 'connexion';
  return 'websocket';
}

function detail(lien, etat) {
  const chemin = lien?.chemin?.trouve ? ` (${formatRtcPath(lien.chemin)})` : '';
  if (etat === 'direct') return `direct${chemin}`;
  if (etat === 'relais') return `relais TURN${chemin}`;
  if (etat === 'connexion') return 'connexion…';
  return 'WebSocket (pas de P2P)';
}

/**
 * @param {Array<{ label:string, lien:object|null }>} pairs  les pairs de la room
 * @returns {{ texte:string, classe:'ok'|'warn'|'ko', titre:string }}
 *
 * À deux, la pastille parle comme avant (« Connecté », « Connecté (dégradé) »…) :
 * c'est le cas le plus courant et il n'y a rien à compter. À partir de trois,
 * elle compte les liens ouverts — « 2/3 » — et l'infobulle détaille chaque pair.
 */
export function resumerMaillage(pairs = []) {
  const n = pairs.length;
  if (n === 0) return { texte: 'Déconnecté', classe: 'ko', titre: '' };

  const etats = pairs.map((p) => etatPair(p.lien));

  if (n === 1) {
    const etat = etats[0];
    const chemin = pairs[0].lien?.chemin;
    if (etat === 'direct') {
      return {
        texte: 'Connecté',
        classe: 'ok',
        titre: chemin?.trouve ? `Connexion directe : ${formatRtcPath(chemin)}` : ''
      };
    }
    if (etat === 'relais') {
      return {
        texte: 'Connecté (dégradé)',
        classe: 'warn',
        titre: chemin?.trouve ? `Relayé par un serveur TURN : ${formatRtcPath(chemin)}` : ''
      };
    }
    return { texte: etat === 'connexion' ? 'Connexion...' : 'Déconnecté', classe: 'ko', titre: '' };
  }

  const ouverts = etats.filter((e) => e === 'direct' || e === 'relais').length;
  const relayes = etats.filter((e) => e === 'relais').length;
  const classe = ouverts === n && relayes === 0 ? 'ok' : ouverts === 0 ? 'ko' : 'warn';
  return {
    texte: `${ouverts}/${n}` + (relayes ? ' (dégradé)' : ''),
    classe,
    titre: pairs.map((p, i) => `${p.label} : ${detail(p.lien, etats[i])}`).join('\n')
  };
}
