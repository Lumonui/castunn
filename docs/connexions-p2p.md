# Connexions entre pairs : direct, relais, WebSocket

Castunn tente, dans cet ordre :

1. **le direct** — sur le réseau local, ou à travers les NAT grâce à STUN ;
2. **le relais TURN**, si le serveur de signalisation en annonce un ;
3. **le WebSocket**, en dernier recours, comme avant.

ICE essaie seul le direct puis le relais ; le repli WebSocket joue dès que le
canal P2P n'est pas ouvert. Le partage d'écran et la diffusion de flux exigent
le P2P : sans lui, le message d'erreur dit si un relais existait.

## Ce qui a été fait

| Étape | En bref |
|---|---|
| A1 | Les candidats ICE arrivés trop tôt attendent au lieu d'être jetés ; plus d'échec silencieux. |
| A2 | Négociation « perfect negotiation » : une seule fabrique d'offres, les collisions ne détruisent plus la connexion, `restartIce()` a enfin un effet. |
| A3 | Après un échec, un seul des deux pairs relance. |
| A4 | Deux STUN indépendants (Google, Cloudflare). |
| A5 | Plage UDP fixe 26100-26159 (`webrtc-ports.js`), vérifiée au démarrage. |
| A6 | Ouverture automatique sur la box (UPnP-IGD, puis NAT-PMP), par fenêtres de 12 ports : une par machine au départ, une de plus quand elle se remplit, 60 ports au plus ; case dans les Paramètres ; aucun port fantôme. |
| A7 | Chemin journalisé (`[RTC] chemin : host ↔ srflx…`) ; pastille verte en direct, jaune-orangé « Connecté (dégradé) » par relais. |
| B1 | Le serveur annonce un relais TURN avec des identifiants temporaires (`TURN_URLS`, `TURN_SECRET`). |
| B2 | Le client l'utilise, renouvelle ses identifiants avant échéance, s'en passe s'il est mal formé. |
| B3 | Sonde au démarrage : `[TURN] disponible` ou la raison de l'échec. |
| B4 | Repli WebSocket conservé ; messages d'absence de P2P qui disent si un relais existait. |
| B6 | Modes de test : relais forcé, RTC désactivé. |

Installation d'un relais : `relais-turn.md`.

## Ce qui n'a pas été fait

- **B5, sécurité** (limites de débit, quotas, client malveillant) : traité à part.
  Le minimum vital côté coturn (refus de relayer vers des adresses privées)
  figure déjà dans le guide.
- **PCP** et **ouvertures IPv6 sur la box** (WANIPv6FirewallControl) : gain
  négligeable, l'un faute de serveurs PCP chez les opérateurs, l'autre parce
  qu'ICE ouvre déjà le pare-feu IPv6 en émettant des deux côtés à la fois.
- **Relais servi par un Cloudflare Worker** : un Worker ne peut pas héberger de
  TURN (pas d'UDP). Le point d'extension est décrit dans `server.js` ; le
  projet ne contient d'ailleurs pas de Worker.
- Aucune API Electron n'a manqué : `setWebRTCUDPPortRange` et
  `setWebRTCIPHandlingPolicy` existent dans la version du projet (31).

## Tester chaque étage

Les modes de test se règlent par variables d'environnement sous Electron (on
ne tape pas d'URL dans une application), ou par paramètres d'URL quand la page
est servie par un navigateur. Ils sont toujours annoncés dans la console
(`[TEST] …`) : un mode oublié ne passe pas inaperçu.

| Variable (Electron) | Paramètre d'URL | Effet |
|---|---|---|
| `CASTUNN_FORCE_RELAY=1` | `?forceRelay=1` | seules les connexions par relais sont tentées |
| `CASTUNN_SANS_RTC=1` | `?rtc=off` | aucune connexion P2P : tout passe par le WebSocket |

En PowerShell, depuis le dossier du projet :

```powershell
$env:CASTUNN_FORCE_RELAY = '1'; npm start
```

Remettre à zéro avec `Remove-Item Env:CASTUNN_FORCE_RELAY`.

### Direct

Deux Castunn reliés au même serveur.
- Console : `[RTC] chemin : host ↔ host` sur le même réseau, `srflx` à
  travers Internet. Pastille **Connecté** en vert.
- Un envoi d'URL est accusé « (URL via RTC) ».
- Automatique : `npm run test:rtc`.

### Ouverture de ports (UPnP / NAT-PMP)

- Console : `UPnP : ports 26100-26111 ouverts`, ou la raison d'un échec.
  Une seconde machine du foyer prend la fenêtre suivante (`26112-26123`).
- Interface de la box : douze redirections UDP décrites « Castunn » par
  machine ; décocher la case des Paramètres, ou quitter Castunn, les supprime.
- Agrandissement : au-delà d'une dizaine de connexions simultanées sur une
  machine, la console affiche `UPnP : ports 26100-26123 ouverts` ; quand elles
  se ferment, la fenêtre ajoutée est rendue (contrôle toutes les 5 s).
  Fenêtre suivante prise : `[UPnP] ports … déjà redirigés ailleurs` dans le
  terminal, et les connexions en plus passent par STUN ou le relais.
- Automatique : `npm run test:nat` (contre de faux routeurs, sans toucher à la
  vraie box).

### Essaim (fichiers à plusieurs)

Trois Castunn ou plus, reliés en P2P (pastille `2/2`, `3/3`…).
- Émetteur : `Envoi de film.mp4 : 2 par essaim`, puis `Envoi terminé … — les
  récepteurs de l’essaim finissent entre eux`.
- Récepteurs : `[essaim] réception de film.mp4 (… Mo) — émis par …`, puis la
  vignette ; l'émetteur reçoit « Média reçu (essaim) ».
- L'émetteur n'envoie qu'environ une copie du fichier, quel que soit le nombre
  de récepteurs : ils se redistribuent les morceaux.
- Une ancienne version dans le groupe : la lancer avec `CASTUNN_SANS_ESSAIM=1`
  (ou `?essaim=off`) ; elle reçoit le fichier entier, `Envoi de … : 1 par
  essaim, 1 en P2P`.
- Automatique : `npm run test:essaim` (moteur, faux réseau) et
  `npm run test:mesh` (vraies pages, empreintes comparées).

### Lecture pendant le téléchargement

Une grosse vidéo envoyée à au moins un autre Castunn.
- Récepteur : `[essaim] lecture pendant le téléchargement : film.mp4` ; la
  vidéo démarre sans attendre la fin, et la barre de lecture permet d'aller
  plus loin (les morceaux voulus sont demandés en priorité).
- Dans un navigateur : seulement en https (ou sur localhost) ; en http sur le
  réseau local, la vidéo s'affiche une fois reçue, comme avant.
- Automatique : `npm run test:lecture` (vraie vidéo, application et service
  worker).

### Relais

Un serveur de signalisation configuré avec un relais (`relais-turn.md`), et
deux Castunn lancés avec `CASTUNN_FORCE_RELAY=1`.
- Console : `[TURN] disponible (…)`, puis `[RTC] chemin : relay ↔ relay`.
- Pastille **Connecté (dégradé)**, jaune-orangé ; l'infobulle nomme le chemin.
- Un envoi d'URL reste accusé « (URL via RTC) » : il traverse le relais.
- Sans relais annoncé, `CASTUNN_FORCE_RELAY=1` empêche toute connexion : c'est
  une simulation réaliste d'échec P2P.
- Automatique : `npm run test:turn` (vrai relais local `node-turn`).

### WebSocket

Deux Castunn lancés avec `CASTUNN_SANS_RTC=1`.
- Console : `[TEST] RTC désactivé (rtc=off)`, et les envois accusés
  « (URL via WS) ».
- Le partage d'écran refuse, avec la raison : pas de pair, pas de relais, ou
  relais injoignable.
- Automatique : `npm run test:turn` (dernier scénario).

`npm run test:all` enchaîne toutes les suites.
