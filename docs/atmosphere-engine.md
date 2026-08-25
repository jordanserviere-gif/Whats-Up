# Moteur atmosphérique — documentation des modules

Documentation vivante du moteur d'optique atmosphérique physiquement fondé.
Voir [`atmosphere-engine-audit.md`](atmosphere-engine-audit.md) pour l'audit
d'intégration qui précède, et [`atmosphere-progress.md`](atmosphere-progress.md)
pour l'état d'avancement des phases.

## Principe

Le moteur ne code pas les phénomènes, il code leurs causes :

```
état physique → propriétés optiques → transport de lumière → image observée
```

Un phénomène est correctement implémenté s'il apparaît **parce que ses causes
sont présentes**. Aucun `sunsetColor`, aucun `greenFlashStrength`, aucune
condition sur la hauteur du Soleil.

## Conventions transverses

### Unités

Tous les solveurs travaillent en **SI strict**. Aucune unité Three.js ne
traverse la frontière — voir [`core/units.ts`](../src/atmosphere/core/units.ts),
qui est le seul endroit où une grandeur change de monde.

| Grandeur | Unité | Convention de nommage |
| --- | --- | --- |
| Longueur | m | `…M` (`altitudeM`, `rangeM`) |
| Pression | Pa | `…Pa` |
| Température | K | `…K` |
| Masse volumique | kg/m³ | `…KgPerM3` |
| Densité numérique | m⁻³ | `…PerM3` |
| Coefficient d'extinction | m⁻¹ | `…PerM` |
| Angle | rad dans les solveurs, ° aux interfaces | `…Rad` / `…Deg` |
| **Longueur d'onde** | **nm** aux interfaces | `lambdaNm`, **sans exception** |

Le choix du nanomètre pour λ est délibéré : la littérature optique parle en
nanomètres, et une interface en `5,5·10⁻⁷ m` serait illisible et propice aux
erreurs d'ordre de grandeur. Les conversions vers le mètre sont locales aux
formules qui l'exigent.

### Les trois rayons terrestres

Le projet en utilise trois, et c'est correct. Les confondre serait une erreur ;
les unifier aussi.

| Constante | Valeur | Question à laquelle elle répond |
| --- | --- | --- |
| `EARTH_RADIUS_KM` (`astro/coords.ts`) | 6 378,137 km | où est physiquement l'observateur ? (WGS84 équatorial) |
| `EARTH_MEAN_RADIUS_M` (`core/units.ts`) | 6 371 km | quelle épaisseur d'air le rayon traverse-t-il ? |
| `US1976_EARTH_RADIUS` (`core/constants.ts`) | 6 356,766 km | quelle altitude géopotentielle correspond à cette altitude géométrique ? |

Le troisième n'est même pas une longueur géométrique : c'est un paramètre de
changement de variable.

### Directions

Le repère de la scène (**+X est, +Y zénith, −Z nord**) *est* un repère physique
local orthonormé. Un vecteur unitaire y est le même objet mathématique que dans
le repère topocentrique d'un solveur : **aucune conversion n'est nécessaire**.
C'est cette propriété qui rend l'intégration possible, et elle est vérifiée à
10⁻¹² par `core/units.validation.ts`.

En revanche, **une profondeur de scène n'est pas une distance** : elle est
comprimée en logarithme (`7,375·log₁₀(d_km) + 0,4`). Un rapport de distances de
4,5 milliards s'y comprime en un rapport de profondeurs de 179. La distance
réelle doit donc **voyager séparément**, en mètres, dans un uniform — patron
déjà établi par `uRangeM` dans les matériaux d'avion.

---

## Modules

### `core/constants.ts`

**Rôle.** Constantes physiques fondamentales, chacune avec sa source.

**Le point délicat.** `GAS_CONSTANT` (8,314462618, produit exact de constantes
SI 2019) et `US1976_GAS_CONSTANT` (8,31432) **coexistent volontairement**. Les
tables publiées de l'US1976 ont été calculées avec la seconde ; utiliser la
première décale la pression de quelques pascals en altitude et fait échouer une
validation serrée. Ce n'est pas une incohérence, c'est la différence entre un
modèle normatif et une constante de la nature.

**Fréquence.** Constantes de compilation.
**Cache.** Sans objet.
**Tests.** Indirects, via toutes les suites qui les consomment.

| Constante | Valeur | Source |
| --- | --- | --- |
| `BOLTZMANN` | 1,380649·10⁻²³ J/K | SI 2019, **exacte** |
| `AVOGADRO` | 6,02214076·10²³ mol⁻¹ | SI 2019, **exacte** |
| `STANDARD_GRAVITY` | 9,80665 m/s² | 3ᵉ CGPM (1901), exacte |
| `DRY_AIR_MOLAR_MASS` | 0,0289644 kg/mol | US1976 |
| `US1976_GAS_CONSTANT` | 8,31432 J/(mol·K) | US1976, **normative** |
| `US1976_EARTH_RADIUS` | 6 356 766 m | US1976 |
| `DEFAULT_CO2_MOLE_FRACTION` | 420 ppm | **paramètre**, pas une constante |
| `SOLAR_CONSTANT` | 1361 W/m² | valeur nominale — sert de **contrôle d'intégration** du futur spectre, pas d'entrée |

---

### `core/units.ts`

**Rôle.** Frontière physique ↔ rendu. Conversions de longueurs, angles,
longueurs d'onde ; position de l'observateur ; transport des directions.

**Point notable.** `observerPosition(elevationM)` rend `elevationM`
**obligatoire**. Le rendu actuel place l'observateur au niveau de la mer en dur
alors que le lieu porte son altitude — jusqu'à 2 877 m au Pic du Midi, où un
quart de la masse atmosphérique est déjà sous l'observateur. Ce n'est pas une
approximation, c'est une autre atmosphère ; le paramètre est donc non
optionnel pour qu'aucun appelant ne puisse l'omettre par défaut.

`directionFromHorizontal` duplique volontairement `viewDirection` de
`scene/sceneMath.ts` : le solveur ne doit pas dépendre du module de scène, sous
peine d'ouvrir un chemin par lequel une unité de rendu remonterait jusqu'à la
physique. La duplication est transformée en **invariant testé** plutôt qu'en
dette.

**Fréquence.** Fonctions pures, appelées à la demande.
**Cache.** Sans objet.
**Tests.** `core/units.validation.ts` — 33 contrôles.

---

### `thermodynamics/standardAtmosphere.ts`

**Rôle.** Profil vertical de température, pression, masse volumique et densité
numérique.

**Modèle.** U.S. Standard Atmosphere 1976, couches 0 à 7, jusqu'à 84,852 km
d'altitude géopotentielle. Identique à l'ISA de l'OACI jusqu'à 32 km.

**Équations.**

```
dP/dh = −ρg          ρ = PM/(R*T)          N = P/(k_B T)

L ≠ 0 :  P(H) = P_b · [T_b/(T_b + L(H − H_b))]^(g₀M/(R*L))
L = 0 :  P(H) = P_b · exp[−g₀M(H − H_b)/(R*T_b)]

H = r₀z/(r₀ + z)       (altitude géopotentielle)
```

**Pourquoi l'altitude géopotentielle.** Les équations supposent `g` constante.
Elle ne l'est pas. Plutôt que de traîner `g(h)` dans chaque intégrale, le
changement de variable l'absorbe dans la géométrie : dans ce système, `g₀` est
constante *par construction*. L'écart n'est pas négligeable — 11 km
géopotentiels valent 11,019 km géométriques, et l'écart atteint 250 m à 80 km.

**Toute l'API publique prend une altitude géométrique en mètres**, parce que
c'est ce qu'un marcheur de rayons connaît. La conversion est interne.

**Approximation numérique.** Aucune : l'intégration hydrostatique est
analytique et exacte à l'intérieur de chaque couche. Les **pressions de base
sont dérivées par récurrence** depuis les seules valeurs définissantes, jamais
recopiées des tables — ce qui rend la validation contre ces tables non
circulaire.

**Domaine de validité.** 84,852 km géopotentiels. Au-delà, ce module
**extrapole** de façon isotherme, et le signale (`extrapolated: true`).
L'extrapolation porte moins de 4·10⁻⁶ de la colonne, donc elle est sans effet
optique — mais elle n'est pas l'US1976, et ne doit pas être présentée comme
telle.

**Fréquence.** Calcul de précomputation (génération de LUT, validation).
Alloue un objet par appel : les marcheurs de rayons échantillonneront une
table, pas cette fonction.
**Cache.** À prévoir en phase 4 (LUT de transmittance).

**Tests.** `standardAtmosphere.validation.ts` — 3 familles :

1. contre les tables publiées (8 altitudes × T, P, ρ) ;
2. contre une constante de la nature — le nombre de Loschmidt, qui ne vient
   d'aucune table atmosphérique ;
3. **contre les équations elles-mêmes** — l'intégration analytique reconfrontée
   à une intégration numérique de Simpson indépendante. Ce contrôle ne dépend
   d'aucune donnée extérieure.

Plus continuité aux 6 interfaces de couches, monotonie de P/ρ/N, non-monotonie
de T (la remontée stratosphérique), et aller-retour géométrique↔géopotentiel.

**Résultats mesurés.**

| Grandeur | Valeur | Écart aux tables |
| --- | --- | --- |
| P(11 km′) | 22 632,06 Pa | 1,8·10⁻⁷ |
| P(84,852 km′) | 0,3734 Pa | 4,4·10⁻⁵ |
| Analytique vs Simpson | — | < 10⁻¹³ |
| Hauteur d'échelle au sol | 8 435 m | — |
| Hauteur d'échelle à la tropopause | **6 342 m** | — |

> La dernière ligne est instructive : le moteur de rendu actuel fige la hauteur
> d'échelle Rayleigh à 8 000 m. La vraie hauteur d'échelle varie de 6 342 m à
> 8 435 m selon l'altitude, parce qu'elle suit la température.

---

### `thermodynamics/waterVapour.ts`

**Rôle.** Pression de vapeur saturante et humidité.

**Pourquoi dès la phase 1.** L'humidité n'a aucun effet optique direct notable
dans le visible. Elle est pourtant une variable d'état de premier plan :
l'indice de réfraction de l'air en dépend (phase 10), et **c'est elle qui
condense** — gouttelettes, brume et cristaux (phase 18) n'apparaîtront pas par
décret mais parce que la vapeur atteint la saturation.

**Modèle.** Buck, A. L. (1981), *New Equations for Computing Vapor Pressure and
Enhancement Factor*, J. Appl. Meteorol. **20**, 1527–1532, équations `ew2`
(eau liquide) et `ei2` (glace).

```
e_w(T) = 6,1121 · exp[(18,678 − T_c/234,5) · T_c/(257,14 + T_c)]   hPa
e_i(T) = 6,1115 · exp[(23,036 − T_c/333,7) · T_c/(279,82 + T_c)]   hPa
```

Domaine annoncé : −80 à +50 °C.

**Confiance.** Les coefficients ont été saisis à la main. Ils sont **validés par
trois ancres indépendantes de la formule** :

| Ancre | Valeur connue | Obtenue | Écart relatif |
| --- | --- | --- | --- |
| e_w(0 °C) | 611,2 Pa | 611,21 Pa | 1,6·10⁻⁵ |
| e_w(20 °C) | 2 338,8 Pa | 2 338,3 Pa | 2,0·10⁻⁴ |
| e_w(50 °C) | 12 344 Pa | 12 349 Pa | 4,4·10⁻⁴ |

Une faute de frappe dans un coefficient déplacerait la courbe de plusieurs
pour cent : ces contrôles ne comparent pas la formule à elle-même, c'est tout
leur intérêt.

> ⚠️ **Point de moindre confiance.** Le **facteur d'accroissement**
> `f = 1,0007 + 3,46·10⁻⁶ P` (Buck 1981, `f_w2`) apporte +0,42 % au niveau de
> la mer. Faute d'ancre publiée commode, un coefficient erroné s'y verrait mal.
> Il est isolé dans sa propre fonction, désactivable, et **doit être confronté
> à la publication avant que la phase 10 ne s'en serve**.

**Fréquence.** À la demande. **Cache.** Sans objet.
**Tests.** `waterVapour.validation.ts` — ancres, continuité eau/glace à 0 °C,
`e_i < e_w` sous zéro (l'inversion casserait toute la microphysique froide),
monotonie, et l'invariant contre-intuitif « l'air saturé est moins dense que
l'air sec ».

---

### `state/AtmosphereState.ts`

**Rôle.** État physique de l'atmosphère — l'unique source de vérité dont tous
les solveurs dérivent leurs propriétés optiques.

**Ce qui n'est pas dedans.** Aucune grandeur de rendu : pas de couleur, pas
d'exposition, pas de « trouble », pas d'intensité. Une propriété optique
(coefficient de diffusion, fonction de phase, indice) **s'en déduit** et n'y
appartient pas. C'est ce qui garantit qu'on ne puisse pas régler une couleur en
douce : il faudrait modifier une densité ou une composition, et l'effet se
propagerait partout de façon cohérente.

**Champ 1D.** Toute grandeur est fonction de la seule altitude. Un champ 3D
n'est pas une extension de ce modèle, c'est un autre moteur (phase 13). La
généralisation est cependant préparée sans code mort : les profils verticaux
sont des **fonctions remplaçables**. Une inversion thermique (phase 14) ne
demandera aucun cas particulier, seulement un autre `temperatureOffsetK`.

| Champ | Unité | Statut |
| --- | --- | --- |
| `groundElevationM` | m | actif |
| `temperatureOffsetK(z)` | K | actif — **le** degré de liberté thermique |
| `relativeHumidity(z)` | 0–1 | actif, **profil par défaut non physique** (voir ci-dessous) |
| `groundAlbedo` | — | déclaré, requis par la phase 8 |
| `co2MoleFraction` | — | déclaré, requis par la phase 10 |
| `aerosols` | — | `null` jusqu'à la phase 6 |
| `ozone` | — | `null` jusqu'à la phase 7 |
| `turbulence` | — | `null` jusqu'à la phase 15 |

Les champs non encore modélisés sont typés `null`, et non « présents mais
neutres » — ce qui rendrait indiscernable un aérosol absent d'un aérosol nul.

> ⚠️ **Le profil d'humidité par défaut n'est pas un modèle physique** : il
> maintient l'humidité de surface à toutes les altitudes. La vraie vapeur d'eau
> décroît bien plus vite que l'air. Sans conséquence aujourd'hui — l'humidité
> n'intervient que dans l'indice de réfraction, non branché — mais **à
> remplacer en phase 10**.

**Approximation assumée.** `sampleAtmosphere` applique l'écart de température
**à pression inchangée**. Ce n'est pas rigoureux : une couche réchauffée se
dilate et modifie la colonne au-dessus d'elle. L'écart reste du second ordre
pour quelques kelvins sur quelques dizaines de mètres, alors qu'une
réintégration hydrostatique complète à chaque échantillon coûterait tout. La
densité, elle, **suit** la température corrigée : c'est elle qui porte l'effet
optique. **À revoir en phase 14**, où les gradients deviennent violents.

**Tests.** `AtmosphereState.validation.ts` — l'état par défaut redonne
exactement l'atmosphère standard (à 10⁻¹²), `ρ ∝ 1/T` sous offset, un offset
localisé à 30 m ne déborde pas à 100 m.

---

### `spectral/SpectralGrid.ts`

**Rôle.** Discrétisation du domaine des longueurs d'onde. Le cœur physique
transporte `L(λ)`, pas trois canaux RGB.

**Le nombre de bandes est un curseur qualité/coût, pas une constante
d'architecture.** Aucun module ne code en dur un nombre de bandes ni ne suppose
un pas constant. Défaut : 16 bandes sur 360–830 nm (~29 nm), assez fin pour que
λ⁻⁴ varie proprement sur le visible (facteur 28 entre les bornes), assez
grossier pour tenir dans une LUT.

**Le point qui décide de tout : moyenner, pas échantillonner.** Ramener une
courbe fine sur une grille grossière se fait par **intégration sur la bande**.
Avec la moyenne de bande, `valeur_i × largeur_i` vaut exactement l'intégrale sur
la bande, donc la somme reconstitue l'intégrale totale **quelle que soit la
grille**. Un prélèvement au centre manquerait les pics des fonctions
colorimétriques, perdrait de l'énergie, et l'erreur dépendrait du nombre de
bandes — rendant toute comparaison entre résolutions impossible.

`integratePiecewiseLinear` est **exacte** pour une table interpolée
linéairement, ce qui est la définition d'une donnée expérimentale tabulée. Hors
du domaine tabulé la contribution est nulle : on n'extrapole jamais une mesure.

**Tests.** Intégrale exacte d'une fonction affine, conservation de l'intégrale à
3/8/16/64/300 bandes (écart < 4·10⁻¹⁶), Simpson exact sur un cubique.

---

### `spectral/colourMatching.ts`

**Rôle.** Fonctions colorimétriques CIE 1931 2° — la réponse de l'œil, dernier
maillon avant l'écran.

**Données.** `src/data/cie1931.json`, 360–830 nm à 1 nm, généré par
`npm run data:spectral` depuis la table republiée par `colour-science/colour`
(BSD-3-Clause). **Jamais saisies à la main.**

**Observateur 2° et non 10°** : c'est la convention sur laquelle sRGB est
défini. Le 10° serait plus fidèle à la perception d'un grand champ comme un
ciel, mais briserait la cohérence avec l'espace de sortie. Choix assumé, module
remplaçable.

`LUMINOUS_EFFICACY = 683 lm/W` est **exacte par définition** — c'est ainsi que
la candela est définie depuis 1979.

**Cache.** Les fonctions rééchantillonnées sont mémorisées par grille : c'est un
cache de calcul scientifique, pas une approximation.

**Résultats.**

| Grandeur | Obtenue | Publiée |
| --- | --- | --- |
| ∫x̄ dλ | 106,865 | 106,865 |
| ∫ȳ dλ | 106,857 | 106,857 |
| ∫z̄ dλ | 106,892 | 106,892 |
| Pic de ȳ | 555 nm | 555 nm |
| ȳ au pic | 1,000000 | 1 (normalisation) |

---

### `spectral/blackbody.ts`

**Rôle.** Loi de Planck. Deux usages réels :

1. **Les étoiles.** Le catalogue HYG porte le B−V de chaque étoile, dont
   `astro/catalog.ts` tire déjà une température de couleur. Avec Planck, cette
   température devient une **distribution spectrale d'énergie** : une étoile
   rouge s'éteindra davantage à l'horizon qu'une bleue parce que son spectre est
   différent, non parce qu'on l'aura décidé.
2. **Un juge sans donnée externe.** Voir le bouclage plus bas.

**Équations.** `B_λ(λ,T) = (2hc²/λ⁵)/(exp(hc/λk_BT) − 1)`, rendue en
W·m⁻²·sr⁻¹·**nm⁻¹**. `expm1` évite la perte de précision dans l'infrarouge
lointain.

La constante de Wien est **dérivée** du point fixe de `x = 5(1 − e⁻ˣ)`, pas
saisie : la valeur publiée sert de contrôle (écart 6,4·10⁻¹¹).

`colourTemperatureFromBv` reprend **la même approximation de Ballesteros que
`astro/catalog.ts`**, pour qu'une étoile ne puisse pas avoir deux températures
selon le module qui la regarde.

---

### `spectral/SolarSpectrum.ts`

**Rôle.** L'**entrée** du moteur. Tout le transport atmosphérique consiste
ensuite à retirer et redistribuer de l'énergie de ce spectre. Il remplace
`SUN_INTENSITY_REF = 22`, que son propre commentaire décrivait comme « une
constante de calibrage du modèle, pas une grandeur physique ».

**Données.** ASTM G173-03 colonne *extraterrestrial* (dérivée d'ASTM E-490),
280–4000 nm en W/m²/nm, via `pvlib/pvlib-python` (BSD-3-Clause).

> **Deux nombres à ne pas confondre.** L'intégrale de la table vaut
> **1347,9 W/m²**, pas la constante solaire de 1361 W/m². Les 13,1 W/m² d'écart
> (0,96 %) sont l'infrarouge au-delà de 4 µm et l'UV sous 280 nm, hors du
> domaine tabulé. Renormaliser pour « retrouver » 1361 ajouterait dans le
> visible une énergie qui est ailleurs.
>
> Le domaine qui intéresse le moteur, 360–830 nm, porte **734,8 W/m²** — 54,5 %
> du tabulé.

**Distance.** La table est à 1 UA. L'orbite terrestre étant excentrique, l'écart
périhélie–aphélie atteint **6,9 %** sur l'année — pas négligeable devant les
effets que le moteur cherche à rendre.

---

### `spectral/SpectralSensor.ts`

**Rôle.** `L(λ) → XYZ → RGB linéaire`. Frontière de sortie du moteur : en amont
tout est radiométrique et spectral, en aval tout est colorimétrique.

**Ce module ne fait ni exposition ni tone mapping.** Il rend du RGB linéaire non
borné, qui peut valoir 10⁴ pour un disque solaire, et ne borne pas les
composantes négatives (couleurs hors gamut sRGB, qui arrivent réellement pour un
ciel très saturé). Écraser cela ici perdrait l'information avant que la passe
d'affichage n'ait pu décider quoi en faire. **Le capteur mesure, il ne juge
pas.** C'est précisément ce mélange que le rendu actuel opère dans chaque
matériau — l'objet de la phase 0.5.

**Point de raccord.** La deuxième ligne de `LINEAR_SRGB_TO_XYZ` est la luminance
relative : `(0,2126729, 0,7151522, 0,0721750)` — exactement le triplet déjà
utilisé par `scene/atmosphere.ts` dans sa resaturation. Ce n'est pas une
coïncidence, et la validation le vérifie.

**`luminance()` est le pont vers `astro/photometry.ts`**, qui calcule déjà tout
son bilan en lux par un chemin entièrement indépendant. Voir le raccord chiffré
plus bas.

---

### `rayleigh/standardAir.ts`

**Rôle.** Indice de réfraction et facteur de King de l'air standard — les deux
grandeurs optiques qui entrent dans la section efficace de Rayleigh.

**Modèles.** Peck & Reeder (1972) pour la dispersion de l'air sec standard
(15 °C, 101 325 Pa) ; Bodhaine et al. (1999) pour le facteur de King pondéré par
la composition et pour la correction de l'indice à la teneur en CO₂.

```
(n − 1)·10⁸ = 8060,51 + 2480990/(132,274 − σ²) + 17455,7/(39,32957 − σ²)     σ = 1/λ_µm

F_air = (78,084·F_N2 + 20,946·F_O2 + 0,934·F_Ar + C·F_CO2) / (78,084 + 20,946 + 0,934 + C)
F_N2 = 1,034 + 3,17·10⁻⁴σ²      F_O2 = 1,096 + 1,385·10⁻³σ² + 1,448·10⁻⁴σ⁴
```

**Le point qui compte : « standard » n'est pas « approché ».** L'indice calculé
ici est celui de l'air à 15 °C et 101 325 Pa, et ce n'est *pas* une
approximation. La section efficace de Rayleigh est une propriété **moléculaire**,
et la combinaison `(n²−1)/N` qui y intervient est quasi indépendante de la
densité (Lorentz-Lorenz). Évaluer `n` et `N` aux mêmes conditions de référence
donne donc la bonne section efficace partout dans l'atmosphère.

L'indice **local** — celui qui courbe les rayons, qui dépend de P, T et de
l'humidité — est un autre objet, et il arrive à la phase 10 (Ciddor). Les
confondre serait une erreur de nature, pas de précision.

**Le facteur de King n'est pas un détail.** Il vaudrait 1 pour des molécules
sphériques ; l'air étant diatomique il vaut **1,0488** à 550 nm. **La diffusion
Rayleigh réelle est donc près de 5 % plus forte** que ce que donne le modèle
idéalisé.

**Résultats.**

| Grandeur | Obtenue | Publiée |
| --- | --- | --- |
| n(550 nm) − 1 | 2,7782·10⁻⁴ | 2,7782·10⁻⁴ |
| Facteur de King F(550) | 1,0488 | ~1,0484 |
| Dépolarisation ρ(550) | 0,02832 | 0,027–0,030 |

---

### `rayleigh/rayleigh.ts`

**Rôle.** Section efficace, coefficient de diffusion, fonction de phase,
épaisseur optique. **Le premier phénomène optique réel du moteur, et celui d'où
sort la couleur du ciel.**

**Équation.** Bodhaine et al. (1999), eq. 2 :

```
σ(λ) = 24π³ (n² − 1)² / (λ⁴ N_s² (n² + 2)²) × F(air, λ)
β(λ, z) = σ(λ) · N(z)              [m⁻¹]
τ(λ)    = σ(λ) · ∫N dz
```

**Rien ici ne mentionne le bleu.** La section efficace décroît en λ⁻⁴ parce que
c'est ce que donne le calcul ; le ciel est bleu en conséquence.

**λ⁻⁴, mais pas exactement.** L'indice et le facteur de King dépendent eux aussi
de λ. L'exposant effectif **mesuré** sur le visible vaut **4,095**, pas 4.
L'architecture ne suppose nulle part une loi de puissance : elle évalue la
formule complète, et l'exposant est une grandeur mesurée par la validation, pas
une entrée.

**Séparation précalcul / runtime.** `σ(λ)` est moléculaire : elle ne dépend ni de
l'altitude, ni de P, ni de T. Elle se tabule une fois pour toutes. `N(z)` vient
de la phase 1. Leur produit ne se recalcule pour rien. C'est la première
occasion concrète du moteur de séparer ce qui se met en cache de ce qui doit
être runtime.

**Fonction de phase, avec dépolarisation** — pas la forme idéalisée :

```
p(θ) = 3 / (16π(1 + 2γ)) · [(1 + 3γ) + (1 − γ)cos²θ]        γ = ρ/(2 − ρ)
```

La dépolarisation **remonte le minimum à 90°** : `p(0°)/p(90°)` vaut 1,945 au
lieu de 2. C'est mesurable — la lumière du ciel à 90° du Soleil n'est jamais
totalement polarisée — et c'est une des rares corrections de quelques pour cent
qui change une propriété *qualitative* plutôt qu'une intensité.

**Fréquence.** `σ` : une fois. `β` : par échantillon, mais c'est une
multiplication. `τ` zénithale : une intégration de colonne, indépendante de λ,
donc une seule pour tout le spectre.

**Résultats.**

| Grandeur | Valeur |
| --- | --- |
| σ(550 nm) | 4,510·10⁻³¹ m² (4,510·10⁻²⁷ cm²) |
| **τ_R(550 nm), niveau de la mer** | **0,09711** (Bodhaine : 0,0973) |
| β(550 nm), niveau de la mer | **1,149·10⁻⁵ m⁻¹** |
| Exposant spectral effectif | 4,095 |
| σ(450)/σ(650) | 4,50 |
| τ_R(550) au Pic du Midi (2 877 m) | 0,0683 — 30 % de colonne en moins |

> **Le rendu actuel code `13,0·10⁻⁶ m⁻¹` en dur pour le vert.** La valeur
> physique est 1,149·10⁻⁵ — le rendu surestime la diffusion moléculaire
> d'environ 13 %, et ne la fait dépendre ni de l'état de l'atmosphère ni de
> l'altitude de l'observateur.

---

### `validation/harness.ts`

**Rôle.** Harnais de validation numérique, sans renderer, sans DOM, sans GPU.

**Quatre formes de contrôle**, et le choix entre elles n'est pas cosmétique :

| Forme | Quand |
| --- | --- |
| `check` | écart **absolu**, quand la tolérance a un sens physique dans l'unité |
| `checkRelative` | écart **relatif**, quand la grandeur couvre plusieurs ordres de grandeur |
| `checkTrue` | invariant booléen |
| `checkMonotonic` | monotonie d'une série — **ne demande aucune référence externe**, et attrape les erreurs de signe, les plus fréquentes et les plus invisibles |

Une exception levée dans une suite est convertie en échec plutôt que de faire
tomber la campagne : un solveur qui explose sur un cas limite doit apparaître
comme un test rouge parmi les autres.

Les suites rendent des **données**, pas du texte. Le formatage vit dans le
script. Une suite est ainsi consommable par un rapport ou une comparaison entre
deux versions du moteur.

**Enregistrement.** Une nouvelle couche ajoute **une ligne** dans
`validation/suites.ts`. Le script d'exécution n'a pas à la connaître.

---

## Outils

### `npm run verify:atmosphere`

Campagne de validation numérique. Sans GPU, sans navigateur. Code de sortie non
nul en cas d'échec.

```bash
npm run verify:atmosphere              # tout
npm run verify:atmosphere -- vapeur    # filtre sur le nom de suite
```

**État : 249 contrôles, 10 suites, aucun échec.**

### `npm run atmo:baseline`

Coût GPU mesuré + sondes de non-régression colorimétrique. Requiert le serveur
de développement (`npm run dev -- --port 5199`, ou `SHOOT_URL`).

```bash
npm run atmo:baseline              # mesure et compare à la référence
npm run atmo:baseline -- --write   # écrit une nouvelle référence
```

**Pourquoi un banc isolé.** Mesurer les images de l'application ne dit **rien** :
le rendu est verrouillé au vsync et affiche 16,7 ms dans toutes les situations,
quelle que soit la marge réelle. Le noyau est donc compilé seul dans un quad
plein écran, hors de toute scène, et chronométré sur des passes successives
synchronisées par `readPixels`. Le résultat est un coût en **nanosecondes par
pixel**, comparable d'une phase à l'autre.

Chaque phase qui ajoute une physique au GPU ajoute son noyau à `KERNELS` et
hérite de la mesure.

---

## Baseline mesurée

Référence : [`atmosphere-baseline.json`](atmosphere-baseline.json).
Environnement : ANGLE D3D11, NVIDIA RTX 3060, WebGL 2.0, `EXT_color_buffer_float`
et `OES_texture_float_linear` disponibles, `MAX_3D_TEXTURE_SIZE` = 2048,
`navigator.gpu` présent.

### Coût du noyau actuel

Diffusion simple Rayleigh + Mie, 16 pas primaires × 8 pas secondaires :

| Cible | Coût de la seule voûte | Part d'une image à 60 Hz |
| --- | --- | --- |
| 1440×900 @ dpr 1 | 1,98 ms | 12 % |
| 1440×900 @ dpr 2 | **7,93 ms** | **48 %** |
| 1920×1080 @ dpr 2 | 12,69 ms | 76 % |

**1,53 ns/pixel**, linéaire sur trois résolutions → limité par le remplissage,
donc l'extrapolation est valide. Variation entre exécutions : ~7 % (1,53 à
1,63 ns/px mesurés) — c'est le plancher de bruit du banc, à garder en tête
avant de célébrer un gain.

Et cette intégrale est ensuite **refaite intégralement** sur chaque fragment de
planète, d'avion et de traînée.

### Défauts documentés numériquement

Les sondes ne servent pas qu'à la non-régression : elles **chiffrent** ce que
l'audit décrivait.

| Constat | Sondes | Ce que ça révèle |
| --- | --- | --- |
| **Le crépuscule est mort** | à −5,9° (civil), toutes directions ≈ `4,6,13` ; à −11°, ≈ `4,5,12` | la diffusion simple ne produit **rien** au crépuscule ; ces valeurs sont le socle nocturne peint, pas de la physique. Or le crépuscule civil est assez clair pour lire. Cible de la phase 8. |
| **Saturation à l'horizon** | `254,250,241` vers le Soleil bas, `219,221,216` l'après-midi | écrêtage du tone mapping intégré au matériau (L-1 de l'audit) |
| **Horizon anti-solaire suspect au coucher** | `91,27,18` — rouge saturé du côté **opposé** au Soleil | à confronter à la diffusion multiple : la ceinture de Vénus devrait être rosée au-dessus de l'ombre de la Terre, pas orange vif |
| **La nuit est entièrement peinte** | `3,4,10` au zénith, `5,6,15` à l'horizon, identiques dans **toutes** les directions | aucune contribution physique ; c'est `uNight` et son gradient `pow(1−h, 2)`. Cible de la phase 11. |

---

## Données scientifiques à acquérir

Aucune de ces valeurs ne doit être saisie de mémoire. Le dépôt a déjà le patron
adapté : `npm run data` récupère les catalogues depuis des sources externes et
les commite.

| Donnée | Nécessaire à | Source | État |
| --- | --- | --- | --- |
| Spectre solaire hors atmosphère | phase 2 | ASTM G173-03, via pvlib | **acquis** — `src/data/solar-am0.json` |
| Fonctions colorimétriques CIE 1931 | phase 2 | CIE, via colour-science | **acquis** — `src/data/cie1931.json` |
| Sections efficaces de l'ozone (Chappuis) | phase 7 | MPI-Mainz / Serdyuchenko | à acquérir |
| Indice de réfraction complexe des aérosols | phase 6 | OPAC | à acquérir |
| Distribution de tailles d'aérosols | phase 6 | OPAC | à acquérir |
| Profil de Cn² | phase 15 | Hufnagel-Valley 5/7 | à acquérir |
| Coefficients de Ciddor (indice de l'air) | phase 10 | Ciddor (1996), Appl. Opt. 35 | à acquérir |

Les deux premières sont récupérées par `npm run data:spectral`, sur le patron de
`npm run data` : téléchargées depuis une source citée, converties, commitées.
L'application n'a besoin d'aucun réseau à l'exécution.

---

## Raccord chiffré avec le modèle photométrique existant

Le moteur spectral et `astro/photometry.ts` calculent la même physique par deux
chemins entièrement indépendants. Les confronter est la validation la plus forte
disponible dans ce dépôt, et elle ne coûte aucune donnée externe.

| Grandeur | Moteur spectral | `photometry.ts` |
| --- | --- | --- |
| Éclairement solaire, Soleil au zénith | **133,1 klx** hors atmosphère | 120 klx au sol |
| Transmission zénithale impliquée | **90,2 %** | — |

Les 133,1 klx recoupent la littérature (127–136 klx). L'écart avec les 120 klx
au sol *est* l'extinction atmosphérique zénithale : **la phase 3 devra retrouver
90,2 % à partir du Rayleigh seul.** C'est une cible chiffrée, posée avant
d'écrire le code qui doit l'atteindre.

Autres valeurs obtenues, sans équivalent dans le rendu actuel :

| Grandeur | Valeur |
| --- | --- |
| Chromaticité du Soleil hors atmosphère | (0,3234 · 0,3326) |
| Température de couleur corrélée | **5 933 K** (température effective : 5 772 K) |
| Pic de Planck à 5 772 K | 502,0 nm |
| Variation annuelle d'irradiance | 6,9 % |

L'écart entre 5 933 K de température *de couleur* et 5 772 K de température
*effective* n'est pas une erreur : le Soleil n'est pas un corps noir parfait,
son spectre est creusé de raies de Fraunhofer.

---

## Le raccord se referme — phase 3

La cible posée en phase 2 était : **retrouver 90,2 % de transmission zénithale à
partir du Rayleigh seul**. Elle a été écrite avant que le module n'existe.

| Chemin | Éclairement, Soleil au zénith |
| --- | --- |
| Spectre ASTM G173 → CMF CIE → luminance | **133,1 klx** hors atmosphère |
| … × transmittance Rayleigh (Bodhaine + US1976) | **120,9 klx** au sol |
| `astro/photometry.ts`, paliers tabulés depuis la littérature des crépuscules | **120 klx** au sol |

**0,7 % d'écart entre deux chaînes de calcul qui ne partagent aucune ligne de
code.** L'une part d'un spectre solaire mesuré et des fonctions colorimétriques
CIE ; l'autre de paliers d'éclairement relevés dans la littérature. Elles se
rejoignent à travers une extinction calculée depuis la théorie de Rayleigh et un
profil de densité hydrostatique.

Transmission obtenue : **90,81 %** en pondération photopique (90,75 % à 550 nm
seul) contre 90,2 % visés.

L'écart résiduel est attendu et a un nom : il manque encore l'**ozone**
(phase 7) et les **aérosols** (phase 6), qui retirent tous deux de la lumière.
Le Rayleigh seul devait donc transmettre *un peu plus* que la réalité — c'est ce
qu'on observe.

### Et le coucher de Soleil, sans code dédié

À masse d'air 38 (Soleil à l'horizon), la transmittance Rayleigh vaut **0,00 %
dans le bleu et 46,7 % dans le rouge**. Aucune couleur n'est écrite nulle part :
c'est Beer-Lambert appliqué à une section efficace en λ⁻⁴·⁰⁹⁵.

---

*Dernière mise à jour : phases 0 à 3 validées.*
