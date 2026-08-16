# Ã‰tat d'avancement

DerniÃ¨re mise Ã  jour : 2026-08-17T01:40:00Z
Branche : feat/sources-externes
Dernier commit vert : c4290fa

Boucle de reprise : `/loop` en auto-cadencement, consigne Â« Lis AUTONOMY.md et
AUTONOMY-STATE.md, reprends Ã  la prochaine action concrÃ¨te Â». Repli horaire â€”
un reset de crÃ©dits dÃ©passe la borne d'une heure de `ScheduleWakeup`, le tick
doit donc tolÃ©rer d'Ã©chouer plusieurs fois de suite et se reprogrammer.

## Ã‰tapes
- [x] 0. Reconnaissance des API (CORS, formes de rÃ©ponse)
- [x] 5. OpenNGC â€” catalogue embarquÃ©
- [ ] 1. CelesTrak + SGP4                      â† EN COURS
- [ ] 2. Open-Meteo â€” rÃ©fraction
- [ ] 3. Open-Meteo Air Quality â€” extinction
- [ ] ~~4. JPL SBDB â€” petits corps~~           **BLOQUÃ‰** (CORS, voir plus bas)
- [ ] 6. SIMBAD â€” recherche

## Ã‰tape 5 â€” terminÃ©e
- `buildDeepSky()` â†’ `src/data/deepsky.json` : 1 738 objets â‰¤ mag 12, 91 Ko.
  Sous le seuil des 500 Ko, le JSON reste adaptÃ© ; pas de tableaux binaires.
  107 Messier, 13 types. Types `Dup`, `NonEx`, `*` et `**` Ã©cartÃ©s.
- `src/astro/deepsky.ts` : chargement, prÃ©cession J2000 â†’ date mise en cache par
  annÃ©e, recherche par identifiant ou numÃ©ro Messier, brillance de surface.
- `src/scene/DeepSky.tsx` : un maillage instanciÃ© unique porte les 1 738 objets.
  Chaque instance est un quad orientÃ© vers l'observateur et mis Ã  l'Ã©chelle des
  deux axes, ce qui donne l'ellipse sans gÃ©omÃ©trie dÃ©diÃ©e. Les matrices sont
  calculÃ©es **une seule fois** dans le repÃ¨re Ã©quatorial ; la rotation diurne
  passe par la matrice du groupe, comme pour les Ã©toiles.
- Calque `deepSky` dans `LayerVisibility`, exposÃ© dans les puces du HUD.
- Section 8 de `verify-astro.mjs` : 17 assertions, toutes vertes.

**DÃ©cision de conception.** La visibilitÃ© ne suit pas la magnitude intÃ©grÃ©e mais
la **brillance de surface** comparÃ©e au fond de ciel. Une galaxie de magnitude
3,4 Ã©talÃ©e sur trois degrÃ©s n'a rien de commun avec une Ã©toile de magnitude 3,4.
M31 ressort Ã  22,30 mag/arcsecÂ² contre 21,80 pour un site noir : plus tÃ©nue que
le fond de ciel, ce qui reproduit le fait qu'on n'en voie que le noyau Ã  l'Å“il
nu â€” et la fait disparaÃ®tre de jour sans traitement particulier.

## En cours : Ã©tape 1 â€” CelesTrak + SGP4
Fait :
- Couche commune `src/data-sources/` â€” `cache.ts` (IndexedDB sans dÃ©pendance),
  `fetchJson.ts` / `fetchText` (dÃ©lai, rÃ©essai, repli sur cache pÃ©rimÃ©),
  `types.ts` (provenance mesurÃ© / cache / dÃ©faut). Commit `c4290fa`.
- `satellite.js` v7 installÃ©.

Reste :
1. `src/data-sources/celestrak.ts` â€” client, TTL 6 h, avertissement au-delÃ  de
   3 jours.
2. `src/astro/sgp4.ts` Ã  la signature de `propagate()` de `kepler.ts`.
3. Champ `source: 'manuel' | 'tle'` dans `OrbitalElements`.
4. Bascule du `SatellitesPanel`, section de vÃ©rification, contrÃ´le ISS.

Prochaine action concrÃ¨te : crÃ©er `src/data-sources/celestrak.ts`.

### Le piÃ¨ge TEME â€” comment il est contournÃ©
SGP4 rend une position en **TEME**, pas dans l'Ã©quatorial de la date qu'utilise
`observerEci()`. Passer l'une pour l'autre donne quelques dixiÃ¨mes de degrÃ© :
assez pour rater un passage sans que rien n'ait l'air faux.

`satellite.js` v7 fournit toute la chaÃ®ne correcte, il suffit de ne pas en
sortir : `propagate()` â†’ `gstime()` â†’ `eciToEcf()` â†’ `ecfToLookAngles()`.
On obtient azimut et hauteur sans jamais toucher au repÃ¨re Ã©quatorial de la
date. Comme la scÃ¨ne place les satellites par `horizontalToScene()`, qui ne
demande qu'azimut et hauteur, **le problÃ¨me ne se pose pas si l'on s'interdit
de rÃ©utiliser `eciVectorToHorizontal()` sur une position TEME.**

Deux usages restent en repÃ¨re brut, tous deux sans consÃ©quence :
- trace au sol, via `eciToGeodetic(eci, gmst)` de satellite.js, qui gÃ¨re TEME ;
- test d'ombre terrestre, oÃ¹ l'Ã©cart TEME / Ã©quatorial de la date vaut environ
  une seconde d'arc â€” nÃ©gligeable pour dÃ©cider si un satellite est Ã©clairÃ©.

`json2satrec` consomme directement le GP JSON de CelesTrak : aucun passage par
les chaÃ®nes TLE Ã  deux lignes, donc aucun risque de dÃ©coupage Ã  la colonne prÃ¨s.

## BloquÃ©
- **Ã‰tape 4 â€” JPL SBDB.** Les trois points d'entrÃ©e JPL testÃ©s depuis le
  navigateur sont refusÃ©s par la politique d'origine croisÃ©e :
  `sbdb.api`, `sbdb_query.api` et `ssd.jpl.nasa.gov/api/horizons.api`.
  Aucun n'Ã©met d'en-tÃªte `Access-Control-Allow-Origin`. ConformÃ©ment Ã  la
  rÃ¨gle 3, aucun proxy n'est mis en place : l'Ã©tape reste bloquÃ©e.
  *Piste si elle devait Ãªtre dÃ©bloquÃ©e un jour :* embarquer au build un jeu
  d'Ã©lÃ©ments osculateurs pour quelques dizaines de petits corps (mÃªme motif que
  OpenNGC), au prix d'une pÃ©remption lente des Ã©lÃ©ments comÃ©taires.

## DÃ©cisions prises
- Travail sur la branche `feat/sources-externes`, jamais sur `main`.
- Les captures de contrÃ´le vont dans `shots/` via `scripts/shoot.mjs`, qui
  localise lui-mÃªme les instants par Ã©phÃ©mÃ©rides plutÃ´t que par dates codÃ©es en
  dur â€” une date figÃ©e devient fausse dÃ¨s que l'objet passe sous l'horizon.
- **Horizons reste utilisable pour la vÃ©rification.** Il n'est bloquÃ© que dans
  le navigateur ; `verify-astro.mjs` tourne sous Node, oÃ¹ la politique
  d'origine croisÃ©e ne s'applique pas. La rÃ©fÃ©rence autoritative de la
  section 8.3 reste donc disponible.
- SIMBAD, annoncÃ© comme le plus douteux, fonctionne : CORS ouvert et TAP
  synchrone opÃ©rationnel. L'Ã©tape 6 n'est pas Ã  risque.

## Ã‰tape 0 â€” rÃ©sultats de la reconnaissance

Ã‰chantillons dans `scripts/.cache/samples/` (non commitÃ©s, rÃ©gÃ©nÃ©rables par
`node scripts/probe-sources.mjs`). CORS mesurÃ© depuis une page servie par
`npm run dev` via `node scripts/probe-cors.mjs`.

| Source | HTTP | CORS navigateur | Forme rÃ©elle |
|---|---|---|---|
| CelesTrak | 200, 9 Ko | **OK** | 22 objets pour `stations`. Champs `OBJECT_NAME, OBJECT_ID, EPOCH, MEAN_MOTION, ECCENTRICITY, INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, NORAD_CAT_ID, BSTARâ€¦` ISS prÃ©sente. |
| Open-Meteo | 200 | **OK** | `current: { surface_pressure (hPa), temperature_2m (Â°C), pressure_msl (hPa) }` + `current_units`. |
| Open-Meteo AQ | 200 | **OK** | `current.aerosol_optical_depth` = 0,3 ; sÃ©rie `hourly` de 24 valeurs. |
| JPL SBDB | 200 | **BLOQUÃ‰** | Ã‰lÃ©ments prÃ©sents (`e, a, q, i, om, w, ma, tp, per`, Ã©poque en jour julien) mais inaccessibles depuis le navigateur. |
| OpenNGC | 200, 3,7 Mo | OK (`*`) | CSV **point-virgule**, 13 971 objets. Colonnes : `Name;Type;RA;Dec;Const;MajAx;MinAx;PosAng;B-Mag;V-Mag;â€¦;M;NGC;IC;â€¦;Common names`. RA en `hh:mm:ss.ss`, Dec en `+dd:mm:ss.s`. |
| SIMBAD | 200 | **OK** | TAP synchrone, ADQL. `basic` ne porte pas les magnitudes : il faut joindre `allfluxes`, et rÃ©soudre les noms par `ident` (identifiants normalisÃ©s, Â« M  31 Â» avec deux espaces). |

PiÃ¨ges relevÃ©s Ã  l'Ã©tape 0 :

- Une requÃªte Node n'envoie pas d'en-tÃªte `Origin` : la plupart des serveurs
  omettent alors `Access-Control-Allow-Origin`, y compris ceux qui l'Ã©mettent
  correctement pour un navigateur. L'absence de l'en-tÃªte cÃ´tÃ© Node ne dit donc
  **rien** ; seul le test navigateur tranche. C'est exactement ce qui a
  distinguÃ© CelesTrak (autorisÃ©) de SBDB (refusÃ©), tous deux Â« sans en-tÃªte Â»
  cÃ´tÃ© Node.
- La requÃªte ADQL initiale sur SIMBAD renvoyait 400 : la colonne `V` n'existe
  pas dans `basic`. Le corps de la rÃ©ponse d'erreur portait le diagnostic, d'oÃ¹
  son enregistrement systÃ©matique dans le script de sondage.

## Travaux prÃ©alables (hors mission, dÃ©jÃ  livrÃ©s)
Commit `231f112` â€” trois dÃ©fauts de rendu corrigÃ©s avant le dÃ©marrage :
fond de ciel et atmosphÃ¨re fusionnÃ©s en une passe opaque (le Soleil Ã©tait
repeint par l'atmosphÃ¨re transparente), exposition du ciel ramenÃ©e de 0,5 Ã 
0,14 avec resaturation post-ACES, et voile atmosphÃ©rique sur les disques
planÃ©taires. VÃ©rification ajoutÃ©e : l'angle de phase reconstruit depuis le
vecteur corps â†’ Soleil colle Ã  0,05Â° prÃ¨s pour toutes les planÃ¨tes.

## Journal des vÃ©rifications
| Date | Ã‰vÃ©nement testÃ© | Lieu | Attendu | Obtenu | Verdict |
|------|-----------------|------|---------|--------|---------|
| 2026-08-17 | Phase de tous les corps vs astronomy-engine | Paris, 2 dates | Ã©cart < 0,05Â° (planÃ¨tes) | 3e-4 Ã  3e-2Â° | OK |
| 2026-08-17 | Amplitude des phases de VÃ©nus sur un an | Paris | < 15 % et > 90 % | 0,7 % â†’ 100 % | OK |
| 2026-08-17 | Face visible de la Lune (capture) | Paris | mers reconnaissables | Imbrium, Crisium, Tycho | OK |
| 2026-08-17 | Croissant de VÃ©nus (capture) | Paris | corne opposÃ©e au Soleil | conforme | OK |
| 2026-08-17 | Masse d'air bornÃ©e sur [-90Â°, 90Â°] | â€” | toujours dans [1, 40] | conforme | OK |
| 2026-08-17 | CORS des six sources depuis le navigateur | localhost:5199 | â€” | 5 OK, JPL bloquÃ© | OK |
| 2026-08-17 | SIMBAD â€” position de M 31 | â€” | 10,685Â° / +41,269Â° | 10,6847Â° / 41,2688Â°, V=3,44 | OK |
| 2026-08-17 | M31 / M42 / M13 â€” positions OpenNGC | â€” | consigne Â§8.3 | Ã©cart < 0,004Â° | OK |
| 2026-08-17 | M31 â€” taille apparente | â€” | â‰ˆ 3Â°, six fois la Lune | 2,96Â°, 5,7Ã— | OK |
| 2026-08-17 | M31 â€” brillance de surface vs fond de ciel | site noir | plus tÃ©nue que le ciel | 22,30 > 21,80 | OK |
| 2026-08-17 | Fond de ciel de jour | â€” | noie tout objet Ã©tendu | 0,05 mag/arcsecÂ² | OK |
| 2026-08-17 | M31 â€” prÃ©cession J2000 â†’ 2026 | â€” | 12â€² Ã  30â€² | 18,6â€² | OK |
| 2026-08-17 | M31 rendue Ã  taille rÃ©elle (capture) | Paris | ellipse â‰ˆ 3Â° | â‰ˆ 2,7Â° visible, M32/M110 prÃ©sentes | OK |

