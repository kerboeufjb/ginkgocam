# GinkgoCam

Savoir si Ginkgo aboie vraiment quand JB est au travail, le voir en direct et lui parler.
Appli web perso, gratuite, sans abonnement, sans compte à créer (sauf l'hébergement).

## Comment ça marche

```
VIEUX TÉLÉPHONE (maison)                                IPHONE DE JB
home.html                                               view.html
 ├ caméra + micro (navigateur)
 ├ YAMNet (IA Google, tourne SUR le téléphone) ──► « Aboiement 82 % » / « Choc sourd » / « Sonnette »
 ├ 2 détections chien en 2 s → épisode
 │   ├ clip vidéo (MP4/WebM) dans le téléphone
 │   └ notification ─────────── ntfy.sh ───────────► appli ntfy → tap → view.html
 ├ journal du jour (aboiements + autres sons forts)
 └ PeerJS / WebRTC ◄═════ direct chiffré de bout en bout ═════► vidéo, son, micro, caméra de JB,
                                                                 journal, clips, pause à distance
 └ 23 h : tout est effacé
```

- **Ballon qui tombe** : YAMNet le classe en « Choc sourd » / « Rebond », il est noté dans le journal mais **ne déclenche aucune notification**. Seules les classes chien (aboiement, jappement, hurlement, grognement, gémissement) comptent.
- **Chien du voisin dehors** : filtré par le volume minimum (réglage « Volume minimum (dB) »).
- **Rien ne sort de chez toi** sauf la notification texte (« Ginkgo aboie à 10:42 »). Les vidéos restent dans le téléphone maison et ne passent que par la liaison directe chiffrée quand tu les demandes.
- **Sécurité** : l'appairage (identifiant + clé de 32 caractères) passe par un QR code ; sans la clé, la station refuse la connexion.

## La pipeline, étape par étape

| # | Étape | État |
|---|---|---|
| 1 | Station maison : caméra, micro, détection aboiements, clips, journal, purge du soir, horaires | ✅ fait, testé en local |
| 2 | Vue iPhone : direct, parler à Ginkgo, se montrer, journal, clips, graphique par heure | ✅ fait, testé en local |
| 3 | Notifications ntfy avec lien vers le direct | ✅ fait (envoi testé) |
| 4 | **Mettre en ligne en https** (obligatoire pour la caméra sur téléphone) — GitHub Pages | ⏳ à faire |
| 5 | Installer : vieux téléphone (station) + iPhone (ntfy + appairage QR) | ⏳ à faire chez toi |
| 6 | Calibrer 1–2 jours : sensibilité, volume mini, vérifier les faux positifs | ⏳ |
| 7 | Si le direct ne passe pas en 4G : ajouter un relais TURN gratuit (Cloudflare ou Metered) dans Réglages › Avancé | ⏳ si besoin |
| 8 | Bonus possibles : rapport du soir dans Paolo, phrase pré-enregistrée « Ginkgo, panier ! » envoyée d'un bouton | 💡 idées |

## Installation (étape 5)

**Téléphone maison** (vieil iPhone ou Android) :
1. Ouvrir l'adresse en ligne dans Safari / Chrome → **Station maison**.
2. Réglages : horaires de travail, jours, heure d'effacement.
3. Le poser **branché**, écran face à la pièce (la caméra avant filme, Ginkgo voit ton visage quand tu appelles).
4. **Démarrer la surveillance**, autoriser caméra et micro.
5. Verrouiller l'appli au premier plan : iPhone → Réglages › Accessibilité › **Accès guidé** ; Android → **Épingler l'écran**. L'écran passe en noir après 1 min (veille), mais l'appli reste active.
6. Désactiver le verrouillage auto si besoin (iPhone : Réglages › Luminosité › Verrouillage auto › Jamais).

**iPhone de JB** :
1. Installer **ntfy** (App Store, gratuit), s'abonner au sujet affiché dans « Appairer mon iPhone ».
2. Scanner le QR code avec l'appareil photo, ouvrir dans **Safari**.
3. Une fois la page appairée ouverte : Partager › **Sur l'écran d'accueil**. L'icône garde l'appairage dans son adresse (`view.html#p=…`) : plus jamais de QR code à rescanner, même si Safari vide sa mémoire.
4. Toucher « Envoyer une notif de test » sur la station pour vérifier.

> L'appairage est gardé à la fois dans l'adresse de la page et dans la mémoire du navigateur. Ne partage ni cette adresse ni une capture de la barre d'adresse : c'est la clé de la caméra.

## Limites connues (honnêtes)

- La station doit rester **au premier plan, écran allumé** : un navigateur coupe le micro en arrière-plan. Le journal note chaque passage en arrière-plan pour que tu saches s'il y a eu un trou.
- Pas de « pré-enregistrement » : le clip commence ~1 s après le premier aboiement.
- En 4G, certains opérateurs bloquent la liaison directe → étape 7 (relais TURN).
- Le serveur public PeerJS (mise en relation) et ntfy.sh sont des services gratuits tiers : s'ils tombent, la détection et les clips continuent, seul l'accès à distance est coupé.
- Filmer chez soi est permis ; si quelqu'un d'autre entre (ménage, propriétaire, visite), il faut l'en informer.

## Tester en local

```powershell
cd "$HOME\Documents\GinkgoCam"; python -m http.server 8765
```
Puis http://localhost:8765 (la caméra marche en localhost ; sur un autre appareil, il faut le https de l'étape 4).

## Fichiers

- `home.html` / `home.js` — station maison
- `view.html` / `view.js` — vue iPhone
- `common.js` — classes de sons, réglages par défaut, appairage
- `style.css`, `icon.svg`, `manifest.webmanifest`

Bibliothèques (CDN, versions figées) : MediaPipe Tasks Audio 0.10.14 + modèle YAMNet, PeerJS 1.5.4, qrcode-generator 1.4.4.
