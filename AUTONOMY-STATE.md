# État d'avancement

Dernière mise à jour : 2026-08-17T02:30:00Z
Branche : feat/sources-externes
Dernier commit vert : 4e9576f

Boucle de reprise : `/loop` en auto-cadencement, consigne « Lis AUTONOMY.md et
AUTONOMY-STATE.md, reprends à la prochaine action concrète ». Repli horaire —
un reset de crédits dépasse la borne d'une heure de `ScheduleWakeup`, le tick
doit donc tolérer d'échouer plusieurs fois de suite et se reprogrammer.

> **Encodage.** Ce fichier est en UTF-8. Ne jamais le réécrire via
> `Get-Content | Set-Content` sous PowerShell 5.1 : la lecture se fait en ANSI
> et la réécriture en UTF-8, ce qui double-encode tous les accents. Passer par
> l'outil d'écriture de fichiers, jamais par le shell.

## Étapes
- [x] 0. Reconnaissance des API (CORS, formes de réponse)
- [x] 5. OpenNGC — catalogue embarqué
- [ ] 1. CelesTrak + SGP4                      ← EN COURS
- [ ] 2. Open-Meteo — réfraction
- [ ] 3. Open-Meteo Air Quality — extinction
- [ ] ~~4. JPL SBDB — petits corps~~           **BLOQUÉ** (CORS, voir plus bas)
- [ ] 6. SIMBAD — recherche

## En cours : étape 1 — CelesTrak + SGP4
Fait :
- Couche commune `src/data-sources/` — `cache.ts` (IndexedDB sans dépendance),
  `fetchJson.ts` / `fetchText` (délai, réessai, repli sur cache périmé),
  `types.ts` (provenance mesuré / cache / défaut). Commit `c4290fa`.
- `satellite.js` v7 installé.

Reste :
1. `src/data-sources/celestrak.ts` — client, TTL 6 h, avertissement au-delà de
   3 jours.
2. `src/astro/sgp4.ts` à la signature de `propagate()` de `kepler.ts`.
3. Champ `source: 'manuel' | 'tle'` dans `OrbitalElements`.
4. Bascule du `SatellitesPanel`, section de vérification, contrôle ISS.

Prochaine action concrète : créer `src/data-sources/celestrak.ts`.

### Le piège TEME — comment il est contourné
SGP4 rend une position en **TEME**, pas dans l'équatorial de la date qu'utilise
`observerEci()`. Passer l'une pour l'autre donne quelques dixièmes de degré :
assez pour rater un passage sans que rien n'ait l'air faux.

`satellite.js` v7 fournit toute la chaîne correcte, il suffit de ne pas en
sortir : `propagate()` → `gstime()` → `eciToEcf()` → `ecfToLookAngles()`.
On obtient azimut et hauteur sans jamais toucher au repère équatorial de la
date. Comme la scène place les satellites par `horizontalToScene()`, qui ne
demande qu'azimut et hauteur, **le problème ne se pose pas si l'on s'interdit
de réutiliser `eciVectorToHorizontal()` sur une position TEME.**

Deux usages restent en repère brut, tous deux sans conséquence :
- trace au sol, via `eciToGeodetic(eci, gmst)` de satellite.js, qui gère TEME ;
- test d'ombre terrestre, où l'écart TEME / équatorial de la date vaut environ
  une seconde d'arc — négligeable pour décider si un satellite est éclairé.

`json2satrec` consomme directement le GP JSON de CelesTrak : aucun passage par
les chaînes TLE à deux lignes, donc aucun risque de découpage à la colonne près.

## Étape 5 — terminée
- `buildDeepSky()` → `src/data/deepsky.json` : 1 738 objets ≤ mag 12, 91 Ko.
  Sous le seuil des 500 Ko, le JSON reste adapté ; pas de tableaux binaires.
  107 Messier, 13 types. Types `Dup`, `NonEx`, `*` et `**` écartés.
- `src/astro/deepsky.ts` : chargement, précession J2000 → date mise en cache par
  année, recherche par identifiant ou numéro Messier, brillance de surface.
- `src/scene/DeepSky.tsx` : un maillage instancié unique porte les 1 738 objets.
  Chaque instance est un quad orienté vers l'observateur et mis à l'échelle des
  deux axes, ce qui donne l'ellipse sans géométrie dédiée. Les matrices sont
  calculées **une seule fois** dans le repère équatorial ; la rotation diurne
  passe par la matrice du groupe, comme pour les étoiles.
- Calque `deepSky` dans `LayerVisibility`, exposé dans les puces du HUD.
- Section 8 de `verify-astro.mjs` : 17 assertions, toutes vertes.

**Décision de conception.** La visibilité ne suit pas la magnitude intégrée mais
la **brillance de surface** comparée au fond de ciel. Une galaxie de magnitude
3,4 étalée sur trois degrés n'a rien de commun avec une étoile de magnitude 3,4.
M31 ressort à 22,30 mag/arcsec² contre 21,80 pour un site noir : plus ténue que
le fond de ciel, ce qui reproduit le fait qu'on n'en voie que le noyau à l'œil
nu — et la fait disparaître de jour sans traitement particulier.

## Bloqué
- **Étape 4 — JPL SBDB.** Les trois points d'entrée JPL testés depuis le
  navigateur sont refusés par la politique d'origine croisée :
  `sbdb.api`, `sbdb_query.api` et `ssd.jpl.nasa.gov/api/horizons.api`.
  Aucun n'émet d'en-tête `Access-Control-Allow-Origin`. Conformément à la
  règle 3, aucun proxy n'est mis en place : l'étape reste bloquée.
  *Piste si elle devait être débloquée un jour :* embarquer au build un jeu
  d'éléments osculateurs pour quelques dizaines de petits corps (même motif que
  OpenNGC), au prix d'une péremption lente des éléments cométaires.

## Décisions prises
- Travail sur la branche `feat/sources-externes`, jamais sur `main`.
- Les captures de contrôle vont dans `shots/` via `scripts/shoot.mjs`, qui
  localise lui-même les instants par éphémérides plutôt que par dates codées en
  dur — une date figée devient fausse dès que l'objet passe sous l'horizon.
- **Horizons reste utilisable pour la vérification.** Il n'est bloqué que dans
  le navigateur ; `verify-astro.mjs` tourne sous Node, où la politique
  d'origine croisée ne s'applique pas. La référence autoritative de la
  section 8.3 reste donc disponible.
- SIMBAD, annoncé comme le plus douteux, fonctionne : CORS ouvert et TAP
  synchrone opérationnel. L'étape 6 n'est pas à risque.

## Étape 0 — résultats de la reconnaissance

Échantillons dans `scripts/.cache/samples/` (non commités, régénérables par
`node scripts/probe-sources.mjs`). CORS mesuré depuis une page servie par
`npm run dev` via `node scripts/probe-cors.mjs`.

| Source | HTTP | CORS navigateur | Forme réelle |
|---|---|---|---|
| CelesTrak | 200, 9 Ko | **OK** | 22 objets pour `stations`. Champs `OBJECT_NAME, OBJECT_ID, EPOCH, MEAN_MOTION, ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, NORAD_CAT_ID, BSTAR…` ISS présente. |
| Open-Meteo | 200 | **OK** | `current: { surface_pressure (hPa), temperature_2m (°C), pressure_msl (hPa) }` + `current_units`. |
| Open-Meteo AQ | 200 | **OK** | `current.aerosol_optical_depth` = 0,3 ; série `hourly` de 24 valeurs. |
| JPL SBDB | 200 | **BLOQUÉ** | Éléments présents (`e, a, q, i, om, w, ma, tp, per`, époque en jour julien) mais inaccessibles depuis le navigateur. |
| OpenNGC | 200, 3,7 Mo | OK (`*`) | CSV **point-virgule**, 13 971 objets. Colonnes : `Name;Type;RA;Dec;Const;MajAx;MinAx;PosAng;B-Mag;V-Mag;…;M;NGC;IC;…;Common names`. RA en `hh:mm:ss.ss`, Dec en `+dd:mm:ss.s`. |
| SIMBAD | 200 | **OK** | TAP synchrone, ADQL. `basic` ne porte pas les magnitudes : il faut joindre `allfluxes`, et résoudre les noms par `ident` (identifiants normalisés, « M  31 » avec deux espaces). |

Pièges relevés à l'étape 0 :

- Une requête Node n'envoie pas d'en-tête `Origin` : la plupart des serveurs
  omettent alors `Access-Control-Allow-Origin`, y compris ceux qui l'émettent
  correctement pour un navigateur. L'absence de l'en-tête côté Node ne dit donc
  **rien** ; seul le test navigateur tranche. C'est exactement ce qui a
  distingué CelesTrak (autorisé) de SBDB (refusé), tous deux « sans en-tête »
  côté Node.
- La requête ADQL initiale sur SIMBAD renvoyait 400 : la colonne `V` n'existe
  pas dans `basic`. Le corps de la réponse d'erreur portait le diagnostic, d'où
  son enregistrement systématique dans le script de sondage.

## Travaux préalables (hors mission, déjà livrés)
Commit `231f112` — trois défauts de rendu corrigés avant le démarrage : fond de
ciel et atmosphère fusionnés en une passe opaque (le Soleil était repeint par
l'atmosphère transparente), exposition du ciel ramenée de 0,5 à 0,14 avec
resaturation post-ACES, et voile atmosphérique sur les disques planétaires.
Vérification ajoutée : l'angle de phase reconstruit depuis le vecteur
corps → Soleil colle à 0,05° près pour toutes les planètes.

## Dettes soldées
- **Attribution CC BY 4.0** honorée : tableau des crédits dans le README, et
  section « Sources et licences » dans le panneau Réglages — la licence impose
  que le crédit soit visible dans l'application, pas seulement dans le dépôt.
- **Jupiter et Saturne inspectés** au champ de 0,05°. Les deux rendent
  correctement : bandes nuageuses et Grande Tache rouge pour Jupiter, anneaux
  inclinés avec division de Cassini, ombre des anneaux sur le globe et globe
  occultant l'arrière des anneaux pour Saturne. L'orientation des textures
  planétaires est donc validée, pas seulement l'axe de la Lune.

  Cette inspection a révélé **deux vrais bugs**, tous deux invisibles au champ
  large (voir la section suivante).

## Bug trouvé par l'inspection à fort grossissement
`computeBodyState` rapportait une position horizontale **réfractée**
(`A.Horizon(..., 'normal')`) alors que la scène place les corps depuis leur
direction équatoriale **non réfractée**. Écart d'environ 2′ à 25° de hauteur :
imperceptible au champ large, mais suffisant pour faire sortir Saturne du cadre
à 0,05° — et pour décaler toutes les étiquettes de leurs objets.

Corrigé en rapportant des coordonnées non réfractées, cohérentes avec la
géométrie de la scène. **L'étape 2 devra introduire la réfraction de façon
cohérente pour toutes les couches à la fois** — étoiles, corps, étiquettes,
satellites — et non sur une seule.

Piège associé : `A.Horizon` teste la véracité de son argument de réfraction.
`'none'` est *truthy* et lève « unrecognized value ». La chaîne vide est la
façon correcte de la désactiver.

Second bug : la borne basse du champ était à 0,15°, et le garde-fou de
publication du `CameraRig` (`> 0.2`) interdisait de toute façon tout réglage
sous le demi-degré. Bornes ramenées à 0,02° et seuils rendus proportionnels au
champ.

## Journal des vérifications
| Date | Événement testé | Lieu | Attendu | Obtenu | Verdict |
|------|-----------------|------|---------|--------|---------|
| 2026-08-17 | Phase de tous les corps vs astronomy-engine | Paris, 2 dates | écart < 0,05° (planètes) | 3e-4 à 3e-2° | OK |
| 2026-08-17 | Amplitude des phases de Vénus sur un an | Paris | < 15 % et > 90 % | 0,7 % → 100 % | OK |
| 2026-08-17 | Face visible de la Lune (capture) | Paris | mers reconnaissables | Imbrium, Crisium, Tycho | OK |
| 2026-08-17 | Croissant de Vénus (capture) | Paris | corne opposée au Soleil | conforme | OK |
| 2026-08-17 | Masse d'air bornée sur [-90°, 90°] | — | toujours dans [1, 40] | conforme | OK |
| 2026-08-17 | CORS des six sources depuis le navigateur | localhost:5199 | — | 5 OK, JPL bloqué | OK |
| 2026-08-17 | SIMBAD — position de M 31 | — | 10,685° / +41,269° | 10,6847° / 41,2688°, V=3,44 | OK |
| 2026-08-17 | M31 / M42 / M13 — positions OpenNGC | — | consigne §8.3 | écart < 0,004° | OK |
| 2026-08-17 | M31 — taille apparente | — | ≈ 3°, six fois la Lune | 2,96°, 5,7× | OK |
| 2026-08-17 | M31 — brillance de surface vs fond de ciel | site noir | plus ténue que le ciel | 22,30 > 21,80 | OK |
| 2026-08-17 | Fond de ciel de jour | — | noie tout objet étendu | 0,05 mag/arcsec² | OK |
| 2026-08-17 | M31 — précession J2000 → 2026 | — | 12′ à 30′ | 18,6′ | OK |
| 2026-08-17 | M31 rendue à taille réelle (capture) | Paris | ellipse ≈ 3° | ≈ 2,7° visible, M32/M110 présentes | OK |
