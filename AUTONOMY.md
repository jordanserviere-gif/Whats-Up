# Mission autonome — intégrations de données externes

Tu travailles seul sur ce dépôt, sur plusieurs sessions, sans validation
intermédiaire. Ce document est ta seule source d'instructions. Lis-le en entier
avant d'agir, puis relis `AUTONOMY-STATE.md` à chaque reprise.

---

## 1. Objectif

Brancher six sources de données externes sur la webapp d'observation du ciel.
Ces sources sont des enrichissements : l'application doit rester utilisable et
lisible quand l'une d'elles est indisponible, lente ou périmée.

| # | Source | Rôle |
|---|--------|------|
| 1 | CelesTrak | TLE réels → propagation SGP4 des satellites existants |
| 2 | Open-Meteo | pression / température → réfraction, levers et couchers justes |
| 3 | Open-Meteo Air Quality | épaisseur optique en aérosols → coefficient d'extinction réel |
| 4 | JPL SBDB API | éléments osculateurs de comètes et astéroïdes |
| 5 | OpenNGC | catalogue du ciel profond, embarqué au build |
| 6 | SIMBAD (CDS) | recherche d'objet par nom, à la demande |

Ordre d'implémentation imposé : **5 → 1 → 2 → 3 → 4 → 6.**
On commence par OpenNGC parce qu'il suit un motif déjà en place (`npm run data`)
et ne demande aucune infrastructure nouvelle. SIMBAD arrive en dernier : c'est
celui dont le support navigateur est le plus incertain, et le plus facile à
abandonner sans dommage.

---

## 2. Règles non négociables

1. **Aucune source externe ne bloque le rendu.** Une requête lente ou en échec
   ne doit jamais empêcher la scène de s'afficher ni le temps de s'écouler. Les
   appels réseau restent hors du chemin critique et hors de `useFrame`.
2. **Dégradation propre.** Une source indisponible retombe sur la valeur
   standard actuelle, sans erreur bloquante ni dialogue modal. La provenance de
   chaque donnée (`mesuré` / `cache` / `défaut`) reste visible dans le panneau
   Réglages, avec l'heure de dernière récupération.
3. **Pas de backend.** Tout se fait côté client. Si une source exige un proxy,
   tu ne l'implémentes pas : tu la notes comme bloquée dans l'état d'avancement
   et tu passes à la suivante.
4. **Pas de clé d'API.** Aucune des six n'en demande. Si l'une se met à en
   exiger une, elle devient bloquée.
5. **Tokenisation.** Aucune couleur, durée, graisse ou rayon en dur. Tout passe
   par `src/styles/tokens/`. Cette règle vaut pour tout nouveau composant.
6. **La suite `npm run verify` ne régresse jamais.** Elle doit rester verte à
   chaque commit non préfixé `wip:`.
7. **Français partout** : interface, commentaires, messages de commit. Accents
   corrects, y compris dans les commentaires de code.
8. **Tu travailles sur une branche, jamais sur `main`**, et tu ne pousses pas
   sans avoir fait passer typecheck, verify et build.

---

## 3. Où tu es

Arborescence utile :

```
src/astro/       time · coords · bodies · photometry · kepler · satellite · catalog · types
src/scene/       sceneMath · SkyCanvas · CameraRig · Starfield · ConstellationLines
                 Grids · SkyDome · Bodies · Satellites · LabelLayer · useSceneColors
src/ui/          ~28 composants MD3 Expressive + index.ts (barrel)
src/features/    TimelineBar · LuminanceBand · SkyHud · ObjectsPanel
                 SatellitesPanel · SettingsPanel · MoonPhaseDial
src/data/        stars.json · constellations.json   ← générés, commités
scripts/         build-catalogs · gen-motion · gen-color · verify-astro · bench-luminance
```

Scripts npm : `dev` `build` `preview` `typecheck` `data` `motion` `color`
`tokens` `verify`

Invariants du modèle 3D à ne pas casser :

```
sceneDepth(d_km)        = 7,375 · log₁₀(d_km) − 11,19      (strictement croissante)
sceneRadiusForBody(r,d) = r · sceneDepth(d) / d            (diamètre apparent exact)
SKY_RADIUS = 200   DOME_RADIUS = 320   GROUND_RADIUS = 150
```

Le sol est une calotte à 150 : elle doit rester **plus proche que les étoiles**
(200) et **plus lointaine que le corps le plus éloigné** du système solaire
(~90). Tout nouvel objet doit se placer dans cet intervalle ou en respecter la
logique.

Constantes photométriques : `AIRGLOW_LUX = 2e-4`,
`EXTINCTION_COEFFICIENT = 0.28`, `POINT_BASE_SIZE_PX = 2.3`.

---

## 4. Protocole d'autonomie

### 4.1 Fichier d'état

Tu maintiens `AUTONOMY-STATE.md` à la racine. **Tu le mets à jour après chaque
changement commité**, avant toute autre action. C'est ce qui te permet de
reprendre après une perte de contexte ou une coupure.

Format imposé :

```markdown
# État d'avancement

Dernière mise à jour : 2026-08-17T14:32:00Z
Branche : feat/sources-externes
Dernier commit vert : a1b2c3d

## Étapes
- [x] 0. Reconnaissance des API (CORS, formes de réponse)
- [x] 5. OpenNGC — catalogue embarqué
- [ ] 1. CelesTrak + SGP4      ← EN COURS
- [ ] 2. Open-Meteo — réfraction
- [ ] 3. Open-Meteo Air Quality — extinction
- [ ] 4. JPL SBDB — petits corps
- [ ] 6. SIMBAD — recherche

## En cours : étape 1
Fait : couche cache IndexedDB, client CelesTrak, parsing GP JSON.
Reste : brancher satellite.js, basculer SatellitesPanel, vérifier un passage ISS.
Prochaine action concrète : créer src/astro/sgp4.ts

## Bloqué
- (rien pour l'instant)

## Décisions prises
- Cache IndexedDB via idb-keyval, TTL 6 h pour les TLE.
- Les éléments saisis à la main et les TLE cohabitent : champ `source` dans
  OrbitalElements ('manuel' | 'tle').

## Journal des vérifications
| Date | Événement testé | Lieu | Attendu | Obtenu | Verdict |
|------|-----------------|------|---------|--------|---------|
| ...  | ...             | ...  | ...     | ...    | ...     |
```

### 4.2 Reprise après limite de crédit

Si tu es interrompu par une limite d'usage, la session suivante doit repartir
sans intervention humaine. Deux mécanismes, à mettre en place **avant** de
commencer l'étape 5 :

**a) Boucle de relance.** Lance `/loop` sans intervalle (auto-cadencement) avec
pour consigne : *« Lis AUTONOMY.md et AUTONOMY-STATE.md, reprends à la
prochaine action concrète. »* Chaque réveil doit être **idempotent et bon
marché** : tu lis l'état, et s'il n'y a rien à faire ou si les crédits manquent
encore, tu replanifies sans rien consommer.

Attention : `ScheduleWakeup` est borné à une heure. Un reset de crédits est en
général plus long. Ton tick doit donc tolérer d'échouer plusieurs fois de suite
et se reprogrammer, plutôt que de supposer que le crédit est revenu.

Dans le meilleurs des cas, si tu as accès d'un manière ou d'une autre à l'heure de reset des crédits, relance a cette dite heure.

**b) Point de reprise propre.** Ne t'arrête jamais au milieu d'un fichier. Avant
toute action longue, écris dans l'état ce que tu t'apprêtes à faire. Si tu
reprends et que le dépôt est dans un état intermédiaire, `git status` et
`git diff` font foi — pas ta mémoire.

### 4.3 Commits — un point de reprise par changement

Commite **chaque changement cohérent**, pas chaque étape. Un fichier de cache
créé, un client d'API écrit, une conversion de repère corrigée, une section de
vérification ajoutée : autant de commits. Tu dois pouvoir revenir en arrière
d'un cran sans perdre une demi-journée de travail.

Avant chaque commit : `npm run typecheck`, `npm run verify`, `npm run build`.

Si un changement est réellement en cours et ne peut pas passer les trois, tu
commites quand même — préfixé `wip:` — pour garder le point de reprise. Ces
commits restent sur la branche et ne sont jamais fusionnés tels quels : tu les
regroupes une fois l'étape verte.

Note le SHA du dernier commit vert dans `AUTONOMY-STATE.md` à chaque fois. C'est
lui qui fait foi à la reprise, pas ta mémoire.

Messages en français, explicites sur le quoi et le pourquoi :

```
feat(sources): client CelesTrak avec cache IndexedDB

TTL 6 h, repli sur le cache périmé en cas d'échec réseau.
Format GP JSON, groupe 'stations' vérifié contre l'échantillon.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

## 5. Travail préalable obligatoire — étape 0

**Ne code rien avant d'avoir fait ça.** Toutes les informations ci-dessous sur
les API sont issues de ma connaissance et peuvent être périmées ou fausses.
Vérifie chaque point et consigne le résultat dans l'état d'avancement.

Pour chacune des six sources :

1. Fais une vraie requête (curl, puis depuis le navigateur) et **enregistre un
   échantillon de réponse** dans `scripts/.cache/samples/`.
2. **Teste le CORS explicitement** depuis une page servie par `npm run dev`, pas
   seulement en curl — curl ignore CORS et te donnerait un faux positif.
3. Note la forme réelle de la réponse : noms de champs, unités, valeurs
   manquantes. Ne code pas contre ma description, code contre l'échantillon.
4. Note les conditions d'usage : limites de débit, obligation de cache,
   attribution à afficher.

Points de départ (**à confirmer**) :

- CelesTrak : `https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json`
  Demande explicitement la mise en cache. Groupes utiles : `stations`,
  `visual`, `starlink`, `gps-ops`, `active`.
- Open-Meteo : `https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&current=surface_pressure,temperature_2m`
- Open-Meteo Air Quality : `https://air-quality-api.open-meteo.com/v1/air-quality?…&hourly=aerosol_optical_depth`
- JPL SBDB : `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=Ceres&full-prec=true`
- OpenNGC : dépôt GitHub, CSV. **Téléchargé au build, jamais à l'exécution.**
- SIMBAD : service TAP du CDS, requêtes ADQL. C'est le plus douteux côté
  navigateur — si le CORS bloque, marque bloqué et passe.

Si une source échoue à l'étape 0, **tu ne la contournes pas par un proxy**. Tu
la notes bloquée avec la raison exacte et tu continues.

---

## 6. Architecture à mettre en place une seule fois

Avant l'étape 5, crée la couche commune. Toutes les intégrations passent par
elle.

```
src/data-sources/
  cache.ts        IndexedDB : { clé, charge, récupéréLe, expireLe }
  fetchJson.ts    fetch + délai d'expiration + réessai + repli sur cache périmé
  types.ts
  celestrak.ts    (étape 1)
  meteo.ts        (étapes 2 et 3)
  sbdb.ts         (étape 4)
  simbad.ts       (étape 6)
```

Contrat de `fetchJson` :

- délai d'expiration explicite (5 s) ;
- au succès, écrit en cache avec un TTL ;
- à l'échec, **renvoie le cache même périmé** si présent, en signalant sa
  fraîcheur ;
- si rien en cache, renvoie `null` — jamais une exception qui remonte à l'UI.

Chaque consommateur expose l'origine de la donnée : `'mesuré' | 'cache' |
'défaut'`. Le panneau Réglages affiche cette provenance, avec l'heure de la
dernière récupération. C'est ce qui rend la dégradation lisible plutôt que
mystérieuse.

---

## 7. Les six étapes

### Étape 5 — OpenNGC (à faire en premier)

Étends `scripts/build-catalogs.mjs`. Produis `src/data/deepsky.json` :
identifiant, nom courant, type, RA/Dec J2000, magnitude, dimensions apparentes.
Filtre à la magnitude 12 pour rester raisonnable.

Rendu : nouveau calque `deepSky` dans `LayerVisibility`. Les objets étendus se
dessinent à `SKY_RADIUS` comme les étoiles, en ellipse à leur taille apparente
réelle — cohérent avec le parti pris du projet. Ils obéissent à la magnitude
limite issue de `photometry.ts` : invisibles de jour, révélés la nuit.

Si les fichiers embarqués dépassent ~500 kB, passe en tableaux typés binaires
plutôt qu'en JSON : le parse devient le coût dominant bien avant le transfert.

### Étape 1 — CelesTrak + SGP4

Installe `satellite.js`. Crée `src/astro/sgp4.ts` avec **la même signature** que
`propagate()` de `kepler.ts`, pour que la couche scène ne change pas.

`OrbitalElements` gagne un champ `source: 'manuel' | 'tle'`. L'éditeur manuel
reste : il sert à explorer des familles d'orbites, ce que les TLE ne permettent
pas. Les objets réels passent par SGP4.

Attention : SGP4 travaille en TEME, pas dans l'équatorial de la date utilisé par
`observerEci()`. **La conversion TEME → équatorial de la date est le piège
principal de cette étape.** Un oubli donne une erreur de quelques dixièmes de
degré, assez pour rater un passage sans que rien n'ait l'air faux.

TTL du cache : 6 h. Au-delà de 3 jours, avertis que le TLE est vieux.

### Étape 2 — Réfraction réelle

`A.Horizon(..., 'normal')` suppose une atmosphère standard. Avec pression et
température locales, la réfraction près de l'horizon bouge de plusieurs minutes
d'arc, ce qui déplace directement les heures de lever et de coucher.

Formule de Bennett corrigée : `R × (P/1010) × (283/(273+T))`. Applique-la dans
`coords.ts`, avec les valeurs standard par défaut.

### Étape 3 — Extinction réelle

Remplace la constante `EXTINCTION_COEFFICIENT` par une valeur dérivée de
l'épaisseur optique en aérosols, avec 0,28 comme repli. Cela affecte l'éclat de
tout ce qui approche l'horizon, dans `Starfield.tsx` comme dans `Bodies.tsx`.

Pense à réviser la **pollution lumineuse** dans le même mouvement si tu en as le
temps : `AIRGLOW_LUX = 2e-4` correspond à un site noir. Sous un ciel urbain, la
magnitude limite réelle est plutôt 3–4 que 6,6 — l'application est aujourd'hui
optimiste de plusieurs magnitudes en ville. Il n'existe pas de bonne API gratuite
point-à-point ; un raster VIIRS grossier embarqué serait la voie propre. **Si
c'est trop long, note-le comme suite possible et n'entame pas.**

### Étape 4 — Petits corps

La machinerie képlérienne existe déjà pour les satellites. La transposer en
héliocentrique donne comètes et astéroïdes presque gratuitement — mais attention,
`kepler.ts` est écrit autour de `EARTH_MU`. Généralise le paramètre
gravitationnel plutôt que de dupliquer le code.

Magnitude : formule H-G pour les astéroïdes, formule à deux composantes pour les
comètes. Ces objets doivent passer par la même loi photométrique que les étoiles
et les planètes.

### Étape 6 — SIMBAD

Recherche par nom dans une barre de recherche MD3. Si le CORS bloque, abandonne
proprement : cette étape est facultative.

---

## 8. Protocole de vérification

C'est le cœur de la mission. **Une étape n'est pas terminée tant qu'elle n'a pas
été vérifiée sur un phénomène réel, à la date et au lieu réels.**

### 8.1 Rendre l'UI testable

Premier travail de vérification : ajouter des paramètres d'URL au démarrage.

```
?t=2026-08-12T18:27:00Z&lat=43.3619&lon=-5.8494&alt=232&az=250&h=45&fov=10
```

Sans ça, tu ne peux pas vérifier de façon reproductible. C'est aussi une vraie
fonctionnalité : partager une vue du ciel par lien.

### 8.2 Comment vérifier

Deux niveaux, les deux obligatoires :

**Numérique** — étends `scripts/verify-astro.mjs`. C'est là que vivent les
assertions dures et rejouables. Chaque étape ajoute sa section.

**Visuel** — pilote un navigateur sans affichage (Playwright), navigue vers
l'URL du phénomène, prends une capture dans `verification/`, et **regarde-la
vraiment**. Une assertion numérique verte n'exclut pas un rendu cassé : le
projet a déjà eu le cas d'une géométrie correcte affichée dans le mauvais ordre
de profondeur.

Consigne chaque vérification dans le tableau du fichier d'état.

### 8.3 Événements de contrôle

> **Toutes les valeurs ci-dessous sont approximatives et de mémoire.** Tu dois
> les confronter à une source autoritative avant d'en faire une assertion.
> **JPL Horizons** (`https://ssd.jpl.nasa.gov/api/horizons.api`, gratuit, sans
> clé) est la référence. Ne code jamais une valeur attendue tirée de ce
> document sans l'avoir recoupée.

**Déjà couvert par la suite existante — ne doit jamais régresser :**

| Événement | Lieu | Attendu |
|---|---|---|
| Éclipse totale 12/08/2026 | Reykjavík 64,147 N / −21,943 | 100 %, max ~17:49 UTC, 64 575 lx → 32 lx |
| Éclipse totale 12/08/2026 | Oviedo 43,362 N / −5,849 | 100 %, max ~18:27 UTC |
| Éclipse partielle 12/08/2026 | Paris | ~92 %, max ~18:17 UTC |

**Pour la réfraction (étape 2)** — l'effet est maximal à l'horizon :

- Lever et coucher du Soleil, jour d'équinoxe, à une latitude moyenne : compare
  avec et sans pression réelle, l'écart attendu se chiffre en minutes.
- Soleil de minuit à Tromsø (69,65 N) autour du solstice de juin : le Soleil ne
  doit jamais passer sous l'horizon.
- Nuit polaire à la même latitude en décembre.
- Un site en altitude (Pic du Midi, 2 877 m — déjà dans les lieux prédéfinis)
  contre un site au niveau de la mer.

**Pour la géométrie et les tailles :**

- Périgée et apogée lunaires : diamètre apparent d'environ 33,5′ contre 29,4′.
- Périhélie (début janvier) et aphélie (début juillet) : diamètre solaire
  d'environ 32,5′ contre 31,5′.
- Grande conjonction Jupiter–Saturne du 21 décembre 2020 : séparation de
  l'ordre de 6′. Excellent test de l'ordre de profondeur — Jupiter doit être
  devant Saturne.
- Transit de Vénus du 6 juin 2012 et transit de Mercure du 11 novembre 2019 :
  le disque planétaire doit passer **devant** le disque solaire. C'est le test
  d'occultation le plus exigeant du lot.
- Éclipse totale de Lune : la Lune doit rester visible et rougir. Vérifie au
  passage que ton modèle photométrique ne la fait pas disparaître.

**Pour les satellites (étape 1) :**

- Récupère le TLE de l'ISS, calcule les passages des 48 heures à venir, compare
  avec une source de référence (Heavens-Above ou l'API de repérage de la NASA).
  Tolérance : moins d'une minute sur l'heure du passage, moins de deux degrés
  sur la hauteur au maximum. Si tu dérives davantage, c'est très probablement
  la conversion TEME.
- Un géostationnaire doit rester immobile en azimut et hauteur sur 24 h.
- Une héliosynchrone doit repasser à la même heure solaire locale.
- Vérifie l'entrée en ombre : un satellite qui traverse le cône d'ombre doit
  changer de couleur sur la trace.

**Pour les petits corps (étape 4) :**

- Cérès et Vesta à l'opposition : position et magnitude contre Horizons.
- Une comète brillante récente, si tu en trouves une aux éléments encore
  valides dans SBDB. Attention : les éléments cométaires ont une époque, et une
  comète propagée loin de son époque diverge.

**Pour le ciel profond (étape 5) :**

- M42 : environ 05h35m17s, −05°23′. M31 : environ 00h42m44s, +41°16′.
  M13 : environ 16h41m41s, +36°28′. Recoupe avec SIMBAD ou OpenNGC lui-même.
- Vérifie qu'un objet étendu a la bonne taille apparente : M31 fait environ 3°
  de long, soit six fois la Lune. Si M31 apparaît comme un point, le rendu des
  objets étendus est faux.

### 8.4 Critère d'arrêt d'une étape

- `npm run typecheck` sans erreur
- `npm run verify` entièrement vert, sections nouvelles comprises
- `npm run build` réussi
- au moins une vérification visuelle par capture, regardée
- fichier d'état à jour
- l'étape est regroupée en commits propres, le SHA du dernier commit vert est
  noté dans le fichier d'état

---

## 9. Pièges connus

- **CORS** : curl ne le teste pas. Toujours vérifier depuis le navigateur.
- **TEME contre équatorial de la date** : le piège de l'étape 1.
- **Époques** : TLE, éléments cométaires et éléments planétaires ont chacun leur
  époque de référence. Propager loin de l'époque diverge silencieusement.
- **Unités** : SBDB donne les demi-grands axes en unités astronomiques, `kepler.ts`
  travaille en kilomètres. CelesTrak donne un mouvement moyen en tours par jour.
- **Double comptage photométrique** : cette erreur a déjà été commise une fois
  entre le terme solaire et l'airglow. Toute nouvelle contribution lumineuse
  doit être vérifiée en pleine nuit contre le plancher.
- **Ordre de profondeur** : tout nouvel objet doit se placer correctement entre
  le sol (150) et les étoiles (200), ou dans la plage du système solaire.
- **Cadence de recalcul** : les éphémérides tournent à 10 Hz, le rendu à la
  fréquence de l'écran. N'introduis pas d'appel réseau ni de calcul lourd dans
  `useFrame`.

---

## 10. Quand t'arrêter et demander

Tu t'arrêtes et tu écris la question dans le fichier d'état, section `Bloqué`,
si et seulement si :

- une source exige un proxy ou une clé (tu ne l'implémentes pas, tu notes) ;
- une vérification échoue de façon reproductible et tu as épuisé tes
  hypothèses ;
- une intégration exigerait de casser une règle de la section 2.

Dans tous les autres cas, tranche toi-même, note la décision dans
`Décisions prises`, et continue.
