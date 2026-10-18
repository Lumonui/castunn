# Installer un relais TURN (coturn) pour Castunn

Le relais ne sert que lorsque la connexion directe échoue : réseaux mobiles,
réseaux d'entreprise, NAT symétriques. Il fait alors transiter **tout** le flux
entre les deux pairs : prévoir la bande passante du VPS en conséquence (un
partage d'écran consomme quelques Mbit/s dans chaque sens).

Le serveur de signalisation Castunn ne relaie rien lui-même : il distribue des
identifiants temporaires, calculés avec un secret partagé avec coturn. Le
secret ne quitte jamais les deux serveurs.

Exemple ci-dessous : Debian ou Ubuntu, nom de domaine `turn.exemple.fr` pointant
vers le VPS.

## 1. Installer

```bash
sudo apt install coturn certbot
openssl rand -hex 32        # le secret partagé : à garder pour l'étape 5
```

Sur les anciennes versions du paquet, activer le service dans
`/etc/default/coturn` (ligne `TURNSERVER_ENABLED=1`), si ce fichier existe.

## 2. Ouvrir les ports

| Port | Protocole | Rôle |
|---|---|---|
| 3478 | UDP + TCP | TURN classique |
| 443 | TCP | TURN sur TLS (`turns:`) — passe les pare-feu d'entreprise |
| 49152-65535 | UDP | ports relayés |
| 80 | TCP | renouvellement du certificat (certbot) |

```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 443/tcp
sudo ufw allow 49152:65535/udp
sudo ufw allow 80/tcp
```

Ouvrir aussi ces ports dans le pare-feu de l'hébergeur s'il en a un.
Si un serveur web occupe déjà le 443 de la machine, utiliser le 5349 à la
place (moins efficace contre les pare-feu d'entreprise), ou une seconde IP.

## 3. Certificat TLS

```bash
sudo certbot certonly --standalone -d turn.exemple.fr \
  --deploy-hook 'install -D -m 640 -o turnserver -g turnserver "$RENEWED_LINEAGE/fullchain.pem" /etc/coturn/certs/fullchain.pem && install -D -m 640 -o turnserver -g turnserver "$RENEWED_LINEAGE/privkey.pem" /etc/coturn/certs/privkey.pem && systemctl restart coturn'
```

Le crochet copie le certificat là où coturn (qui ne tourne pas en root) peut le
lire, et redémarre coturn. Il rejoue à chaque renouvellement.

## 4. Configurer coturn

`/etc/turnserver.conf` :

```ini
listening-port=3478
tls-listening-port=443
realm=turn.exemple.fr
server-name=turn.exemple.fr

# Machine derrière un NAT (AWS, GCP, certains hébergeurs) :
# external-ip=IP_PUBLIQUE/IP_PRIVEE

# Identifiants temporaires « TURN REST API » : le même secret que TURN_SECRET
use-auth-secret
static-auth-secret=LE_SECRET_DE_L_ETAPE_1

cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/certs/privkey.pem
no-tlsv1
no-tlsv1_1

min-port=49152
max-port=65535
fingerprint
no-cli
no-multicast-peers

# Ne jamais relayer vers des adresses privées : sans ces lignes, n'importe qui
# muni d'identifiants pourrait atteindre le réseau interne du VPS.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=240.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
no-loopback-peers

# Limites. Un « utilisateur » coturn est un participant Castunn (le nom
# d'utilisateur porte son identifiant) ; une « allocation », un lien P2P
# relayé.
#  - 1 Mo/s (8 Mbit/s) par lien relayé, chaque sens compté à part :
max-bps=1000000
#  - 12 liens relayés à la fois par participant :
user-quota=12
#  - 1 200 au total (100 participants × 12), et 800 Mbit/s pour tout le relais,
#    sous le 1 Gbit/s du VPS :
total-quota=1200
bps-capacity=100000000
# Un nonce périmé oblige à se réauthentifier : des identifiants volés servent moins longtemps.
stale-nonce=600
```

Ce que coturn ne sait pas faire : borner le débit **total** d'une personne.
`max-bps` vaut pour chaque lien relayé ; quelqu'un relayé vers trois pairs à
la fois peut donc atteindre 3 Mo/s (et 12 Mo/s au pire, avec `user-quota`). En
pratique, seuls les liens sans chemin direct passent par le relais : souvent
un ou deux par personne.

Écouter sur le port 443 demande un droit particulier à un service non root :

```bash
sudo systemctl edit coturn
```
```ini
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
```
```bash
sudo systemctl restart coturn
sudo systemctl status coturn
```

Les lignes `denied-peer-ip` ci-dessus sont le minimum à ne pas omettre. Côté
Castunn, le serveur de signalisation ne remet des identifiants qu'aux membres
d'une salle, jamais à un simple visiteur.

## 5. Brancher Castunn

Dans l'environnement du serveur de signalisation (configuration du site sur
l'hébergeur, rubrique des variables d'environnement), puis redémarrer le site :

```
TURN_URLS=turn:turn.exemple.fr:3478?transport=udp,turn:turn.exemple.fr:3478?transport=tcp,turns:turn.exemple.fr:443?transport=tcp
TURN_SECRET=LE_SECRET_DE_L_ETAPE_1
```

Facultatif : `TURN_TTL`, la durée de validité des identifiants en secondes
(6 h par défaut, entre 5 min et 48 h).

## 6. Vérifier

1. Journal du serveur de signalisation au démarrage :
   `[TURN] relais annoncé aux clients : turn:turn.exemple.fr:3478…`
2. Console de Castunn à la connexion :
   `[TURN] disponible (turn:…)`. En cas d'échec, la raison suit :
   `identifiants refusés (401)` signifie que les deux secrets diffèrent ;
   `serveur injoignable (701)`, un port fermé ou un nom de domaine erroné.
3. Connexion réellement relayée : lancer deux Castunn avec
   `CASTUNN_FORCE_RELAY=1` (voir `connexions-p2p.md`). La pastille doit
   afficher **Connecté (dégradé)**, et la console `[RTC] chemin : relay ↔ relay`.

**eturnal** convient aussi : il implémente le même mécanisme de secret partagé.
Ce guide ne couvre que coturn.
