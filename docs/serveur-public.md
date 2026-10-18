# Héberger le serveur de signalisation en public

`server.js` sert deux usages : le serveur local que lance l'application (réseau
de confiance), et un serveur public sur un hébergeur ou un VPS. Par défaut, il
se comporte en serveur public : tout client est présumé hostile.

## Déployer

- `server.js` **et** `package.json` côte à côte : le serveur y lit sa version,
  et refuse tout client d'une autre version. Sans `package.json`, il refuse de
  démarrer (ou définir `CASTUNN_VERSION`).
- Dépendances : `npm install --omit=dev` (express, ws).
- Toute modification de `server.js` exige un redéploiement.

## Réglages (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 8080 | port d'écoute |
| `CASTUNN_SALLE_LIBRE` | (absent) | `1` : la salle commune « default » est permise. **Jamais sur un serveur public** : sans elle, on ne rejoint une salle qu'avec son code. Le serveur local de l'application la pose. |
| `CASTUNN_MAX_CLIENTS` | 100 | personnes connectées à la fois |
| `CASTUNN_MAX_PAR_IP` | 10 | connexions simultanées par adresse IP |
| `CASTUNN_CONNEXIONS_PAR_MINUTE` | 10 | nouvelles connexions par minute et par adresse IP |
| `CASTUNN_DEBIT_MAX` | 1048576 | octets/s qu'un client peut envoyer (1 Mo/s) ; au-delà il est ralenti, pas coupé |
| `CASTUNN_MESSAGES_PAR_SECONDE` | 100 | messages/s d'un client (rafales de 300 permises) |
| `CASTUNN_PROXIES` | (absent) | adresses de reverse proxies dont on croit `X-Forwarded-For`, s'ils ne sont pas sur la même machine |
| `TURN_URLS`, `TURN_SECRET`, `TURN_TTL` | (absent) | relais TURN : voir `relais-turn.md` |

Le journal de démarrage récapitule le mode et les limites :
`[Castunn] v1.2.3 — salles privées seulement ; 100 clients au plus, 10 par IP…`

## Ce que fait le serveur contre les abus

- **Salles privées** : un client n'entre que dans la salle dont il a le code ;
  le serveur n'en voit que l'empreinte (43 caractères), impossible à deviner.
- **Rien ne circule hors d'une salle** : tant qu'un client n'y est pas entré,
  le serveur ne relaie rien de lui. La signalisation P2P et les messages
  adressés ne franchissent jamais une salle.
- **Personne ne parle au nom d'un autre** : l'émetteur de chaque message est
  imposé par le serveur ; le nom affiché dans le tchat est celui que les pairs
  connaissent, pas celui que l'émetteur prétend.
- **Relais TURN** : identifiants remis aux seuls membres d'une salle.
- **Adresse IP** : `X-Forwarded-For` n'est cru que d'un proxy local (ou listé),
  sinon un client choisirait son adresse et contournerait les limites.
- **Limites** : connexions par IP et par minute, total, débit et cadence par
  client ; message de 256 Kio au plus ; un destinataire lent ralentit
  l'émetteur au lieu de remplir la mémoire du serveur.
- **Robustesse** : une trame WebSocket invalide ferme la connexion fautive, et
  elle seule (dans les versions précédentes, elle arrêtait le serveur entier).

Refus côté client : « serveur plein » et « trop de connexions » s'affichent
dans un bandeau, avec un nouvel essai automatique après le délai indiqué par
le serveur ; une salle refusée demande un code dans les Paramètres.

## Ce qui n'est pas (encore) protégé

- **Le repli WebSocket n'est pas chiffré de bout en bout** : un fichier envoyé
  à un pair sans lien P2P passe en clair par le serveur (le transport, lui, est
  chiffré en `wss://`). Le code de salle pourra servir de clé.

Côté client, chaque morceau d'un fichier reçu par essaim est comparé à
l'empreinte SHA-256 donnée par son émetteur : un membre de la salle qui
relaierait un morceau faux est démasqué et n'est plus écouté pour ce fichier.
Exception : un navigateur en http (sans calcul d'empreintes), sur un réseau
de confiance.
