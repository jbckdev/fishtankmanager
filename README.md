# FishTankManager 🐠

Application web pour gérer son aquarium au quotidien : **éclairage Juwel HeliaLux SmartControl**, population, plantes, entretien, et une **simulation 3D** du bac qui suit le programme lumineux.

Elle remplace l'interface web d'origine du HeliaLux SmartControl, peu pratique, par une interface moderne utilisable sur ordinateur et sur téléphone.

> Projet personnel, non officiel, sans lien avec Juwel. Utilisation à vos risques.

## Fonctionnalités

### Accueil : tableau de bord
- Lumière en direct (heure du contrôleur, programme actif, niveau de chaque canal) et raccourcis en un clic.
- Tâches à faire : changement d'eau, filtre, tests, avec « fait » en un clic.
- Alertes de compatibilité et des derniers tests d'eau.
- Courbes des derniers paramètres et résumé de la population.

### Lumière (HeliaLux SmartControl)
- **Direct** : état réel de la lampe, courbe du jour, statistiques de photopériode (avec alerte algues), contrôle manuel, simulation d'une heure.
- **Raccourcis** : Nourrissage, Entretien, Photo, Clair de lune. La lampe revient seule au programme.
- **Programmes** : éditeur graphique des 8 profils :
  - glisser-déposer des points, par canal ou sur tous les canaux à la fois ;
  - nuages, annuler/rétablir, transitions adoucies ;
  - assistant « journée » (lever et coucher progressifs, pause de midi, veilleuse) ;
  - comparaison entre profils, modèles Juwel, aperçu en direct sur la lampe.
- **Semaine** : un profil par jour, avec application rapide à la semaine ou au week-end.
- **Simulation 3D** :
  - bac planté rendu avec Three.js, poissons en banc qui réagissent à la lumière (actifs le jour, au repos la nuit, effrayés par les changements brusques), plantes qui « perlent » ;
  - lecture accélérée (jusqu'à 1 h/s), timeline, mode en direct ;
  - option « Reproduire sur la lampe » : la vraie lampe suit la simulation.

### Mon bac
- Fiche du bac : volume, dimensions, mise en eau, matériel.
- Population : catalogue indicatif de **127 espèces** (poissons, crevettes, escargots) classées par famille, avec nombre et livrée.
- Plantes (**56**, avec besoins en lumière et CO₂) et décor.
- **Compatibilité** :
  - plage commune de température, pH et dureté ;
  - taille des bancs, prédation, poissons qui mordillent les nageoires, mangeurs d'escargots ou de plantes ;
  - longueur du bac et charge (environ 1 cm de poisson adulte par litre).
- La simulation 3D reprend la population (néons, scalaires et leur livrée, corydoras, apistogrammas).

### Entretien
- Carnet : changements d'eau, tests (pH, GH, KH, NO₂, NO₃, NH₄, température), filtre, engrais, taille…
- Courbes des paramètres avec zone conseillée, rappels réglables, pastille de retard.

### Réglages
- Adresse IP du contrôleur, testée avant d'être enregistrée.
- Heure du contrôleur comparée à celle de l'appareil, avec suggestion du bon fuseau horaire. Fuseau et synchronisation NTP modifiables.
- Informations sur l'appareil et le réseau, en lecture seule.
- Sauvegarde et restauration des 8 profils et de la semaine (JSON).

## Prérequis

- **Node.js 18 ou plus récent**.
- Un **Juwel HeliaLux SmartControl** connecté au même réseau local. Sans contrôleur, les espaces Mon bac et Entretien restent utilisables.
- Une connexion Internet pour la simulation 3D (la bibliothèque Three.js est chargée depuis jsDelivr).

## Installation

```bash
git clone https://github.com/jbckdev/fishtankmanager.git
cd fishtankmanager
npm start
```

Ouvrir ensuite http://localhost:8080, puis renseigner l'adresse IP du contrôleur dans **Réglages → Contrôleur HeliaLux**. On la trouve dans l'interface de la box internet, ou dans l'appli Juwel.

Le serveur n'a besoin d'aucune dépendance. `npm install` sert uniquement à l'outil d'optimisation des modèles 3D (voir plus bas).

### Options de lancement

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port de l'application | `8080` |
| `HELIALUX` | Adresse du contrôleur, prioritaire sur celle des Réglages | — |

```bash
HELIALUX=192.168.1.50 PORT=3000 npm start
```

### Sur le téléphone

Ouvrir `http://<ip-de-l-ordinateur>:8080` depuis un téléphone connecté au même WiFi.
- **iPhone** : Safari → Partager → « Sur l'écran d'accueil » pour l'installer comme une appli.
- **Android** : Chrome → ⋮ → « Ajouter à l'écran d'accueil ». L'installation complète en plein écran demande du HTTPS.

Les raccourcis existent aussi en lien direct, utilisables par exemple dans l'appli Raccourcis d'iOS : `/?raccourci=nourrissage` (ou `entretien`, `photo`, `lune`).

L'ordinateur qui fait tourner le serveur doit rester allumé.

## Modèles 3D réels (facultatif)

Sans modèles, la simulation génère elle-même poissons, plantes et décor. Pour un rendu plus réaliste, on peut ajouter des modèles 3D gratuits. Ils ne sont **pas inclus dans le dépôt**, car leurs licences n'autorisent pas toutes la redistribution.

1. Télécharger les modèles au format **GLB** (ou glTF) et les déposer dans `public/models/` sous ces noms :

   | Nom du fichier | Modèle suggéré | Licence |
   |---|---|---|
   | `neon.glb` | [Paracheirodon Innesi – Tetra Neon](https://sketchfab.com/models/2fabf5db754746b7b81ebfa0bbe99161) (BlueMesh) | CC BY |
   | `scalaire.glb` | [Freshwater Angelfish](https://sketchfab.com/models/37475fc6c8904b6bbf7e27617bd851b8) (monte-hotate), version 2k | Sketchfab Free Standard |
   | `corydoras.glb` | [Bronze Corydora](https://sketchfab.com/models/80db835f3bb7420aae1763c4f52122e8) (chuajop) | CC BY |
   | `anubias.glb` | [Plants Anubias](https://sketchfab.com/models/2ba1d06a191b437e848b81b2981a9e02) (Pala_002) | CC BY |
   | `plantes.glb` | [Aquariumplants (Java Fern, Vallisneria…)](https://sketchfab.com/models/f34fac656a364f8eaeab0918179d6df6) (Nullifiedit) | CC BY |
   | `bois.glb` | [Real Aquarium Wood 3D scan](https://sketchfab.com/models/c53807eff7c4427faacfde6c1b581532) (zdenkoroman) | CC BY |
   | `root_cluster.glb` | [Root Cluster 01](https://polyhaven.com/a/root_cluster_01) (Poly Haven) | CC0 |

   On peut aussi déposer le dossier dézippé d'un export Sketchfab, renommé `<nom>/` (avec son `scene.gltf` dedans).

2. Optimiser les modèles (compression meshopt, textures WebP) :

   ```bash
   npm install
   npm run models
   ```

Les modèles optimisés sont placés dans `public/models/opt/` et utilisés automatiquement. Les auteurs sont crédités dans **Réglages → Crédits des modèles 3D**.

## Fonctionnement

```
Navigateur (ordinateur, téléphone)  ──▶  server.js (Node, aucune dépendance)  ──▶  HeliaLux SmartControl
                                           │
                                           └─ data/aquarium.json, data/config.json
```

Le contrôleur n'envoie pas d'en-têtes CORS et gère mal les requêtes simultanées. `server.js` sert l'interface, relaie les appels vers le contrôleur un par un et enregistre les données du bac.

API du contrôleur utilisée (reconstituée à partir de son interface web) :

| Appel | Rôle |
|---|---|
| `POST /stat action=10` | État : heure, canaux, modes |
| `POST /stat action=11-15` | Simulation horaire, mode manuel |
| `POST /color action=1` | Couleur manuelle |
| `POST /color action=20/5/21` | Aperçu dans l'éditeur |
| `POST /profedit.html profNum=N`, puis `GET /profeditvars.js` | Lire le profil N |
| `POST /pedit action=30` | Enregistrer le profil sélectionné |
| `GET /wpvars.js`, `POST /week.html` | Programme de la semaine |
| `GET /setvars.js`, `POST /setting.html` | Réglages (fuseau, NTP) |

Les réglages sont enregistrés en rejouant le formulaire d'origine à l'identique. Les mots de passe WiFi sont relus sur le contrôleur et ne passent jamais par le navigateur. Le réseau du contrôleur n'est jamais modifié.

### Données

Tout est enregistré localement dans `data/`, exclu du dépôt :
- `aquarium.json` : fiche du bac, population, plantes, décor, carnet d'entretien ;
- `config.json` : adresse du contrôleur.

Pensez à sauvegarder ce dossier.

## Structure du projet

```
server.js                  Serveur : interface, relais vers le contrôleur, données
public/index.html          Application (interface, logique)
public/catalogue.js        Catalogue des espèces, plantes et types de décor
public/sim3d.js            Simulation 3D (Three.js)
public/manifest.webmanifest, icônes   Installation sur téléphone (PWA)
scripts/optimize-models.js Optimisation des modèles 3D (npm run models)
scripts/make-icons.js      Génération des icônes
```

## Limites

- Les valeurs du catalogue (température, pH, taille, groupe…) sont **indicatives** : ce sont des moyennes des fiches aquariophiles courantes.
- Testé avec un **HeliaLux Spectrum 4 canaux** (firmware V2.0.0). Les lampes 2 canaux et 2×2 canaux sont prévues, mais n'ont pas été testées.
- La simulation 3D reste stylisée : elle ne représente fidèlement que quelques familles (néons, scalaires, corydoras, apistogrammas).

## Crédits

- Rendu 3D : [Three.js](https://threejs.org/).
- Modèles 3D facultatifs : voir le tableau ci-dessus (Sketchfab, Poly Haven).
