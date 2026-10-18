// src/renderer/salle.js
// Salles privées : un code à partager, que le serveur ne voit jamais.
//
// Le code (20 caractères, ~100 bits d'aléa) se transmet entre participants —
// de vive voix, par message, et bientôt par lien ou QR code. Le serveur ne
// reçoit que son empreinte SHA-256 : il range les membres d'une même salle
// sans pouvoir la deviner ni en lire le code. Le code restera donc
// utilisable comme clé de chiffrement de bout en bout.
//
// Sans dépendance au DOM : `crypto` est injectable pour les tests.

// Sans 0, 1, l, o : rien à confondre en lisant ou en dictant le code.
export const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const LONGUEUR = 20;

/** Nouveau code, en groupes de 4 : « abcd-efgh-ijkm-npqr-stuv ». */
export function nouveauCode(aleatoire = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  // 256 est un multiple de 32 : le modulo ne favorise aucune lettre.
  const octets = aleatoire(LONGUEUR);
  return formaterCode([...octets].map((o) => ALPHABET[o % ALPHABET.length]).join(''));
}

/** Code saisi -> forme canonique (20 caractères), ou null s'il n'en est pas un. */
export function normaliserCode(saisie) {
  const brut = String(saisie || '').toLowerCase().replace(/[\s-]/g, '');
  if (brut.length !== LONGUEUR) return null;
  for (const c of brut) if (!ALPHABET.includes(c)) return null;
  return brut;
}

export function formaterCode(canonique) {
  return String(canonique).match(/.{1,4}/g)?.join('-') || '';
}

/** Identifiant envoyé au serveur : base64url(SHA-256(« castunn-salle: » + code)), 43 caractères. */
export async function identifiantSalle(code, subtle = globalThis.crypto?.subtle) {
  const canonique = normaliserCode(code);
  if (!canonique) throw new Error('code de salle invalide');
  if (!subtle) throw new Error('chiffrement indisponible (page non sécurisée)');
  const empreinte = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(`castunn-salle:${canonique}`)));
  let binaire = '';
  for (const o of empreinte) binaire += String.fromCharCode(o);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
