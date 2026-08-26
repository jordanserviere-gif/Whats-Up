# Audit d'intégration — moteur d'optique atmosphérique

Audit du dépôt avant toute réécriture. Aucune modification du code n'a été faite
pour le produire ; l'instrumentation de mesure a vécu hors du dépôt.

---

## 1. Résumé exécutif

**Oui, un nouveau ciel physique s'implémente dans ce framework.** Et mieux que
« ça peut tenir » : la codebase a déjà, sans le nommer, la moitié de
l'architecture cible.

Trois propriétés structurelles rendent l'opération réaliste :

1. **La couture du transfert radiatif existe déjà.** `hazeColorTo(dir, maxPath,
   out transmittance)` dans [atmosphere.ts](../src/scene/atmosphere.ts) rend
   *exactement* les deux moitiés de l'équation du transfert : ce que
   l'atmosphère ajoute et ce qu'elle laisse passer. Trois matériaux la
   consomment déjà — fond de ciel, corps du système solaire, avions et traînées
   — et l'appliquent sous la forme `vu = objet × T + L_diffusée`. Remplacer
   l'implémentation derrière cette signature ne touche aucun site d'appel.

2. **La couche astronomique est délibérément sans réfraction.** `computeBodyState`
   appelle `A.Horizon(..., '')` avec un commentaire explicite : *« La réfraction
   sera introduite de façon cohérente pour toutes les couches — étoiles comprises
   — à l'étape 2 de la mission. »* La géométrie est donc purement géométrique et
   vérifiée ([verify-astro.mjs](../scripts/verify-astro.mjs), 36 contrôles
   numériques). Le moteur atmosphérique peut s'approprier la réfraction sans
   rien avoir à défaire.

3. **Le module atmosphérique vit déjà en unités SI**, découplé des unités
   comprimées de la scène. Il ne partage avec elle qu'une convention de
   direction. C'est précisément la frontière qu'on voudrait tracer.

**Quatre choses doivent être restructurées avant, pas après.** La plus
importante : *le tone mapping est à l'intérieur des matériaux*
(`ATMOSPHERE_TONEMAP_FN`, ACES + resaturation ×1,4), le renderer étant en
`NoToneMapping`. Il n'existe aucune chaîne linéaire HDR de bout en bout — donc
aucun endroit où faire vivre une radiance spectrale. Le code le reconnaît
lui-même : *« L'atténuation s'applique à une couleur déjà en espace d'affichage,
alors que la transmittance est une grandeur linéaire : le produit est donc une
approximation. »*

**Le budget de performance ne se déduit pas d'une marge disponible : il se
libère.** Le noyau de diffusion actuel coûte **0,95 ns/pixel**, soit ~4,9 ms par
image à dpr 2 — ~30 % d'une image à 60 Hz, pour la seule voûte, recalculé
intégralement à chaque image, puis *refait* sur chaque fragment de planète et
d'avion. Une chaîne à LUT précalculées ramène cela à quelques accès de texture.
Les ~5 ms ainsi libérées *sont* le budget de la diffusion multiple, de la
perspective aérienne, de la réfraction et de la turbulence.

> **Correction du 26 août 2026.** Cette section annonçait initialement
> 1,8 ns/pixel, 9,5 ms et 57 %. Ces chiffres étaient **surestimés d'environ
> 90 %** : le microbanc tournait dans l'onglet de l'application, dont le rendu
> à 60 Hz s'ajoutait à la mesure, et sa phase de chauffe était trop courte pour
> que le GPU ait quitté ses fréquences d'attente. Voir §14 pour la mesure
> corrigée et la méthode. Le raisonnement est inchangé, son échelle non.

**Verdict : GO WITH REFACTOR** (détail en §20).

---

## 2. Architecture actuelle

### Stack

| Élément | Valeur |
| --- | --- |
| Three.js | **0.171.0** |
| Renderer | **WebGLRenderer** (via `@react-three/fiber` 8.18.0) |
| WebGPU | **non utilisé** — mais `three/webgpu` et `three/tsl` sont livrés par le paquet installé |
| TSL / WGSL | **aucun** |
| Shaders | **13 `ShaderMaterial` en GLSL brut**, chaînes de template dans les `.tsx` |
| Compute | **aucun** (ni WebGL transform-feedback, ni WebGPU compute) |
| Workers | **aucun** |
| Render targets | **aucun**, hors celui interne à `postprocessing` |
| Post-processing | `@react-three/postprocessing` 2.19.1 / `postprocessing` 6.39.4 — **WebGL seulement** |
| Langage | TypeScript 5.7, `strict: true`, `noUnusedLocals`, `noUnusedParameters` |
| Bundler | Vite 6.0.11, cible `es2022`, chunks manuels (`three`, `astro`, `catalog`) |
| Éphémérides | `astronomy-engine` 2.1.19 (VSOP87 tronqué + ELP2000) |
| État | Zustand 5 + `persist` |
| Inspection visuelle | Playwright 1.62 — [`scripts/shoot.mjs`](../scripts/shoot.mjs), 20 scénarios pilotés par `window.__skyStore` |
| Vérification numérique | [`scripts/verify-astro.mjs`](../scripts/verify-astro.mjs), `npm run verify`, code de sortie |

Machine de mesure : Chromium / ANGLE D3D11 / **NVIDIA RTX 3060**. WebGL 2.0,
`EXT_color_buffer_float` ✓, `OES_texture_float_linear` ✓,
`EXT_disjoint_timer_query_webgl2` ✓, `MAX_3D_TEXTURE_SIZE` = 2048,
`MAX_DRAW_BUFFERS` = 8, `navigator.gpu` présent.

### Cartographie

```
App.tsx
└── SkyCanvas.tsx ......... <Canvas> R3F : caméra, gl, dpr, EffectComposer
    ├── CameraRig ......... orientation az/alt en ref locale, publiée à 10 Hz
    ├── SkyBackground ..... sphère r=320, BackSide, opaque, depthTest:false
    ├── Starfield ......... 5 071 POINTS, matrice de groupe équatoriale
    ├── ConstellationLines / DeepSky / Grids
    ├── SolarSystemBodies . 10 sphères à profondeur réelle comprimée
    ├── SatelliteLayer / AircraftLayer
    ├── Ground ............ calotte r=150, BackSide, opaque
    ├── LabelLayer ........ nœuds DOM projetés hors React
    └── EffectComposer .... Bloom(seuil 1) — conditionnel au calque `bloom`
```

Boucle de rendu : `useFrame` (29 occurrences), toutes les mises à jour d'uniforms
s'y font. Moteur temporel séparé (`useTimeEngine`) : éphémérides à **10 Hz** au
repos, une fois par image dès que le temps est accéléré. Mémos à une case
partagés (`bodiesFor`, `conditionsFor`) évitant le recalcul multiple par image.

### Ordre de rendu

| `renderOrder` | Objet | Profondeur |
| --- | --- | --- |
| −1000 | Fond de ciel | `depthTest:false`, `depthWrite:false` |
| 2 | Grilles | `depthWrite:false` |
| 4 | Étoiles | `depthTest:true`, additif |
| 6 | Sol | opaque, écrit la profondeur |
| 19–24 | Anneaux, corps, halos, réticule | opaque + additif |

---

## 3. Pipeline graphique actuel

```
gl = { antialias: true, alpha: false, toneMapping: NoToneMapping }
dpr = [1, 2]
camera = { fov: 65 (0,02 → 110), near: 0.1, far: 900, position: [0,0,0] }
outputColorSpace = SRGBColorSpace (défaut three r152+)
```

**Le tone mapping n'est pas dans le pipeline : il est dans les matériaux.**
`ATMOSPHERE_TONEMAP_FN` applique ACES (approximation Narkowicz 2015) puis une
resaturation ×1,4, et **borne à [0,1]**, dans le fragment shader de chaque
matériau qui touche à l'atmosphère. Le renderer ne fait ensuite que l'encodage
sRGB.

Conséquences directes, toutes structurelles :

- **Aucune radiance ne survit au-delà du matériau.** La grandeur physique est
  détruite avant la composition. Un capteur spectral (`SpectralSensor` de
  l'architecture cible) n'a nulle part où s'insérer.
- Les valeurs > 1 sont écrêtées dans le shader, donc **le ciel ne peut jamais
  alimenter le bloom** — le seuil de `Bloom` est à 1, et seul le Soleil
  (`uGain = 6`, hors chaîne atmosphérique) le dépasse.
- La multiplication `couleur_affichage × transmittance` est faite en espace
  d'affichage. Le commentaire du code l'assume explicitement comme une
  approximation.
- `EffectComposer` n'est instancié **que si le calque `bloom` est actif** : le
  format du tampon de rendu change donc selon un réglage utilisateur.

**Il n'existe aucun `WebGLRenderTarget` propre à l'application.** Pas de passe
hors écran, pas de LUT, pas de framebuffer intermédiaire. C'est la principale
infrastructure manquante — mais elle est *additive*, pas destructive.

---

## 4. Système astronomique

Solide, vérifié, et de qualité nettement supérieure à ce qu'on trouve
habituellement dans un projet de rendu.

| Grandeur | Source | Précision revendiquée | Vérifiée par |
| --- | --- | --- | --- |
| Soleil, Lune, planètes | `astronomy-engine` (VSOP87 tronqué, ELP2000) | ~1″ | `verify` vs astronomy-engine, 3 lieux × 3 époques, tol. 0,02° |
| Temps sidéral | IAU 1982, `gmstDegrees` | ~1″/siècle | tol. 0,005° vs `A.SiderealTime` |
| Précession J2000→date | série rigoureuse à ~1″/siècle | — | matrice de scène vs trigonométrie, tol. 1e-3 |
| Orientation des corps | `A.RotationAxis`, convention UAI, nœud ascendant | — | contrôle visuel (face visible de la Lune) |
| Étoiles | HYG v4.1, 5 071 ≤ mag 6,0, J2000 précessées | catalogue | — |
| Ciel profond | OpenNGC, 1 738 objets | catalogue | M31 : grand axe 2,96°, tol. 0,1° |
| Satellites | Képlérien + dérives séculaires J2 (**pas SGP4**) | géométrie osculatrice | vis-viva, périgée, géostationnaire sur 6 h |
| Position observateur | `observerEci`, aplatissement WGS84 | cm | sous-point à 1e-6°, altitude à 0,5 m |

**Conventions.** Repère de scène : **+X est, +Y zénith, −Z nord**, observateur à
l'origine. `equatorialToSceneMatrix` compose la rotation horaire et le
basculement à la latitude ; c'est une **rotation pure**, donc sa transposée est
son inverse, ce dont `sceneDirectionToEquatorial` tire parti. Azimut compté du
nord vers l'est. Le repère intermédiaire est SEZ (sud, est, zénith).

**Le point qui compte pour la suite : la réfraction est absente *volontairement*.**
`computeBodyState` désactive explicitement la réfraction d'`astronomy-engine`,
en documentant l'écart évité (~2′ à 25° de hauteur) et en annonçant son
introduction cohérente à l'étape suivante. `skyLuminance`, en revanche, utilise
`'normal'` (avec réfraction) pour le bilan photométrique — **incohérence à
traiter** : deux hauteurs solaires différentes coexistent dans le code, l'une
géométrique pour la scène, l'autre réfractée pour la photométrie.

**Altitude de l'observateur.** `location.elevation` existe, est persistée, et va
de 12 m (Marseille) à 2 877 m (Pic du Midi). Elle est utilisée par
`observerEci` et par `A.Observer` — **mais pas par l'atmosphère**, qui pose
`r0 = vec3(0, uPlanetRadius, 0)`, soit toujours le niveau de la mer. Un degré de
liberté physique déjà présent dans les données et jeté.

---

## 5. Système de coordonnées

Cinq repères coexistent, tous explicites :

1. **Équatorial de la date** — RA/dec en degrés, ou vecteur cartésien km.
2. **Horizontal** — azimut (N→E) / hauteur, degrés.
3. **SEZ** — sud, est, zénith ; intermédiaire des conversions topocentriques.
4. **ECI** — géocentrique inertiel, km, WGS84.
5. **Scène Three.js** — +X est, +Y zénith, −Z nord, **profondeur comprimée**.

La compression de profondeur est le choix le plus singulier du projet :

```
profondeur(d) = 7,375 · log₁₀(max(1, d_km)) + 0,4
rayon_rendu   = rayon_km × profondeur(d) / d_km
```

Strictement croissante → **l'ordre des occultations est exact**. Le rapport
rayon/distance est conservé → **le diamètre apparent est exact** (vérifié à 1e-6
degré). C'est ce qui fait qu'une éclipse se joue dans le tampon de profondeur,
sans ordre de dessin choisi à la main.

**Conséquence pour le moteur atmosphérique :** la profondeur de scène est
inutilisable comme distance physique. Le code a déjà résolu le problème de la
bonne façon — la distance réelle voyage en parallèle, en uniform :
`uRangeM` dans les matériaux d'avion. Une perspective aérienne en froxels devra
suivre exactement ce patron : **indexer le volume par `rangeM`, jamais par la
profondeur de scène.**

---

## 6. Unités

Discipline de nommage remarquable, et suffixes systématiques. Inventaire réel :

| Domaine | Unités | Constat |
| --- | --- | --- |
| Astro | km, degrés, ms (epoch), UA (`distanceAu`) | cohérent, suffixé (`distanceKm`, `altitudeDeg`, `measuredAtMs`) |
| Photométrie | lux, magnitudes, mag/arcsec², masses d'air | cohérent |
| **Atmosphère** | **mètres, m⁻¹, SI** | `PLANET_RADIUS_M`, `RAYLEIGH_SCALE_HEIGHT_M`, coefficients par mètre |
| Scène | unités arbitraires log-comprimées | isolées, converties explicitement |
| Shaders | radians (conversion au bord), pixels | `DEG` importé, jamais redéfini en dur |
| Aérosols | µg/m³ (PM2,5) → trouble sans dimension | `turbidityFromSurfaceAerosol` |

**Le mélange existe mais il est frontalisé, pas diffus.** Chaque conversion a un
point unique. Il n'y a pas de constante magique de conversion dispersée dans les
matériaux — sauf trois, à traiter (§8).

Le futur moteur peut donc adopter le SI strict au niveau des solveurs sans
combat : c'est déjà ce que fait `atmosphere.ts`.

---

## 7. Matériau atmosphérique actuel

### Où et comment

[`src/scene/atmosphere.ts`](../src/scene/atmosphere.ts) (415 lignes) n'est **pas
un matériau** : c'est un module de constantes SI + fragments GLSL exportés comme
chaînes, injectés par interpolation dans les fragment shaders de trois
consommateurs :

| Consommateur | Appel | Rôle |
| --- | --- | --- |
| [`SkyBackground.tsx`](../src/scene/SkyBackground.tsx) | `hazeColorAlong(dir)` | voûte, diffusion seule |
| [`Bodies.tsx`](../src/scene/Bodies.tsx) | `hazeColorAlong(dir, transmittance)` | disque planétaire : `col × T + haze` |
| [`Aircraft.tsx`](../src/scene/Aircraft.tsx) ×2 | `hazeColorTo(vView, uRangeM, transmittance)` | silhouette et traînée, trajet **borné** |

`atmosphereUniforms()` fabrique le bloc d'uniforms commun ;
`applyAerosolTurbidity()` est le point unique qui écrit la charge en aérosols —
*« ce qui garantit que le voile d'un avion, celui d'une planète et le fond de
ciel ne peuvent pas décrire des atmosphères différentes »*. C'est déjà un
`AtmosphereState` partagé, en germe.

### Ce qu'il calcule

Portage littéral de `glsl-atmosphere` (wwwtyro, Unlicense), lui-même une
implémentation du modèle de Sean O'Neil (GPU Gems 2, 2004) :

- **diffusion simple** Rayleigh + Mie, marche de **16 pas** sur le rayon
  primaire × **8 pas** sur le rayon secondaire vers le Soleil ;
- phase de Rayleigh `3/(16π)(1+μ²)`, phase de Henyey-Greenstein pour Mie
  (`g = 0,758`) ;
- densités exponentielles, hauteurs d'échelle 8 000 m (Rayleigh) et 1 200 m (Mie) ;
- **transmittance rendue en sortie** — ajout maison par rapport à l'original,
  et c'est l'apport structurel majeur ;
- intégration analytique de la transmittance **sur la longueur du pas**
  (`(1−e^−dτ)/dτ`), correction documentée d'un bug réel d'horizon noirci.

### Ce qu'il consomme

`uSunDir` (direction scène), `uSunIntensity`, `uPlanetRadius`,
`uAtmosphereRadius`, `uRayleighCoeff` (vec3), `uMieCoeff`, les deux hauteurs
d'échelle, `uMieG`, `uAtmosphereExposure`. **Aucune texture. Aucune LUT.**

### Ce qui est déjà physique — à conserver

- La géométrie Terre-atmosphère (intersection rayon-sphère, corde, altitude le
  long du rayon) est correcte.
- L'équation `vu = objet × T + L_diffusée` est appliquée partout, correctement.
- Le bornage du trajet (`maxPath`) pour un objet *dans* l'atmosphère.
- Le pilotage des aérosols par une mesure réelle de **PM2,5 de surface** — avec
  une justification physique de premier ordre, documentée : l'AOD intègre toute
  la colonne, alors que la hauteur d'échelle Mie du modèle décrit une couche
  limite ; les deux se décorrèlent (exemple mesuré au Pic du Midi). Ce
  raisonnement est juste et doit survivre.
- L'extinction photométrique (Pickering 2002 + coefficient séparé
  moléculaire/aérosol) dans [`photometry.ts`](../src/astro/photometry.ts).

### Ce qui doit devenir une simple couche d'intégration

- `atmosphereUniforms()` → doit devenir la projection GPU d'un `AtmosphereState`.
- `applyAerosolTurbidity()` → doit devenir un modèle de microphysique
  (distribution de tailles → sections efficaces Mie), pas un multiplicateur.
- `ATMOSPHERE_TONEMAP_FN` → doit sortir des matériaux et devenir la passe
  d'affichage unique.

### Ce qui doit disparaître — les faux artistiques

Ils sont peu nombreux, localisés, et le code les signale lui-même comme des
pis-aller. Liste exhaustive :

| Où | Quoi | Pourquoi c'est un faux |
| --- | --- | --- |
| `SkyBackground` | `uNight` + `mix(uNight*1.6, uNight, smoothstep(0,0.45,h))` | socle nocturne peint ; l'airglow est une **source d'émission** de la couche à ~90 km, elle appartient à l'équation du transfert |
| `SkyBackground` | `uMoonGlow * uMoonFactor * (0.25 + 0.75·pow(toMoon, 6))` | halo lunaire inventé ; la Lune est une source comme le Soleil — même intégrale, spectre et irradiance différents |
| `SkyBackground` | `uPollution * (0.3 + 0.7·pow(1−h, 2))` | halo urbain paramétrique ; c'est une source au sol dont la lumière **remonte** — un terme source dans le RTE, avec sa propre géométrie |
| `SkyCanvas` | `atmosphereExposure = 0.3 · sqrt(1 − obs + 8e-4·obs)` | **constante d'exposition arbitraire** et traitement de l'éclipse par atténuation scalaire globale |
| `atmosphere.ts` | `SUN_INTENSITY_REF = 22` | assumé dans le commentaire : *« une constante de calibrage du modèle, pas une grandeur physique en lux »* |
| `atmosphere.ts` | `ATMOSPHERE_SATURATION = 1.4` | resaturation cosmétique post-courbe |
| `Bodies.tsx` | `glowMaterial()` — quad additif `core*0.85 + pow(1−r, falloff)` | **halo solaire ajouté artificiellement**, explicitement proscrit par la vision. Le vrai éblouissement vient de la diffusion Mie vers l'avant + la PSF de l'œil/instrument |
| `Bodies.tsx` | `uNightSide = 0.012` (Lune) / `0.003` | lumière cendrée en constante ; c'est l'albédo terrestre vu depuis la Lune, calculable |
| `Ground.tsx` | `uBrightness = 0.14 + 2.4·t²` sur `log10(illuminance)` | le sol ne participe à aucun transfert ; or **l'albédo du sol est une condition aux limites requise** par tout solveur de diffusion multiple |
| `Starfield` | rougissement `exp(-0.035·x)`, `exp(-0.085·x)` par canal | extinction en RGB avec deux constantes ajustées, à remplacer par la transmittance spectrale du solveur |

**Il n'y a aucune LUT artistique, aucune texture de coucher de soleil, aucun
`sunsetColor`, aucun test « si c'est une étoile alors ».** Le projet est déjà
largement conforme à sa propre règle. La dette est concentrée sur le socle
nocturne, le halo solaire additif et l'ancrage radiométrique.

---

## 8. Limitations identifiées

### Bloquantes pour un moteur physique

**L-1 — Aucune chaîne linéaire HDR.** Tone mapping dans les matériaux, écrêtage
à 1 dans le shader, renderer en `NoToneMapping`, `EffectComposer` conditionnel.
Il n'existe aucun endroit où une radiance spectrale puisse vivre entre le
solveur et l'écran. *C'est le blocage n°1 et il conditionne tout le reste.*

**L-2 — Aucune infrastructure de passe hors écran.** Zéro `WebGLRenderTarget`
applicatif. Pas de LUT possible sans la créer.

**L-3 — Radiométrie non ancrée.** `SUN_INTENSITY_REF = 22` et
`atmosphereExposure = 0,3` sont des constantes de calibrage. Aucun lien avec
l'irradiance solaire au sommet de l'atmosphère (~1361 W/m²) ni avec les lux que
`photometry.ts` calcule pourtant très correctement à côté. **Deux échelles
lumineuses parallèles et non réconciliées coexistent dans le projet** : le
bilan en lux (physique, testé) et l'exposition du shader (arbitraire).

### Sérieuses

**L-4 — Coût recalculé sans cache.** L'intégrale à 16×8 pas tourne par fragment,
par image, sur la voûte *et* sur chaque fragment de corps et d'avion. À `fov`
0,02° le disque solaire couvre l'écran : la scène paie l'intégrale deux fois
plein écran.

**L-5 — Altitude de l'observateur ignorée** par l'atmosphère (`r0` au niveau de
la mer), alors que la donnée existe et va jusqu'à 2 877 m.

**L-6 — Incohérence de réfraction dans la couche astro.** Scène sans réfraction
(volontaire, documenté), photométrie avec réfraction (`'normal'`). Deux hauteurs
solaires. À unifier au moment où le moteur prend la réfraction en charge.

**L-7 — Coefficients Rayleigh en trois constantes RGB.**
`[5.5e-6, 13.0e-6, 22.4e-6]` sont les valeurs héritées de `glsl-atmosphere`, pas
un calcul. Le rapport rouge/bleu (4,07) correspond à une loi en λ⁻⁴ sur une
séparation spectrale effective plus étroite que 440–680 nm. **Non dérivées, non
spectrales, sans dépolarisation.**

**L-8 — Mie sans absorption ni microphysique.** `MIE_COEFFICIENT` scalaire,
`g` fixe à 0,758, **albédo de diffusion simple implicitement égal à 1**. Un
aérosol réel absorbe (suie : ω₀ ≈ 0,2). Le passage PM2,5 → propriétés optiques
n'est pas modélisé, il est postulé par une loi de puissance à deux ancres.

**L-9 — Pas de pas adaptatif.** 16 pas fixes quelle que soit la géométrie ; à
l'horizon la corde fait ~1 100 km. L'intégration analytique de la transmittance
par pas corrige la partie la plus grave, mais **l'exactitude de la profondeur
optique rasante n'a jamais été confrontée à une référence** — à mesurer, avant
de décider si c'est un vrai défaut (une LUT de transmittance rend la question
sans objet).

**L-10 — Le sol ne participe à rien.** Albédo absent du transfert radiatif.
Toute diffusion multiple correcte en a besoin comme condition aux limites.

### Structurelles, à connaître mais non bloquantes

**L-11 — Les corps sont rasterisés, pas tracés.** Le Soleil et la Lune sont de
vraies sphères à profondeur réelle : c'est ce qui fait tomber les éclipses du
tampon de profondeur, et c'est une **très bonne propriété qu'il faut préserver**.
Mais un moteur à rayons courbés voudrait les échantillonner au bout du rayon
dévié. Voir §17 pour la réconciliation, et §11 pour ce que cela interdit
(Fata Morgana à images multiples).

**L-12 — R3F 8 / postprocessing 6 sont WebGL seulement.** Voir §10.

---

## 9. Opportunités de réutilisation

C'est la section la plus favorable de cet audit.

| Existant | Réutilisation |
| --- | --- |
| `hazeColorTo(dir, maxPath, out T)` | **La signature du RTE est déjà la bonne.** Nouvelle implémentation, zéro site d'appel modifié |
| `atmosphereUniforms()` / `applyAerosolTurbidity()` | Point unique d'écriture de l'état atmosphérique → devient `AtmosphereState` |
| Injection de GLSL par chaînes partagées | Le mécanisme qui a diffusé `hazeColorAlong` dans 3 matériaux diffusera `refract(dir, λ)` dans les **vertex** shaders |
| `equatorialToSceneMatrix` (rotation pure, vérifiée) | Base géométrique du moteur, inchangée |
| `sceneDepth` / `uRangeM` | Le patron « distance réelle en uniform à côté de la profondeur comprimée » est déjà établi |
| `photometry.ts` (lux, Bortle, Schaefer, Pickering, obscuration) | Modèle photométrique **testé** ; devient l'aval du capteur spectral et la référence de validation croisée |
| `bvToRgb` / `RAW.ci` (indice B−V) | **Une SED de corps noir est reconstructible pour chaque étoile** — le catalogue porte déjà l'information spectrale |
| `verify-astro.mjs` (`check()`, 36 contrôles, code de sortie) | **La suite de tests scientifiques a déjà son foyer.** Aucun framework à introduire |
| `shoot.mjs` (20 scénarios, `window.__skyStore`) | Non-régression visuelle par scénario, déjà pilotable |
| `airQuality.ts` / `lightPollution.ts` | Sources de données réelles déjà branchées sur l'état |
| `Starfield` : travail par sommet dans un shader | Point d'insertion naturel de la réfraction, du jitter de seeing et de la scintillation |

---

## 10. Compatibilité WebGPU

**Trois faits, à ne pas confondre.**

1. **Le paquet installé livre déjà WebGPU.** `three@0.171` expose
   `three/webgpu` (`WebGPURenderer`, `PostProcessing` par nœuds) et `three/tsl`
   (`three.tsl.js`, `src/nodes/gpgpu/`). Aucune mise à jour n'est nécessaire.
   `navigator.gpu` est présent sur la machine de test.

2. **R3F 8.18 peut techniquement recevoir un renderer personnalisé** :
   `gl?: Renderer | ((canvas) => Renderer) | ...`. Mais `WebGPURenderer` exige
   `await renderer.init()` avant le premier rendu, et **R3F v8 n'a pas
   d'initialisation asynchrone du renderer** (ajoutée en v9). Faisable en forçant
   `frameloop="never"` jusqu'à résolution, mais fragile.

3. **`postprocessing` 6.39 est WebGL uniquement.** Le `Bloom` actuel devrait
   être remplacé par la chaîne de nœuds de three. Et **les 13 `ShaderMaterial`
   GLSL bruts devraient tous être portés en TSL / `NodeMaterial`.**

**Conclusion : WebGPU est une migration séparée, pas un prérequis.** Et surtout,
elle n'est pas nécessaire pour l'essentiel :

WebGL2 + `EXT_color_buffer_float` + `WebGL3DRenderTarget` + `Data3DTexture`
(tous présents, tous vérifiés disponibles dans three 0.171) suffisent à :

- LUT de transmittance 2D (altitude × angle zénithal) ;
- LUT de diffusion multiple (méthode Hillaire, 32×32) ;
- LUT de ciel 2D (azimut × hauteur) ;
- **volume de perspective aérienne en froxels** (`MAX_3D_TEXTURE_SIZE` = 2048,
  très au-delà des 32×32×32 usuels) ;
- tables de phase de Mie précalculées hors ligne ;
- écrans de phase de turbulence précalculés hors ligne.

Ce qui **exigerait vraiment** WebGPU : un solveur de thermodynamique itératif à
l'exécution, une propagation de Fresnel par FFT à l'exécution, un calcul de Mie
en direct sur une distribution variable. Tous relèvent du long terme, et tous
peuvent d'abord vivre en précalcul hors ligne (Node) exporté en texture.

**Recommandation : rester sur WebGL2 pour les étapes 1 à 6 (§18). Réévaluer
WebGPU au moment où un vrai besoin de compute apparaît — pas avant.**

---

## 11. Faisabilité de chaque sous-système physique

Légende des catégories : **[TR]** temps réel dans cette architecture ·
**[APX]** faisable avec approximations numériques raisonnables · **[PART]**
partiellement · **[CHER]** très coûteux, cas d'usage restreints · **[RG]**
research-grade / irréaliste en temps réel général · **[BLOQ]** bloqué par
l'architecture actuelle.

| # | Sous-système | Cat. | Algo | GPU | Intégration | Mémoire GPU | Recalcul | Cacheable | Doit être runtime |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Transport spectral multi-bandes | **APX** | moyenne | moyenne | **L-1 d'abord** | 8–16 bandes × LUT | à chaque changement d'état | tout le précalcul | intégration CIE finale |
| 2 | Rayleigh physique | **TR** | faible | faible | remplace 3 constantes | négligeable | jamais (analytique) | β_R(λ) tabulé | phase(μ) |
| 3 | Absorption atmosphérique | **TR** | faible | faible | +1 profil de densité | négligeable | profil ozone | sections efficaces | profondeur optique |
| 4 | Mie sur distributions | **APX** | **élevée** | faible à l'exécution | nouveau précalcul Node | ~1–4 Mo de tables | par type d'aérosol | **tout** (Bohren-Huffman hors ligne) | lookup |
| 5 | Single scattering | **TR** | faible | moyenne | déjà là | LUT ciel ~2 Mo | position solaire | LUT | échantillonnage |
| 6 | Multiple scattering | **APX** | moyenne | moyenne | LUT Hillaire 32×32 | ~256 Ko | état atmosphérique | **tout** | lookup |
| 7 | Perspective aérienne | **TR** | faible | moyenne | froxels 32×32×32, indexés par `rangeM` | ~1,5 Mo (RGBA16F) | par image (ou 1/2) | partiellement | oui |
| 8 | Réfraction spectrale | **APX** | moyenne | faible | n(λ,P,T,RH) — Ciddor/Edlén | table 1D | profil atmosphérique | n(λ) et le profil | déviation par direction |
| 9 | Ray bending | **PART** | moyenne | faible | déplacement de sommets, cf. §17 | LUT 1D déviation(h) | profil | LUT | lookup + déplacement |
| 10 | Soleil aplati | **TR** | faible | faible | conséquence directe de #9 | — | — | — | par sommet |
| 11 | Green flash | **PART** | moyenne | faible | conséquence de #8+#9 | — | — | — | **visible seulement à fort zoom** (voir note) |
| 12 | Atmosphère 3D | **CHER** | élevée | élevée | rupture du modèle 1D | 3D volumique, ≥ 32 Mo | continu | non | oui |
| 13 | Gradients thermiques | **PART** | moyenne | faible | profil 1D variable : OK. Champ 3D : non | table 1D | lent | oui | lookup |
| 14 | Mirages (inférieur/supérieur) | **PART** | élevée | moyenne | ray-march à travers un profil fortement stratifié | LUT fine près du sol | profil | profil | marche |
| 15 | Fata Morgana | **BLOQ** | élevée | élevée | **images multiples de sources rasterisées** — cf. L-11 | — | — | — | — |
| 16 | Turbulence (Cn², r₀) | **APX** | moyenne | faible | modèle Hufnagel-Valley → r₀, θ₀ | négligeable | lent | tout | paramètres |
| 17 | Scintillation | **TR** | moyenne | faible | par point dans le vertex shader du `Starfield` | écran de phase ~4 Mo | défilement temporel | l'écran | échantillonnage |
| 18 | Seeing | **TR** | faible | faible | taille de PSF depuis r₀, `gl_PointSize` | — | — | — | oui |
| 19 | Phase screens | **APX** | élevée | faible à l'exécution | **FFT hors ligne** (Node), export en texture | 2–8 Mo | jamais | **tout** | défilement |
| 20 | Propagation Fresnel | **RG** | très élevée | très élevée | FFT par image | — | par image | non | oui |
| 21 | Gouttelettes | **APX** | élevée | faible | même précalcul Mie que #4 | tables | par distribution | tout | lookup |
| 22 | Cristaux de glace | **CHER** | très élevée | faible à l'exécution | ray-tracing dans le cristal, hors ligne | tables de phase | par habitus | tout | lookup |
| 23 | Halos (22°, 46°, parhélies, piliers) | **APX** | élevée | moyenne | découle de #22 + distribution d'orientations | ~2–8 Mo | par population | tout | lookup |
| 24 | Arcs-en-ciel | **APX** | élevée | moyenne | découle de #21 (pic Mie ~138°) | tables | par distribution de gouttes | tout | lookup |

### Notes qui comptent

**#11, green flash.** Physiquement il tombe de #8 + #9 sans code dédié — c'est
exactement le genre d'émergence visée. Mais son extension angulaire est de
l'ordre de **10″**. Au champ par défaut (65° sur ~900 px) un pixel vaut ~4′ :
le flash est **250 fois sous le pixel**. Il ne deviendra visible qu'au champ
serré, que l'application permet déjà (`MIN_FOV = 0,02°`). À dire clairement au
lieu de le « rendre visible » par un gonflement artificiel.

**#15, Fata Morgana.** C'est le seul **[BLOQ]** de la table, et la raison est
précise : le phénomène produit *plusieurs images* de la même source. Une source
rasterisée n'a qu'une position par sommet. Le lever serait de tracer Soleil et
Lune analytiquement au bout du rayon dévié — mais cela sacrifierait la propriété
qui fait la valeur de la scène actuelle (les éclipses issues du tampon de
profondeur). **Arbitrage à poser explicitement au moment venu ; ne pas le
trancher par inadvertance en cours de route.**

**#12, atmosphère 3D.** L'architecture 1D à symétrie sphérique est ce qui rend
tout le reste abordable. En sortir n'est pas une extension, c'est un autre
moteur. À réserver à des cas locaux (une couche de brouillard, un panache), pas
à l'atmosphère entière.

**#6, diffusion multiple.** C'est ce qui manque le plus visiblement aujourd'hui
— le code le dit lui-même : *« la simple diffusion ne restitue pas l'arche
bleue, la ceinture de Vénus »*. C'est aussi le meilleur rapport
gain/coût de toute la liste.

---

## 12. Risques techniques

| Risque | Gravité | Mitigation |
| --- | --- | --- |
| Le passage en HDR linéaire casse *tout* le rendu d'un coup (13 matériaux, tokens de couleur, bloom, sol, étiquettes) | **élevée** | Le faire **en premier**, isolément, à rendu constant : introduire la passe d'affichage, puis retirer le tone mapping matériau par matériau, en validant par `shoot.mjs` à chaque étape |
| `EffectComposer` conditionnel au calque `bloom` → deux formats de tampon | moyenne | Rendre la passe d'affichage inconditionnelle ; le bloom devient un effet parmi d'autres |
| Régression de l'éclipse du 12 août 2026 (propriété testée) | **élevée** | `verify` la couvre déjà ; l'exécuter à chaque étape, ne jamais toucher `sceneDepth` |
| Migration WebGPU entreprise trop tôt | moyenne | §10 : ne pas l'entreprendre avant qu'un besoin de compute soit démontré |
| StrictMode + `useMemo(build…, [])` : recréation de matériaux lourds | faible | déjà stable ; surveiller si des LUT deviennent des ressources coûteuses (prévoir une libération explicite) |
| `MAX_3D_TEXTURE_SIZE` = 2048 sur la machine de test, mais mobile/PWA visée (manifest iOS) | moyenne | **Mesurer sur iOS avant de dimensionner les froxels.** Safari/WebGL2 a des limites plus basses et pas de `EXT_color_buffer_float` garanti |
| Explosion du nombre de variantes de shaders (spectral × bandes × options) | moyenne | Générer le GLSL depuis TS, comme aujourd'hui — le patron existe |

---

## 13. Risques scientifiques

**Ce qui n'est pas suffisamment défini dans le projet actuel et ne doit pas être
inventé silencieusement :**

1. **`SUN_INTENSITY_REF = 22`** — sans unité, sans dérivation. À remplacer par
   une irradiance spectrale au sommet de l'atmosphère issue d'une référence
   nommée (ASTM E-490, ou Chance & Kurucz). *Ne pas « convertir » 22 en quoi que
   ce soit : le jeter.*
2. **`RAYLEIGH_COEFFICIENTS`** — à recalculer depuis une formulation publiée
   (Bodhaine et al. 1999, avec facteur de dépolarisation de King), pas à
   interpoler depuis les trois valeurs héritées.
3. **`MIE_COEFFICIENT`, `MIE_G = 0,758`, hauteur d'échelle 1 200 m** — valeurs
   d'usage graphique. Un modèle physique exige une **distribution de tailles**
   (log-normale, ou modèles OPAC), un indice de réfraction complexe, et en sort
   σ_sca, σ_abs, g et la fonction de phase. **L'albédo de diffusion simple
   manque totalement aujourd'hui.**
4. **`turbidityFromSurfaceAerosol`** — la loi de puissance à deux ancres
   (PM2,5 = 3 → trouble 1 ; PM2,5 = 200 → trouble 6) est une construction du
   projet, honnêtement documentée comme telle. Le lien physique PM2,5 → σ_ext
   dépend de la densité, de l'hygroscopicité et de la distribution : il demande
   un modèle de mélange, pas une loi ajustée.
5. **`8e-4`, plancher d'éclairement pendant la totalité** — ordre de grandeur
   plausible et documenté, mais c'est un plancher, pas un calcul. La luminance
   du ciel dans l'ombre est un transport horizontal depuis l'extérieur de la
   pénombre : **honnêtement difficile**, et hors de portée d'un modèle 1D.
6. **Rougissement stellaire `exp(-0,035x)`, `exp(-0,085x)`** — deux constantes
   ajustées, à remplacer par la transmittance spectrale.
7. **`Cn²`, `r₀`, profils de turbulence** — absents du projet. Un modèle nommé
   sera nécessaire (Hufnagel-Valley 5/7 est le point de départ conventionnel) ;
   les valeurs de site réelles ne sont pas dérivables des données actuellement
   branchées.
8. **Indice de réfraction de l'air** — absent. Ciddor (1996) ou Edlén révisé,
   avec dépendance explicite à λ, P, T et pression partielle de vapeur d'eau.
   `AtmosphereState` prévoit l'humidité ; **aucune source de données ne
   l'alimente aujourd'hui.**

**Risque scientifique transverse :** le projet a jusqu'ici validé sa physique
contre des références *externes* (astronomy-engine, éphémérides publiées, atlas
de pollution). Pour l'atmosphère, il n'existe pas d'équivalent aussi commode.
La validation devra s'appuyer sur des **valeurs tabulées publiées** (§16), et
certaines resteront invalidables autrement que par jugement.

---

## 14. Risques de performance

### Baseline mesurée

Mesures Playwright, Chromium/ANGLE D3D11, RTX 3060, viewport 1440×900.

**Frametime applicatif : inexploitable.** Les 9 scénarios (midi, Soleil bas,
coucher, crépuscule, nuit, zénith, horizon, anti-Soleil, zoom ×130) rendent tous
à **60,0 ± 0,4 fps / 16,70 ms médian**, verrouillé au vsync. Aucune marge n'est
lisible. Le panneau latéral réduisait de plus le canvas à 940×884.

Ce qui reste exploitable :

| Grandeur | Valeur |
| --- | --- |
| Draw calls | 22 (midi) à 30 (coucher) ; **5 sans bloom**, 2 en ciel seul |
| Triangles | 13 k (midi) à 86 k (zénith/coucher) |
| Programmes GLSL | 25 (50 shaders) |
| Textures | ~44 Mo (cartes de surface planétaires) |
| Buffers | 1,7 Mo |
| Tas JS | 32 Mo |
| Erreurs console | **0** |

Le bloom coûte 17 draw calls sur 22 — c'est le poste le plus lourd en nombre
d'appels, pour un effet dont §7 recommande de toute façon la refonte.

### Le chiffre qui compte

Microbenchmark du **noyau de diffusion seul**, compilé depuis
`ATMOSPHERE_GLSL`, plein écran, synchronisé par `readPixels` :

> ⚠️ **Les chiffres de la première rédaction étaient faux.** Ils sont conservés
> plus bas, avec l'explication : une erreur de méthode de mesure vaut d'être
> documentée, pas effacée.

**Mesure corrigée** (banc isolé, chauffe au temps, médiane de 9 échantillons) :

| Grandeur | Valeur |
| --- | --- |
| Coût du noyau | **0,95 ns/pixel** |
| Dispersion inter-exécutions | ±7 % |
| Dispersion intra-exécution | 3 à 11 % |

**Coût linéaire en pixels → strictement fill-rate bound.** Extrapolation aux
conditions réelles de l'application (`dpr` plafonné à 2) :

| Cible | Pixels | Voûte seule | Part d'une image à 60 Hz |
| --- | --- | --- | --- |
| 1440×900 @ dpr 1 | 1,3 Mpx | ~1,2 ms | 7 % |
| 1440×900 @ dpr 2 | 5,2 Mpx | **~4,9 ms** | **~30 %** |
| 1920×1080 @ dpr 2 | 8,3 Mpx | ~7,9 ms | ~47 % |

#### L'erreur de mesure, et pourquoi elle est instructive

La première rédaction annonçait 1,83 ns/pixel et 9,5 ms à dpr 2. Deux défauts
cumulés, chacun gonflant le résultat :

1. **Le banc tournait dans l'onglet de l'application.** Le rendu de la scène, à
   soixante images par seconde, s'ajoutait à la mesure. Le symptôme qui l'a
   révélé : le chiffre est passé de 1,53 à 2,74 ns/px au fil du refactor de la
   phase 0.5, **alors que le GLSL mesuré n'avait pas changé d'un caractère**.
2. **La chauffe était trop courte** — quatre passes, quelques millisecondes. Un
   GPU au repos tourne à fréquence réduite et met des centaines de
   millisecondes à monter : le banc mesurait la montée en fréquence autant que
   le noyau. D'où des écarts de 40 % entre deux exécutions identiques.

Le banc s'exécute désormais dans une page vierge servie par Vite, **avant** que
l'application ne soit chargée, avec 400 ms de chauffe et la médiane de neuf
échantillons — et il **rend sa dispersion avec sa mesure**. Un chiffre de
performance sans son incertitude ne permet pas de juger une régression.

À dpr 2 sur une RTX 3060, **la seule voûte consomme environ 30 % d'une image à
60 Hz** —
et l'intégrale est ensuite *refaite intégralement* sur chaque fragment de
planète, d'avion et de traînée. Sur un GPU intégré ou un iPhone (cible PWA
déclarée dans le manifest), le budget est déjà dépassé aujourd'hui.

### Ce qu'on en déduit

**Le budget ne se décrète pas : il se libère.** Un pipeline Bruneton/Hillaire
remplace l'intégrale par ~3 accès de texture, soit un coût plein écran de
l'ordre de 0,1–0,3 ms. Les **~5 ms rendues** constituent le budget réel de la
diffusion multiple, de la perspective aérienne en froxels, de la réfraction et
de la turbulence — le tout **à coût inférieur à l'actuel**.

C'est le principal argument économique de cette refonte, et il est mesuré, pas
supposé.

**Risques résiduels :** coût de reconstruction des LUT lors d'une avance rapide
du temps (×86400 : la position solaire change à chaque image → invalidation
continue). Mitigation : amortir la reconstruction sur plusieurs images, ou
réduire la résolution des LUT pendant l'accélération. C'est un cas d'usage réel
de l'application, pas une hypothèse.

---

## 15. Dépendances nécessaires

**À l'exécution : aucune nouvelle dépendance n'est requise.** Ni pour les LUT,
ni pour les froxels, ni pour le spectral, ni pour la turbulence. Tout tient dans
three 0.171 + WebGL2.

**Hors ligne (`scripts/`, Node), à ajouter au fil des étapes :**

| Besoin | Nature | Étape |
| --- | --- | --- |
| Spectre solaire hors atmosphère | **fichier de données** (ASTM E-490 ou Chance-Kurucz), commité comme les catalogues | 2 |
| Fonctions colorimétriques CIE 1931 x̄ ȳ z̄ | fichier de données | 2 |
| Sections efficaces d'absorption de l'ozone (Chappuis) | fichier de données | 3 |
| Profil d'atmosphère standard (US Standard 1976) | table ou implémentation directe | 1 |
| Calcul de Mie (Bohren-Huffman) | ~200 lignes de JS, ou portage d'une implémentation reconnue | 5 |
| FFT pour les écrans de phase | ~150 lignes, ou dépendance légère | 8 |

Le projet a déjà le patron exact pour cela : `npm run data` génère les catalogues
depuis des sources externes et les commit ; `npm run color` bundle par esbuild un
script Node qui importe du TS. **Aucune infrastructure nouvelle.**

---

## 16. Stratégie de tests

`npm run verify` est le foyer naturel : il importe déjà `.ts` directement via
esbuild, expose `check(label, actual, expected, tolerance, unit)` et sort en code
d'erreur. **Un fichier `scripts/verify-atmosphere.mjs` sur le même modèle, ajouté
au `package.json`, suffit.** Chaque solveur doit être une fonction pure en TS,
testable sans GPU — c'est déjà le cas de `photometry.ts`.

| Module | Contrôle | Référence | Tolérance indicative |
| --- | --- | --- | --- |
| **Atmosphère standard** | P(0), P(11 km), P(20 km) | US Standard 1976 : 101 325 / 22 632 / 5 475 Pa | 0,5 % |
| | T(0), T(11 km), gradient troposphérique | 288,15 K / 216,65 K / −6,5 K·km⁻¹ | 0,1 K |
| | ρ(h) vs loi barométrique | analytique | 1 % |
| **Indice de réfraction** | n−1 à 15 °C, 101,325 kPa, 550 nm | ~2,78·10⁻⁴ (Ciddor) | 1·10⁻⁷ |
| | dépendance à P (linéaire), à T (∝1/T) | analytique | 1 % |
| | dispersion n(400)−n(700) | Ciddor | 1·10⁻⁷ |
| | effet de l'humidité (signe et ordre) | Ciddor | qualitatif + ordre |
| **Rayleigh** | β_R(550 nm) au niveau de la mer | **1,149·10⁻⁵ m⁻¹** (calcule depuis Bodhaine 1999 — la valeur de ~1,35·10⁻⁵ annoncee ici en premiere redaction etait erronee, contaminee par la constante de rendu 13,0·10⁻⁶) | 2 % |
| | exposant spectral effectif 400→700 nm | ≈ −4,09 | 0,05 |
| | profondeur optique zénithale à 550 nm | ≈ 0,097 | 3 % |
| | normalisation de la phase : ∮p dΩ = 1 | analytique | 1·10⁻⁶ |
| **Mie** | σ_sca, σ_abs pour une sphère de référence | table Bohren-Huffman publiée | 1 % |
| | facteur d'asymétrie g, distribution donnée | idem | 2 % |
| | normalisation de la phase | analytique | 1·10⁻⁴ |
| | limite x≪1 → retrouve Rayleigh | analytique | 1 % |
| **Réfraction** | réfraction astronomique à h = 90° / 45° / 10° / 0° | ~0″ / 58″ / 5′18″ / **34′50″** (Bennett) | 5 % |
| | aplatissement du Soleil à l'horizon | ~1/5 du diamètre | 15 % |
| | Soleil visible sous l'horizon géométrique | ≈ 0,57° au contact | 10 % |
| **Transport spectral** | luminance du ciel au zénith, Soleil au zénith | valeurs publiées de luminance de ciel clair | ordre de grandeur + monotonie |
| | couleur du Soleil au zénith → CCT | ~5 800 K → ~5 500 K après extinction | 300 K |
| | éclairement horizontal intégré vs `solarIlluminance()` | **`photometry.ts`, déjà testé** | facteur 2 |
| | monotonie : luminance de l'horizon vs hauteur solaire | analytique | strictement |
| **Turbulence** | seeing FWHM depuis r₀ | 0,98 λ/r₀ | 1 % |
| | r₀ depuis un profil Cn² Hufnagel-Valley | valeurs publiées (~10 cm à 500 nm) | 15 % |
| | indice de scintillation σ_I² (régime faible) | formule de Rytov | 20 % |
| | **σ_I² décroît avec le diamètre angulaire** (étoile vs planète) | qualitatif, moyennage d'ouverture | strictement décroissant |

**Trois catégories de contrôles supplémentaires, qui attrapent d'autres bugs :**

- **Invariants sans référence externe.** Conservation de l'énergie (diffusé +
  transmis + absorbé = 1), monotonie (transmittance décroissante avec la masse
  d'air), symétrie (réciprocité du transfert), limites (τ→0 ⇒ T→1). Ce sont eux
  qui ont attrapé les bugs passés du projet (inversion de signe, double comptage).
- **Non-régression numérique par sondes GPU.** `shoot.mjs` sait déjà piloter la
  scène ; une lecture de pixels à des directions fixes, comparée à des valeurs
  de référence commitées, détecte les dérives de rendu. Sondes déjà relevées lors
  de cet audit (RGB, 1440×900, Paris, 21 juin 2026) :

  | Scénario | Zénith | Centre | Bas |
  | --- | --- | --- | --- |
  | Midi, visée h=12° | `74,122,154` | `85,152,182` | `15,18,26` |
  | Coucher, h=5° | `44,46,43` | `228,151,17` | `9,11,17` |
  | Crépuscule nautique | `3,26,101` | `5,7,16` | `1,2,3` |
  | Nuit | `3,4,10` | `3,4,10` | `5,6,15` |

- **Comparaison croisée entre les deux échelles lumineuses du projet.** Le
  moteur spectral et `photometry.ts` calculent la même chose par deux chemins
  indépendants. Les confronter est le test le plus puissant disponible, et il
  ne coûte aucune donnée externe. *Il révèle aussi immédiatement L-3.*

---

## 17. Proposition d'architecture cible

Le principe directeur : **ne pas construire à côté, mais derrière la couture qui
existe déjà.**

```
src/atmosphere/                    ← nouveau, TS pur, testable sans GPU
├── state.ts .................... AtmosphereState : T, P, RH, composition,
│                                  O₃, aérosols, gouttelettes, cristaux,
│                                  turbulence, albédo du sol
├── standard.ts ................. US Standard 1976 : P(h), T(h), ρ(h)
├── refractiveIndex.ts .......... Ciddor : n(λ, P, T, e)
├── spectral/
│   ├── solar.ts ................ irradiance TOA (donnée commitée)
│   ├── cie.ts .................. x̄ ȳ z̄, XYZ → sRGB linéaire
│   └── bands.ts ................ discrétisation en bandes
├── rayleigh.ts ................. Bodhaine : β_R(λ), phase
├── mie.ts ...................... Bohren-Huffman (précalcul hors ligne)
├── absorption.ts ............... O₃ Chappuis, profils
├── turbulence.ts ............... Cn²(h) → r₀, θ₀, σ_I²
└── lut/
    ├── transmittance.ts ........ génération LUT 2D
    ├── multiScatter.ts ......... LUT Hillaire 32×32
    └── skyView.ts .............. LUT ciel

src/scene/atmosphere/              ← remplace atmosphere.ts, MÊME INTERFACE
├── uniforms.ts ................. projection GPU de AtmosphereState
├── luts.tsx .................... passes hors écran (WebGLRenderTarget)
├── aerialPerspective.tsx ....... froxels, indexés par rangeM
├── rte.glsl.ts ................. hazeColorTo() — signature INCHANGÉE
├── refraction.glsl.ts .......... refract(dir, λ) pour les VERTEX shaders
└── turbulence.glsl.ts .......... jitter, PSF, scintillation

src/scene/display/                 ← nouveau, prérequis n°1
└── DisplayPass.tsx ............. UNIQUE transform : radiance → XYZ → sRGB
```

### Les trois décisions structurantes

**A. La passe d'affichage unique.** `ATMOSPHERE_TONEMAP_FN` sort des matériaux.
Tous les shaders émettent de la **radiance linéaire**, sans borne. Le renderer
rend dans un tampon `HalfFloatType` inconditionnel, et une passe finale applique
XYZ → sRGB + adaptation d'exposition. Le bloom devient un effet de cette chaîne
au lieu d'en conditionner le format. **Rien d'autre n'est possible avant.**

**B. La couture RTE est préservée à l'identique.**

```glsl
vec3 hazeColorTo(vec3 dir, float maxPath, out vec3 transmittance);
```

Trois matériaux l'appellent aujourd'hui ; ils continueront, sans modification.
Seule l'implémentation change : de 128 `exp()` par fragment à 2–3 `texture()`.
**C'est ce qui rend la migration incrémentale au lieu d'être un big bang.**

**C. La réfraction entre par les vertex shaders.** Elle ne peut pas vivre dans le
fragment shader : elle déplace les objets. Or *toute* la scène place déjà ses
objets par des directions manipulées dans des vertex shaders — étoiles
(`Starfield`), corps (`Bodies`), avions, grilles. Une fonction partagée

```glsl
vec3 refractDirection(vec3 dir, float lambdaNm);
```

injectée par le même mécanisme de chaînes GLSL qui a diffusé `hazeColorAlong`
dans trois fragment shaders, donne :

- la réfraction astronomique (déplacement en hauteur) ;
- **l'aplatissement du Soleil gratuitement** — le limbe inférieur est déplacé
  plus que le supérieur, la sphère se déforme d'elle-même ;
- la dispersion, en évaluant à trois (ou N) longueurs d'onde ;
- le green flash, comme conséquence, sans une ligne qui le nomme.

La caméra reste inchangée. La géométrie d'occultation reste inchangée.
**L'éclipse continue de tomber du tampon de profondeur.**

### Ce qui reste hors du moteur

Three.js garde la scène, la caméra, les objets, les corps célestes, le rendu
final — exactement le partage décrit dans la vision. `astro/` reste une couche
pure sans React, et **conserve sa géométrie non réfractée** : la réfraction
devient une propriété du rendu, pas des éphémérides. C'est le bon découpage, et
c'est déjà l'intention annoncée dans les commentaires du code.

---

## 18. Ordre recommandé d'implémentation

Chaque étape est livrable, testable, et laisse l'application fonctionnelle.

| # | Étape | Livrable | Débloque |
| --- | --- | --- | --- |
| **0** | `scripts/verify-atmosphere.mjs` + atmosphère standard (US 1976) | premiers contrôles verts | la méthode de travail |
| **1** | **Passe d'affichage HDR linéaire** — retirer le tone mapping des 13 matériaux, à rendu constant | pipeline linéaire | **tout le reste** |
| **2** | Ancrage radiométrique : spectre solaire TOA, CIE, XYZ→sRGB ; jeter `SUN_INTENSITY_REF` et `atmosphereExposure` | échelle physique unique | validation croisée avec `photometry.ts` |
| **3** | Rayleigh + absorption ozone dérivés (Bodhaine, Chappuis) ; altitude de l'observateur ; albédo du sol | vrai Rayleigh spectral | fin de L-5, L-7 |
| **4** | **LUT de transmittance + LUT de ciel** — infrastructure de render targets | **~5 ms libérées** | tout le budget |
| **5** | Diffusion multiple (LUT Hillaire) | arche bleue, ceinture de Vénus | crépuscule correct |
| **6** | Perspective aérienne en froxels (indexés par `rangeM`) | avions, sol, satellites cohérents | fin de L-10 |
| **7** | Mie physique : précalcul Bohren-Huffman, distributions, ω₀ | aérosols absorbants, halo solaire réel | **retrait de `glowMaterial()`** |
| **8** | Indice de réfraction (Ciddor) + `refractDirection()` en vertex | réfraction, Soleil aplati, dispersion, green flash | #9, #10, #11 |
| **9** | Turbulence : Cn² → r₀ ; PSF et jitter | seeing | — |
| **10** | Écrans de phase précalculés → scintillation ; moyennage d'ouverture | **différence étoile/planète émergente** | — |
| **11** | Sources nocturnes physiques : airglow, pollution lumineuse et clair de lune **dans** le RTE | **retrait du socle nocturne peint** | conformité complète à la règle |
| **12** | Profils thermiques stratifiés → mirage inférieur | mirages | — |
| **13** | Microphysique : gouttelettes, cristaux, halos, arcs | phénomènes de #21 à #24 | — |

**Note sur l'ordre.** L'étape 1 est un refactor sans gain visible qui touche tout
le rendu : la tentation de la sauter sera forte. Ne pas la sauter. Les étapes 2
et 4 en dépendent entièrement, et tout ce qui serait construit avant devrait
être refait.

L'étape 11 est placée tard **volontairement** : le socle nocturne peint est laid
du point de vue de la règle, mais il ne bloque rien, et le retirer avant d'avoir
les sources physiques laisserait un ciel nocturne noir et sans étoiles lisibles.

---

## 19. Estimation relative de complexité

Échelle relative, sans jours-homme : **S** < **M** < **L** < **XL**.

| Étape | Complexité | Risque de régression | Commentaire |
| --- | --- | --- | --- |
| 0 — harnais de tests | **S** | nul | le patron existe |
| 1 — HDR linéaire | **L** | **élevé** | touche 13 matériaux, le bloom, le sol, les tokens |
| 2 — ancrage radiométrique | **M** | moyen | données externes + validation croisée |
| 3 — Rayleigh/ozone dérivés | **S** | faible | remplacement de constantes |
| 4 — LUT + render targets | **L** | moyen | infrastructure nouvelle, gain de perf immédiat |
| 5 — diffusion multiple | **M** | faible | s'ajoute derrière les LUT |
| 6 — froxels | **L** | moyen | 3D render target, indexation par `rangeM` |
| 7 — Mie physique | **XL** | faible | gros précalcul hors ligne, faible risque à l'exécution |
| 8 — réfraction | **L** | **élevé** | déplace les objets ; interagit avec le pointage, les étiquettes, `picking.ts` |
| 9 — seeing | **S** | faible | — |
| 10 — scintillation | **M** | faible | précalcul FFT |
| 11 — sources nocturnes | **L** | moyen | change tout le rendu de nuit |
| 12 — mirages | **XL** | moyen | ray-march stratifié |
| 13 — microphysique | **XL** | faible | très gros précalcul, phénomènes rares |

**Attention particulière sur l'étape 8.** La réfraction déplace les objets à
l'écran, mais `picking.ts` et `fieldLabels.ts` calculent la désignation et les
étiquettes en **coordonnées horizontales géométriques**. Si le rendu réfracte et
que le pointage ne réfracte pas, on cliquera à côté des objets près de l'horizon
— d'un demi-degré, soit plus d'un diamètre solaire. **La réfraction doit être
disponible côté CPU en même temps que côté GPU.** C'est exactement ce que le
commentaire de `computeBodyState` anticipe en parlant d'une introduction
« cohérente pour toutes les couches ».

---

## 20. Verdict

# GO WITH REFACTOR

**L'architecture permet l'évolution incrémentale visée, et elle la favorise plus
qu'elle ne l'entrave.** La couture du transfert radiatif existe déjà et est
consommée par trois matériaux ; les unités SI y sont déjà ; la géométrie
astronomique est vérifiée numériquement et délibérément non réfractée ; le
harnais de tests et le harnais visuel existent tous les deux ; et le budget de
performance nécessaire est *dans* le code actuel, immobilisé par une intégrale
recalculée sans cache.

**Mais quatre éléments fondamentaux doivent être restructurés d'abord**, et
aucun ne peut être contourné :

1. **La chaîne linéaire HDR** (§8 L-1). Le tone mapping est dans les matériaux ;
   il n'existe aucun endroit où une radiance spectrale puisse vivre. *Prérequis
   absolu de tout le reste.*
2. **L'infrastructure de passes hors écran** (L-2). Zéro render target
   applicatif aujourd'hui ; sans elle, aucune LUT, donc aucun budget.
3. **L'ancrage radiométrique** (L-3). Deux échelles lumineuses parallèles et non
   réconciliées coexistent : le bilan en lux, physique et testé, et l'exposition
   du shader, arbitraire. Les unifier est aussi le meilleur test disponible.
4. **La cohérence de la réfraction entre rendu et pointage** (§19). À traiter
   au moment de l'étape 8, pas après.

**Une seule limite dure a été identifiée** : la Fata Morgana à images multiples
(§11 #15) est incompatible avec des corps rasterisés, et la lever coûterait la
propriété qui fait aujourd'hui la valeur de la scène — les éclipses issues du
tampon de profondeur. **Ce n'est pas une raison de ne pas commencer ; c'est un
arbitrage à poser explicitement le jour où il se présentera, et non à trancher
par inadvertance.**

Le reste des 24 sous-systèmes est atteignable, dont 7 en temps réel direct et 10
avec des approximations numériques contrôlées — c'est-à-dire précisément ce que
la vision autorise.

---

### Annexe — points signalés, non inventés

Conformément à la consigne, les grandeurs suivantes sont **absentes ou
insuffisamment définies** dans le projet actuel et n'ont pas été comblées
silencieusement : irradiance solaire spectrale hors atmosphère · coefficients de
Rayleigh dérivés avec dépolarisation · albédo de diffusion simple des aérosols ·
distribution de tailles des aérosols · indice de réfraction complexe des
aérosols · indice de réfraction de l'air (λ, P, T, humidité) · humidité relative
(aucune source de données branchée) · profil de Cn² · albédo du sol · sections
efficaces d'absorption de l'ozone · fonctions colorimétriques CIE · SED des
planètes (seul B−V stellaire est disponible, via `bvToRgb`).

*Audit réalisé sur `main` @ `257afd8`. Mesures : Chromium/ANGLE D3D11, NVIDIA
RTX 3060, WebGL 2.0, viewport 1440×900.*
