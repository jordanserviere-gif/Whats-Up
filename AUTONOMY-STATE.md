# État d'avancement

Dernière mise à jour : 2026-08-17T01:40:00Z
Branche : feat/sources-externes
Dernier commit vert : 0d00215

Boucle de reprise : `/loop` en auto-cadencement, consigne « Lis AUTONOMY.md et
AUTONOMY-STATE.md, reprends à la prochaine action concrète ». Repli horaire —
un reset de crédits dépasse la borne d'une heure de `ScheduleWakeup`, le tick
doit donc tolérer d'échouer plusieurs fois de suite et se reprogrammer.

## Étapes
- [x] 0. Reconnaissance des API (CORS, formes de réponse)
- [x] 5. OpenNGC — catalogue embarqué
- [ ] 1. CelesTrak + SGP4                      ← EN COURS
- [ ] 2. Open-Meteo — réfraction
- [ ] 3. Open-Meteo Air Quality — extinction
- [ ] ~~4. JPL SBDB — petits corps~~           **BLOQUÉ** (CORS, voir plus bas)
- [ ] 6. SIMBAD — recherche

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

## En cours : étape 1 — CelesTrak + SGP4
Fait : rien encore.
Reste : couche `src/data-sources/` (cache IndexedDB, `fetchJson` avec repli sur
cache périmé), client CelesTrak, `src/astro/sgp4.ts` à la signature de
`propagate()`, champ `source` dans `OrbitalElements`, bascule du panneau.
Prochaine action concrète : créer `src/data-sources/cache.ts` et `fetchJson.ts`
(architecture de la section 6, à faire une seule fois).

Piège identifié à ne pas oublier : SGP4 travaille en **TEME**, pas dans
l'équatorial de la date qu'utilise `observerEci()`. La conversion est le vrai
risque de l'étape ; un oubli donne quelques dixièmes de degré, assez pour rater
un passage sans que rien n'ait l'air faux.

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
Commit `231f112` — trois défauts de rendu corrigés avant le démarrage :
fond de ciel et atmosphère fusionnés en une passe opaque (le Soleil était
repeint par l'atmosphère transparente), exposition du ciel ramenée de 0,5 à
0,14 avec resaturation post-ACES, et voile atmosphérique sur les disques
planétaires. Vérification ajoutée : l'angle de phase reconstruit depuis le
vecteur corps → Soleil colle à 0,05° près pour toutes les planètes.

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
