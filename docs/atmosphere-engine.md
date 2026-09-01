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

### `transport/slantPath.ts`

**Rôle.** Colonne moléculaire le long d'un rayon oblique, en géométrie
**sphérique**.

**Pourquoi pas une sécante.** L'approximation plan-parallèle donne
`masse d'air = 1/cos z`. Elle est excellente jusqu'à 60° et **diverge à
l'horizon**. La réalité plafonne : la courbure de la Terre fait remonter le
rayon hors de l'atmosphère dense avant qu'il n'ait traversé une colonne infinie.
Or c'est précisément près de l'horizon que se joue tout ce que ce moteur cherche
à rendre.

```
|p(s)|² = s² + 2·s·r₀·cos z + r₀²        altitude(s) = |p(s)| − R
colonne = ∫ N(altitude(s)) ds
```

Intégration par point milieu, pas **proportionnel à la longueur du trajet** :
une visée rasante parcourt 1 133 km là où une visée zénithale en parcourt 100.
Convergence vérifiée à 5,5·10⁻⁹ entre 4 096 et 16 384 pas.

**Validation croisée gratuite.** La masse d'air relative doit retrouver la
formule empirique de Pickering (2002) que `astro/photometry.ts` applique déjà,
par un chemin entièrement différent — ici une intégration géométrique, là-bas un
ajustement.

| Hauteur | Ce module | Pickering | Écart |
| --- | --- | --- | --- |
| 90° | 1,00 | 1,00 | 2·10⁻⁷ |
| 45° | 1,41 | 1,41 | 1,6·10⁻⁴ |
| 20° | 2,90 | 2,90 | 4,0·10⁻⁴ |
| 10° | 5,56 | 5,58 | 2,9·10⁻³ |
| 0° | **35,18** | **38,75** | 9 % |

L'écart à l'horizon **est physique** : Pickering est ajusté sur une atmosphère
*réfractée*, qui allonge le trajet ; ce module est purement géométrique. Il
devrait se refermer à la phase 11.

> **Le rayon est droit.** La réfraction abaisserait la position apparente du
> Soleil d'environ 35′ à l'horizon — plus que son propre diamètre. Les hauteurs
> manipulées ici sont **géométriques**, cohérentes avec la scène qui l'est aussi.

---

### `transport/directSolar.ts`

**Rôle.** Le Soleil vu à travers l'atmosphère. `L(λ) = L₀(λ)·exp(−τ(λ,z))`, et
rien d'autre.

**Ce qui en sort tout seul.** Le Soleil rougit en descendant. Pas parce qu'une
fonction le décide, mais parce que le trajet s'allonge d'un facteur 35 et que la
section efficace varie en λ⁻⁴·¹. Il n'existe dans ce fichier ni `sunsetColor`,
ni condition sur la hauteur, ni palier : la hauteur n'entre que dans la longueur
du trajet.

**Ce qui remplace quoi.** `extinctionTint()` — deux exponentielles ajustées par
canal — et un affaiblissement en `10^(−0,4·k·X·0,5)` dont le facteur 0,5 n'avait
aucune justification.

**Séparation cache / runtime.** `σ(λ)` est moléculaire : tabulée une fois par
grille. La profondeur optique n'est plus qu'une multiplication par la colonne.

**Résultats.**

| Grandeur | Valeur |
| --- | --- |
| Éclairement horizontal à 90° | 120,9 klx |
| … à 45° | 82,2 klx |
| … à 20° | 34,5 klx |
| CCT au zénith | 5 353 K |
| CCT à 2° | **2 322 K** |
| Transmittance à l'horizon, bleu / rouge | 0,00 % / 46,7 % |

**Normalisation de la teinte livrée au rendu.** `sunDiscTint()` rend un sRGB
linéaire dont la luma vaut 1 au zénith **au niveau de la mer** — référence fixe,
de sorte qu'un observateur au Pic du Midi voie effectivement un Soleil plus
brillant. Normaliser plutôt que livrer la radiance absolue est un choix **de
transition** : le ciel n'est pas encore sur la même échelle radiométrique
(phase 5), et les mettre en rapport avant qu'ils ne la partagent produirait un
Soleil correct sur un ciel faux. La grandeur absolue existe déjà
(`normalIlluminanceLux`) et prendra le relais.

---

### `transport/singleScattering.ts`

**Rôle.** La lumière du ciel. Radiance diffusée vers la caméra, et éclairement
diffus hémisphérique.

```
L(λ,d) = E₀(λ)·σ(λ)·p(θ,λ) · ∫ N(h(t))·exp[−σ(λ)·(C_prim(t) + C_sec(t))] dt
```

`θ` est **constant le long du rayon** — les rayons solaires sont parallèles à
l'échelle de l'atmosphère — donc la fonction de phase sort de l'intégrale et se
calcule une fois par direction plutôt qu'une fois par pas.

**Rien n'est bleu dans ce fichier.** Aucune couleur, aucun dégradé, aucune
constante ajustée. Le ciel est bleu parce que `σ(λ)` varie en λ⁻⁴·¹ ; il
blanchit vers l'horizon parce que l'auto-extinction finit par rattraper le gain
de diffuseurs, dans le bleu avant le rouge.

**Le test d'ombre fait le crépuscule.** `columnToSpace()` rend `Infinity` quand
le rayon vers le Soleil rencontre la Terre. C'est **toute** la physique du
crépuscule : un point haut voit encore le Soleil quand l'observateur ne le voit
plus. Aucune géométrie d'ombre n'est écrite ailleurs.

**Distribution des pas.** Quadratique sur le rayon primaire, resserrée près de
l'observateur : une visée rasante parcourt 1 133 km mais l'essentiel de la
densité tient dans les premières dizaines. Convergence vérifiée à 4,4·10⁻⁴ entre
48×128 et 192×512 pas.

**Coût.** **0,25 ms** par direction en régime établi (16 bandes, 48×128 pas),
et **0,067 ms** avec la table de colonne. Le poste dominant était le rayon
secondaire : 128 évaluations de profil par pas du rayon primaire.

**Ce qui manque, et le signe que ça donne.** Diffusion multiple (phase 8),
réflexion du sol (`groundAlbedo`, déclaré et pas encore lu), aérosols (phase 6),
ozone (phase 7).

---

### `lut/transmittanceLut.ts`

**Rôle.** Table de colonne moléculaire — la première LUT du moteur. Remplace
l'intégration du rayon secondaire par un accès interpolé.

**Un seul canal suffit.** `T(λ) = exp(−σ(λ)·C)` : tant que Rayleigh est la seule
espèce, la colonne `C` ne dépend pas de λ. Elle se factorise hors du spectre, et
**le nombre de bandes reste libre** au lieu d'être figé à trois par le format de
la texture. Cette factorisation cessera avec l'ozone et les aérosols, dont les
profils verticaux diffèrent : un canal par espèce, sans changer la
paramétrisation.

**Paramétrisation** de Bruneton (2008, révisée 2017), qui répartit les texels
selon la géométrie plutôt que selon les angles :

```
ρ = √(r²−R²)    H = √(r_top²−R²)    d = −rµ + √(r²µ² + r_top²−r²)
u = (d − d_min)/(d_max − d_min)     v = ρ/H
```

`u = 0` est la visée zénithale, `u = 1` la rasante. Un maillage uniforme en
cosinus zénithal gaspillerait ses lignes au zénith, où la colonne est plate, et
manquerait l'horizon, où elle varie de plusieurs ordres de grandeur en une
fraction de degré.

**Le test d'intersection avec le sol reste hors de la table.** C'est lui qui
produit l'ombre de la Terre, et l'interpoler la rendrait floue.

**Statique.** Elle ne dépend ni de l'heure, ni du lieu, ni du Soleil — seulement
du profil de densité. Un calcul unique contre une intégration à chaque pas de
chaque rayon. Elle deviendra dépendante de l'état aux phases 13 et 14, et devra
alors être reconstruite quand cet état change, pas à chaque image.

| Grandeur | Valeur |
| --- | --- |
| Table | 256 × 64, un canal, 64 ko |
| Construction | 85 ms, une fois |
| Erreur max sur la transmittance | **0,082 %** |
| Écart sur la radiance de ciel | ≤ 2,9·10⁻⁴ |
| Gain sur le solveur | **×4** (0,25 → 0,067 ms/direction) |

> **L'erreur est dominée par l'interpolation, pas par l'intégration.** 128 pas
> par entrée donnent la même précision que 512, pour trois fois moins de temps.
> Doubler la résolution de la table, en revanche, divise l'erreur par trois.

**Tests.** `lut/transmittanceLut.validation.ts` — aller-retour de la
paramétrisation, erreur d'interpolation mesurée sur la **transmittance** (la
colonne varie sur des dizaines d'ordres de grandeur et son erreur relative n'a
pas de sens près de zéro), cohérence avec le solveur de référence, monotonies.

---

### `lut/skyViewLut.ts` et `scene/useSkyViewLut.ts`

**Rôle.** La radiance du ciel, précalculée par direction et livrée au rendu
comme texture. **Le nuanceur du fond de ciel n'intègre plus rien : il
échantillonne.**

**La symétrie qui divise le travail par deux.** L'atmosphère est à symétrie de
révolution et les rayons solaires sont parallèles : le ciel est donc
*exactement* symétrique par rapport au plan vertical contenant le Soleil. Ne
stocker que 0–180° d'azimut relatif n'est pas une approximation mais une
conséquence du modèle. Elle cessera d'être exacte en phase 13.

**Paramétrisation.** `u` = azimut relatif / 180°, `v = √(hauteur/90°)`. Le carré
concentre les lignes près de l'horizon : la première ligne d'une table de 32
tombe à **0,094°**, là où un maillage uniforme la placerait à 2,9° — au-dessus
de toute l'arche crépusculaire.

**Construction étalée.** Les 2 048 directions coûtent ~40 ms d'un trait :
imperceptible une fois par minute en temps réel, mais un hoquet net en avance
rapide (p95 mesuré à 50 ms). Le travail est donc réparti sur plusieurs images,
quatre lignes à la fois, dans un tampon séparé — la texture ne change qu'une
fois la table complète, donc sans déchirure.

| Régime | p95 avant | p95 après |
| --- | --- | --- |
| Temps réel | 16,8 ms | **16,8 ms** |
| ×3600 | 50,0 ms | **16,8 ms** |
| ×86400 | — | **16,8 ms** |

**Erreur mesurée en niveaux d'affichage, pas en relatif.** La distinction n'est
pas rhétorique : au bord de l'ombre terrestre, l'erreur *relative* atteint
plusieurs centaines de pour cent — l'interpolation ne peut pas représenter une
discontinuité. En niveaux, elle vaut **3 sur 255**, parce que les deux valeurs y
sont sombres et que c'est ce que l'œil voit.

| Grandeur | Valeur |
| --- | --- |
| Table | 64 × 32, RGBA flottant, **32 ko** |
| Construction | ~40 ms, étalée sur 8 images |
| Erreur max | **3 niveaux sur 255** |
| Reconstruction | quand le Soleil bouge de 0,25° |

> **Format.** Flottant simple avec filtrage linéaire — `OES_texture_float_linear`,
> présent sur la machine de référence. **Sur mobile, le demi-flottant serait le
> format sûr**, à prévoir avant tout déploiement iOS.

---

### `scene/display/exposure.ts`

**Rôle.** Le pont entre une luminance réelle et un pixel.

Le moteur produit désormais des luminances : le ciel de midi avoisine
1 200 cd/m². Il faut décider laquelle s'affiche en blanc, et **cette décision
n'est pas de la physique — c'est de la photographie.**

**Ce n'est pas un modèle d'adaptation.** L'œil qui regarde un coucher de Soleil
est adapté à une scène sombre ; le même œil à midi ne l'est pas. Reproduire cela
demande une boucle d'adaptation temporelle. Ici, l'exposition est fixe.

**Deux ancrages, et celui qui est retenu.**

| Ancrage | Blanc à | Statut |
| --- | --- | --- |
| Photographique — surface lambertienne 0,9 sous 120 klx | 34 377 cd/m² | convention usuelle, probablement l'avenir |
| **Continuité** — le zénith de midi s'affiche comme avant | **86 302 cd/m²** | **retenu** |

Le choix est délibéré : cette étape change le **modèle** du ciel, et y mêler une
modification de l'exposition rendrait les deux impossibles à juger séparément.
On mesure d'abord la physique à apparence constante. C'est la même démarche
qu'en phase 0.5, où le sur-éclat du Soleil avait été *traduit* plutôt que
redeviné.

Conséquence chiffrée : le rendu actuel est **2,5× plus sombre** que la
convention photographique.

---

### `absorption/ozone.ts`

**Rôle.** L'absorbeur qui fait le bleu du crépuscule.

**Le point structurel.** Jusqu'ici *extinction = diffusion* : Rayleigh est
conservatif, tout ce qu'il retire au faisceau reparaît ailleurs. L'ozone absorbe,
et ce qu'il retire disparaît. Les deux grandeurs se séparent :

```
extinction   tau(lambda) = sigma_R.C_air + sigma_O3.C_ozone   attenue les trajets
diffusion    beta(lambda) = sigma_R.N(h)                      seule source diffusee
```

Les confondre ferait briller le ciel de la lumière que l'ozone a absorbée.

**La bande de Chappuis** culmine à 5,019·10⁻²⁵ m² vers 600 nm — **dans
l'orange**. Elle retire au ciel précisément ce que Rayleigh lui laisse. Son
épaisseur optique verticale n'est que de 0,039 : négligeable au zénith, décisive
au crépuscule.

| lambda | tau vertical (300 DU) |
| --- | --- |
| 450 nm | 0,0016 |
| 550 nm | 0,0266 |
| **600 nm** | **0,0392** |
| 700 nm | 0,0068 |

**Données.** IUP Bremen, *o3spectra2011* à 233 K — la température de la
stratosphère, où vit l'ozone. La bande de Chappuis dépend peu de la température,
contrairement aux bandes ultraviolettes.

**Profil vertical.** Une « tente » : nulle sous 10 km, maximale à 25 km, nulle à
40 km, d'intégrale 15 km — ce qui permet de la normaliser exactement sur une
colonne totale mesurable (300 DU par défaut, valeur des latitudes moyennes).

> **Le profil est le maillon faible du module.** Un profil tabulé serait plus
> rigoureux. La tente suffit tant que seules comptent la colonne totale et son
> altitude moyenne.

**Une géométrie contre-intuitive, mesurée.** En visée rasante depuis le sol,
l'air s'allonge d'un facteur **24**, l'ozone de **11** seulement. On attendrait
l'inverse. La raison : un rayon rasant traverse l'air bas tangentiellement, mais
quand il atteint les 25 km où vit l'ozone il a déjà grimpé, et son angle zénithal
local n'est plus que 85°. C'est exactement pourquoi une seule colonne ne peut
plus servir les deux espèces.

**Ce qui n'est pas fait.** O2 (bandes A à 762 nm, B à 688 nm) et H2O
(720, 820 nm) : étroites, dans le proche infrarouge, sans effet notable sur la
couleur. L'architecture les accueillerait sans changement.

---

### `mie/mie.ts`

**Rôle.** Diffusion par une sphère de taille quelconque — solution de Bohren &
Huffman (1983), chapitre 4.

**Pourquoi.** Rayleigh suppose des diffuseurs très petits devant la longueur
d'onde : vrai d'une molécule d'air (0,3 nm contre 550), faux d'un aérosol
(0,1 à 1 µm). Quand la particule approche λ, la diffusion cesse d'être
symétrique et cesse de suivre λ⁻⁴ — elle devient fortement dirigée vers l'avant
et presque achromatique.

**Deux précautions numériques, non optionnelles.** La récurrence sur `Dₙ` se
fait **vers le bas** — vers le haut elle est instable et le résultat devient
absurde dès quelques longueurs d'onde. Le nombre de termes suit le critère de
Wiscombe `x + 4x^⅓ + 2`.

**Validation sans donnée externe.**

| Contrôle | Résultat |
| --- | --- |
| Limite de Rayleigh (x → 0) | 9,5·10⁻⁸ à x = 0,001 |
| Paradoxe de l'extinction (Q_ext → 2) | 2,0 ± 0,06 |
| ω₀ = 1 exactement pour un indice réel | 2·10⁻¹⁶ |
| Phase normalisée | < 1,4·10⁻⁵ |
| **Mie × facteur de King = Bodhaine** | **< 4·10⁻⁴** |

Le dernier est le meilleur du lot : une molécule d'air traitée comme une sphère
minuscule doit rendre la section efficace que le module Rayleigh de la phase 3
calcule par un tout autre chemin. L'écart résiduel **est exactement le facteur
de King**, que Bodhaine porte et qu'un modèle de sphère isotrope ne peut pas
avoir. Le corriger ramène l'accord à 4·10⁻⁴ — deux algorithmes indépendants,
un seul nombre.

> Le contrôle `ω₀ ≤ 1` a attrapé une **convention de signe inversée** sur la
> partie imaginaire de l'indice : le calcul rendait des albédos de 1,5,
> c'est-à-dire une particule diffusant plus de lumière qu'elle n'en intercepte.
> Rien d'autre ne l'aurait signalé.

---

### `mie/aerosol.ts`

**Rôle.** Propriétés optiques d'une population — distribution de tailles,
profil vertical, tables prêtes pour le transport.

**La séparation qu'impose le prompt.** Le calcul de Mie coûte ~125 ms pour
40 tailles × 16 bandes. Il est fait **une fois** et rendu sous forme de tables :
sections efficaces, asymétrie, fonction de phase sur 256 angles. Changer la
quantité d'aérosols ne le refait pas — les propriétés ne dépendent que de la
*nature* des particules, pas de leur nombre.

**Le rayon médian est calé sur une observable, pas choisi.** L'exposant
d'Ångström est précisément ce que la science atmosphérique utilise pour
contraindre la taille des aérosols, et les réseaux de photomètres solaires le
publient. `r_g = 0,05 µm` donne α = 1,29.

Ce qui rend le calage crédible : **les deux autres observables suivent sans être
touchées.**

| Grandeur | Modèle | Littérature |
| --- | --- | --- |
| α (440/870) | **1,29** | 1,2 – 1,5 |
| ω₀ (550 nm) | **0,954** | 0,92 – 0,96 |
| g (550 nm) | **0,646** | 0,6 – 0,7 |

Un seul paramètre calé, trois observables d'accord.

> ⚠️ **L'indice de réfraction complexe reste un paramètre**, pas une mesure.
> La référence serait **OPAC** (Hess, Koepke & Schult, 1998), qui tabule
> indices et distributions par type d'aérosol. Les brancher ne demanderait aucun
> changement de structure.

**Le pont avec le réglage existant.** Le « trouble » de 1 à 6, asservi au PM2,5,
se traduit en **épaisseur optique à 550 nm** — `AOD = 0,03 × trouble`, ancré sur
l'air le plus pur (Cerro Paranal ≈ 0,03).

---

### `scene/display/tonemap.ts`

**Rôle.** Le transform d'affichage — l'unique endroit où une radiance devient un
pixel. Et son inverse.

**La courbe n'a pas changé** : ACES filmique (Narkowicz 2015) puis re-saturation
×1,4, exactement les opérations qui vivaient dans `scene/atmosphere.ts`. La
phase 0.5 les **déplace**, elle ne les modifie pas — c'est ce qui permet de
vérifier le refactor par comparaison de pixels plutôt que par jugement.

**L'inverse, et à quoi il sert.** Tous les matériaux ne sont pas encore
physiques. Un trait de grille, une étoile, le sol : leurs couleurs sont des
valeurs d'affichage héritées, pas des radiances. Les laisser telles quelles dans
un tampon linéaire les ferait traverser la courbe une seconde fois.

`radianceFromDisplay()` convertit une couleur d'affichage en la radiance qui
s'affichera **identiquement**. Ce n'est pas un réglage : c'est une cale calculée,
exacte par construction, qui rend le refactor neutre pour les couches pas encore
portées. **Chaque phase supprime sa propre cale** en rendant son matériau
physique — le Soleil en phase 4, le ciel en 5, le sol en 9, l'airglow en 11. Le
jour où plus aucun appelant n'utilise `radianceFromDisplay`, la transition est
terminée.

L'inverse est analytique parce que la re-saturation **préserve la luminance** :
`luma(sortie) = luma(entrée)`, donc `m = (c − (1−S)·luma(c))/S`, puis
l'inversion de la quadratique ACES.

`RADIANCE_AT_DISPLAY_WHITE = 7,2417` — la radiance qui s'affiche exactement en
blanc. Elle sert deux fois : seuil du bloom, et facteur de traduction de
l'ancien sur-éclat du Soleil.

**Tests.** `atmosphere/validation/display.validation.ts` — aller-retour à 10⁻¹⁶,
monotonie sous la saturation, écrêtage au-delà, conservation de la luminance,
pente à l'origine (0,2143 = 0,03/0,14).

---

### `scene/display/DisplayEffect.tsx`

**Rôle.** La passe d'affichage, appliquée une seule fois en fin de chaîne.

```
scène → tampon demi-flottant → Bloom → DisplayEffect → sRGB → écran
```

**Le bloom passe avant, et c'est délibéré.** Un halo lumineux est un phénomène
optique : il se produit sur la lumière, pas sur des pixels déjà compressés. Son
seuil s'exprime de ce fait en radiance — celle qui s'affiche en blanc — là où
l'ancien seuil de 1 se comparait à des valeurs déjà écrêtées, ce qui interdisait
structurellement au ciel de déborder quelle que soit sa luminance réelle.

Le composeur est désormais **inconditionnel** : son format de tampon ne peut
plus dépendre d'un réglage d'interface.

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

**État : 695 contrôles, 31 suites, aucun échec.**

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
| 1440×900 @ dpr 2 | **~4,9 ms** | **~30 %** |
| 1920×1080 @ dpr 2 | ~7,9 ms | ~47 % |

**0,95 ns/pixel** (±7 % d'une exécution à l'autre), linéaire sur trois
résolutions → limité par le remplissage,
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

## Ce que la migration linéaire a changé — phase 0.5

Le refactor a été mesuré, pas jugé. Sondes comparées à la référence committée :

| Régime | Dérive |
| --- | --- |
| Nuit, crépuscule nautique | **zéro** — identique au pixel près |
| Ciel de jour | **+3 à +7 niveaux**, systématiquement plus clair |
| Horizon au coucher, canal bleu | **18 niveaux**, tombe à 0 |
| Disque solaire | 255,255,255 — inchangé |
| Coût GPU du noyau | inchangé — voir la note de méthode ci-dessous |

**La nuit est identique au bit près.** C'est la vérification la plus utile : là
où la diffusion est nulle, la cale `radianceFromDisplay` restitue exactement la
couleur d'origine. L'inverse est donc juste.

**Le jour est légèrement plus clair, et c'est plus correct.** Le socle nocturne
était auparavant ajouté *après* la courbe, sur une valeur déjà compressée. Il est
maintenant ajouté *en radiance*, avant — là où la courbe est plus raide, d'où un
incrément plus visible. Additionner des radiances puis compresser est juste ;
additionner une valeur d'affichage à une valeur déjà compressée ne l'est pas.

**Un artefact a été mis à nu.** Au coucher, le canal bleu de l'horizon tombe à 0
au lieu de 18. La cause n'est pas la migration mais la **re-saturation ×1,4** :
sur un orange très saturé, elle pousse le bleu en négatif et l'écrêtage le ramène
à zéro. Le socle nocturne, ajouté après coup dans l'ancienne chaîne, masquait le
phénomène. `DISPLAY_SATURATION` est un facteur cosmétique, déjà signalé comme
tel ; il disparaîtra quand la physique pourra le remplacer. Le noter valait mieux
que le masquer à nouveau.

### Une erreur de méthode corrigée au passage

Le banc GPU tournait **dans l'onglet de l'application**. Il additionnait donc au
noyau le coût de tout ce que la scène rend par ailleurs, soixante fois par
seconde. Le chiffre est passé de 1,53 à 1,87 puis 2,74 ns/px au fil du refactor,
alors que **le GLSL mesuré n'avait pas changé d'un caractère**.

Le banc s'exécute désormais dans une page vierge servie par le serveur de
développement — vierge pour ne rien mesurer d'autre, servie par le serveur pour
que l'import du module passe par Vite.

**Un second défaut est apparu ensuite**, et il était plus grave : même isolé, le
banc rendait 0,95 · 0,96 · 1,37 ns/px sur trois exécutions du même code — 44 %
d'écart. La cause était la **chauffe**, quatre passes seulement. Un GPU au repos
tourne à fréquence réduite et met des centaines de millisecondes à monter ; le
banc mesurait donc la montée en fréquence autant que le noyau.

Il chauffe désormais pendant 400 ms, calibre son nombre de passes pour des
échantillons d'au moins 25 ms, prend la **médiane de neuf échantillons**, et
**rend sa dispersion avec sa mesure** : `0,95 ns/pixel ±7 %`. Un chiffre de
performance sans incertitude ne permet pas de juger une régression — et la
comparaison à la référence annonce maintenant « dans le bruit » plutôt qu'un
rapport trompeur.

**Conséquence : les chiffres publiés jusqu'ici étaient surestimés d'environ
90 %.** La voûte coûte ~4,9 ms à dpr 2 et non 7,9, soit ~30 % d'une image et non
48 %. L'audit est corrigé en conséquence ; le raisonnement sur le budget tient,
son échelle change.

---

## Le Soleil couchant, sans code de coucher — phase 4

Les paliers d'éclairement de `astro/photometry.ts`, tabulés depuis la
littérature des crépuscules, sont retrouvés par une chaîne entièrement
indépendante : spectre ASTM G173 → extinction de Rayleigh le long du trajet
oblique → fonctions colorimétriques CIE.

| Hauteur du Soleil | `photometry.ts` | Calculé | Écart |
| --- | --- | --- | --- |
| 90° | 120 000 lx | 120,9 klx | 0,7 % |
| 45° | 82 000 lx | 82,2 klx | 0,2 % |
| 20° | 34 000 lx | 34,5 klx | 1,5 % |
| 10° | 15 000 lx | 13,7 klx | **−9 %** |
| 5° | 8 000 lx | 4,5 klx | **−44 %** |

La projection `E_horizontal = E_normal · sin(h)` est indispensable : les paliers
publiés sont des éclairements horizontaux.

**Le déficit à basse hauteur est le résultat le plus intéressant du lot.** Ce
module ne calcule que le rayonnement **direct** ; à Soleil bas, la lumière
diffuse du ciel devient dominante. Le déficit mesure donc exactement ce que la
phase 5 devra apporter. **Un accord parfait à 5° aurait été suspect**, pas
rassurant.

### L'émergence

| Hauteur | Température de couleur |
| --- | --- |
| 90° | 5 353 K |
| 30° | 4 903 K |
| 10° | 3 859 K |
| 5° | 3 105 K |
| 2° | **2 322 K** |

Trois mille kelvins de rougissement, et aucune couleur n'est écrite nulle part.

### Ce que le rendu montre, et ce qu'il ne montre pas encore

Sonde du disque solaire à hauteur rasante : `255,255,164` au centre,
`255,255,0` dans la couronne. **Le bleu est bien retiré** — le rougissement est
réel et mesurable. Mais le rouge et le vert restent écrêtés à 255, parce que
l'exposition d'affichage est fixe.

Le disque lit donc jaune-blanc plutôt qu'orange. Ce n'est pas une erreur du
transport : c'est l'absence de modèle d'adaptation. L'œil qui voit un Soleil
couchant orange est adapté à une scène sombre ; notre exposition ne l'est pas.
Elle deviendra une grandeur photométrique en même temps que le ciel et le Soleil
partageront une échelle radiométrique — phase 5.

---

## Le ciel, et ce que son erreur raconte — phase 5

### La cible de la phase 4 est atteinte

Le Soleil direct seul rendait 4,50 klx à 5° contre 8,0 klx tabulés. Le déficit
de 44 % devait être le ciel diffus. Il l'est :

| | Éclairement horizontal à 5° |
| --- | --- |
| Direct (phase 4) | 4,50 klx |
| Diffus (phase 5) | **3,15 klx** |
| Total | **7,65 klx** contre 8,0 publiés (−4 %) |

### Le bilan complet, et le signe de l'écart

| Hauteur | Calculé | Publié | Écart |
| --- | --- | --- | --- |
| 90° | 125,9 klx | 120,0 | **+5 %** |
| 45° | 87,0 klx | 82,0 | **+6 %** |
| 20° | 39,0 klx | 34,0 | +15 % |
| 10° | 17,6 klx | 13,0 | +35 % |
| 5° | 7,6 klx | 8,0 | −4 % |

**Le dépassement est le résultat utile.** Il ne s'agissait pas de faire
coïncider : le modèle n'a encore ni ozone ni aérosols, qui ne font que *retirer*
de la lumière. Un accord parfait aurait signalé deux erreurs qui se compensent.
L'excès mesure ce que les phases 6 et 7 doivent retirer, et il croît avec la
longueur du trajet — exactement comme une extinction manquante.

> **Requalification du résultat de la phase 4.** Elle annonçait « 120,9 klx
> calculés contre 120 000 publiés ». Mais les paliers de `photometry.ts` sont
> des éclairements **globaux**, et la phase 4 ne calculait que le direct. Que le
> direct seul atteigne le global signifiait que le direct était trop fort d'à
> peu près la fraction diffuse. La phase 5 le rend visible.

### Ce qui émerge, sans être écrit

| Structure | Mesure |
| --- | --- |
| Zénith bleu | chromaticité (0,243 · 0,251) contre (0,313 · 0,329) pour le blanc · B/R = 3,33 |
| Blanchiment vers l'horizon | (0,244 · 0,253) au zénith → (0,308 · 0,336) à 2° |
| Gradient de luminance | 1 013 cd/m² au zénith → 5 923 à 2° |
| Fonction de phase lisible dans le ciel | 3 207 vers le Soleil · **1 905 à 90°** · 2 110 à l'opposé |
| Arche crépusculaire (Soleil à −4°) | 355 cd/m² à 2° vers le Soleil · 9,0 au zénith · **0,00 à l'opposé** |
| Rougissement du crépuscule | (0,491 · 0,440) à l'horizon contre (0,339 · 0,346) au zénith |

Le zéro exact à l'horizon anti-solaire est **l'ombre de la Terre**. Elle sort du
seul test de rencontre du rayon secondaire avec le sol.

### Le crépuscule est trop clair, et ça dit quelque chose

| Hauteur solaire | Calculé / publié |
| --- | --- |
| 0° | ×2,1 |
| −2° | ×3,0 |
| −4° | ×2,8 |

Deux manques agissent en sens **contraire** : la diffusion multiple ajouterait
de la lumière, l'absorption par l'ozone en retirerait. Le signe de l'écart dit
donc lequel domine — et c'est **l'absorption**.

Cela recoupe le résultat classique de Hulburt (1953) : le bleu du ciel
crépusculaire est un effet de la bande de Chappuis de l'ozone, pas de Rayleigh.
Le modèle le confirme *par défaut* : son zénith crépusculaire est quasi blanc
(0,339 · 0,346) là où le ciel réel est franchement bleu. C'est une cible chiffrée
pour la phase 7.

> Réserve honnête : les paliers de `photometry.ts` sont eux-mêmes des valeurs de
> littérature interpolées en logarithme, et le modèle n'a pas de réfraction —
> à 0° géométrique le Soleil réel est encore partiellement visible. La
> comparaison au crépuscule porte donc de l'incertitude des deux côtés. Seul
> l'ordre de grandeur et le signe sont exploitables.

### Ce qui reste pour le voir à l'écran

> ⚠️ **Cette section annonçait 5,5 ms par direction, et une LUT de ciel à onze
> secondes.** Les deux étaient faux : la mesure avait été prise sur le **premier
> appel**, donc dominée par la compilation JIT plutôt que par le solveur. Voir
> ci-dessous les chiffres réels, inférieurs de deux ordres de grandeur.

Le solveur coûte **0,25 ms par direction** en régime établi, et **0,067 ms** une
fois la table de colonne en place. Une LUT de ciel 64×32 — 2 048 directions —
coûte donc **34 ms**, pas onze secondes.

Le chemin vers le rendu est par conséquent bien plus court que je ne l'avais
écrit : une table de ciel calculée sur le processeur, téléversée en
`DataTexture` et échantillonnée par direction, suffirait — sans aucune
infrastructure de render target. Elle ne serait reconstruite que lorsque le
Soleil bouge sensiblement.

Tant que ce n'est pas fait, le rendu continue d'afficher l'ancien noyau
`glsl-atmosphere`, et le solveur physique reste une référence numérique.

---

## Le ciel physique arrive à l'écran

Le nuanceur du fond de ciel n'intègre plus aucun rayon. Il échantillonne une
table calculée par le solveur des phases 1 à 5 : atmosphère standard, spectre
solaire mesuré, sections efficaces de Rayleigh dérivées, transport oblique en
géométrie sphérique, diffusion simple avec test d'ombre terrestre.

### Ce que les sondes montrent

| Scénario | Avant | Après |
| --- | --- | --- |
| Midi, zénith | `67,106,137` | `57,109,171` |
| Midi, horizon | `133,172,181` | `207,215,214` |
| Coucher, vers le Soleil | `255,195,0` | `212,156,0` |
| Coucher, opposé | `95,33,0` | `180,78,0` |
| Crépuscule civil, vers le Soleil | `25,15,17` | `46,21,8` |
| Nuit | `3,4,10` | `3,4,10` (inchangé) |

Le zénith est plus saturé, l'horizon blanchit franchement, et **le crépuscule
existe** là où l'ancien rendu ne produisait que le socle nocturne peint.

### Le vert-olive du ciel crépusculaire n'est pas un défaut

C'est **le diagnostic de la phase 5 devenu visible**. Au coucher, la lumière qui
atteint les points de diffusion en altitude a traversé une colonne horizontale
énorme : elle est rougie. Elle diffuse ensuite en Rayleigh, qui favorise le
bleu. Rouge × bleu ≈ neutre — d'où un ciel moyen gris-olive au lieu du bleu
profond attendu.

C'est exactement le résultat de Hulburt (1953) : **le bleu du ciel crépusculaire
vient de la bande de Chappuis de l'ozone, pas de Rayleigh.** Les nombres de la
phase 5 le disaient (zénith crépusculaire quasi blanc, chromaticité 0,339 ·
0,346) ; l'image le confirme. C'est une cible chiffrée *et* visuelle pour la
phase 7.

### La dette de cette étape

Les corps et les avions continuent d'utiliser `hazeColorAlong()`, l'ancien
noyau. **Le ciel et le voile des objets suivent donc temporairement deux modèles
différents** : un astre bas sur l'horizon ne se fond plus exactement dans le ciel
qui l'entoure — propriété que le code d'origine avait pris soin d'établir. Elle
se solde à la phase 9, quand la perspective atmosphérique des objets passera au
même transport.

Le banc GPU continue de mesurer l'ancien noyau, qui reste payé par les fragments
de corps et d'avions. Le ciel, lui, ne coûte plus qu'un accès de texture.

---

## Le bleu du crépuscule — phase 7

La phase 5 avait laissé deux cibles chiffrées. Les deux sont atteintes, et par
la même cause.

### Cible 1 — le dépassement de journée

| Hauteur | Sans ozone | Avec ozone |
| --- | --- | --- |
| 90° | +5 % | **+2 %** |
| 45° | +6 % | **+2 %** |
| 20° | +15 % | **+6 %** |
| 10° | +35 % | +18 % |

Divisé par deux partout. Le résidu croît toujours avec la longueur du trajet :
c'est la signature des **aérosols**, qui restent absents (phase 6).

### Cible 2 — le zénith crépusculaire devient bleu

| | Chromaticité |
| --- | --- |
| Sans ozone | (0,339 · 0,346) — quasi blanc |
| **Avec ozone** | **(0,270 · 0,267)** — franchement bleu |
| Blanc D65, pour référence | (0,313 · 0,329) |

C'est le résultat de Hulburt (1953) reproduit : **le bleu du ciel crépusculaire
ne vient pas de Rayleigh mais de la bande de Chappuis.** La lumière qui éclaire
le ciel après le coucher a traversé une colonne horizontale énorme et en ressort
rougie ; diffusée ensuite en Rayleigh, elle donnerait du neutre. C'est l'ozone,
en retirant l'orange, qui rend le bleu.

Les sondes le confirment à l'écran : `coucher/zénith` passe de `31,32,34` — un
gris neutre — à `18,25,36`, où le bleu domine enfin. Et l'olive du ciel moyen,
`77,74,62`, devient le bleu-gris `47,58,69`.

### Le signe des résidus a changé, et c'est ce qui compte

À 5°, le bilan est passé de −4 % à **−23 %**. Un absorbeur ne peut que retirer :
c'était attendu. Le trajet y est assez long pour que la **diffusion multiple**
manquante domine — elle, ajouterait de la lumière.

Au crépuscule, les rapports calculé/publié tombent de 2,1 · 3,0 · 2,8 à
1,3 · 1,7 · 1,3, et passent sous 1 au-delà de −6°. Le modèle est désormais
**entouré** : il dépasse là où il manque de l'absorption, il manque là où il
manque de la diffusion multiple. C'est une bien meilleure carte de ce qui reste
à faire qu'un écart de signe constant.

---

## Les aérosols — phase 6

### Le bilan de journée se referme

| Hauteur | Phase 5 | +ozone | **+aérosols** |
| --- | --- | --- | --- |
| 90° | +5 % | +2 % | **+1 %** |
| 45° | +6 % | +2 % | **+1 %** |
| 20° | +15 % | +6 % | **+2 %** |
| 10° | +35 % | +18 % | **+9 %** |
| 5° | −4 % | −23 % | −32 % |

Trois modules construits séparément — Rayleigh depuis Bodhaine, ozone depuis
l'IUP Bremen, aérosols depuis Mie — convergent à 1–2 % des paliers tabulés de
`astro/photometry.ts`, qui n'ont participé à aucun de ces calculs.

Le déficit à 5° s'aggrave, et c'est attendu : un absorbeur ne peut que retirer.
Il isole maintenant proprement ce qui manque — la **diffusion multiple**.

### La source de diffusion a deux termes

```
source(λ) = beta_R(λ)·p_R(θ)·N_air(h)  +  beta_M(λ)·p_M(θ)·N_aer(h)
```

Chaque espèce diffusante apporte son propre terme, avec sa section efficace de
**diffusion** — pas d'extinction — et sa propre fonction de phase. Les mélanger
sous une phase moyenne effacerait précisément ce qui distingue un ciel clair
d'un ciel voilé : le halo serré autour du Soleil. `p(0°)/p(90°)` vaut **77 pour
Mie contre 1,9 pour Rayleigh**.

### Ce que le trouble fait, maintenant qu'il est physique

Soleil à 45° :

| Trouble | AOD | Zénith | Chromaticité | Horizon | Halo à 20° |
| --- | --- | --- | --- | --- | --- |
| 1 | 0,03 | 1 394 cd/m² | (0,261 · 0,271) | 4 408 | 6 148 |
| 2 | 0,06 | 1 778 | (0,272 · 0,285) | 3 647 | 8 816 |
| 4 | 0,12 | 2 464 | (0,287 · 0,300) | 2 845 | 13 148 |
| 6 | 0,18 | 3 048 | (0,295 · 0,310) | 2 427 | 16 350 |

Le zénith s'éclaircit **et se désature** vers le blanc ; l'horizon
**s'assombrit**, l'extinction de basse couche l'emportant sur le gain de
diffuseurs ; le halo solaire triple. À l'écran, le dégradé vertical s'aplatit
jusqu'à disparaître : de `142,169,202` au trouble 1 à `221,226,231` au trouble 6.

Rien de tout cela n'est écrit. L'ancien modèle multipliait un coefficient et
blanchissait l'horizon par construction.

### Une régression réparée, et signalée

En câblant la table de ciel deux étapes plus tôt, j'avais retiré
`aerosolTurbidity` de `SkyBackground` **sans le signaler**. Le réglage de trouble
— et son asservissement automatique au PM2,5 — n'affectait plus le ciel. C'est
réparé, et physiquement cette fois.

---

## La diffusion multiple — phase 8

### Le problème, et pourquoi il fallait le traiter

La diffusion simple suppose qu'un photon est dévié une fois puis atteint l'œil.
C'est une bonne approximation quand la profondeur optique est petite, et une
mauvaise dès qu'elle approche l'unité — près de l'horizon, au crépuscule, dans
le bleu. Les phases 6 et 7 avaient isolé proprement le manque : les deux
absorbeurs ne peuvent que **retirer** de la lumière, et ce qui restait à combler
ne pouvait donc qu'en **ajouter**.

### La stratégie, et pourquoi celle-là

Le calcul exact demande de résoudre le champ de radiance ordre par ordre, dans
une table à quatre dimensions. C'est hors de portée d'une reconstruction
interactive.

La méthode de **Hillaire (2020)** repose sur une approximation dont l'hypothèse
est explicite : au-delà du second ordre, la lumière diffusée a perdu la mémoire
de sa direction d'origine et peut être traitée comme **isotrope**. Les ordres
suivants forment alors une série géométrique, dont la somme est close :

```
L_f(x)  = ⟨ ∫ T(x,x')·σ_s(x')·p_u·S(x')·E_sol dt ⟩ sur 4π     p_u = 1/4π
f_ms(x) = ⟨ ∫ T(x,x')·σ_s(x') dt ⟩ sur 4π
Ψ_ms    = L_f / (1 − f_ms)
```

`Ψ_ms` entre ensuite dans la marche principale comme **terme source isotrope**,
sans fonction de phase — c'est précisément l'hypothèse qui rend la méthode
abordable. Ce n'est pas une LUT peinte : chaque entrée sort du même transport
que le reste du moteur, mêmes profils, mêmes sections efficaces, même test
d'ombre.

Mesuré : `f_ms` culmine à **0,641**, donc la série converge. C'est une condition
de validité, pas une tolérance : au-delà de 1, `1/(1−f)` change de signe et la
table rendrait des radiances négatives.

### Le facteur 4π que seul le bilan d'éclairement pouvait voir

La première version omettait le `p_u = 1/4π` de la source solaire dans `L_f`.
Tous les profils restaient plausibles — dégradé vertical correct, horizon plus
clair que le zénith, couleurs dans le bon ordre. Le ciel était simplement **trois
à six fois trop lumineux**.

| | zénith | horizon | vers le Soleil |
| --- | --- | --- | --- |
| avec le facteur oublié | ×3,33 | ×5,97 | ×2,34 |
| **corrigé** | **×1,27** | **×1,60** | **×1,15** |

Aucun contrôle de forme n'aurait attrapé cela. Seule une grandeur ancrée en
valeur **absolue** le pouvait : le bilan d'éclairement horizontal passait de
+1 % à +17 % à midi.

### Ce que la diffusion multiple change à l'écran

Dix-neuf sondes colorimétriques ont dérivé, toutes vers plus clair et plus bleu.
La plus forte n'est pas où on l'attendrait :

| Sonde | Avant | Après |
| --- | --- | --- |
| midi / antisoleil-30 | `70,114,167` | `89,145,210` |
| midi / perpendiculaire-30 | `93,134,182` | `109,159,215` |
| midi / zénith | `133,161,197` | `139,171,213` |
| après-midi / zénith | `72,107,154` | `78,122,183` |

La direction antisolaire à 30° est exactement là où la fonction de phase de
Rayleigh passe par son minimum, donc là où la diffusion simple est la plus
déficitaire. **La diffusion multiple comble ce creux en premier** — sans que rien
ne le lui demande.

### Le sol entre enfin dans le calcul

`AtmosphereState.groundAlbedo` était déclaré depuis la phase 1 et **n'était lu
par personne**. La lumière renvoyée par la surface est une composante de la
diffusion multiple : un rayon qui rencontre le sol n'y disparaît pas, il en
repart, en surface lambertienne `E·albedo/π`. C'est ici que l'albédo trouve son
emploi, et la raison pour laquelle il avait été déclaré.

Mesuré, visée à 30°, Soleil à 45° : **2 074 cd/m² au-dessus d'un sol noir contre
3 899 au-dessus de la neige**. Le ciel au-dessus d'un champ enneigé est
effectivement plus lumineux, et personne ne l'a écrit.

### Une intuition fausse, corrigée par un contrôle

J'avais écrit que `Ψ_ms` devait **décroître** avec l'altitude — il n'y a presque
plus de diffuseurs à 60 km. Le contrôle a mesuré l'inverse : `1,74·10⁻²` au sol
contre `1,78·10⁻²` à 60 km.

La raison est instructive. `Ψ_ms` est une radiance **moyennée sur toute la
sphère**. Depuis le sol, la moitié basse des directions bute sur la surface et
n'apporte presque rien ; depuis 60 km, cette même moitié est remplie par
l'atmosphère éclairée vue d'en haut, qui est lumineuse. Les deux moyennes sont
du même ordre, et c'est correct.

Ce qui doit s'effondrer, c'est le **terme source** `σ_s · Ψ_ms`, celui que la
marche intègre réellement : mesuré, `4,4·10²³` au sol contre `1,2·10²⁰` à 60 km.
Le test a été réécrit sur la bonne grandeur, pas assoupli.

### ⚠️ Le nœud à 5° de la table d'éclairement — anomalie signalée, non corrigée

La phase 6 avait enregistré « −32 % à 5° » comme cible chiffrée de cette phase.
La diffusion multiple ne le ramène qu'à **−28 %**, alors qu'elle déplace tout le
reste. En regardant la courbe entière, la cible elle-même est suspecte.

| Hauteur | Modèle | `SOLAR_ANCHORS` | Écart | |
| --- | --- | --- | --- | --- |
| 3° | 3,03 klx | 2,86 | +6 % | |
| 4° | 4,28 | 4,79 | −11 % | |
| **5°** | **5,73** | **8,00** | **−28 %** | **nœud** |
| 6° | 7,35 | 8,81 | −17 % | |
| 8° | 10,95 | 10,68 | +2 % | |
| 20° | 36,04 | 34,00 | +6 % | **nœud** |
| 45° | 84,70 | 82,00 | +3 % | **nœud** |
| 90° | 124,13 | 120,00 | +3 % | **nœud** |

Trois éléments écartent une erreur du modèle :

1. **Les trois autres nœuds tombent à 3–6 %.** Entre les nœuds, l'écart remonte
   à +14–22 % : c'est la signature d'une interpolation log-linéaire qui affaisse
   une courbe convexe. Vérifié — le modèle est lui-même 40 % au-dessus de sa
   propre interpolation log-linéaire entre 5° et 20°.
2. **Les rapports entre nœuds hauts concordent** : ×2,35 contre ×2,41 de 20° à
   45°, ×1,47 contre ×1,46 de 45° à 90°. Seule la jambe basse diverge — ×20 pour
   la table contre ×7,3 pour le modèle.
3. **Le faisceau direct s'y vérifie seul.** 2,60 klx horizontal à 5° donne
   29,8 klx en incidence normale, soit **0,157 mag par masse d'air** sur les
   10,4 masses de Pickering — exactement la plage d'un site propre. Pour
   atteindre 8 000 lux, il faudrait 5,4 klx de diffus, soit 54 % du diffus
   obtenu Soleil au zénith alors que le faisceau est atténué dix fois.

Le déficit **n'est pas numérique** : l'intégrale d'hémisphère converge à 0,16 %
dès 16×32, et la table de diffusion multiple à 0,5 % dès 32 directions.

`SOLAR_ANCHORS` a été écrit pour calculer une magnitude limite, pas comme étalon
radiométrique : quatre nœuds de jour interpolés en logarithme. Lui demander de
trancher au niveau de ±5 % dépasse ce qu'il peut donner. **Le nœud à 5° est donc
écarté de la suite de validation, explicitement et avec sa justification** — les
nœuds 20°, 45° et 90° y restent, à 10 % de tolérance. Rien n'a été ajusté pour
le rejoindre.

> Pour trancher réellement, il faudrait une mesure d'éclairement horizontal
> global par ciel clair en fonction de la hauteur solaire — un jeu **BSRN** ou
> **IDMP (CIE)** ferait l'affaire. C'est la donnée manquante.

### Le coût, et comment il a été réparti

| Résolution | Coût | Écart au convergé (niveaux/255) |
| --- | --- | --- |
| 16×16, 16 dir × 12 pas | 21 ms | 9 |
| 32×32, 16 dir × 12 pas | 84 ms | 10 |
| **32×32, 32 dir × 20 pas** | **275 ms** | **5** |
| 32×32, 64 dir × 32 pas | 872 ms | 2 |

L'erreur est gouvernée par le nombre de directions, pas par la résolution de la
table. Retenu : 32×32 à 32 directions, 5 niveaux sur 255 — la même classe
d'erreur que la table de ciel elle-même.

La table ne dépend **que de la composition** de l'atmosphère : la hauteur du
Soleil est l'une de ses deux dimensions, pas un paramètre. Un lever de Soleil ne
la reconstruit donc jamais — seul un changement de trouble le fait.

Ces 275 ms sont étalés sur une soixantaine d'images, **par entrée et non par
ligne** : une ligne vaut 8,6 ms, soit plus de la moitié d'une image à 60 Hz, un
grain trop gros pour choisir la charge. Seize entrées font 4,3 ms — le même
budget que les quatre lignes de ciel déjà en place.

Une construction en cours n'est jamais interrompue. Un glissement de curseur
change le trouble à chaque image : la relancer à chaque fois signifierait ne
jamais la finir. Elle va au bout, une seconde suit le cas échéant, et le trouble
se rattrape en une seconde après le relâchement — c'est-à-dire au moment où on
le regarde.

Le noyau GLSL est inchangé : **0,88 ns/px**, dans le bruit de la mesure
précédente (dispersion ±8 %).

---

## La perspective atmospherique — phase 9

### La dette que cette phase solde

Depuis que le ciel etait passe au solveur physique, les astres et les avions
etaient restes sur l'ancien noyau analytique `hazeColorAlong` : deux
coefficients de Rayleigh choisis a la main, une phase de Henyey-Greenstein, un
facteur d'exposition de calibrage de 0,3. **Le ciel et le voile des objets
suivaient deux modeles differents**, et un astre bas ne se fondait plus dans le
ciel qui l'entourait.

### La table est le ciel, prolonge vers l'observateur

Plutot que d'ajouter une seconde table aux objets, l'axe des **distances** a ete
ajoute a celle du ciel :

| Axe | Domaine | Parametrisation |
| --- | --- | --- |
| `u` | azimut relatif au Soleil, 0 à 180° | linéaire, repliée par symétrie |
| `v` | hauteur de visée, 0 à 90° | `v = √(h/90)` |
| `w` | distance | `t = trajet_total · w²` |

La normalisation de `w` par le trajet atmospherique **propre a chaque
direction** est le choix qui porte toute la phase : `w = 1` designe exactement la
sortie de l'atmosphere, quelle que soit la visee. Un astre est a l'infini, il
tombe donc pile sur le dernier texel — et non entre deux, ou l'interpolation
l'aurait decale du ciel voisin.

Consequence : **le fond de ciel n'a plus sa propre table**, il lit cette tranche.
Un astre lit la meme. Le raccord n'est pas ajuste, il est structurel.

Mesure : la tranche lointaine reproduit `skyRadiance` a **5,5·10⁻⁸** aux nœuds
exacts. Et le banc de non-regression le confirme a l'ecran — **aucune derive
colorimetrique** sur les 42 sondes apres bascule.

### Une seule marche, seize distances

La transmittance a la distance `d` et la diffusion cumulee jusqu'a `d` sont des
**prefixes** des memes integrales que le ciel entier. La marche accumule deja
les colonnes depuis l'observateur : il suffit de relever leur valeur en chemin.

C'est ce qui rend une table 3D a peine plus chere qu'une 2D — 92 ms contre 34,
pour seize fois plus de donnees. `skyRadiance` est d'ailleurs devenu un **cas
particulier** de `aerialPerspective`, avec un seul intervalle : il n'y a plus
qu'une implementation du transport, donc aucune derive possible entre ce que
voit le fond et ce que voit un astre.

### Ce qui disparait du chemin de rendu

Plus aucun materiau n'appelle `scene/atmosphere.ts`. Avec lui sortent les
dernieres constantes choisies a la main du rendu atmospherique :

| Constante | Valeur | Devenue |
| --- | --- | --- |
| `RAYLEIGH_COEFFICIENTS` | `[55e-7, 13e-6, 224e-7]` | sections efficaces de Bodhaine |
| `MIE_COEFFICIENT` | `21e-6` | calcul de Mie sur distribution log-normale |
| `MIE_G` | `0,758` | asymetrie calculee, 0,646 a 550 nm |
| `SUN_INTENSITY_REF` | `22` | spectre solaire ASTM G173 |
| `uAtmosphereExposure` | `0,3` | l'exposition du ciel, partagee |

Le module reste dans l'arbre, **hors du chemin de rendu**, comme point de
comparaison du banc de mesure — et son en-tete le dit.

### Le cout, mesure

| Noyau | Cout | 1920x1080@dpr2 |
| --- | --- | --- |
| ancien noyau analytique (16×8) | 0,88 ns/px | 7,27 ms — 44 % d'une image |
| **lecture de la table (phase 9)** | **0,04 ns/px** | **0,31 ms — 2 %** |

Un facteur **22**, et la mesure de la phase 9 comprend **deux** lectures : un
astre a l'infini et un objet a distance finie. Le banc mesurait jusqu'ici un
noyau que plus rien n'appelle ; il porte desormais les deux, l'ancien etiquete
comme tel.

Cote processeur, la construction s'etale a deux lignes par image (2,9 ms), comme
la table de ciel qu'elle remplace.

### ⚠️ La transmittance spectrale reduite a trois nombres

Le transport calcule `T(λ)` sur seize bandes ; le nuanceur n'en porte que trois.
Or `∫L(λ)T(λ)` ne se factorise pas en `(∫L)(∫T)` : reduire une transmittance a
trois nombres n'est **exact que pour un spectre d'objet donne**.

Le spectre de reference retenu est celui du **Soleil**, parce que les objets qui
traversent cette table — Lune, planetes, avions — sont eclaires par lui. Les
etoiles ne passent pas par ici : elles gardent leur extinction en magnitudes,
traitee par type spectral.

**C'est une limite de la chaine RGB, pas du transport.** La lever demanderait de
porter le spectre jusqu'au nuanceur.

### Le gamut sRGB, et deux artefacts qu'il faut distinguer

Une transmittance tres rougie — visee rasante, plusieurs dizaines de masses
d'air — a une chromaticite qui **sort du triangle sRGB**. Sa projection sur la
primaire bleue, qui a des lobes negatifs dans le rouge, devient alors legerement
negative. Deux grandeurs sont touchees, et elles ont ete traitees
differemment :

| | Ampleur | Traitement |
| --- | --- | --- |
| **transmittance** | jusqu'a −2,5·10⁻³, remontee de 8,6·10⁻⁴ sur des valeurs de 2·10⁻³ — **43 % en relatif** | ecretee a zero puis minimum courant |
| **diffusion cumulee** | baisse de 7,2·10⁻³ sur 25,8 — **2,8·10⁻⁴**, jamais negative | **rien** |

La transmittance est un **multiplicateur** : un signe negatif y inverserait le
canal bleu de l'objet, et la remontee brisait la decroissance avec la distance —
une violation par direction, exactement. La diffusion est un terme **additif**,
toujours positif, dont l'artefact reste sous le dix-millieme, et dont la tranche
lointaine est validee au bit pres contre `skyRadiance`. La forcer abimerait le
ciel pour rien.

Dans les deux cas, **le spectre est monotone a zero violation** : la physique est
juste, c'est la projection qui ne l'herite pas. Le test a ete reecrit sur la
grandeur ou l'invariant est vrai, pas assoupli.

### L'echantillonneur GPU verifie contre l'echantillonneur CPU

Les seize tranches sont **empilees verticalement** dans une texture de 64 x 512
— ce qui est deja la disposition memoire naturelle de la table, et evite
d'imposer GLSL ES 3.00 aux trois materiaux consommateurs. L'indexation en bande
et le recentrage de texels sont exactement le genre d'endroit ou une erreur d'un
texel serait invisible a l'oeil.

Le nuanceur a donc ete compile hors de l'application et compare a
`sampleAerialLut` sur 24 combinaisons de visee et de distance : accord a
**4,5·10⁻⁵**, la precision du flottant simple.

---

## L'indice de refraction de l'air — phase 10

### Pourquoi un second indice, alors qu'il en existe deja un

`rayleigh/standardAir.ts` porte l'indice de **Peck & Reeder**, et il n'est pas
remplace : il est juste la ou il est. La section efficace de Rayleigh s'ecrit
`(n²−1)²/N²`, et ce rapport n'a de sens que si `n` et `N` decrivent le **meme**
gaz, aux memes conditions de reference. Y mettre un indice local serait une
erreur, pas un raffinement.

Ciddor repond a l'autre question, celle que Peck & Reeder ne peut pas traiter :
**quel est l'indice ici**, a cette temperature, sous cette pression, avec cette
humidite ? C'est la grandeur dont depend la courbure d'un rayon.

### La structure de la formulation

Ciddor ne calcule pas `n` directement. Il calcule deux refractivites **aux
conditions ou elles ont ete mesurees**, puis les ramene aux conditions reelles
par le rapport des masses volumiques :

```
n − 1 = (ρ_a/ρ_axs)·(n_axs − 1) + (ρ_w/ρ_ws)·(n_ws − 1)
```

L'air sec et la vapeur d'eau sont traites separement — leurs dispersions n'ont
rien a voir — et les densites viennent d'une equation d'etat de gaz **reel**, non
de la loi des gaz parfaits.

### Le probleme de validation particulier a ce module

Il est presque entierement fait de **constantes publiees** : quatre pour la
dispersion de l'air sec, quatre pour la vapeur, neuf pour l'equation d'etat,
quatre pour la pression saturante. Une coquille dans l'une d'elles decalerait le
resultat de quelques pour cent au plus — c'est-a-dire de rien du tout a l'oeil.
L'indice de l'air vaut 1,0003, et il vaudrait encore 1,0003.

Les controles de forme sont donc sans valeur ici. Seuls comptent les
**recoupements independants**, et ils sont tous passes :

| Recoupement | Resultat |
| --- | --- |
| Ciddor **contre Peck & Reeder**, 380 à 780 nm | **3,5·10⁻⁵** en relatif |
| `n` à 633 nm, 20 °C — valeur de l'article | **1,000271800**, écart 1,7·10⁻¹⁰ |
| Densité CIPM **contre US1976** | 0,0375 % mesuré, 0,0408 % prédit par `1/Z` |
| svp Ciddor **contre Buck** (−20 à +40 °C) | **0,039 %** |
| Facteur d'accroissement, les deux formes | **0,018 %** |
| **Réfraction astronomique à 45°** | **58,3″** contre 58,2″ des éphémérides |

Le premier est le garde-fou : deux formulations publiees a vingt-quatre ans
d'intervalle, par des chemins sans rapport, decrivent le meme air standard. Le
dernier est le plus parlant — une formule de metrologie retombe a 0,2 % sur une
constante d'ephemeride.

### L'humidite abaisse l'indice

Contre-intuitif, et vrai : dans le visible, remplacer des molecules d'air par des
molecules d'eau **diminue** l'indice. La vapeur est moins refringente par
molecule que l'air a ces longueurs d'onde, et l'air humide est de surcroit moins
dense (18 g/mol contre 29).

Mesure : de l'air sec a l'air sature a 20 °C, `n−1` passe de 2,7308·10⁻⁴ a
2,7224·10⁻⁴, soit **−0,31 %**.

C'est un invariant de **signe**, et c'est pour cela qu'il est teste : une
inversion y serait totalement invisible sur les ordres de grandeur.

### Deux conventions de CO₂ qui different, et ce n'est pas une coquille

La formule de dispersion de l'air sec est etablie pour **450 ppm** ; la formule
de masse molaire du CIPM est referencee a **400 ppm**. Les deux chiffres
coexistent donc dans le module, avec des roles differents. C'est ainsi que
l'article est ecrit, et les aligner serait une erreur.

### Deux formules pour la meme grandeur, volontairement

Le moteur porte desormais **deux** pressions saturantes et **deux** facteurs
d'accroissement : ceux de Buck (1981) dans `thermodynamics/waterVapour.ts`, que
suit la meteorologie, et ceux de Ciddor dans `refraction/airIndex.ts`.

Ce n'est pas une duplication a resorber. Une formulation doit etre employee avec
les relations auxiliaires sur lesquelles ses coefficients ont ete ajustes ;
melanger les deux introduirait un desaccord sans le dire. L'ecart est mesure et
documente — 0,039 % et 0,018 % — plutot que masque.

> **Dette de phase 1 soldee.** Le commentaire de `enhancementFactor` portait
> « coefficient a confronter a la publication avant la phase 10 ». Buck (1981)
> donne `f_w = 1,0007 + 3,46·10⁻⁶ P` avec `P` en millibars : c'est exactement la
> forme qui etait ecrite. Confirmee.

### Ce que la phase 10 ne fait pas

**Rien n'arrive a l'ecran.** Aucun materiau ne lit ce module, et le banc le
confirme — aucune derive colorimetrique, noyaux GPU dans le bruit. C'est de
l'infrastructure : le profil vertical `n(z)` et son gradient sont ce dont la
phase 11 a besoin pour courber les rayons.

Le gradient au sol vaut **−2,67·10⁻⁸ m⁻¹**. C'est cette pente qui fixe l'echelle
de tout ce qui suivra, et c'est son **inversion locale** au ras d'une surface
chaude qui produira les mirages — d'ou le pont `sampleRefractiveIndex`, qui lit
un point d'etat de l'atmosphere plutot que l'atmosphere standard, laquelle n'a
jamais d'inversion.

Deja mesurable, et deja au bon ordre de grandeur : a 85° de distance zenithale,
la refraction vaut **661″ dans le bleu contre 651″ dans le rouge**. Ces dix
secondes d'arc sont le germe du rayon vert.

---

## La courbure des rayons — phase 11

### Ce qui change

Jusqu'ici, tous les rayons du moteur etaient **droits**. C'est ce qui interdisait
a une classe entiere de phenomenes d'exister — le Soleil visible alors qu'il est
geometriquement couche, son disque aplati, le rayon vert, les mirages. Aucun
n'est un effet a peindre : ce sont des consequences du fait qu'un rayon ne va pas
droit dans un milieu dont l'indice varie.

### L'invariant, et la singularite qu'il faut savoir traiter

En stratification spherique, la loi de Snell devient une constante le long du
rayon :

```
n(r)·r·sin z = L        →        R = −∫ tan z ·(1/n)(dn/dr) dr
```

A l'horizon `z → 90°`, donc `tan z → ∞`. L'integrale reste finie — la
singularite est en racine carree — mais l'evaluer naivement rend l'infini des le
premier pas.

Le changement de variable **`r = r₀ + w²`** la supprime exactement : pres de
l'observateur `cos z ∝ w`, la tangente diverge en `1/w`, et le `2w dw` du
jacobien l'annule terme a terme. Ce n'est pas une commodite numerique — c'est la
seule facon d'obtenir la refraction a l'horizon, precisement la ou tout se joue.

### Confrontation aux grandeurs publiees

| Grandeur | Modele | Reference |
| --- | --- | --- |
| Réfraction à 45° | **57,99″** | 58,23″ — *Astronomical Almanac* |
| Réfraction horizontale | 33,53′ | 34,48′ — Bennett (−2,8 %) |
| Accord général 1–45° | **< 2,9 %** | Bennett |
| Dépression de l'horizon, 35 m / 1 km | 0,911 / 0,915 | rapport classique ~0,92 |
| Astre visible dès | **−33,0′** | −34′ des almanachs |
| **Disque solaire couchant** | **27,6′ × 32,0′** | ~28′ observé |

Les conditions sont ramenees a celles des references : une table de refraction
sans sa temperature et sa pression ne veut rien dire.

Bennett s'ecarte de 2 a 3 % en altitude, ou l'Almanach est suivi a **0,4 %** —
c'est son ajustement empirique qui derive la, pas le modele.

### Ce qui emerge, sans etre ecrit

**Le Soleil aplati.** La refraction decroit quand la hauteur augmente : le limbe
inferieur est donc releve davantage que le superieur, et le disque s'ecrase. Le
facteur est `da_apparente/da_vraie`, une **derivee de la meme fonction** que la
position — ni parametre, ni courbe d'ajustement. Le diametre horizontal n'est pas
touche, d'ou un ovale et non un disque plus petit.

| Hauteur vraie | Facteur | Diamètre vertical |
| --- | --- | --- |
| 0° | **0,8638** | **27,6′** contre 32,0′ |
| 0,5° | 0,8882 | 28,4′ |
| 2° | 0,9367 | 30,0′ |
| 20° | 0,9977 | 31,9′ |

**Le lever anticipe.** Un astre est visible des sa hauteur vraie de −33,0′ : le
Soleil se leve avant d'etre leve, et se couche apres s'etre couche.

**La reponse aux conditions.** −40 °C donne 41,7′ a l'horizon, +40 °C 30,2′ : la
dispersion reelle observee, 30′ a 42′. Rien ne la parametre — elle sort de la
densite de l'air.

**La dispersion chromatique.** 53,9″ entre 400 et 700 nm a l'horizon, soit 2,8 %
du diametre solaire. C'est le germe du rayon vert.

### La branche descendante, et la depression de l'horizon

Une visee sous l'horizon apparent — depuis un sommet, un avion — suit un rayon
qui **descend**, atteint un point tangent, puis remonte. Les deux branches sont
integrees, et le raccord est verifie par la continuite a la traversee de
l'horizontale : 4,2·10⁻⁴ en relatif.

Un rayon qui rencontrerait le sol rend `NaN` plutot qu'un nombre plausible. Une
valeur silencieusement fausse serait pire qu'une absence de valeur.

### ⚠️ Le mirage n'est pas encore possible, et voici pourquoi

Le module fournit `surfaceInversionProfile` : une couche surchauffee est moins
dense, donc **moins refringente**, et le gradient d'indice s'y retourne — mesure,
de −2,67·10⁻⁸ a +1,19·10⁻⁵ m⁻¹ pour 15 K d'exces sur un metre.

Mais un mirage demande davantage : il faut que `n(r)·r` cesse d'etre monotone,
c'est-a-dire `dn/dr < −1/r`, soit **six fois le gradient standard**. La racine du
point tangent cesse alors d'etre unique — le meme astre est vu par deux chemins.
La dichotomie n'en trouve qu'une, et le module ne rend qu'une image.

Le crochet est en place, la condition est identifiee et chiffree, le phenomene ne
peut pas encore apparaitre. C'est dit plutot que suggere.

### Le cout, et la table

L'integrale coute **0,2 ms**, et son inversion vers la hauteur apparente 1,6 ms.
Dix astres feraient 14 ms — presque une image entiere — et les etoiles se
comptent par milliers.

La table contourne l'inversion par le sens de construction : elle est batie sur
une grille de hauteurs **apparentes**, dont les hauteurs vraies se deduisent par
soustraction. La suite obtenue est croissante, et la lecture inverse n'est plus
qu'une dichotomie.

| | Cout | Ecart au solveur |
| --- | --- | --- |
| solveur direct | 1 600 µs | — |
| **table de 512 entrees** | **0,023 µs** | **2,1″** |

Un facteur **70 000**, pour 2,1 secondes d'arc sur un disque solaire qui en fait
1920. Construction : 16 ms, une fois.

> **Une erreur que le profil tabule a revelee.** La derivee de l'indice se prend
> par difference finie sur un metre : a dix centimetres d'altitude, elle
> interroge donc `n(−0,9 m)`. Ecreter a zero y **halve le gradient**, la ou la
> refraction horizontale se joue presque entierement — 9,3 secondes d'arc
> d'erreur. Extrapoler sous le sol la ramene a 2,4″.

### Rien n'arrive encore a l'ecran, et c'est un choix

Comme la phase 10, celle-ci est de l'infrastructure. Le cablage n'est **pas**
fait, et deliberement.

La raison est dans le code lui-meme : `astro/bodies.ts` desactive explicitement
la refraction avec un commentaire qui avertit qu'un melange des deux conventions
« decale les etiquettes de leurs objets ». Les corps du systeme solaire, les
etoiles, le ciel profond, les constellations et les etiquettes suivent des
chemins differents — direction equatoriale tournee par matrice pour les uns,
coordonnees horizontales pour les autres.

**Une refraction a moitie cablee serait pire que pas de refraction du tout** :
une planete se detacherait visiblement de sa constellation pres de l'horizon, de
plus d'un diametre lunaire. Le cablage doit se faire d'un seul tenant, pour
toutes les couches, et c'est un travail distinct.

---

## Les phenomenes emergents de refraction — phase 12

### Ce que la phase 11 avait laisse en suspens

La physique etait validee et ne produisait rien a l'ecran. La raison etait
explicite : le ciel est peuple par **cinq mecanismes de placement differents**,
et une refraction a moitie cablee aurait ete pire que pas de refraction du tout.

| Couche | Placement | Ou la refraction entre |
| --- | --- | --- |
| Corps du systeme solaire | direction équatoriale tournée, sur le processeur | `refractSceneDirection` |
| Étoiles | même direction, tournée dans un nuanceur | `REFRACTION_LUT_GLSL` |
| Ciel profond | idem, par instance | idem |
| Constellations | matrice appliquée à l'objet entier | **matériau réécrit** |
| Étiquettes | coordonnées horizontales | suivent les corps |

Les constellations meritent un mot : la refraction **n'est pas une transformation
lineaire**, et aucune matrice ne peut la porter. Leur `lineBasicMaterial` a donc
ete remplace par un materiau propre, qui redresse chaque sommet comme les etoiles
qu'il relie. Sans cela, une figure basse se serait decrochee de ses propres
etoiles d'un demi-degre.

### Une seule table, deux lecteurs

`RefractionTable` est construite une fois par site — seize millisecondes — et lue
des deux cotes : par `refractSceneDirection` sur le processeur, par une texture
de 512 texels sur le GPU. Les deux portent les memes valeurs par construction.

Mesure de l'accord, nuanceur compile hors application et compare a
`refractSceneDirection` sur 45 directions : **2,6 secondes d'arc**, pour un pixel
qui en vaut une centaine au champ courant. Un astre et une etoile dans la meme
direction atterrissent au meme endroit.

### Ce qui se voit maintenant

**Le Soleil se couche apres s'etre couche.** A Paris le 21 juin, il est encore vu
a 1,22° de hauteur apparente alors qu'il n'est plus qu'a 0,85° de hauteur
geometrique — et il reste visible jusqu'a −33,0′, soit plusieurs minutes de jour
supplementaires a chaque extremite.

| Hauteur vraie | Relevé | |
| --- | --- | --- |
| 7,13° | 7,01′ | |
| 3,57° | 11,96′ | |
| 1,52° | 18,54′ | |
| 0,85° | **21,99′** | |

**Le disque solaire est un ovale.** Le limbe inferieur etant releve davantage que
le superieur, le disque s'ecrase :

| Hauteur vraie | Échelle verticale | Diamètre |
| --- | --- | --- |
| 0° | **0,8637** | **27,6′ × 32,0′** |
| 1° | 0,9080 | 29,1′ × 32,0′ |
| 5° | 0,9758 | 31,2′ × 32,0′ |

Le facteur est la **derivee** de la fonction qui a servi a placer l'astre, pas un
parametre. Le groupe qui porte le corps n'ayant ni rotation ni echelle, ses axes
sont ceux de la scene : une echelle verticale y comprime exactement selon la
verticale locale, et le diametre horizontal reste intact.

### Sous l'horizon apparent, une discontinuite qu'il fallait supprimer

Il n'y a la, au sens strict, **aucune image** : plus aucun rayon ne parvient a
l'observateur. Rendre la hauteur vraie telle quelle etait pourtant le mauvais
choix — la fonction faisait alors un saut de trente-trois minutes d'arc a la
frontiere, **et la texture avec elle** : 1377 secondes d'arc d'erreur
d'interpolation juste sous l'horizon.

Le prolongement retenu conserve la refraction horizontale : l'astre continue de
descendre au meme rythme, en restant cache. La fonction reste continue et
croissante, ce dont dependent l'interpolation de la texture et le mouvement d'un
astre qui se couche. L'erreur retombe a **2,0 secondes d'arc**.

La visibilite ne se decide donc pas au signe du resultat, mais par `isVisible`.

### ⚠️ Un mot reserve, et ce qu'il enseigne

`flat` est un **qualificateur d'interpolation** du langage GLSL. En avoir fait un
nom de variable locale a fait echouer la compilation des trois nuanceurs qui
incluent le fragment partage.

Ce qui compte ici n'est pas la faute mais sa signature : le chemin **processeur**
fonctionnait parfaitement — les corps se relevaient, le disque s'aplatissait — et
seules les etoiles restaient en place. C'est exactement le mode de defaillance
que cette phase visait a eviter, et il n'a ete vu que parce que l'application est
chargee et sa console lue a chaque etape. Ni la compilation TypeScript, ni la
suite de validation, ni le banc colorimetrique ne pouvaient l'attraper.

### La vue depuis l'espace reste un cas du modele

Le calque « atmosphere » eteint remet les rayons droits. Le drapeau vit dans la
couche atmospherique, non dans la scene : la couche **astronomique** doit le lire
elle aussi, faute de quoi une etiquette resterait a la position apparente d'un
astre dessine a sa position geometrique.

### ⚠️ Ce qui n'est pas refracte, et pourquoi

**Le fond de ciel.** Sa table est construite le long de rayons **droits** : en
courber la direction d'echantillonnage serait incoherent avec la facon dont elle
a ete calculee. Le traitement juste est d'integrer le transport le long du rayon
courbe, ce qui est un changement de fond. La consequence visible est nulle sur un
degrade lisse, mais le bord de l'ombre de la Terre est decale d'un demi-degre.

**Les avions et les satellites.** Ils sont **dans** l'atmosphere, a distance
finie : leur refraction est une autre integrale, de l'observateur a l'objet et
non a l'espace. Leur appliquer la refraction astronomique serait faux. La
physique dit qu'ils different, et ils different.

**Le rayon vert.** La refraction est chromatique — 53,9 secondes d'arc entre 400
et 700 nm, soit 2,8 % du diametre solaire. Le rendre demanderait trois tables et
un disque rendu spectralement, ce qui appartient a l'optique ondulatoire. Le
decalage est ici plus fin que le disque n'est pixellise.

### Cout

Aucun. La table est memoisee par site, la texture fait 512 texels, et le banc ne
mesure aucune derive colorimetrique ni aucun changement de cout GPU — la
refraction deplace des objets, pas des pixels de ciel.

---

## L'atmosphere 3D — phase 13

### L'hypothese que cette phase leve

Tout le moteur, jusqu'ici, suppose l'atmosphere **a symetrie spherique** :
l'indice, la densite et la temperature ne dependent que de l'altitude. Ce n'est
pas un detail d'implementation — c'est ce qui rend possible l'invariant de
Bouguer, une table de ciel a deux dimensions, et un point tangent unique.

C'est aussi ce qui interdit tout ce qui varie **horizontalement** : une dalle de
bitume surchauffee, un front qui approche, une couche d'inversion qui ne couvre
qu'un secteur. C'est-a-dire l'essentiel de ce qui fait un mirage reel, lequel
n'est presque jamais symetrique.

### L'equation qui remplace l'invariant

Des que l'indice varie horizontalement, il n'y a plus de constante du mouvement
a exploiter. Il faut integrer l'equation du rayon elle-meme :

```
dr/ds = u          du/ds = (∇n − (u·∇n)·u) / n
```

Le second terme du numerateur retire la composante **longitudinale** du
gradient : seule sa partie transverse courbe le rayon, la longitudinale ne fait
que changer la vitesse de phase. C'est ce qui garde `u` unitaire, et c'est
exactement ce qui manquerait a une integration naive.

### Le controle qui porte la phase

Le traceur **n'utilise jamais** l'invariant de Bouguer. Dans un champ spherique,
il doit pourtant le conserver, et retomber sur la refraction de la phase 11 —
obtenue par un tout autre chemin.

| Contrôle | Résultat |
| --- | --- |
| Traceur 3D **contre** intégrale 1D de la phase 11 | **0,044″** sur 1980″ |
| Invariant de Bouguer, dérive sur 24 035 pas | **1,6·10⁻⁷** |
| Isotropie azimutale d'un champ sphérique | 2·10⁻⁷ ″ — bruit de flottant |
| Gradient par différences finies **contre** analytique | 9,1·10⁻⁸ |
| Perturbation nulle **contre** champ de base | **égalité stricte** |

Le premier est plus fort qu'une comparaison a une table publiee : il n'y a ici
aucune reference exterieure a laquelle s'ajuster. Deux algorithmes sans rien de
commun rendent le meme nombre.

Le deuxieme est meilleur encore — c'est une **loi de conservation que le schema
numerique ignore**. Il ne peut pas la satisfaire par construction.

### La composition plutot que l'heritage

Un champ est une fonction ; une perturbation est une fonction qui en enveloppe
une autre. L'atmosphere standard spherique est le champ de base ; la dalle
chauffee et le gradient horizontal sont des couches posees dessus.

D'ou le controle a **egalite stricte** : une perturbation d'amplitude nulle rend
le champ de base au bit pres. Une couche qui deriverait de zero fausserait
silencieusement tout ce qui la traverse, et l'ecart serait porte au compte de la
physique.

### Ce que le champ 3D produit

**Un front de 2 K/km**, sature a 20 K :

| Visée | Réfraction horizontale | Écart |
| --- | --- | --- |
| vers l'air chaud | 30,74′ | **−136″** |
| perpendiculaire | 33,09′ | +5″ |
| vers l'air froid | 35,64′ | **+158″** |

Presque cinq minutes d'arc d'un bord a l'autre. L'air chaud est moins dense donc
moins refringent : viser vers lui diminue la refraction, et rien n'a eu besoin de
l'ecrire.

**Un rayon qui se retourne.** Au-dessus d'une route surchauffee de 35 K sur
80 cm, un rayon vise a −0,2° descend jusqu'a **0,88 m puis remonte**, la ou
l'atmosphere standard le laisse rencontrer le sol. C'est la condition du mirage
inferieur — l'observateur voit le ciel dans une direction ou devrait etre le sol.

L'atmosphere standard, dont le gradient d'indice est monotone, **ne peut pas**
produire cela. Le controle l'affirme dans les deux sens.

### ⚠️ Un bug que seul le mirage pouvait reveler

La couche chaude prenait l'altitude de l'**observateur** comme origine de ses
hauteurs, au lieu de celle du **sol**. Avec un oeil a 1,7 m, il n'y avait donc
aucun echauffement sous 1,7 m — precisement la ou l'inversion existe. Les rayons
rencontraient le sol au lieu de se retourner, et aucun mirage n'etait possible.

`surfaceInversionProfile`, ecrit a la phase 11, portait la meme faute, masquee
par un parametre qui valait zero par defaut. Les deux sont corriges, et le
parametre s'appelle desormais `surfaceAltitudeM`.

Rien d'autre ne pouvait l'attraper : la refraction restait juste, les invariants
etaient conserves, et le champ perturbe rendait des valeurs plausibles. Seule la
question « le rayon remonte-t-il ? » avait une reponse fausse.

### ⚠️ Une fiction commode, bornee

Un gradient horizontal lineaire devient absurde a l'echelle d'un rayon rasant :
celui-ci parcourt trois cents kilometres d'horizontale, ou 2 K/km donneraient six
cents kelvins d'ecart — et une temperature negative d'un cote. Un front reel a
une amplitude finie, que `maxExcessK` porte par saturation en tangente
hyperbolique : lineaire pres de l'observateur, bornee au loin.

### ⚠️ Ce qui reste spherique, et ce que cela coute

Les tables de **ciel** et de **perspective atmospherique** restent construites
sous l'hypothese de symetrie. Les rendre tridimensionnelles ajouterait deux
dimensions a des tables qui en ont deja trois, et le cout serait sans rapport
avec le gain visuel — un degrade de ciel ne se juge pas au dixieme de degre.

La phase 14 n'en a pas besoin : un mirage est un phenomene de **rayon**, pas de
transport, et le traceur qui le produit est la.

### Le cout

Une trace complete a l'horizon coute **22 ms** pour 24 035 pas, et le pas croit
avec l'altitude — cinq metres au ras du sol, deux kilometres en haut. Ce n'est
pas une operation d'image : c'est un outil de phase 14, et l'usage en rendu
passera par une table, comme partout ailleurs dans ce moteur.

---

## Les inversions thermiques et les mirages — phase 14

### Ce qu'est vraiment un mirage

Ce n'est pas une image « reflechie » : rien ne reflechit. C'est le meme rayon,
courbe assez fort par un gradient d'indice inverse pour redescendre vers l'oeil
apres etre parti vers le bas. L'oeil, qui suppose les rayons droits, attribue
alors l'image a la direction d'ou elle arrive.

D'ou la grandeur qui decrit tout : **la fonction de transfert**, qui a une
direction de visee associe la direction d'ou vient effectivement la lumiere.

Dans une atmosphere standard, elle est croissante : viser plus haut, c'est voir
plus haut. **Un mirage est exactement le moment ou elle cesse de l'etre.**

### La forme en V

Route surchauffee de 20 K sur 80 cm, oeil a 1,7 m :

| Visée | Source | |
| --- | --- | --- |
| −0,350° | *le sol* | |
| −0,290° | −0,196° | ↖ branche inversée |
| −0,170° | −0,323° | |
| −0,050° | −0,409° | |
| **−0,020°** | **minimum** | **ligne de fuite** |
| +0,010° | −0,412° | |
| +0,130° | −0,338° | ↗ branche directe |
| +0,250° | −0,220° | |

La fonction descend puis remonte. Deux visees de part et d'autre du minimum
ramenent la meme portion de ciel : **l'objet est vu deux fois**, dont une a
l'envers. C'est la ligne de fuite du mirage, la ou les deux images se rejoignent.

Mesure : **deux images**, image inversee de **0,270°** — a comparer au demi-degre
du disque solaire, ce qui place le regime dans celui du Soleil « vase etrusque ».
A 50 K sur 50 cm, elle passe a 0,450°.

Et la bande de −0,290° a −0,005° rend du **ciel** la ou il devrait y avoir du
sol : c'est la flaque d'eau sur une route seche, qui n'a jamais ete autre chose
que l'image du ciel ramenee vers l'oeil.

### Le decoupage qui rend le calcul possible

Une trace complete coute 22 ms — hors de question par pixel. Mais le mirage se
joue dans les premieres dizaines de metres ; au-dessus, le rayon reprend une
refraction ordinaire, **deja tabulee depuis la phase 11**.

On ne trace donc que la couche limite, et on raccorde. Le cout tombe a **24 ms
par visee**, contre 400 ms pour une trace complete.

### ⚠️ Deux erreurs de repere que seul le raccord pouvait reveler

Le raccord doit etre **indifferent a l'endroit de la coupe** : couper a 8, 20 ou
60 metres doit donner le meme resultat, et retomber sur la table directe quand il
n'y a aucune inversion. C'est ce controle qui a attrape deux fautes, toutes deux
invisibles autrement.

| | Dérive du raccord |
| --- | --- |
| `apparentFromTable` employée à l'envers | 20″ à 118″ selon le sommet |
| angle mesuré sur l'axe Y global | 350″ à 1001″ |
| **corrigé** | **1,3″ de dispersion** |

**La premiere** confondait les deux sens de la table de refraction. Elle va de la
hauteur vraie a l'apparente ; le raccord a besoin de l'inverse — « je regarde la,
d'ou vient la lumiere ? ». Les confondre **ajoute** la refraction la ou il faut
la retrancher. Une fonction `trueFromTable` a ete ajoutee, et les deux sens
existent desormais parce que les deux questions existent.

**La seconde** mesurait l'angle de sortie sur l'axe `Y` global. Or le rayon a
parcouru des kilometres a l'horizontale, et **la verticale locale y a tourne**.
L'erreur croissait en `√(sommet)` — la signature de la distance horizontale, qui
vaut `√(2Rh)` — ce qui a permis de l'identifier.

Aucun des deux ne se voyait sur la forme du mirage, qui restait plausible dans
les deux cas.

### ⚠️ La ligne de fuite est une caustique

Le bord de la bande de retournement reste sensible au pas de marche, meme fin :
un rayon qui se retourne de justesse et un rayon qui touche le sol y sont
voisins. Ce n'est pas un defaut numerique — c'est la nature d'une **caustique**,
et la ligne de fuite d'un mirage en est une.

Le corps de la fonction, lui, est convergé : 0,6932° contre 0,6931° entre un pas
de 0,1 m et un pas de 0,05 m.

### ⚠️ Le pas doit resoudre la couche, et c'est un resultat

Un pas de 3 metres sur une couche de 80 centimetres **efface le mirage**. Ce
n'est pas une limite a masquer : un modele qui ne voit pas la couche ne peut pas
en voir les consequences. La suite de validation le controle explicitement, pour
que le reglage ne derive pas silencieusement vers l'aveuglement.

### ⚠️ Ce qui n'arrive pas a l'ecran, et pourquoi

Un mirage rend l'application `visee → objet` **multivaluee**. C'est toute sa
nature, et c'est ce qui l'oppose a tout ce que le moteur sait faire jusqu'ici :

- la phase 12 **deplace** les objets par une fonction a valeur unique ;
- un maillage ne peut etre qu'a un endroit.

Le Soleil « vase etrusque » — l'image inversee soudee a l'image directe — demande
donc que le disque soit rendu **a travers** la fonction de transfert, et non
deplace par elle. C'est un changement de rendu distinct : il faut echantillonner
le ciel et les astres par direction, dans la bande proche de l'horizon, la ou le
moteur les dessine aujourd'hui comme des objets places.

La physique est la, mesuree et validee. Le rendu ne l'est pas, et ce serait le
faire a moitie que de deplacer le Soleil sur une seule branche.

---

## La turbulence optique — phase 15

### Une seule grandeur

L'air n'est pas homogene : le brassage turbulent mele en permanence des parcelles
a des temperatures legerement differentes, donc a des indices legerement
differents. Un front d'onde qui traverse ce milieu en ressort froisse — et c'est
**toute** l'origine du scintillement des etoiles, du seeing des telescopes et du
tremblement de l'air au-dessus d'une route.

Tout tient dans la **constante de structure de l'indice**, definie par la
fonction de structure de Kolmogorov :

```
D_n(r) = ⟨[n(x) − n(x+r)]²⟩ = C_n² · r^(2/3)
```

L'exposant 2/3 n'est pas ajustable : il sort de l'analyse dimensionnelle de la
cascade turbulente. Mesure : **0,666667**, a 10⁻¹⁶ pres.

### Le lien avec le reste du moteur

Ce ne sont pas les fluctuations d'indice qui existent en premier, ce sont celles
de **temperature** :

```
n − 1 ≈ 79·10⁻⁶ · P/T      dn/dT = −79·10⁻⁶ · P/T²      C_n = |dn/dT|·C_T
```

Cette forme a **un seul terme** est celle qu'emploie toute la litterature de la
turbulence, la ou la phase 10 en emploie une quinzaine. Elles doivent decrire le
meme air — et elles s'accordent a **0,018 %**.

Le signe negatif de `dn/dT` est le meme que celui qui produit les mirages : l'air
chaud est moins dense, donc moins refringent.

### Le modele porte son nom

**Hufnagel-Valley 5/7** tire son nom de ce qu'il doit produire : `r₀ = 5 cm` et
`θ₀ = 7 µrad` a 500 nm au zenith. Ce ne sont pas des valeurs a comparer a une
table exterieure — ce sont celles qui **definissent** le jeu de parametres, et
une constante mal recopiee les ferait manquer.

| | Modèle | Attendu |
| --- | --- | --- |
| `r₀` à 500 nm, zénith | **4,961 cm** | 5 cm |
| `θ₀` | **6,903 µrad** | 7 µrad |
| Seeing | 2,04″ | site ordinaire |
| Fréquence de Greenwood | 72 Hz | quelques dizaines |

### Les lois d'echelle sont des identites

`r₀ ∝ λ^(6/5)` et `r₀ ∝ (cos ζ)^(3/5)` sortent directement de la definition de
Fried. Elles sont donc verifiees a **4·10⁻¹⁶** — la precision machine — et non a
quelques pour cent : ce sont des identites algebriques, pas des mesures.

Consequence immediate : le seeing varie en `λ^(−1/5)`. Il **s'ameliore vers
l'infrarouge, mais lentement** — 2,04″ a 500 nm contre 1,51″ a 2,2 µm, soit un
facteur 1,34 pour un rapport de longueur d'onde de 4,4.

### Ce qui emerge : deux couches, deux phenomenes

Chaque grandeur observable est un moment de `C_n²` le long de la visee, et
**chacune pese l'altitude differemment**. C'est tout ce qui les separe, et cela
suffit :

| Couche | Part de `r₀` (poids `h⁰`) | Part de la scintillation (poids `h^(5/6)`) |
| --- | --- | --- |
| 0 – 100 m | **49,2 %** | 4,4 % |
| 100 m – 1 km | 35,6 % | 14,9 % |
| 1 – 5 km | 8,7 % | 21,7 % |
| **5 – 15 km** | 5,7 % | **49,5 %** |
| 15 – 25 km | 0,7 % | 9,5 % |

**Le seeing vient du sol, la scintillation de la haute troposphere.** Rien ne
l'ecrit : c'est la difference des poids. C'est aussi pourquoi une turbulence de
surface brouille l'image sans faire scintiller, et pourquoi les etoiles basses
scintillent — l'indice croit en `sec^(11/6) ζ`, de 0,234 au zenith a 1,672 a 70°
de distance zenithale.

### Le spectre, et pourquoi il en faut deux

Le spectre de **Kolmogorov**, `Φ_n(κ) = 0,033·C_n²·κ^(−11/3)`, diverge aux deux
bouts : c'est le signe qu'il extrapole la cascade au-dela du domaine ou elle
existe. Celui de **von Karman** la borne par les deux echelles reelles.

Mesure : les deux se confondent a **0,5 %** dans le domaine inertiel (κ = 5 a
50 m⁻¹), et divergent aux bords — rapport 0,66 a κ = 0,5 m⁻¹ ou l'echelle externe
mord, 0,84 a κ = 500 m⁻¹ ou la viscosite dissipe. C'est exactement le
comportement voulu.

### ⚠️ L'echelle externe reste la grandeur mal contrainte

Les mesures vont de **quelques metres a plusieurs centaines** selon le site, la
methode et l'altitude. Vingt-cinq metres est une valeur d'usage pour
l'atmosphere libre.

Ce qui rend cette incertitude vivable : **`r₀` n'en depend pas du tout** dans la
theorie de Kolmogorov, et les grandeurs qui en dependent le font en puissance
fractionnaire. L'echelle interne, elle, est mieux cernee — quelques
millimetres — parce que fixee par la viscosite.

### ⚠️ La scintillation n'est valable qu'en regime faible

Au-dela de `σ_I² ≈ 1`, la theorie de perturbation qui donne l'expression cesse
d'etre valable et l'indice **sature**. A 70° de distance zenithale le modele rend
1,67, donc deja hors du domaine. La formule le signale, elle ne le corrige pas.

### Ce qui n'arrive pas a l'ecran

Rien, encore. La phase 15 fournit les grandeurs ; **la phase 17 les appliquera
aux images d'etoiles** — c'est la que le seeing devient une tache et la
scintillation un clignotement.

---

## L'optique ondulatoire — phase 16

### Ce que le moteur avait deja, et ce qui manquait

La theorie de Mie de la phase 6 **est** de l'optique ondulatoire : elle resout
les equations de Maxwell autour d'une sphere, sans approximation. Ce qui
manquait, c'est l'autre bout de la chaine — ce que devient un front d'onde en
entrant dans une **ouverture**, oeil compris.

### Le 1,22 n'est pas une constante du moteur

C'est le premier zero de la fonction de Bessel `J₁`, divise par π. La validation
le **trouve par dichotomie** plutot que de le supposer : `3,8317059703` contre
`3,8317059702` tabule, soit `1,219670` apres division. Si l'implementation de
Bessel derive, le critere de Rayleigh derive avec elle, et le controle le voit.

### La question que l'application posait sans le savoir

Le seeing vaut deux secondes d'arc (phase 15). **Pourquoi les etoiles ne
paraissent-elles pas floues a l'oeil nu ?**

| Ouverture | Diffraction | Limitée par | Tache réelle |
| --- | --- | --- | --- |
| pupille jour, 2 mm | **58,4″** | diffraction | 58,4″ |
| pupille nuit, 7 mm | 16,7″ | diffraction | 16,8″ |
| jumelles 50 mm | 2,33″ | diffraction | 3,07″ |
| télescope 200 mm | 0,58″ | **atmosphère** | 2,08″ |
| télescope 1 m | 0,12″ | atmosphère | 2,00″ |

**L'oeil nu est limite par sa propre diffraction, d'un facteur 29.** Il ne *peut
pas* voir le flou atmospherique. Il voit en revanche parfaitement la
scintillation, qui est une variation d'intensite et non de forme.

Ce n'est ecrit nulle part : c'est la comparaison de deux grandeurs calculees
separement, l'une par une tache d'Airy, l'autre par une integrale de `C_n²`.

### Le croisement retrouve le parametre de Fried

Le diametre au-dela duquel l'atmosphere l'emporte vaut **5,8 cm**, calcule ici a
partir de la tache d'Airy et du seeing. Le parametre de Fried de la phase 15,
obtenu par une integrale de `C_n²` sur vingt-cinq kilometres, vaut **5,6 cm**.

Deux chemins sans rien de commun, 4 % d'ecart — et c'est la **definition
physique** de `r₀`, retrouvee au lieu d'etre posee.

### Les couronnes ne sont ecrites nulle part

Le module ne dessine aucun anneau et n'en connait aucun rayon. Il calcule la
fonction de phase de Mie d'une gouttelette de nuage — le solveur de la phase 6,
sans un coefficient de plus — et **cherche ou elle a des minima**.

| Gouttelette | Premier minimum de Mie | Prédiction par diffraction | Écart |
| --- | --- | --- | --- |
| 3 µm | 6,689° | 6,406° | +4,4 % |
| 5 µm | 3,703° | 3,844° | −3,7 % |
| 10 µm | 1,885° | 1,922° | −1,9 % |
| 20 µm | 0,951° | 0,961° | **−1,0 %** |

L'accord **s'ameliore avec la taille**, comme une asymptotique le doit : la
prediction traite la gouttelette comme un disque opaque, le solveur resout
Maxwell autour d'une sphere transparente.

La couronne est **coloree, et dans le bon sens** : 1,551° a 450 nm contre 2,234°
a 650 nm, soit un rapport de 1,4409 pour 1,4444 attendu. Bleu a l'interieur,
rouge a l'exterieur — l'inverse d'un arc-en-ciel, ou commande la dispersion et
non la diffraction.

Et la lecture inverse marche : un anneau de 2,352° redonne une gouttelette de
8,17 µm pour 8,00 reels. C'est **l'usage historique** des couronnes — avant les
sondages, mesurer le rayon d'une couronne lunaire estimait la taille des
gouttelettes d'un nuage.

### ⚠️ Une assertion fausse, corrigee par la physique

Un premier controle affirmait qu'a 3 µm la prediction par diffraction « cessait
de valoir », sur la foi d'un ecart de **43 %**. C'etait faux, et pour une raison
instructive.

La fonction de phase d'une sphere **transparente** de grand parametre de taille
porte une structure fine de **resonances** — les modes propres de la
gouttelette — superposee a l'enveloppe de diffraction. La detection du premier
minimum prenait une ondulation pour l'anneau.

Or un nuage reel n'est **jamais monodisperse**, et la dispersion des tailles
lisse ces resonances en laissant l'enveloppe intacte. C'est precisement pour cela
que les couronnes observees ont des anneaux nets, et qu'une couronne bien marquee
signale un nuage a distribution etroite.

Moyenner sur 5 % de dispersion n'etait donc pas un lissage de confort : **c'etait
ce qui manquait au modele**. L'ecart a 3 µm tombe de 43 % a 4,4 %, et celui a
20 µm de 2,8 % a 1,0 %. Le controle a ete reecrit sur l'enonce correct — l'accord
se degrade vers les petites tailles, sans rupture.

| | Gouttelette unique | 5 % de dispersion |
| --- | --- | --- |
| Écart à 10 µm | 4,5 % | **1,3 %** |

### ⚠️ Ce qui n'arrive pas a l'ecran

Aucune couronne. Le voile atmospherique du moteur suppose une **atmosphere
claire** : ni nuage, ni gouttelette. Poser une couronne demanderait une couche de
nuage dans le transport, qui n'existe pas.

Le calcul est ici parce que la physique y est, mesurable et verifiable — et parce
que la limite de diffraction, elle, sert des maintenant a repondre a une question
que l'application posait.

---

## Le seeing et la scintillation — phase 17

### Une decision de rendu, appuyee sur une mesure

La phase 16 avait etabli que la pupille impose **16,7″ a 58,4″** de limite par sa
seule diffraction, contre **2,00″** de seeing. La phase 17 en tire la
consequence : **on ne rend pas le seeing.** L'oeil ne peut pas le voir, et le
champ de l'application n'a de toute facon que 42 secondes d'arc par pixel.

La scintillation, elle, n'est pas une deformation de l'image mais une variation
de son **intensite**. L'oeil la percoit parfaitement, et c'est donc la seule des
deux qui arrive a l'ecran.

### Ce que voit vraiment l'oeil

| | |
| --- | --- |
| Couche responsable | **7,42 km** — barycentre du moment `h^(5/6)` |
| Rayon de Fresnel | **6,39 cm** |
| Fréquence caractéristique | **548 Hz** |
| Fraction sous la fusion rétinienne | **3,7 %** |

La variance totale porte tout le spectre, jusqu'a plusieurs centaines de hertz.
La retine en moyenne l'essentiel : **une etoile au zenith ne fremit qu'a
σ = 0,094 magnitude**, la ou la variance brute laisserait croire a un
clignotement spectaculaire.

L'altitude de la couche n'est pas choisie — c'est le barycentre du moment dont
depend la scintillation, et il retrouve la tranche 5–15 km que la phase 15 avait
designee par un autre calcul.

### Pourquoi les planetes ne scintillent pas

**Aucune regle ne le dit.** C'est le rapport de deux longueurs : la taille
qu'une source projette a l'altitude de la couche, comparee au rayon de Fresnel.

| Objet | Taille projetée à 7,4 km | Moyennage | σ à 30° de hauteur |
| --- | --- | --- | --- |
| étoile | 0 m | 1,000 | **0,210 mag** |
| Mars, 5″ | 0,18 m | 0,045 | 0,031 |
| Jupiter, 40″ | 1,44 m | 0,0004 | **0,0028 mag** |
| Lune, 30′ | 65 m | ~0 | 3·10⁻⁵ |

Un facteur **76** entre une etoile et Jupiter, et la transition tombe a
**1,8 secondes d'arc** — la ou une source projette exactement un rayon de
Fresnel. Uranus et Neptune sont pile dessus, ce qui est correct : ce sont les
seules planetes dont on discute encore si elles scintillent.

### L'exposant qui permet le rendu

La variance percue suit `sec^(7/3) ζ`, et cet exposant est une somme :

- `11/6` pour la variance elle-meme ;
- `1/2` parce qu'une visee oblique **allonge le trajet** jusqu'a la couche,
  agrandit le rayon de Fresnel, abaisse la frequence — dont l'oeil percoit alors
  une fraction plus grande.

Mesure : **2,341** contre 2,333 predits. Ce n'est pas un ajustement, c'est une
addition.

C'est cet exposant unique qui permet de ne porter au GPU **qu'une seule
constante** — la variance percue au zenith, `7,55·10⁻³` — toute la dependance a
la hauteur etant analytique dans le nuanceur. Une etoile a 20° scintille alors a
0,324 magnitude contre 0,094 au zenith, sans que rien ne l'ecrive.

### Ce qui est physique, et ce qui est un tirage

Le nuanceur module l'intensite de chaque etoile par trois sinusoides de
frequences incommensurables, normalisees a **variance unite**. La realisation
est arbitraire — c'est un tirage. Ce qui est physique, c'est son **amplitude** et
sa **bande passante**, toutes deux issues de `C_n²`.

Le temps employe est le temps **reel**, non le temps simule : en avance rapide,
les etoiles continuent de fremir au meme rythme, parce que la turbulence ne
depend pas de la vitesse a laquelle on fait defiler le ciel.

Et sans atmosphere, plus de turbulence : les etoiles cessent de scintiller en
meme temps que le ciel disparait. C'est le drapeau que la refraction portait
deja.

### ⚠️ Le plafond est une borne de validite

A cinq degres de hauteur le modele rend `σ_I² = 18,3`. Au-dela de 1, la theorie
de perturbation **surestime** : la scintillation reelle sature puis decroit, les
taches de lumiere se fragmentant au lieu de se creuser.

Le plafond de 0,5 sur la variance percue — soit 0,69 magnitude — n'est donc pas
un reglage esthetique mais la borne du domaine, posee explicitement plutot que
laissee diverger.

### ⚠️ Deux approximations signalees

**Le moyennage d'ouverture** emploie la forme d'ingenierie d'Andrews & Phillips
plutot que l'integrale double exacte. Elle est correcte aux deux limites — et son
asymptote en `D^(−7/3)` est mesuree a 0,2 % — a quelques pour cent entre.

**La fraction percue** suppose un spectre plat a coupure franche et une reponse
retinienne en creneau. Elle donne l'ordre de grandeur de ce qui reste visible,
pas sa valeur exacte. La frequence de fusion retenue, 20 Hz, est celle de la
vision **scotopique** — celle dont on regarde les etoiles.

---

## Le calage scientifique — phase 19

### Deux grandeurs que le transport attendait

Le solveur savait depuis longtemps prendre en compte la distance du Soleil et la
colonne d'ozone. **Personne ne les lui donnait.** Les brancher n'ajoute aucune
physique : cela cesse d'en soustraire.

**La distance du Soleil** vient desormais de l'ephemeride, non d'un `1` suppose.
Elle va de 0,983 ua au perihelie de debut janvier a 1,017 a l'aphelie de debut
juillet, soit **6,91 %** d'ecart en eclairement — mesure exactement egal a
`(1,0167/0,9833)²`. Ce n'est pas ce qui fait les saisons, mais c'est reel.

**La colonne d'ozone** dependait d'une constante unique, 300 DU, employee partout
et en toute saison. Elle depend maintenant du lieu et de la date.

### Ce que l'ozone change, et pourquoi cela se voit

L'ozone est ce qui rend le crepuscule **bleu** — bande de Chappuis, phase 7. Sa
colonne en decide donc la profondeur :

| Colonne | Luminance | Bleu/rouge |
| --- | --- | --- |
| 245 DU (tropiques) | 20,2 cd/m² | **1,60** |
| 300 DU (l'ancienne constante) | 17,9 | 1,91 |
| 400 DU (haute latitude, printemps) | 14,7 | **2,57** |

**Soixante et un pour cent d'ecart sur le rapport bleu/rouge.** Un observateur
norvegien en avril et un observateur equatorial ne voient pas le meme crepuscule,
et c'est en grande partie pour cette raison.

### ⚠️ La parametrisation de l'ozone est une interpolation, pas une climatologie

Les coefficients ne viennent d'aucune publication. Ils sont choisis pour que le
modele reproduise les **bornes observees** et la forme qualitative, qui elle est
solide :

| Fait d'observation | Modèle |
| --- | --- |
| Plage hors trou antarctique, 240 à 450 DU | **245 à 413 DU** |
| Colonne équatoriale invariante | **0 DU** de variation |
| Croissance vers les pôles | vérifiée, monotone |
| Maximum printanier | 368 DU en avril contre 265 en octobre, à 60°N |
| Hémisphères en opposition de phase | à 6,5·10⁻⁴ près |

**La reference a adopter est van Heuklon (1979)**, *Estimating atmospheric ozone
for solar radiation models*, Solar Energy 22, 63–68. La brancher ne demanderait
aucun changement de structure — seulement les bons coefficients.

Ne sont pas representes : le **trou d'ozone antarctique**, phenomene anthropique
dont l'amplitude varie d'une decennie a l'autre et qu'une formule ne saurait
porter ; et la dependance en **longitude**, l'ozone suivant les ondes planetaires.

---

## Le socle nocturne — dette du registre

### Ce qui etait peint

Airglow, lueur lunaire et halo urbain etaient trois couleurs choisies, posees
par-dessus le transport. Le degrade nocturne — `mix(nuit × 1,6, nuit, smoothstep)`
— etait plus clair pres de l'horizon parce que c'est ce qu'on observe. **Il avait
la bonne forme pour la mauvaise raison.**

### L'airglow est une emission reelle

Le rayonnement ultraviolet dissocie l'oxygene de la haute atmosphere le jour ;
la nuit, les atomes se recombinent et rendent cette energie en raies. C'est de la
**chimiluminescence**, dans une couche mince a **quatre-vingt-dix kilometres** —
et c'est pourquoi le ciel nocturne n'est jamais noir, meme sans Lune, sans etoile
et sans ville.

### Le degrade sort de deux fonctions dont aucune n'en decrit un

Une couche mince vue obliquement est traversee plus longuement — facteur de **van
Rhijn**, `1/√(1 − [R/(R+h)]²sin²z)`, qui atteint **6,01** a l'horizon. Mais cette
lumiere doit ensuite traverser toute l'atmosphere, et une visee rasante y perd
presque tout.

| Hauteur | van Rhijn | Après extinction |
| --- | --- | --- |
| 90° | 1,00 | 1,00 |
| 30° | 1,92 | 1,68 |
| **15°** | 3,28 | **2,18** ← maximum |
| 5° | 5,34 | 1,63 |
| 1° | 5,98 | **0,175** |

Le maximum a quinze degres et l'effondrement au ras de l'horizon **emergent** du
produit. Van Rhijn, seul, croit encore a un degre — c'est l'extinction qui
retourne la courbe.

La transmittance employee est celle que la table de perspective calculait deja
pour le fond de ciel, et que le nuanceur jetait.

### Ce que cela change a l'ecran

Dix-huit sondes ont derive, et la plus parlante est `nuit/antisoleil-horizon` :
`5,6,15 → 3,1,0`. **Le ciel nocturne s'assombrit desormais vers l'horizon au lieu
de s'y eclaircir.**

C'est correct. La lumiere naturelle du ciel — airglow comme lumiere stellaire —
traverse toute l'atmosphere, et une visee rasante en perd l'essentiel, le bleu
d'abord. Ce qui eclaire reellement un horizon nocturne, c'est la **pollution
lumineuse**, emise depuis le sol : elle reste un terme separe, et elle continue
de s'eclaircir vers le bas.

### ⚠️ L'amplitude ne peut pas encore etre physique

L'airglow reel vaut **3,7·10⁻⁵ cd/m²** au zenith, soit **4·10⁻¹⁰ du blanc
d'affichage** ancre a 86 302 cd/m². A exposition fixe, il est rigoureusement
invisible.

**C'est la raison pour laquelle ce socle etait peint**, et elle ne disparaitra
qu'avec un modele d'adaptation : l'oeil couvre six ordres de grandeur entre le
jour et la nuit, une exposition fixe n'en couvre aucun.

Ce qui change ici est donc la **forme**, desormais calculee ; l'**amplitude**
reste posee.

> **Cette dette ne peut pas etre soldee avant celle de l'exposition.** L'ordre
> que j'avais annonce etait faux, et c'est la mesure qui l'a montre.

### ⚠️ Ce que la validation signale

L'ancre `AIRGLOW_LUX = 2·10⁻⁴` lux donne **23,66 mag/arcsec²** au zenith, quand
le ciel nocturne naturel observe vaut 21,8 a 22,3. Une partie de l'ecart est
legitime — ce module ne represente ni la lumiere zodiacale ni la lumiere
stellaire integree — mais l'ancre parait basse d'un facteur cinq. **Signale, non
corrige** : y toucher decalerait tout le calcul de magnitude limite.

Les **poids des raies** ne viennent d'aucune mesure. Ce qui est verifie est leur
consequence : la teinte est verdatre, `(0,440 · 0,558)`, la raie de l'oxygene a
557,7 nm dominant le signal photopique.

Les **bandes de OH** ont ete retirees. Elles portent l'essentiel de l'energie,
mais une premiere version les incluait et rendait une chromaticite orangee. Deux
raisons de les oter plutot que d'ajuster leur poids : elles sont centrees au-dela
de 700 nm, hors de ce qu'un ecran montre, et a 4·10⁻⁵ cd/m² l'oeil est en vision
**scotopique**, dont la sensibilite s'effondre passe 650 nm. Retirer une
composante est plus honnete que lui inventer un poids correcteur.

### ⚠️ Une mesure ratee, encore

Mon premier controle du ciel nocturne lisait le canevas par `getImageData` et
rendait **du noir partout** — j'en ai conclu a une regression. C'etait faux : sans
`preserveDrawingBuffer`, le tampon WebGL est efface apres composition, et il faut
passer par une capture d'ecran. **Troisieme fois** qu'une mesure mal conditionnee
donne un resultat aberrant, apres le banc GPU de la phase 0 et le rendu logiciel
de la phase 20.

---

## L'adaptation visuelle — dette du registre

### Le probleme, chiffre

Le ciel couvre **huit decades** de luminance entre un midi (3 863 cd/m² en
moyenne) et un ciel sans Lune (3,7·10⁻⁵). Un ecran en couvre deux ou trois.

Une exposition **fixe** doit donc choisir. Le moteur avait choisi le jour, et
c'est pourquoi tout le reste etait peint : le socle nocturne, et un crepuscule
qui rendait `4,6,13` — invisible.

### L'exposant n'est pas choisi, il se deduit

```
L_blanc = L_ref · (L_ciel / L_ref)^p        p = 1 − décades_écran / décades_scène
```

`p = 1` serait une adaptation totale : plus de jour ni de nuit. `p = 0`
redonnerait l'exposition fixe. Entre les deux, la dynamique restituee vaut
`decades_scene × (1 − p)` — et on veut qu'elle soit celle que l'ecran peut
montrer.

**Aucun des deux nombres n'est esthetique** : le premier est une propriete de
l'ecran, le second une mesure du moteur. L'exposant en sort — **0,747**, une
adaptation a 75 %, les 25 % restants portant toute la sensation de jour et de
nuit.

Le seul choix est `DISPLAY_DECADES = 2` : combien de la dynamique de l'ecran
consacrer a l'ecart jour/nuit plutot qu'au contraste **a l'interieur** d'une
image. Il est enonce en termes de ce qu'un ecran peut faire, non en candelas
arbitraires, et la validation en mesure la consequence exacte.

### Le ciel decide de sa propre exposition

La luminance d'adaptation est **mesuree sur la table de ciel elle-meme**, en
moyennant sa tranche lointaine — pas lue dans une table d'ancres exterieure. Elle
ne coute rien : les valeurs sont deja ecrites.

Recoupement : cette moyenne doit egaler celle qu'obtient le solveur en
echantillonnant l'hemisphere. **1,2 % d'ecart**, par deux parcours sans rien de
commun.

### ⚠️ Angle solide, et non eclairement — la distinction n'est pas academique

Une premiere version ponderait la moyenne par `cos z`, ce qui donne
l'**eclairement** sur une surface horizontale. Au crepuscule, le zenith est
sombre et l'horizon brille : l'oeil s'adaptait donc au zenith, et la bande claire
de l'horizon **saturait** — le banc rendait un `254,246,194` blanc au crepuscule
nautique.

L'oeil s'adapte a ce qu'il **voit**, donc a la moyenne en **angle solide**. Le
changement a resorbe la saturation et modifie l'ancre de 3 039 a 3 863 cd/m².

Une seconde erreur avait precede : le jacobien de la parametrisation verticale
`hauteur = (π/2)v²` omettait son `cos(hauteur)`, ce qui surponderait le zenith et
donnait **24,6 %** d'ecart au solveur. Corrige : 1,2 %.

### Ce que cela change

La continuite de midi est **exacte** — a la luminance de reference, l'exposition
adaptative vaut la fixe au bit pres, comme en phase 0.5. Tout l'ecart se voit
ailleurs :

| Sonde | Fixe | Adaptative |
| --- | --- | --- |
| coucher / zénith | 18,24,37 | **62,79,103** |
| coucher / perpendiculaire 30° | 31,38,49 | **99,114,130** |
| crépuscule civil / zénith | 4,6,13 | **14,25,51** |
| crépuscule civil / vers le Soleil 30° | 7,9,17 | **57,88,140** |
| nuit / vers le Soleil, horizon | 3,1,0 | 31,8,0 |

Dix-neuf sondes ont derive, toutes vers le crepuscule et le coucher. **Le
crepuscule existe enfin** : la ou le ciel rendait `4,6,13`, il montre desormais
un degrade complet du bleu profond au rouge de l'horizon.

### ⚠️ Ce que ce module ne fait pas

**L'adaptation est instantanee.** L'oeil met des secondes a des minutes ; ici le
changement suit la scene sans retard. C'est le bon choix pour une application ou
l'on fait defiler le temps, mais ce n'est pas ce que vit un observateur.

**La vision scotopique n'est pas modelisee.** Sous 0,01 cd/m² les batonnets
prennent le relais : la couleur disparait, la sensibilite se decale vers le bleu,
l'acuite s'effondre. Le rendre demanderait la courbe `V'(λ)`, que le moteur
n'embarque pas — c'est pourquoi le ciel nocturne garde ses couleurs photopiques,
ce qu'aucun observateur ne verrait.

**La courbe de tonalite devient le facteur limitant.** Au crepuscule, la bande
claire de l'horizon vaut seize a trente-sept fois la moyenne du ciel, et l'ACES
approche du moteur l'ecrete. Ce n'etait pas visible tant que rien n'etait clair a
ces heures-la. La courbe et son `DISPLAY_SATURATION = 1,4` sont deja au registre
comme parametres choisis ; ils y montent d'un cran.

### ⚠️ Une quatrieme mesure ratee

Pour verifier le cablage, je lisais `aerialTextures` depuis la page par un
`import()` dynamique — et j'obtenais des valeurs nulles. J'en ai conclu que le
cablage etait rompu. C'etait faux : apres un rechargement a chaud, Vite sert le
module sous une autre URL, et `import()` en creait une **seconde instance**. Le
rayon de l'observateur valait 6 371 000 au lieu de 6 371 035, ce qui l'a trahi.

Quatrieme fois de cette session qu'une mesure mal conditionnee donne un resultat
aberrant, apres le banc GPU de la phase 0, le rendu logiciel de la phase 20 et le
`getImageData` de l'airglow. **Le rendu n'a ete en cause aucune de ces fois.**

---

## La passe globale — ce que l'adaptation a debloque

### Le socle nocturne devient entierement physique

L'amplitude de l'airglow etait bloquee par l'exposition fixe : `4·10⁻¹⁰` du blanc
d'affichage. Depuis que l'exposition suit le ciel, **le plancher d'adaptation est
precisement la luminance de l'airglow** — et celui-ci retrouve sa place.

La couleur peinte a disparu. Le socle nocturne est desormais une emission
calculee, de bout en bout : spectre de raies, geometrie de couche, extinction,
exposition.

| Sonde de nuit | Peinte | Calculée |
| --- | --- | --- |
| zénith | 3,4,10 | **3,3,3** |
| vers le Soleil, 30° | 5,7,14 | **5,5,5** |
| perpendiculaire, 30° | 5,7,14 | **5,5,5** |

### La vision scotopique, et pourquoi elle etait indispensable

L'airglow est physiquement **verdatre** — sa raie de l'oxygene a 557,7 nm domine
le signal photopique. Le brancher tel quel donnait un ciel nocturne vert, ce que
personne ne voit.

La raison n'est pas que le calcul soit faux, c'est que **l'oeil ne voit pas les
couleurs a ces luminances**. Les batonnets ne portent qu'un pigment : aucune
comparaison entre types de recepteurs n'est possible, donc aucune teinte. Ce
n'est pas une approximation, c'est de l'anatomie.

Le ciel nocturne sort donc **gris**, et c'est ce qu'on observe.

### ⚠️ Deux erreurs sur la bascule, et ce qu'elles apprennent

**Elle est locale, non globale.** Une premiere version employait la luminance
**moyenne** du ciel et grisait tout — y compris la bande orange de l'horizon au
crepuscule nautique, qui rendait un `220,220,220` absurde alors qu'elle est la
chose la plus lumineuse du ciel.

L'adaptation est globale ; la **dominance des cones** ne l'est pas. Elle depend
de l'eclairement retinien local, et c'est pourquoi on voit la couleur d'un feu la
nuit pendant que le reste du paysage reste gris.

**Elle est logarithmique, non lineaire.** Interpolee lineairement entre 0,01 et
3 cd/m², un ciel a 1,8 cd/m² — presque photopique — ressortait a **34 %** de
vision batonnets. L'oeil travaille en decades : en logarithme, c'est **2,3 %**.

| Bande orange, crépuscule nautique | |
| --- | --- |
| avant la passe | 242,216,82 |
| bascule globale | 220,220,220 ← grise, absurde |
| bascule locale, linéaire | 223,220,217 ← encore grise |
| **bascule locale, logarithmique** | **238,217,152** |

### ⚠️ Ce qui n'est toujours pas modelise

**Le decalage de Purkinje.** La sensibilite scotopique culmine a 507 nm contre
555 en photopique : un observateur percoit la nuit legerement **bleutee**. Le
rendre demanderait la courbe `V'(λ)`, que le moteur n'embarque pas. Le ciel
nocturne sort donc gris neutre plutot que gris-bleu.

**La lueur lunaire et le halo urbain** restent peints. La premiere est de la
diffusion — exactement le calcul du ciel de jour, avec la Lune pour source,
quatre cent mille fois plus faible — et devient faisable maintenant que
l'exposition suit. Le second demande le modele de Garstang (1989).

---

## La marge sous l'horizon — trois bornes au meme endroit

### Le symptome

Un astre qui passait l'horizon **redevenait normal, puis s'eteignait**. Les deux
mots comptent : il perdait d'abord ce que l'atmosphere lui avait fait, puis
disparaissait d'un coup.

Ce n'etait pas un defaut mais **trois**, situes dans trois modules sans rapport,
et qui n'avaient en commun que d'avoir borne leur domaine **exactement** a la
hauteur zero.

| Module | Ce qu'il faisait a la frontiere | Ce qu'on voyait |
| --- | --- | --- |
| `columnsToSpace` | colonne **infinie** des que le rayon droit plonge | le disque s'éteint d'un coup |
| `apparentFromTable` | prolongement a **pente un** | le disque redevient rond |
| nuanceur du ciel | `dir.y < 0` donne zero | le ciel se coupe net |

### Ce que la frontiere a de faux

L'horizon **visible** n'est pas a la hauteur zero, et il n'y est pour aucun
observateur reel :

| terme | valeur |
| --- | --- |
| réfraction à l'horizon | 0,57° — un astre de hauteur vraie −0,57° est encore vu |
| demi-diamètre solaire | 0,27° — le limbe supérieur survit au centre |
| abaissement d'horizon à 3 000 m | 1,76° |

Leur somme vaut 2,6°. Couper a zero, c'est couper **a l'interieur** de ce qu'un
observateur voit encore. La marge vaut donc **trois degres**, et
`atmosphere/horizonMargin.ts` porte ce calcul.

⚠️ **Ce n'est pas une grandeur physique**, et le module le dit : c'est une borne
de domaine numerique. La rendre plus grande ne changerait rien a l'image, la
rendre plus petite ferait reapparaitre les sauts.

### La correction, module par module

**La colonne est bornee au rayon tangent.** `columnsToSpace` a raison de rendre
l'infini pour un rayon droit qui plonge dans le sol — c'est ce que dit sa
geometrie. Mais un Soleil de hauteur vraie −0,3° est **encore entierement
visible**, et sa lumiere traverse une colonne finie : le modele rectiligne se
trompe precisement la ou la courbure compte. `sunDiscTint` borne donc son
argument au rayon tangent, la plus longue colonne qu'un rayon puisse parcourir —
meme borne que `AIRMASS_MAX` dans la photometrie, et pour la meme raison.

**Le prolongement de la refraction devient C¹.** L'ancien conservait la valeur
mais pas la pente : `dA/da` sautait de 0,86 a 1 en franchissant l'horizon. Or
cette pente **est** la compression verticale du disque. Le nouveau conserve les
deux, et laisse la pente rejoindre 1 — le regime sans atmosphere — sur l'echelle
de la marge :

```
dA/da = s_h·exp(−d/λ) + (1 − exp(−d/λ))     d = a_h − a,  λ = marge/3
```

C¹ par construction, et strictement croissant puisque sa pente reste entre `s_h`
et 1, tous deux positifs — ce dont dependent la dichotomie et l'interpolation de
la texture. Les 96 echantillons du prolongement sont **tabules**, si bien que les
deux sens de lecture et la texture GPU en profitent sans code supplementaire.

| Marche a la traversee de l'horizon | |
| --- | --- |
| compression verticale, avant | **0,168** |
| compression verticale, après | **0,0037** |
| teinte du disque, avant | **100 %** — elle tombait a zero |
| teinte du disque, après | **0,10 %** |

Effet de bord mesure : la texture de refraction est passee de **1,97″ a 0,81″**
d'erreur. Le coude qu'elle devait interpoler n'existe plus.

### Le sol occulte pour de bon

⚠️ **L'en-tete de `Ground.tsx` affirmait une chose fausse** : que le tampon de
profondeur suffisait a masquer tout ce qui est couche, « planetes, satellites,
etoiles et grilles comprises ». C'etait vrai pour la seconde moitie de la liste
et faux pour la premiere.

`sceneDepth` compresse les distances en logarithme. Les etoiles sont a 200, mais
Neptune a 72, le Soleil a 61, la Lune a 42, un satellite a 20, un avion a 8.
**Tout le systeme solaire est a l'interieur de la calotte**, plus pres que ses
150 : une planete couchee passait le test de profondeur et se dessinait
par-dessus le sol.

Le sol ne teste donc plus la profondeur du tout. Il est dessine en dernier et
recouvre sans condition tout ce qui tombe dans sa geometrie — l'hemisphere sous
l'horizon — quelle que soit la distance de l'objet.

Il declare `transparent: true` tout en restant parfaitement opaque, son alpha
valant un. C'est le seul moyen de le faire passer dans la file des transparents,
ou `renderOrder` est respecte : three.js dessine **tous** les opaques avant
**tous** les transparents, et un sol opaque serait passe avant les corps quel que
soit son rang. Meme contrainte, meme parade que pour le fond de ciel.

### Ce que la validation ne voyait pas

Les trois defauts vivaient sous **675 controles** sans en declencher un seul.
Tous portaient sur la **valeur** des fonctions ; aucun sur leur **derivee**, ni
sur la continuite d'une teinte a la traversee d'une frontiere.

Cinq controles ont ete ajoutes, dont les deux qui auraient suffi :

- `la compression verticale ne saute pas a la traversee de l'horizon` — mesuree
  symetriquement a ±0,02°, comparee a ce que donnait le prolongement precedent ;
- `la teinte du disque traverse l'horizon sans marche` — les deux limites, prises
  a ±0,001° pour que la variation propre de la teinte ne masque pas la marche.

### ⚠️ Ce qui reste

**Les etiquettes ne sont pas occultees.** Le nom d'un astre couche reste affiche
au-dessus du sol : `LabelLayer` est du DOM, hors de la scene 3D, et le sol ne
peut rien contre lui. C'etait deja le cas avant cette passe.

**Le sol lui-meme reste peint.** Deux couleurs d'interface, un `smoothstep` et
une parabole sur le log de l'eclairement. Ni albedo, ni BRDF, ni transport. Le
commentaire du fichier promettait sa disparition « en phase 9, avec la
perspective aerienne » ; la phase 9 a livre la perspective aerienne mais ne l'a
jamais branchee sur le sol. C'est aujourd'hui **la derniere grande surface peinte
du moteur**, et elle rejoint le registre ci-dessous.

---

## Le banc de relief — la distance devient visible

### Ce qui manquait

La table de perspective atmospherique est parametree en **distance**, sur seize
tranches. Une seule servait : le fond de ciel lit la tranche a l'infini, et les
avions lisent une distance uniforme par appareil. **Rien ne faisait varier la
distance a l'interieur d'une meme image**, et quinze seiziemes de la table
n'etaient jamais regardes.

### Le banc

Une chaine **rectiligne** qui passe a quinze kilometres a l'est, longue de six
cents. Tout y est constant sauf la distance, qui va de 15 a 300 km continument :
meme altitude de crete, meme albedo, meme profil d'un bout a l'autre. **Chaque
ecart d'aspect le long de la chaine est donc un effet de distance**, et rien
d'autre.

On y lit ensemble les trois choses que le moteur calcule : l'extinction qui mange
le contraste, la diffusion en avant qui bleuit les cretes, et la courbure de la
Terre qui avale la chaine. Les nombres sortent de la geometrie, pas d'un reglage :

| Distance | Hauteur apparente d'un sommet a 4 000 m | Mesure |
| --- | --- | --- |
| 15 km | +14,75° | conforme |
| 50 km | +4,34° | conforme |
| 100 km | +1,89° | conforme |
| 244 km | **−0,01°** | le sommet atteint l'horizon |

### L'eclairement est calcule

    L = (albedo/π)·(E_direct·cos θ + E_ciel·V_ciel)·T(d) + L_diffusee(d)

`E_direct` vient de `directSolar`, le spectre solaire transmis le long du trajet
oblique reel. `E_ciel` demandait une grandeur que le moteur ne calculait pas : ce
que le ciel **entier depose sur un plan**, par opposition a ce qu'il **rayonne
dans une direction**. D'ou `measureSkyIrradiance`, mesure sur la table qui
s'affiche.

Les deux passent par le meme `spectralToLinearSrgb` que la table elle-meme :
leurs unites sont donc coherentes **par construction**, sans facteur de raccord.
Le recoupement le confirme — `directSolar` rend 111 566 lx d'eclairement solaire
normal, et sa propre grandeur photometrique `normalIlluminanceLux` en donne
111 566.

⚠️ **La ponderation n'est pas celle de la luminance moyenne, et la distinction
n'est pas academique.** `measureMeanSkyLuminance` moyenne en angle solide — ce a
quoi l'oeil s'adapte, et ou le cosinus serait une erreur, deja commise puis
corrigee. Ici c'est l'inverse : un plan recoit d'autant moins qu'une direction
est rasante, et le cosinus **est** le modele. L'invariant qui le garantit : un
ciel de radiance uniforme doit rendre exactement `π·L`. Mesure : **0,06 %**.

### Ce que le banc a mesure du moteur

C'est son objet. A 15 km, sur une visee rasante, la table rend une transmittance
verte de **0,573** — soit un coefficient d'extinction de 0,037 km⁻¹ et, par
Koschmieder, une **portee visuelle de 105 km**. C'est une atmosphere tres pure,
la limite haute d'une belle journee, et non un voile excessif.

Le massif ressort neanmoins clair, et c'est correct : une roche ensoleillee
d'albedo 0,21 rend 6 000 cd/m² quand le ciel moyen en fait 3 800. Une montagne
au soleil **est** plus lumineuse que le ciel bleu.

### ⚠️ Trois erreurs, dont deux de methode

**L'approximation petit-angle, prise pour un angle.** `apparentElevationRad`
rendait `(z−h)/d`, une tangente. Sans consequence au loin — quatre secondes
d'arc a cent kilometres — mais absurde au pied de l'observateur, ou le rapport
depasse l'unite : a vingt metres d'un oeil pose a trente-cinq, il vaut −1,75,
soit cent degres sous l'horizon. Le cosinus changeait de signe, les anneaux
proches se projetaient **a l'azimut oppose**, et le maillage retourne barrait
l'ecran.

**Une somme d'octaves ne visite pas [0, 1].** Ses extremes exigent que toutes les
octaves culminent ensemble, ce qui n'arrive pas : sa plage utile est d'environ
[0,30 ; 0,75]. Une crete nominale de 4 000 m culminait donc a **2 735**. Il a
fallu etirer le bruit pour que la chaine atteigne la hauteur demandee — 3 868 m
mesures apres correction.

**Une mesure ratee, attrapee tout de suite.** Le chronometre de la construction
englobait le `setTimeout` d'attente et rendait 2 504 ms. Le cout reel, mesure sur
les 532 480 evaluations du champ de relief qui le dominent, est de **34 ms**, une
seule fois a l'activation. Le rendu, lui, ne coute rien de mesurable : 6,10 ms
par image avec comme sans, l'application etant verrouillee sur la synchro
verticale.

### ⚠️ Deux defauts signales a l'usage, et ce qu'ils apprennent

**Le sol s'arretait net sous l'horizon.** Le maillage descendait bien jusqu'a
vingt metres, mais **l'observateur est a l'interieur** du terrain, pas devant
lui : il l'entoure et passe sous ses pieds. En profondeur logarithmique, les
anneaux proches forment un cone tres resserre dont on ne voit que la face
**interne** — et l'elimination des faces arriere les supprimait toutes. Le
terrain cessait vers trois cents metres, laissant une coupure rectiligne et un
vide sous l'horizon. `side: DoubleSide` le resout ; c'est le reglage correct pour
une surface qui enveloppe le point de vue.

**Un pas de differences finies fixe ne peut pas eclairer un maillage a echelle
variable.** Les normales etaient prises sur vingt-cinq metres, alors que la maille
s'etire d'un facteur quinze mille — un metre pres de l'observateur, quinze
kilometres a trois cents. Au loin, elles decrivaient donc un **micro-relief que la
maille ne represente pas** : l'ombrage n'avait plus de rapport avec la silhouette
visible, ni avec la position du Soleil.

Les normales viennent desormais du **maillage lui-meme** — produit vectoriel des
deux tangentes, pris en coordonnees physiques et non dans la scene, dont la
profondeur logarithmique fausserait toutes les pentes. Verification : au lever,
Soleil a l'est derriere la chaine, elle est franchement a contre-jour, sans aucun
versant eclaire ; a midi elle montre ses versants et ses ombres.

**Et deux mesures ratees de plus**, du meme genre que les precedentes : deux
captures prises **pendant la reconstruction de la table**, qui rendaient un ciel
noir en plein midi. J'en ai conclu une regression avant de verifier que
`meanSkyLuminanceCdPerM2` valait encore zero. La table se construit en huit
lignes par image ; toute capture doit attendre sa publication.

---

### ⚠️ L'atmosphere coupee net a zero degre

Signale a l'usage, et visible surtout en zoomant : le ciel s'arretait **exactement
a la hauteur zero**, alors que l'horizon d'un observateur en hauteur est plus bas.

La cause etait le sol. La calotte plate avait son bord a `y = 0` et, depuis
qu'elle est totalement occultante, elle masquait la bande de ciel comprise entre
l'horizontale et l'horizon reel. Mesure : **54 pixels** de sol la ou il fallait du
ciel, de 0,000° a −0,189°.

Le bord suit desormais `horizonDipDeg`, l'integrale du moteur sur la branche
descendante du rayon — 0,1731° a trente-cinq metres, 0,9283° a mille. Le fondu de
marge du nuanceur part lui aussi de l'horizon apparent et non de l'horizontale,
sans quoi il attenuait une bande de ciel parfaitement visible.

| Colonne de pixels a 3° de champ | Avant | Apres |
| --- | --- | --- |
| le ciel descend jusqu'a | +0,003° | **−0,173°** |
| sol plat parasite | 54 px | **4 px** |

Les quatre pixels restants sont la resolution de la maille, non un decalage de
modele.

### ⚠️ Deux horizons dans la meme image

En corrigeant, un desaccord est apparu : le terrain placait son horizon avec le
`k = 1/7` de la geodesie, le sol avec l'integrale de Ciddor. **3,1 % d'ecart** sur
le rayon effectif — 1,167 R contre 1,204 R — soit trois millimes de degre, un
pixel a fort zoom.

C'est exactement ce que l'unicite de la table de refraction interdit ailleurs
dans ce projet. Le rayon effectif se **deduit donc de la depression mesuree**, par
inversion de `dip = √(2h/R_eff)` : le terrain et le sol partagent leur horizon par
construction, et non par coincidence.

### ⚠️ Une image par seconde qui n'existait pas

J'ai cru mesurer un effondrement du rendu apres le passage en `DoubleSide` :
**6,1 ms en 640 × 400 contre une seconde en 1920 × 1080**. J'en ai conclu un cout
de **remplissage** et reduit trois choses — premier anneau de 20 a 60 m, maillage
de 512 × 208 a 384 × 160, `forceSinglePass`.

**Le diagnostic etait faux.** Un onglet qui n'a pas le focus voit son
`requestAnimationFrame` cadence a **1 Hz** par le navigateur. La comparaison
opposait une fenetre au premier plan a une fenetre en arriere-plan, et le
`1000,5 ms` mesure n'etait rien d'autre que cette seconde exacte.

Ce qui l'a revele : la meme mesure rendait 1000,5 ms **sans le terrain et sans
l'atmosphere**, sur une scene quasi vide. Aucun rendu ne coute cela. Le focus
rendu, tout revient a **6,1 ms** — terrain, atmosphere et table doublee compris.

Les trois reductions ont donc ete **annulees**, sauf `forceSinglePass`, qui reste
juste pour une autre raison : le terrain est opaque par son alpha, et la seconde
passe que three.js reserve aux surfaces translucides ne changerait rien a l'image.

C'est la **cinquieme** mesure mal conditionnee du projet, apres le banc GPU lance
dans l'onglet de l'application, le rendu logiciel de la phase 20, le
`getImageData` sur un canvas WebGL et l'instance de module dedoublee par le
rechargement a chaud. **Le rendu n'a ete en cause aucune de ces fois.** La lecon
se repete : une mesure de performance doit d'abord prouver que son instrument
mesure ce qu'elle croit.

---

### ⚠️ Ce que ce calque ne modelise pas

**Les ombres portees.** Seul l'auto-ombrage du premier ordre existe, par le
`max(0, N·L)`. Une vallee ne recoit pas l'ombre de la crete qui la domine, faute
de carte d'ombre : au couchant, la chaine est plus uniformement eclairee qu'elle
ne le serait.

**Le facteur de vue du ciel** est l'approximation plane `(1 + N_y)/2`, sans
occlusion par le relief voisin.

**Le relief n'est pas un modele geologique** — bruit de valeur fractal a graine
fixe. C'est une surface de test ; ce qui est physique, c'est ce que l'atmosphere
en fait.

---

## Sous l'horizon — la table cessait d'exister

### Le defaut

Le nuanceur **ecretait** toute visee descendante a la ligne rasante :

```glsl
float v = sqrt(clamp(degrees(asin(clamp(d.y, 0.0, 1.0))), 0.0, 90.0) / 90.0);
```

La table n'etait construite que de 0° a 90°. Sans consequence tant que rien ne
vivait sous l'horizon — le ciel n'y est pas. Faux des qu'une **surface** s'y
trouve, et le banc de relief en a mis une.

La raison est geometrique : le rayon rasant de la table ne rencontre **jamais** le
sol et monte indefiniment, quand le vrai rayon descendant s'y arrete. L'ecart sur
la colonne moleculaire, observateur a trente-cinq metres :

| visee | distance | colonne en trop |
| --- | --- | --- |
| −0,2° | 20 km | **23,5 %** |
| −0,5° | 5 km | **16,5 %** |
| −1,2° | 2 km | **15,8 %** |
| −4° | 500 m | 0,17 % |
| −30° | 60 m | 0,14 % |

La repartition surprend et s'explique : sous forte depression le trajet est court
et l'air homogene, l'erreur est nulle. C'est **pres de l'horizon** qu'elle eclate,
la ou vit un premier plan.

### La correction

La table couvre desormais **les deux hemispheres**, et la parametrisation change
de nature d'un cote a l'autre :

| | au-dessus de l'horizon | en dessous |
| --- | --- | --- |
| fin du trajet | sortie par l'espace | **intersection avec le sol** |
| `totalPath` | `−r₀·µ + √(r₀²µ² + r_top² − r₀²)` | `−r₀·µ − √(r₀²µ² − r₀² + R²)` |
| ce que decrit la tranche lointaine | le ciel | la surface au sol |

Le solveur recoit une option `stopAtGround` : pour le ciel il **renonce** quand le
rayon rencontre le sol — c'est ce que verifie le controle « aucune radiance sous
l'horizon » — et pour une surface il **marche jusque-la**. Les deux comportements
coexistent parce qu'ils repondent a deux questions distinctes.

**Soixante-cinq lignes et non soixante-quatre.** Il en faut un nombre impair pour
que l'horizon tombe exactement sur un texel : c'est la ligne la plus tendue de la
table, celle ou la colonne passe de quelques kilometres a plusieurs centaines, et
l'interpoler entre deux voisins serait la seule erreur qu'on ne peut pas se
permettre. Trente-deux lignes de chaque cote : **la resolution au-dessus de
l'horizon est exactement celle d'avant**, la moitie basse est un ajout et non un
partage.

### Ce qu'il a fallu reprendre

**Les deux mesures d'adaptation.** `measureMeanSkyLuminance` et
`measureSkyIrradiance` parcouraient toute la table. La moitie basse decrivant
desormais des surfaces au sol, les y inclure aurait fait s'adapter l'oeil a un
paysage plutot qu'a la voute — et l'exposition entiere avec lui. Les deux partent
maintenant de la ligne d'horizon.

**L'echantillonneur processeur.** `sampleAerialLut` gardait l'ancienne formule et
designait donc, pour une hauteur donnee, une ligne differente de celle que lit le
nuanceur. Trois controles l'ont attrape immediatement.

**Le controle « la tranche lointaine est le ciel »**, qui balayait toute la table :
il n'est vrai qu'au-dessus de l'horizon.

Sept controles ajoutes, dont celui qui porte le changement : a mi-course, la
transmittance verte vaut **1,000 a −20° contre 0,004 au ras**. L'ecretage donnait
la seconde aux deux.

**Etat : 695 controles, aucun echec ; 6,1 ms par image, table doublee comprise.**

---

## L'horizon n'est plus a zero degre — passe de fond

### La regle

Rien ne doit etre borne a l'**horizontale**. Tout ce qui a une limite basse la
prend a l'**horizon du site**, et avec une **marge** au-dela — jamais cale sur la
limite exacte.

C'est une regle de conception, pas une correction ponctuelle : un observateur
peut choisir une altitude de plusieurs kilometres, et son horizon descend
d'autant.

| altitude | depression | horizon vrai | plancher des tables |
| --- | --- | --- | --- |
| 0 m | 0,000° | −0,549° | −3,549° |
| 35 m | 0,173° | −0,758° | −3,758° |
| 1 000 m | 0,928° | −1,662° | −4,662° |
| 3 000 m | 1,619° | −2,472° | −5,472° |
| 10 000 m | 3,014° | −4,032° | −7,032° |

Tout descend ensemble, et la marge de trois degres reste sous le plus bas.

### Ce qui bornait encore, et ce que cela coutait

**La table de refraction commencait a zero degre apparent.** Elle supposait donc
l'observateur au niveau de la mer, et ignorait toute la bande entre l'horizontale
et l'horizon reel — trois degres de ciel parfaitement visible depuis dix
kilometres. `refractionForApparent` savait pourtant deja suivre la **branche
descendante** du rayon, qui plonge, atteint un point tangent et remonte : il ne
manquait que de la lui demander.

**Le plancher de la texture valait quatre degres pour tout le monde.** Il suit
desormais `floorTrueDeg`, donc le site, et voyage en uniforme jusqu'au nuanceur.

**La masse d'air etait bornee a zero** — dans `photometry.ts` et, une seconde
fois, dans le nuanceur du champ d'etoiles, qui portait sa propre copie de la
formule de Pickering. Deux modeles d'atmosphere dans la meme image, tous deux
supposant l'oeil au niveau de la mer :

| vue depuis 10 km | formule bornee | colonne reelle |
| --- | --- | --- |
| 0° | 38,75 | 39,4 |
| −1° | **38,75** | **63,5** |
| −2° | **38,75** | **112,6** |
| −3° | **38,75** | **218,8** |

Elle est desormais la **colonne que le moteur integre**, tabulee par site et
mise en cache. Au niveau de la mer les deux modeles s'accordent a 0,3 % jusqu'a
dix degres. Et elle voyage dans le **canal vert** de la texture de refraction —
qui etait libre, partage exactement le meme domaine, et se lit sans surcout : le
nuanceur et le processeur lisent enfin la meme grandeur.

### ⚠️ Le plafond qui annulait tout le reste

`extinctionMagnitudes` plafonnait a **douze masses d'air**, atteintes des quatre
degres de hauteur. Au-dela, l'extinction restait figee a 3,36 magnitudes : un
astre a quatre degres, un astre au ras et un astre sous l'horizontale rendaient
**identiquement**. C'etait le plus restrictif de tous les bornages du moteur, et
il rendait les autres sans effet.

Sans lui, l'extinction suit la colonne jusqu'au bout :

| hauteur | masse d'air | avant | apres |
| --- | --- | --- | --- |
| 10° | 5,6 | 1,56 | 1,56 |
| 4° | 12,1 | 3,36 | 3,40 |
| 2° | 18,8 | **3,36** | **5,27** |
| 0° | 35,2 | **3,36** | **9,86** |

**Rien ne change au-dessus de quatre degres.** En dessous, l'extinction atteint
**9,86 magnitudes a l'horizon**, ce qui est la valeur classique de la
litterature — environ dix. Vega y devient une magnitude 9,9 : les etoiles
s'eteignent donc avant d'atteindre l'horizon, exactement ce qu'on observe, et la
capture de nuit le confirme.

`AIRMASS_MAX` passe de 40 a 300 pour la meme raison : quarante etait la valeur
rasante d'un observateur au niveau de la mer, un plafond deguise en fait
physique. Il ne sert plus qu'a empecher la divergence quand le rayon rase le sol.

---

## L'ombre du relief entre dans le transport

### Le principe : ce n'est pas un facteur, c'est le domaine d'integration

La table de perspective atmospherique est calculee pour une atmosphere **a
symetrie spherique**, donc sans relief : chaque point d'air y est eclaire par un
Soleil que rien ne masque. Soleil levant derriere une chaine, la brume situee
**devant** elle brillait donc comme si la montagne n'existait pas — et comme on
regarde presque droit vers le Soleil, le pic de diffusion avant de Mie y saturait
a blanc.

On aurait pu multiplier le voile par un facteur d'ombre. Ce serait faux, et ce
serait de la peinture. La diffusion est une **integrale le long du rayon**, et
l'ombre n'en attenue pas le resultat : elle en **retire des morceaux**.

Or la table donne deja tout ce qu'il faut. Comme l'integrale est lineaire, la
contribution d'un segment vue de l'oeil se lit par simple difference :

    L(a→b) vue de l'observateur  =  L(0→b) − L(0→a)

Il suffit donc de **sommer les segments eclaires** et de sauter les autres. Aucune
ombre n'est dessinee : elle est ce que le relief retire a la somme.

### La carte d'ombre : une altitude, pas une apparence

Pour un instant donne, la direction du Soleil est fixe, et l'ensemble des points
ombres est delimite par une surface. Cette surface se calcule :

    ombre(P) = max sur t>0 de [ h(P + t·L) − t·tan(a) − chute(t) ]

`L` est la direction horizontale vers le Soleil, `a` sa hauteur, `chute`
l'abaissement du a la courbure — avec le **meme rayon effectif** que celui qui
place les sommets, sans quoi l'ombre glisserait sur le relief.

Ce qui est stocke est une **altitude en metres**, pas une couleur. Deplacer le
Soleil d'un degre la change entierement.

**Le balayage est lineaire.** Calculer ce maximum par une marche par texel
couterait `O(N·K)`. Une recurrence l'evite : le voisin situe vers le Soleil
connait deja son propre maximum, et il suffit de l'abaisser d'un pas.

    ombre(P) = max( h(P), ombre(P + δ·L) − δ·tan(a) − chute(δ) )

En parcourant la grille dans l'ordre decroissant de `P·L`, le voisin est toujours
resolu. Le relief, lui, ne depend ni de l'heure ni du Soleil : il est
echantillonne **une fois**, et seul le balayage — qui ne fait que des additions —
est refait.

**Le pas de requantification est lui aussi une consequence.** L'ombre d'un sommet
de quatre mille metres s'allonge en `4000/tan(a)` : cinq kilometres pour un
vingtieme de degre quand le Soleil est a deux degres. C'est la ou les ombres sont
les plus longues qu'il faut suivre le plus finement, et le pas est donc pris
**proportionnel a la tangente** plutot que constant.

### Ce que la mesure donne

Soleil levant a 2° derriere la chaine, visee dans sa direction :

| hauteur dans l'image | avant | apres | rapport |
| --- | --- | --- | --- |
| +8° | 229,193,0 | 29,27,18 | **×7,0** |
| +4° | 233,194,0 | 24,25,15 | **×7,8** |
| +1° | 233,188,0 | 8,19,3 | **×11,9** |

La chaine cesse d'etre une masse orange saturee et redevient une **silhouette a
contre-jour**, le ciel s'eclaircissant derriere elle. Cout : **6,1 ms** par image,
inchange — huit lectures de table supplementaires et autant de la carte d'ombre.

### ⚠️ Ce que cette correction sur-corrige

**Un segment ombre perd toute sa diffusion**, alors que seule la part **solaire
directe** devrait disparaitre. Un point prive de Soleil recoit encore la lumiere
du ciel — c'est ce qui rend les ombres bleues dans le monde reel, et non noires.

La table melange diffusion simple et multiple sans permettre de les separer :
les distinguer demanderait une **seconde table**, construite sans source solaire.
Les ombres sortent donc trop sombres, et le facteur 7 a 12 mesure ci-dessus est
une borne haute plutot qu'une valeur juste.

**La penombre est ignoree.** Le Soleil a un demi-degre de diametre ; le bord de
son ombre est flou sur cinq metres a un kilometre, cinquante a dix. La carte rend
une frontiere nette.

**Seul le relief du banc ombre.** Le sol plat n'a pas de hauteur, donc pas
d'ombre.

---

## Le Soleil se cache, le ciel non

### Ce que le test d'ombre coupait de trop

Le solveur teste, en chaque point de la marche, si le Soleil lui est visible :
la colonne vers le Soleil vaut l'infini dès que le rayon rencontre la Terre. Ce
test coupait alors **les deux sources d'un coup** — le rayon direct, ce qui est
juste, et la diffusion multiple, ce qui ne l'est pas.

Un point privé de Soleil continue de baigner dans la lumière du **reste du
ciel**. C'est elle qui éclaire l'air au ras du sol pendant tout le crépuscule, et
c'est elle qui rend les ombres bleues plutôt que noires.

La mesure était sans appel : à deux degrés sous l'horizon, le voile à quinze
kilomètres valait **exactement zéro**. Une crête lointaine se découpait en noir
absolu sur un ciel encore clair.

### Une seconde extinction qui n'avait pas lieu d'être

Le même passage éteignait la source ambiante par le trajet **Soleil → point**.
Or `Ψ_ms` est déjà la radiance **au point** : la traversée du Soleil jusqu'à lui
est comptée dans sa propre construction, par le terme `S(x')` de `L_f`. Elle
était donc appliquée deux fois, d'un facteur qui atteint la dizaine près de
l'horizon.

Chaque source porte désormais l'extinction qui est la sienne :

    solaire  :  exp(−τ_soleil→point) · exp(−τ_point→œil)
    ambiante :                            exp(−τ_point→œil)

### Ce que la mesure donne

Voile à quinze kilomètres, visée anti-solaire, en cd/m² :

| hauteur du Soleil | avant | après | part du ciel derrière |
| --- | --- | --- | --- |
| +3° | 178 | 587 | 62 % |
| −2° | **0** | **30,9** | 64 % |
| −6° | **0** | **0,53** | 65 % |

Rapport diffusion multiple / simple, qui dit où le premier ordre cesse d'être une
référence :

| Soleil \ visée | 1° | 5° | 20° | 45° | 88° |
| --- | --- | --- | --- | --- | --- |
| +60° | ×2,30 | ×2,00 | ×1,72 | ×1,43 | ×1,21 |
| +10° | ×2,19 | ×1,78 | ×1,62 | ×1,58 | ×1,56 |
| **−2°** | **×17,9** | ×2,03 | ×1,49 | ×1,44 | ×1,43 |

L'envolée est **confinée au coin rasant et crépusculaire**, parce que son
dénominateur y tend vers zéro. Un facteur `1/4π` perdu, lui, inflaterait la
table entière d'un facteur douze : c'est ce que le contrôle distingue désormais,
au lieu de borner un seul nombre.

### Le halo blanc du crépuscule s'en va aussi

Le symptôme qui a lancé l'enquête était un **halo blanc** au-dessus du Soleil
couché. Il n'était ni le terrain ni le disque — sous −0,5° l'extinction sature
à 138 mag et le halo du disque tombe à 8·10⁻²³ — mais l'arche crépusculaire,
localisée sur l'azimut solaire (×270 entre l'azimut du Soleil et l'anti-solaire).

Elle blanchissait pour une raison d'exposition : le ciel **autour** était
artificiellement sombre, l'œil s'adaptait donc trop bas, et l'arche saturait. La
source ambiante rendue à sa juste valeur, la luminance moyenne du ciel remonte
et l'exposition redescend :

| Soleil −4° | avant | après |
| --- | --- | --- |
| luminance moyenne du ciel | 9,01 cd/m² | **21,9 cd/m²** |
| exposition | 5,42 | **2,79** |
| ciel à 9° sur l'azimut solaire | 154,142,129 *(gris)* | **113,118,136** *(bleu)* |

Le passage orange → pâle → bleu ne traverse plus le neutre. Aucune retouche
d'apparence : la couleur suit la correction du transport.

### L'ombre du relief y trouve sa réponse

Le solveur publie désormais, à côté du voile total, **la même intégrale privée
de sa source solaire**. Le nuanceur de terrain n'a plus à sauter les segments
ombrés : chacun prend l'une ou l'autre table.

    segment éclairé  :  L_total(0→b) − L_total(0→a)
    segment ombré    :  L_ambiant(0→b) − L_ambiant(0→a)

C'est ce qui rend enfin **exact** le raccourci de la carte d'ombre sous
l'horizon : déclarer tout le domaine privé de Soleil est vrai — c'est la Terre
qui fait l'ombre — et la conséquence est maintenant la bonne, plus de Soleil
mais toujours le ciel.

| point mesuré | avant | après |
| --- | --- | --- |
| crête, Soleil à −2° | 23,16,13 | **33,40,66** |
| versant, Soleil à −2° | 14,13,7 | **26,37,57** |
| crête à contre-jour, Soleil à +3° | 28,28,20 | **41,67,98** |
| versant à contre-jour | 17,23,11 | **33,63,87** |

Le rapport B/R passe de 0,5 à 2,2 : l'ombre cesse d'être un trou noir et devient
bleue, ce qu'elle est dans le monde réel.

**Coût.** Une troisième texture flottante de 1,06 Mo, et **0,03 ms** sur les
3,49 ms d'une ligne de table — sous un pour cent. Le temps par image reste à
**6,10 ms**, inchangé : les huit lectures supplémentaires par pixel de terrain
ne déplacent pas la médiane.

### ⚠️ Ce qui reste

**La pénombre est toujours ignorée.** Le Soleil a un demi-degré de diamètre ; la
carte d'ombre rend une frontière nette.

**L'ambiante hérite de l'hypothèse isotrope.** Un point ombré par une crête ne
voit pas tout le ciel — la montagne lui en masque une partie — et le modèle lui
en donne la totalité. L'ombre reste donc légèrement trop claire, là où elle était
avant trop sombre. Il faudrait un facteur de vue du ciel le long du rayon.

---

## Le relief devient le monde reel

### Ni Cesium, ni quantized-mesh

Le format de terrain le plus repandu, *quantized-mesh*, est un **maillage
triangulaire irregulier**. Or les deux seuls consommateurs du relief demandent
tous deux `h(est, nord)` en un point **arbitraire** : le maillage radial, et le
balayage d'ombre. Echantillonner un TIN, c'est localiser un point dans un
triangle — donc le rematriciser. On paierait le decodeur pour retomber sur une
grille.

Pire, son argument de vente ne sert a rien ici : la densite adaptative de ses
triangles est **moins bonne** que le maillage radial du moteur, dont les anneaux
log-espaces sont centres sur l'observateur quand un quadtree de tuiles ne l'est
pas.

On prend donc des tuiles **terrarium** sur les donnees ouvertes d'AWS : pas de
jeton, CORS ouvert, couverture mondiale, altitude encodee sur trois canaux —
`h = R·256 + V + B/256 − 32768`.

### La geodesie : deux approximations mesurees, deux rejetees

Le raccourci habituel — `lat += nord/R`, `lon += est/(R cos lat)` — est un
developpement au premier ordre. Mesure a quatre cent cinquante kilometres depuis
Paris, contre le geodesique WGS84 : **20,9 km d'erreur**, soit 2,65° de
deplacement apparent. Une chaine entiere au mauvais endroit.

La correction evidente est la sphere de **rayon de courbure gaussien**, qui
epouse l'ellipsoide au second ordre autour du site. Mesuree a son tour :
**814 m**. Vingt-cinq fois mieux, et **trois pixels** tout de meme.

On resout donc sur l'ellipsoide, par les equations imbriquees de **Vincenty**.
Elles sont iteratives, ce qui serait redhibitoire par cellule — douze millions
d'appels. Mais la projection n'est evaluee que sur un **treillis de 65 par 65**
et par niveau, soit douze mille appels : l'exactitude y est gratuite. Entre les
noeuds, une interpolation bilineaire dont l'erreur se majore a **sept metres**
au niveau le plus grossier, pour des cellules de quatre cent quarante.

⚠️ **La validation ne compare pas Vincenty a Vincenty.** Deux etalons
independants : la longueur d'arc d'un trajet plein nord, obtenue par integration
de Simpson du rayon de courbure meridien — elle se referme a **9·10⁻⁸ m** ; et
la longitude atteinte sur l'equateur, qui vaut exactement la distance sur le
demi-grand axe.

### La pyramide : trois niveaux, une empreinte fixe

Quatre cent cinquante kilometres a trente metres feraient neuf cents millions de
points. Inutile : ce que l'oeil resout n'est pas une longueur mais un **angle**.
A 0,0347° par pixel, un echantillon utile mesure `distance × 6,06·10⁻⁴`.

| niveau | couvre | pas | source | l'ecran demande |
| --- | --- | --- | --- | --- |
| L2 | 28 km | 27 m | z=12 | 15 m a 25 km |
| L1 | 112 km | 110 m | z=10 | 61 m a 100 km |
| L0 | 450 km | 440 m | z=8 | 273 m a 450 km |

Partout autour de **deux pixels par cellule**. Trois grilles Int16 de 2048 :
**25 Mo residents**, quel que soit le rayon demande. Les niveaux se fondent sur
leur frange exterieure — sans quoi un anneau net cerclerait l'observateur ; le
saut mesure tombe a **5,2 m** sur un ecart de 1000 m entre niveaux.

Le domaine stocke est carre mais rien n'en lit les coins : les tuiles hors du
disque utile ne sont pas telechargees.

### ⚠️ La falaise du choix de zoom

Premiere mesure comparee : Chamonix, 45,92° de latitude, **217 tuiles** ; Nice,
43,70°, **703**. Trois fois plus pour deux degres de latitude.

Les zooms vont de deux en deux, et le niveau fin etait choisi comme le premier
dont la resolution tient **strictement** sous la taille d'une cellule. A
Chamonix, le zoom 12 vaut 25,1 m pour une cellule de 27,4 : il passe. A Nice,
Mercator etirant moins, il vaut 27,7 m : il echoue d'**un pour cent**, et le
zoom 13 le remplace — quatre fois plus de tuiles.

Un quart de tolerance supprime la falaise. La perte est une fraction de la
finesse d'une cellule, laquelle est de toute facon deja une fois et demie plus
grossiere que ce que l'ecran resout a la portee du niveau. Nice retombe a
**206 tuiles**.

### Ce que ca coute vraiment

Mesure : Chamonix **217 tuiles**, Paris **244**, Nice **206** — aucun echec,
aucune erreur. Chamonix, **26,2 Mo, 16 s**. Mis en cache un
mois dans IndexedDB. Les niveaux arrivent l'un apres l'autre et le maillage se
reconstruit a chaque palier — le relief proche est la bien avant le lointain.

Cout par image, a 3840×2400 pour sortir du plafond de l'instrument :
**9,00 ms contre 6,10 sans relief**, soit **2,9 ms sur 9,2 Mpx**. Au format
nominal, sous la milliseconde.

---

## Le sol peint devient un globe

`Ground.tsx` etait une calotte **peinte** : deux couleurs d'interface, un
`smoothstep`, une parabole sur le log de l'eclairement. Son propre en-tete
l'admettait, et annoncait la fin de la cale pour la phase 9. Elle n'etait pas
venue.

Un sol peint ne sait pas ou est le Soleil. Il gardait la meme teinte a midi et
sous l'horizon, ne rougissait pas au couchant, ne se voilait pas avec la
distance. Surtout, **rien n'y arretait la lumiere** : la moitie basse de la
scene n'etait pas une surface, seulement un cache.

**Ce n'est pas un maillage.** Le relief a besoin d'un maillage parce que sa
hauteur varie ; un globe sans relief n'a aucune hauteur a porter — sa surface
est une equation. On garde une calotte grossiere comme simple support de
rasterisation, et chaque pixel resout son intersection :

    t = -r0*mu - sqrt( r0^2 mu^2 - r0^2 + R^2 )

Le rayon employe est le **rayon effectif sous refraction**, celui-la meme qui
place les sommets et donne la depression de l'horizon. La validation verifie
qu'au bord de la calotte le discriminant reste positif : aucun fragment rejete,
donc **aucune frange** entre le globe et le ciel.

La normale au point vise est `normalize(P)` et **s'incline avec la distance** —
1,8° a deux cents kilometres. C'est ce qui donne au globe un **terminateur** :
Soleil sous l'horizon de l'observateur, le sol lointain dans sa direction peut
encore etre eclaire. Rien n'est peint ; la separation tombe la ou
`dot(N, soleil)` change de signe.

---

## ⚠️ L'oeil etait dans le sol

Le defaut le plus instructif de cette phase, et il ne pouvait pas exister avant.

Le banc synthetique avait une plaine a **zero** et un observateur a l'altitude du
site — trente-cinq metres. L'oeil la survolait donc de trente-cinq metres, et a
vingt metres de distance le sol apparaissait deja soixante degres sous
l'horizon : le premier anneau du maillage couvrait le nadir.

Avec le relief **reel**, l'altitude du site et celle du terrain sous les pieds
sont **la meme grandeur**. A Chamonix, site a 1035 m et MNT a 1040 m : l'oeil se
retrouvait cinq metres **sous** la surface. Tout le sol se projetait alors sur
l'horizon, l'hemisphere inferieur se vidait, et l'on voyait passer les
constellations sous ses pieds.

Deux corrections, et la seconde est plus subtile que la premiere.

**L'oeil repose sur le sol.** `eyeAltitudeM` prend le maximum de deux lectures :
le sol sous les pieds plus `EYE_HEIGHT_M` = 1,7 m, ou l'altitude demandee. Le
maximum, parce que les deux situations sont legitimes — on peut se tenir au sol,
on peut survoler la vallee. Ce qui ne l'est jamais, c'est d'avoir la tete sous
terre.

**Cette altitude ne doit pas etre arrondie.** Le maillage etait reconstruit sur
une altitude quantifiee a dix metres, ce qui evitait cent mille sommets pour un
metre de deplacement. Avec un oeil qui ne domine le sol que de 1,7 m, l'arrondi
l'enfonce sous la surface une fois sur deux — et **le maillage se retourne** :
le sol qui devrait etre sous l'horizon passe au-dessus, la scene se remplit d'un
dome sombre. L'arrondi ne sert plus qu'a decider **quand** reconstruire ; la
geometrie recoit la valeur exacte.

Le premier anneau descend en consequence de vingt metres a **cinquante
centimetres**, ce qui referme l'hemisphere inferieur jusqu'a soixante-treize
degres sous l'horizon.

**Et le maillage ne porte plus au-dela des donnees.** Depuis sept mille metres,
la portee optique demandait six cent quatre-vingt-dix-sept kilometres quand la
pyramide s'arrete a quatre cent cinquante : les anneaux au-dela retombaient au
niveau de la mer et dessinaient une **marche nette a l'horizon**. Le globe prend
le relais, et il y est justement au niveau de la mer, comme la pyramide hors de
son domaine.

---

## Choisir un lieu sur la carte, et s'en eloigner en hauteur

La carte de selection ne charge **aucun fond de carte**. Elle est dessinee a
partir des memes tuiles d'altitude que le relief : la mer par le signe de
l'altitude — c'est pour cela que le decodage garde la bathymetrie que la surface,
elle, ecrete — et le relief par un ombrage.

L'interet n'est pas d'economiser une dependance. La carte montre **exactement ce
que le moteur sait du terrain**, sa resolution et ses defauts compris : cliquer
sur une crete visible ici, c'est cliquer sur la crete qui sera rendue.

L'eclairement de la carte vient du nord-ouest a quarante-cinq degres. Ce n'est
pas une position solaire mais la **convention des cartes topographiques**, qui
evite l'illusion de relief inverse. C'est une image d'interface, pas une image du
ciel, et aucune de ses couleurs ne touche au rendu de la scene.

**La hauteur au-dessus du sol est un reglage distinct de l'altitude du lieu**, et
la distinction est de fond : l'altitude du lieu est une propriete du terrain, que
le modele numerique connait mieux que n'importe quelle saisie. Le second dit ou
se trouve l'observateur **par rapport a ce sol** — au sommet d'une tour, en
ballon, en avion. C'est lui qui abaisse l'horizon et decouvre le lointain :

| hauteur | horizon | portee sur un sommet de 4000 m |
| --- | --- | --- |
| 2 m | 5,5 km | 253 km |
| 35 m | 23,2 km | 271 km |
| 500 m | 87,4 km | 335 km |
| 3000 m | 212,4 km | 458 km |
| 8000 m | 341,8 km | 583 km |

---

## ⚠️ Trois couches, trois horizons

Le defaut ne pouvait apparaitre qu'apres la hauteur au-dessus du sol, et il
n'apparaissait pas au sol.

Trois couches dessinent la limite entre le ciel et la Terre, et chacune calculait
sa depression de l'horizon dans son coin :

| couche | altitude employee |
| --- | --- |
| relief | celle de **l'oeil** |
| calotte du globe | celle du **site** |
| fondu du fond de ciel | celle du **site** |

Tant qu'on se tenait au sol, les deux altitudes etaient la meme et rien ne se
voyait. Des qu'une hauteur s'ajoutait, l'horizon reel descendait avec l'oeil et
les deux autres restaient ou ils etaient. **La bande entre les deux
n'appartenait a personne** : le relief ne montait pas jusque-la, la calotte ne
descendait pas jusque-la, et l'on y voyait le fondu du fond de ciel s'eteindre
tout seul.

| site → oeil | bande orpheline | ce que le ciel y devient |
| --- | --- | --- |
| 1035 → 1035 m | 0,000° | rien a voir |
| 1035 → 7035 m | **1,564°** | 47 % — un voile pale |
| 35 → 6035 m | **2,144°** | 20 % |
| 35 → 10035 m | **2,847°** | 1 % — un **trait noir** |

### La correction, et pourquoi elle tient

**Une seule altitude pour les trois** : celle de l'oeil. C'est elle qui decide de
la refraction, de la depression et du profil de densite — a six mille metres
au-dessus du site, l'altitude nominale de celui-ci ne decrit plus rien.

**Et la geometrie cesse de decider ou est l'horizon.** La calotte du globe
s'ouvre desormais a l'**horizontale**, pas a la depression : elle couvre tout
l'hemisphere inferieur, et c'est le test d'intersection **par pixel** qui taille
le bord exact. Deux avantages — le bord est au metre pres, et il est
necessairement au meme endroit que celui du relief, puisque les deux resolvent la
meme sphere.

### L'invariant qui empeche la couture de se rouvrir

La validation compare desormais, pour huit altitudes d'oeil de deux metres a
quinze kilometres, trois grandeurs qui doivent rester egales : la silhouette du
relief sur une mer plate, l'horizon que le nuanceur du globe obtient par
intersection, et l'ancrage du fondu du ciel.

Ecart residuel : **2,6·10⁻³°**, soit 9,5″ a quinze kilometres — **un dixieme de
pixel**. Ce n'est pas du bruit mais la difference entre la tangente **exacte**
que resout le globe et la relation petit-angle `dip = √(2h/R)` dont vivent le
relief et la table de refraction. La reduire demanderait d'imposer l'un des deux
modeles aux deux, ce qui degraderait le globe.

Le second controle mesure la **consequence** plutot que l'angle : la ou le globe
s'arrete, le fondu du ciel n'a retire que **3,6·10⁻⁶** de sa radiance.

### Et l'altitude du sol devient une mesure

Choisir un sommet sur la carte laissait le panneau afficher l'altitude du lieu
precedent. Le modele numerique connait cette valeur mieux que n'importe quelle
saisie : elle est desormais **publiee** des qu'il est charge. La hauteur
au-dessus du sol, elle, reste ce que l'utilisateur decide.

---

## ⚠️ La coordonnee de distance prenait la rasance du globe pour une limite

Le defaut que trois hypotheses successives ont manque, et qui se voyait pourtant
a tous les zooms.

### Le symptome

Une rupture nette du voile, a **hauteur apparente fixe**, posee **par-dessus le
relief** — indifferente aux montagnes qui se trouvaient devant. Elle suivait
l'horizon du globe et non celui du terrain.

### La cause

La coordonnee de distance de la table valait :

    w = sqrt( distance / trajet_total )

ou `trajet_total` etait la longueur du rayon **dans sa propre direction** : la
sortie de l'atmosphere pour une visee montante, la rencontre du sol pour une
visee descendante.

Cette longueur est **discontinue**. De part et d'autre de la rasance — la
direction ou le rayon effleure la sphere — elle bascule d'une branche a l'autre.
Mesure a trente-cinq metres d'altitude, pour quatre milliemes de degre d'ecart :

| hauteur | trajet total | tranche lue | relief a 15 km |
| --- | --- | --- | --- |
| −0,1879° | 1154 km | 1,71 | `26,42,75` |
| −0,1919° | 18,3 km | 13,59 | `75,90,124` |

**Un facteur soixante-trois sur la longueur, quarante-neuf niveaux d'affichage
sur la couleur**, en moins d'un pixel.

Trois consequences, toutes visibles :

- deux lignes voisines de la table echantillonnaient des distances sans rapport,
  et les melanger n'avait aucun sens ;
- le nuanceur recalculait cette longueur **par pixel**, avec la meme
  discontinuite ;
- la rupture se posait a la hauteur de la rasance du globe, **quoi qu'il y ait
  devant** — puisque cette longueur ne connait que la sphere.

Pourquoi trois enquetes l'ont manquee : les mesures avaient ete faites **depuis
douze kilometres**, ou la rasance tombe a −3,5° et designe du terrain a plus de
trois cents kilometres — la ou le voile est deja sature, donc ou les deux
tranches donnent presque la meme couleur. Au sol, la meme rasance designe du
relief a **quinze kilometres**, ou le voile est encore mince et l'ecart eclate.

### La correction : une loi globale

La loi de distance ne depend plus d'aucune direction :

    d(w) = D0 · (exp(w · K) − 1)      K = ln(1 + D_max / D0)
    D0 = 50 m        D_max = 800 km

Logarithmique pour rester fine au premier plan sans renoncer au lointain, et
surtout **la meme pour toutes les directions** : le melange des lignes redevient
legitime, la coordonnee est continue, et le nuanceur n'a plus aucune geometrie a
resoudre — il ne connait plus la sphere, donc il ne peut plus prendre sa rasance
pour une limite.

`D_max` n'est pas la longueur d'un rayon mais la distance au-dela de laquelle
l'integrale n'accumule plus rien : une visee rasante parcourt onze cents
kilometres, mais a huit cents elle est deja a quarante-six kilometres d'altitude.
Les tranches suivantes repetent la meme valeur, et `w = 1` designe toujours le
ciel.

Le prix est qu'un rayon ne remplit plus toutes ses tranches : celles qui
depassent sa propre fin repetent la derniere valeur. C'est exactement le
comportement physique au-dela du sol.

### Ce qu'il a fallu ajuster

**Trente-deux tranches au lieu de seize.** La loi globale ne peut plus adapter sa
finesse a chaque rayon ; il faut donc plus de points de controle pour tenir la
meme resolution pres de l'observateur. Le rapport entre tranches consecutives
tombe a 1,37.

**Quatre pas par tranche, et non deux.** Deux auraient tenu le cout d'avant, mais
la quadrature se degradait :

| pas par tranche | ecart a une marche seize fois plus fine |
| --- | --- |
| 2 | 0,199 % |
| **4** | **0,050 %** |
| 8 | 0,012 % |

L'ancienne marche valait 0,07 %. Quatre pas passent dessous : on ne degrade pas
la quadrature pour economiser. Une ligne de table passe de 2,9 a **4,8 ms**, et
le budget se rattrape sur le nombre de lignes par image — une au lieu de deux,
soit un peu plus d'une seconde pour la table entiere, pendant laquelle la
precedente reste affichee.

**Deux controles ont du etre reformules**, et il faut dire pourquoi :

- *la tranche lointaine est numeriquement le ciel* passait a 5,7·10⁻⁸ tant que la
  table et `skyRadiance` partageaient la meme repartition de pas — deux fois la
  meme marche, et le controle ne mesurait qu'une identite d'implementation. Il
  reste **4,2·10⁻⁴**, un vrai ecart de quadrature entre deux integrateurs
  differents, pour un niveau d'affichage qui vaut 3,9·10⁻³. La tolerance est
  desormais fixee par la **visibilite**.
- *sous l'horizon le trajet est borne par le sol* comparait les deux visees a
  `w = 0,5`, ce qui n'etait pas la meme distance pour l'une et pour l'autre. La
  loi globale rend enfin la comparaison possible **a distance egale** : a cent
  quinze kilometres, une visee a −20° garde la transmittance de ses cent deux
  premiers metres, la rasante celle de cent quinze kilometres d'air.

### La mesure d'apres

Meme point de relief a quinze kilometres, de part et d'autre de l'ancienne
rasance : `43,70,119` contre `42,69,118`. **Un niveau d'ecart au lieu de
quarante-neuf**, et la variation redevient monotone avec la hauteur.

A l'ecran, champ de 2,5° sur huit cents pixels — 0,0031° par pixel, le zoom le
plus serre possible — le plus grand saut de toute l'image vaut **0,3 niveau**, et
le profil autour de l'ancienne rasance est plat.

---

## ⚠️ La re-saturation detruisait le degrade du crepuscule

Signale au sommet du Ventoux, le 31 aout a 21h16 : « une transition tres bizarre
entre le halo jaune qui est intense, et la nuit noire ».

### Ce que la physique disait

Rien d'anormal. L'eclairement du ciel a 1910 metres tenait l'echelle de la
litterature :

| heure | Soleil | eclairement du ciel |
| --- | --- | --- |
| 21h05 | −8,48° | 0,428 lx |
| 21h16 | −10,33° | 0,041 lx |
| 21h30 | −12,63° | 0,0066 lx |

Et aucun bleu negatif ne sortait du solveur : au ras de l'horizon la radiance
valait `R = 2,76·10⁻³`, `B = 1,79·10⁻⁴`, tres rouge mais parfaitement positive.

### Ce que la chaine d'affichage en faisait

`DISPLAY_SATURATION` valait **1,4**, et son propre commentaire disait d'ou elle
venait : « meme valeur que celle qui vivait dans `scene/atmosphere.ts` sous le
nom `ATMOSPHERE_SATURATION` ». Un multiplicateur de saturation herite de
l'atmosphere artistique, applique **apres** la courbe de rendu, sans fondement
colorimetrique.

Elle ne forcait pas seulement le trait, elle **detruisait de l'information** :

    out = luma + (mapped − luma) · S

envoie un canal sous zero des que son ecart a la luminance depasse `luma/(S−1)`.
Au Ventoux, une visee un demi-degre au-dessus de l'horizon donnait
`mapped = (0,80 · 0,54 · 0,065)` et `luma = 0,563` :

    bleu = 0,563 + (0,065 − 0,563) · 1,4 = **−0,134**   →   ecrete a zero

| Soleil | part du ciel avec un canal ecrete | ecart introduit |
| --- | --- | --- |
| +30° | 0,0 % | 25 niveaux sur 255 |
| 0° | 1,0 % | **127 niveaux** |
| −10,3° | 3,7 % | 103 niveaux |
| −14° | **12,9 %** | 79 niveaux |

La bande de l'horizon devenait un **aplat orange sans degrade**, et le bleu
reapparaissait d'un coup un degre plus haut. C'etait la transition signalee.

### Pourquoi borner au gamut ne suffisait pas

La correction evidente est de reduire la saturation juste assez pour rester dans
le domaine, au lieu d'ecreter. On l'a calculee : en ce point la borne vaut
**1,13**, et le bleu y ressort encore **exactement a zero**. Ce n'etait pas
l'ecretage qu'il fallait corriger, c'etait la constante.

### La correction

`DISPLAY_SATURATION = 1`. La chaine d'affichage est desormais ACES puis sRGB,
sans retouche. Le bleu de cette meme visee vaut **72 sur 255**, et le degrade
existe.

Les couleurs de plein jour perdent environ **25 niveaux** de saturation. C'est
exactement la mesure de ce que la constante ajoutait, et elle n'avait rien pour
le justifier.

Le controle qui epinglait la valeur 1,4 epingle maintenant une **propriete** :
aucune couleur affichable ne doit pouvoir sortir du domaine par la seule
re-saturation. Toute valeur superieure a un la violerait.

### ⚠️ Ce qui n'etait pas un defaut

Le meme signalement disait « le halo reste longtemps ». C'est vrai, et c'est
**voulu** : l'exposition suit `L_blanc = L_ref·(L_ciel/L_ref)^p` avec
`p = 1 − decades_ecran/decades_scene ≈ 0,75`. Une chute d'un facteur quarante de
la luminance du ciel ne se traduit donc que par un facteur `40^0,25 = 2,5` a
l'ecran — c'est le prix assume de faire tenir huit decades de scene dans les deux
que montre un ecran. Le halo qui persiste est la trace de cette compression, pas
une erreur.

---

## La diffusion multiple cesse de fermer sa serie sur place

### Ce que la fermeture locale supposait

La table refermait la serie des ordres superieurs cellule par cellule :

    Ψ_ms = L_f / (1 − f_ms)

C'est exact **si le champ est uniforme** : la somme geometrique suppose que ce
qui repart pour un tour de plus retombe au meme endroit du plan
(altitude, angle solaire).

De jour, l'atmosphere est eclairee partout et le champ varie lentement :
l'hypothese tient. Au crepuscule profond elle s'effondre. Sous −10° de hauteur
solaire, la diffusion simple est **rigoureusement nulle** — toute l'atmosphere
accessible est dans l'ombre de la Terre — et la lumiere qui eclaire un point
d'ombre a vingt kilometres vient d'air ensoleille situe a des centaines de
kilometres, donc a une tout autre altitude et un tout autre angle solaire.

### Ce qui la remplace

    Ψ⁰ = L_f
    Ψ^{n+1}(x) = ⟨ ∫ T(x,x') σ_s(x') Ψ^n(x') dt ⟩ sur 4π
    Ψ_ms = Σ Ψ^n

La difference tient dans un seul mot : `Ψ^n(x')` est lu **au point
d'echantillonnage**, avec sa propre altitude et son propre angle solaire, et non
au point qu'on calcule. Si le champ etait uniforme on retrouverait exactement
`f_ms·Ψ`, donc la serie geometrique : l'ancien modele en est le cas particulier.

L'iteration est de type **Jacobi** et non Gauss-Seidel — la table se remplit par
tranches etalees sur plusieurs images, et lire ce qu'on ecrit rendrait le
resultat dependant de l'ordre de parcours.

**Deux ordres explicites suffisent**, puis la queue est fermee localement :

| ordres | rapport a −10° | cout |
| --- | --- | --- |
| 1 | ×0,62 | 1,8 s |
| **2** | **×0,64** | **2,4 s** |
| 4 | ×0,65 | 3,3 s |
| 6 | ×0,65 | 4,5 s |

La non-localite ne compte que pour les tout premiers transferts, ceux qui font
entrer la lumiere de l'air ensoleille vers l'ombre. Au-dela le champ est diffus,
et le troisieme ordre ne deplace plus que 1,5 %.

### L'angle solaire etait echantillonne au mauvais endroit

`mu = 2u − 1` repartissait les colonnes uniformement en cosinus : avec
trente-deux colonnes, deux voisines sont separees de **3,7 degres d'angle
zenithal au terminateur**, la ou la luminance change d'un facteur deux par
degre. La table y etait plus grossiere que le phenomene.

Elle est desormais quadratique de part et d'autre du terminateur — la premiere
colonne hors terminateur tombe a 0,06 degre — et deux fois plus large.

⚠️ **C'est la largeur qui compte, pas la hauteur** : 64×32 et 64×48 rendent les
memes chiffres a la troisieme decimale, tandis que 48×48 laisse encore un ×2,17
au milieu d'une serie a ×3.

### ⚠️ Les deux erreurs se compensaient

Le resultat le plus instructif de ce chantier. Mesure croisee, rapport a la
courbe d'eclairement du projet :

| configuration | −10° | −14° | decroissance par degre |
| --- | --- | --- | --- |
| 32×32, fermeture locale — **l'ancien** | ×0,65 | ×0,30 | 1,90 a 3,92 — **erratique** |
| 64×32, fermeture locale | ×0,56 | ×0,23 | 2,60 a 3,51 — lisse |
| 32×32, deux ordres | ×0,79 | ×0,47 | 1,87 a 3,61 — erratique |
| **64×32, deux ordres — le nouveau** | ×0,64 | ×0,29 | **2,56 a 3,53 — lisse** |

Les magnitudes n'ont presque pas bouge. **Une table sous-resolue surestimait
d'un cote, une fermeture locale sous-estimait de l'autre**, et leur produit
tombait a peu pres juste — au prix d'une decroissance qui oscillait entre ×1,5
et ×9,5 par degre la ou une extinction physique est lisse.

C'est exactement le genre d'accord qu'on ne peut pas garder : il tenait par
compensation, et rien dans le rendu ne l'aurait signale.

### Ce qui reste, mesure

L'accord est bon jusqu'a −8° et se degrade ensuite : ×0,92 a −6°, ×0,66 a −8°,
×0,64 a −10°, ×0,29 a −14°, ×0,10 a −16°. La decroissance vaut ×2,56 a ×3,53
par degre quand l'observation donne ×2 a ×2,5 : le ciel s'eteint encore trop
vite.

La cause restante est la meme, non levee : une table indexee sur
(altitude, angle solaire) reste une representation **locale** d'un champ qui ne
l'est pas. Deux ordres de transport la rendent regulière, pas exacte. Aller plus
loin demanderait un champ a trois dimensions ou une resolution en harmoniques
spheriques — un autre chantier.

### Un controle qui l'aurait vu

La suite verifie desormais que **le crepuscule s'eteint sans a-coups** : la
chute par degre entre −6° et −16° doit rester dans une bande physique. Elle vaut
×2,72 a ×3,45 ; l'ancienne table donnait ×1,54 a ×9,51 et passait tous les
controles existants, parce qu'aucun ne regardait la pente.

### Ce que ca coute au demarrage

Trois passes au lieu d'une sur une table deux fois plus large, c'est six fois
plus d'entrees. Le cout par entree a baisse — 0,38 ms a la premiere passe,
0,22 ms aux suivantes, contre 1,27 ms auparavant — mais le total montait a six
secondes, et le ciel n'apparaissait qu'apres.

Deux mesures ont ramene le premier ciel de **12,1 s a 6,0 s** :

- la cadence passe de seize a trente-deux entrees par image, ce qui reste
  moins cher par image qu'avant ;
- **la premiere passe est traitee a part.** Elle suffit a rendre la table
  utilisable — c'est le premier ordre de diffusion, un ciel un peu sombre mais
  juste dans sa forme. Le ciel se batit dessus, les passes suivantes reprennent
  ensuite, et le ciel se reconstruit une derniere fois quand la table est
  complete.

Le sequencement garantit qu'une construction de ciel ne chevauche jamais une
passe : c'est ce qui evite la bande horizontale que l'en-tete du module
redoutait, sans avoir a figer une copie de la table.

---

## ⚠️ La table jetait 93 % du ciel crepusculaire

Signale comme « un halo blanc post-crepusculaire », audite pixel par pixel.

### La methode

On a recalcule, terme par terme, ce que le nuanceur du ciel produit pour une
direction donnee, puis compare au pixel reellement affiche — et enfin compare la
table au **solveur direct**, qui ne passe par aucune table.

Les deux premieres comparaisons etaient rassurantes : la table de l'application
et son recalcul independant s'accordent a **6 %**, ecart uniforme imputable a la
distance Terre-Soleil et a la quantification de la hauteur solaire. Le materiau
faisait donc bien ce qu'on croyait.

La troisieme ne l'etait pas du tout.

| ligne | hauteur | table / solveur direct |
| --- | --- | --- |
| 33 | 0,088° | **x0,074** |
| 35 | 0,791° | **x0,092** |
| 37 | 2,197° | x0,433 |
| 39 | 4,307° | x1,001 |
| 42 | 8,789° | x0,999 |

La table rendait **sept pour cent** de la vraie valeur au ras de l'horizon, et
redevenait exacte au-dela de quatre degres. Entre les deux, le raccord formait
une bande brillante etroite vers deux degres : le halo signale.

### La cause, et c'etait une regression du meme jour

`AERIAL_FAR_M`, la portee de la coordonnee de distance, valait 800 km. Le
raisonnement inscrit dans le code : « ce n'est pas la longueur du rayon, c'est la
distance au-dela de laquelle l'integrale n'accumule plus rien ; une visee rasante
parcourt onze cents kilometres, mais a huit cents elle est deja a quarante-six
kilometres d'altitude, ou il ne reste rien a diffuser ».

**C'est vrai de jour et faux au crepuscule**, et le crepuscule est le seul moment
ou cela compte. Le Soleil couche, l'air proche est dans l'ombre de la Terre et ne
diffuse rien : toute la lumiere du ciel vient de l'air **lointain et haut**, le
seul encore eclaire.

| hauteur de visee | part de la radiance collectee au-dela de 800 km |
| --- | --- |
| 0,09° | **93 %** |
| 0,80° | **91 %** |
| 2,20° | 59 % |
| 4,31° | 0 % |

La borne n'est plus une estimation mais la **longueur reelle du plus long trajet
possible**, `sqrt((R + h_top)^2 - R^2) = 1133 km`, arrondie a 1200 km.

### Pourquoi aucun controle ne l'a vue

Le controle « la tranche lointaine est numeriquement le ciel » existait, et il
est exactement celui qui devait l'attraper. Il ne s'executait qu'a **vingt degres
de hauteur solaire**. De jour la lumiere est collectee dans les premieres
dizaines de kilometres du rayon : la troncature y est invisible.

Il tourne desormais aussi a -6° et -15°, sur les premieres hauteurs au-dessus de
l'horizon, avec un plancher en luminance — au-dela de sept degres a -15° la
diffusion simple vaut deux millioniemes de candela, et un ecart relatif n'y
decrit plus que du bruit.

### La quadrature a suivi

Le meme controle, une fois etendu, a montre un residu de 8,5 % a -15° la ou le
jour donnait 0,05 %. Meme cause de principe : sous l'horizon, l'integrande
acquiert une **arete franche** — le point ou le rayon sort de l'ombre de la Terre
— qu'une quadrature grossiere integre mal.

| Soleil | 4 pas par tranche | 8 pas |
| --- | --- | --- |
| -6° | 0,3 % | 0,0 % |
| -10° | 0,4 % | 0,2 % |
| **-15°** | **8,5 %** | **1,0 %** |

Huit pas, donc, pour **1,2 ms de plus par ligne** — 4,8 a 6,3 — et non le double,
une part du cout d'une ligne ne dependant pas du nombre de pas.

### L'echelle crepusculaire, refaite

Les rapports publies la veille avaient ete mesures **a travers la table
tronquee**. Les voici sur la table corrigee, ou table et solveur direct
s'accordent desormais a 1 % :

| Soleil | avant (table tronquee) | apres | reference |
| --- | --- | --- | --- |
| -6° | x0,92 | **x0,98** | 3,40 lx |
| -8° | x0,66 | **x0,72** | 0,452 lx |
| -10° | x0,64 | **x0,70** | 0,060 lx |
| -12° | x0,64 | **x0,71** | 0,008 lx |
| -14° | x0,29 | **x0,33** | 1,97e-3 lx |
| -16° | x0,10 | **x0,11** | 4,87e-4 lx |

La conclusion qualitative ne change pas — l'accord se degrade sous -12° — mais
les chiffres etaient sous-estimes de sept a dix pour cent.

### Ce que l'audit a aussi etabli

**Le halo n'est pas l'airglow.** Sous trois degres il ne pese que 1 a 2 % du
total ; sa part ne devient notable qu'en altitude — 18 % a 8°, 43 % au zenith.
C'est bien le crepuscule residuel qu'on voit.

**Il est gris parce que l'oeil l'est.** A ces luminances, la desaturation
scotopique vaut 100 % dans tout le ciel : aucune couleur n'est perceptible, et le
modele le dit. Le halo est blanc par construction, non par defaut.

**Les sondes de mesure calculaient a un trouble de 2,5** quand le store part sur
1. Les comparaisons de cette session ont ete refaites avec les entrees de
l'application — trouble, ozone climatologique, altitude de l'oeil.

---

## Registre des incertitudes scientifiques

Ce que le moteur **mesure**, ce qu'il **choisit**, et ce qui lui **manque**. Un
seul endroit, parce que « fini et valide » veut dire savoir exactement ou l'on
en est.

### Mesure, et recoupe par un chemin independant

| Grandeur | Recoupement | Écart |
| --- | --- | --- |
| Atmosphère US1976 | tables normatives | 4,4·10⁻⁵ |
| Section efficace de Rayleigh | Mie × facteur de King | 4·10⁻⁴ |
| Indice de Ciddor | Peck & Reeder | 3,5·10⁻⁵ |
| Réfraction à 45° | Astronomical Almanac | 0,4 % |
| Traceur 3D | intégrale 1D de l'invariant | 0,044″ |
| Invariant de Bouguer | conservation le long du rayon | 1,6·10⁻⁷ |
| HV 5/7 | ses propres valeurs de définition | 0,8 % et 1,4 % |
| Anneaux de couronne | prédiction par diffraction | 1,0 % à 20 µm |
| Ouverture de croisement | paramètre de Fried | 4 % |
| Bilan d'éclairement | paliers de `photometry.ts` | 1–6 % |

### Choisi, et signale comme tel

| Paramètre | Valeur | Ce qu'il faudrait |
| --- | --- | --- |
| Indice complexe des aérosols | `n = 1,53`, `k = 0,008` | **OPAC** (Hess, Koepke & Schult 1998) |
| Rayon médian des aérosols | 0,05 µm, calé sur α = 1,29 | mesure AERONET du site |
| Coefficients d'ozone climatologique | interpolation aux bornes | **van Heuklon (1979)** |
| Échelle externe de turbulence | 25 m | mesure du site ; `r₀` n'en dépend pas |
| Fréquence de fusion rétinienne | 20 Hz | dépend de la luminance |
| Indice de l'eau liquide | 1,333 | **Hale & Querry (1973)** |
| `DISPLAY_SATURATION` | 1,4 | un modèle d'apparence |
| Atténuation d'éclipse | `√(1 − obs + 8·10⁻⁴)` | transport horizontal depuis la pénombre |

### Manquant, et nomme

| | |
| --- | --- |
| **Ancre d'exposition** | **résolue** : l'exposition suit désormais la luminance moyenne du ciel, mesurée sur la table qui s'affiche. `86 302 cd/m²` n'est plus qu'un point d'ancrage de continuité pour un midi. Restent l'adaptation **instantanée** et l'absence de vision **scotopique**. |
| **Nœud à 5° de `SOLAR_ANCHORS`** | incompatible avec ses propres voisins ; écarté de la validation avec sa justification depuis la phase 8. Trancher demanderait un jeu **BSRN** ou **IDMP/CIE**. |
| **Socle nocturne** | **résolu** : forme et amplitude calculées, couleur peinte supprimée. Le ciel nocturne sort gris par **désaturation scotopique** — les bâtonnets sont monochromatiques. Restent le décalage de Purkinje (faute de `V'(λ)`), la lueur lunaire et le halo urbain. |
| **Transmittance spectrale réduite à trois nombres** | exacte pour un spectre solaire seulement. Limite de la chaîne RGB, pas du transport. |
| **Trou d'ozone antarctique** | anthropique et non stationnaire ; une chronologie, pas une formule. |
| **Rendu des mirages** | la physique est validée ; un maillage ne peut être qu'à un endroit, et le Soleil « vase étrusque » demande que le disque soit rendu *à travers* la fonction de transfert. |
| **Nuages** | le transport suppose une atmosphère claire. Sans eux, ni couronne, ni gloire, ni iridescence. |
| **Le sol** | **résolu**. Le relief est le modèle numérique de terrain réel à trente mètres, et au-delà de sa portée le globe est une sphère résolue par pixel. Les deux reçoivent la même équation du transfert que tout le reste : albédo, cosinus d'incidence, éclairement du ciel, extinction, voile. Plus une seule couleur d'interface sous l'horizon. |
| **Un seul albédo pour tout le globe** | faute de couverture du sol, la mer, la forêt et le désert partagent `AtmosphereState.groundAlbedo` = 0,1. C'est au moins la valeur qui nourrit déjà la diffusion multiple : le sol qu'on voit et le sol qui éclaire le ciel sont d'accord. Une couverture ESA WorldCover à 10 m serait la suite. |
| **Le ciel est calculé sur des rayons droits** | la réfraction n'entre pas dans l'intégrale de diffusion : le solveur marche en ligne droite dans une atmosphère sphérique. Nul au niveau de la mer, où le rayon rasant et le rayon courbe partent ensemble. **Croissant avec l'altitude** : visée à l'horizon apparent, le rayon droit passe à 456 m du sol à 3000 m d'altitude et à **1319 m à 12 000 m**, là où le rayon réel rase la surface à 5 m. Il compte donc **13,4 % d'air en trop peu** à douze kilomètres. Le corollaire visible — une rupture du voile à la rasance du globe, posée par-dessus le relief — a été supprimé en rendant la coordonnée de distance globale ; il reste l'écart de colonne, invisible. |
| **Le crépuscule profond est trop sombre** | ⚠️ **partiellement corrigé.** Fermeture locale de la série remplacée par deux ordres de transport explicites, angle solaire échantillonné deux fois plus finement en loi quadratique autour du terminateur. La décroissance est redevenue **régulière** — ×2,56 à ×3,53 par degré, contre ×1,54 à ×9,51 auparavant. ⚠️ Les magnitudes n'ont presque pas bougé : une table sous-résolue surestimait, une fermeture locale sous-estimait, et les deux se compensaient. Rapports à `SOLAR_ANCHORS` de `photometry.ts`, **remesurés après correction de la troncature de la coordonnée de distance** : ×0,98 à −6°, ×0,72 à −8°, ×0,70 à −10°, ×0,71 à −12°, ×0,33 à −14°, ×0,11 à −16°. La table et le solveur direct s'y accordent à 1 %, l'écart restant est donc bien celui du **modèle**. Cause inchangée : une table indexée sur (altitude, angle solaire) reste une représentation **locale** d'un champ qui ne l'est pas. Aller plus loin demanderait un champ à trois dimensions ou une résolution en harmoniques sphériques. |
| **La courbe d'éclairement crépusculaire de référence** | ⚠️ les premières mesures de ce déficit ont été faites contre des valeurs **citées de mémoire**, qui se sont révélées trop hautes d'un facteur 3 à 9 sous −12°. Les comparaisons portent désormais sur `SOLAR_ANCHORS` de `photometry.ts`, les points d'ancrage du projet. Ceux-là sont décrits comme « classiques de la littérature sur les crépuscules » mais ne citent pas leur source : ils sont cohérents avec le reste du moteur, ce qui suffit à mesurer un écart **relatif**, et ne suffirait pas à trancher une calibration absolue. |
| **Le socle nocturne peint** | le halo lunaire et le halo urbain sont encore des couleurs d'interface. Mesuré au Ventoux une heure et demie après le coucher : ils portent **3 à 25 %** de la luminance du ciel, davantage en haut qu'à l'horizon. Le halo lunaire comporte un **plancher isotrope de 25 %** — `0,25 + 0,75·cos⁶` — qui n'a aucun fondement : la Lune éclaire le ciel par diffusion, exactement comme le Soleil, et sa place est dans le transport. ⚠️ Le retirer assombrirait encore un ciel déjà trop sombre : les deux défauts se compensent partiellement, et il ne faut pas corriger l'un sans l'autre. |
| **Résolution du relief proche** | la source est native à **trente mètres**. À cinq kilomètres, trente mètres sous-tendent 0,34°, soit une dizaine de pixels : le premier plan reste en blocs. Aucun choix de format ne le relève — seul un MNT national le ferait (RGE ALTI à 1 m, France seulement). |
| **Bathymétrie écrêtée** | terrarium encode les fonds marins en négatif ; les prendre tels quels creuserait l'océan en cuvette. L'écrêtage à zéro met à plat les dépressions continentales — mer Morte à −430 m, vallée de la Mort à −86 m. Les distinguer demanderait un masque terre/eau. |
| **Horizon du terrain** | le rayon terrestre effectif n'est plus le `k = 1/7` de la géodésie mais **l'inverse de la dépression que le moteur mesure**. C'est un calage sur une grandeur interne, valide à l'altitude du site ; le rapport `R_eff/R` dépend légèrement de l'altitude (1,204 à 35 m, 1,196 à 1 000 m) et n'est donc pas une constante universelle. |
| **Ombre du relief dans l'air** | **résolue**. Un segment ombré ne disparaît plus de l'intégrale : il retombe sur la table **ambiante**, la même intégrale privée de sa source solaire. Une ombre n'est donc ni un facteur ni une soustraction, c'est un **changement de terme source**. Mesure : crête à contre-jour, `28,28,20` → `41,67,98` — le noir devient bleu. |
| **Pénombre** | le Soleil a un demi-degré de diamètre, donc le bord de son ombre est flou sur une largeur croissant avec la distance à l'occulteur — cinq mètres à un kilomètre, cinquante à dix. La carte d'ombre rend une frontière nette. |
| **Relief du banc** | le champ de hauteur est un **bruit fractal a graine fixe**, pas un modèle géologique — c'est une surface de test. Les albédos (0,12 végétation · 0,20 roche · 0,80 neige) sont de manuel ; ni ombres portées, ni occlusion du ciel par le relief voisin. |
| **Altitude de l'observateur** | prise en compte par la réfraction, la masse d'air, le bord du sol et le terrain, chacun via `horizonDipDeg`. Le champ n'est **pas borné** dans l'interface : au-delà de la troposphère, le profil standard reste extrapolé et rien ne le signale à l'utilisateur. |
| **Marge sous l'horizon** | `HORIZON_MARGIN_DEG = 3` est une **borne de domaine numérique**, pas une grandeur physique. Justifiée par une somme de trois termes réels (0,57 + 0,27 + 1,76 = 2,6°) puis arrondie. Le fondu qui l'accompagne est un garde-fou, et il agit hors du champ visible. |

---

## L'optimisation — phase 20

### La regle, d'abord

> *Ne remplace jamais silencieusement un modele physique par une astuce
> artistique pour gagner des FPS.*

Cette phase commence donc par **mesurer**, et n'optimise que ce que la mesure
designe. Elle refuse aussi, explicitement, ce que la mesure ne justifie pas.

### ⚠️ La mesure ratee, et la lecon qui se repete

La premiere mesure de temps par image donnait **146 ms — sept images par
seconde**. Invraisemblable sur cette machine, et faux : Chromium sans argument
tourne en **rendu logiciel**. C'est exactement l'erreur de la phase 0, ou le banc
GPU avait ete lance dans l'onglet de l'application.

Avec `--use-gl=angle --use-angle=d3d11 --enable-gpu`, la carte apparait — et
l'application aussi :

| Cadence | Médiane | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| temps réel | **16,60 ms** | 22,1 | 23,4 | 23,6 |
| ×600 | 16,70 | 22,0 | 22,9 | 28,2 |
| ×86400 (1 jour/s) | 18,10 | 25,8 | **31,7** | 108 |

Seize virgule six millisecondes : l'application est **verrouillee sur la synchro
verticale**, a soixante images par seconde. La seule pression est l'avance
rapide, ou la mediane glisse de 1,5 ms.

### Ou passe le temps, reellement

Une reconstruction de la table de perspective coute **74 ms**, et le profil la
decompose sans ambiguite :

| | Coût | Nature |
| --- | --- | --- |
| Boucle 16 bandes avec exponentielle | **23,4 ms** | l'intégrale du transfert radiatif |
| Géométrie du rayon | 8,1 ms | **indépendante de l'azimut** |
| Colonnes solaires | 7,6 ms | dépend du Soleil |
| Conversions spectre → sRGB | 11 ms | dont la moitié pour la transmittance |
| Fonction de phase des aérosols | 0,6 ms | |

Deux millions d'exponentielles par reconstruction. **C'est l'equation du
transfert elle-meme**, et elle n'est pas compressible : `exp(−τ)` par bande et
par pas est ce que le modele calcule.

### Ce qui a ete corrige, et ce que cela a coute en physique : rien

La table de colonne coutait **124 ms dans le navigateur**, et elle etait
construite **paresseusement au premier besoin — donc dans une image**. C'etait le
plus gros blocage du moteur, et le seul qui se voie : tout le reste etait deja
etale.

Elle est desormais construite par tranches de huit lignes, comme les autres. La
validation le controle a **egalite stricte**, avec un pas de decoupe qui ne
divise pas la hauteur — les coupes tombent donc a des endroits que la boucle
d'origine ne connaissait pas.

Mesure, somme des images de plus de 40 ms au demarrage : **1214 ms → 1076 ms**,
soit exactement les 124 ms retires.

### ⚠️ Ce que la mesure a contredit

Je pensais que les blocages du demarrage etaient ceux du moteur. **Ils ne le sont
pas.** Apres correction, il reste 422, 349 et 103 ms — et ils viennent de
l'amorcage de l'application : React, three.js, les catalogues. Le moteur
atmospherique n'y contribuait que pour 124 ms sur 1214.

C'est hors du perimetre de cette phase, et c'est dit plutot que suppose.

### Une optimisation mesuree, et **non prise**

La geometrie d'un rayon — altitudes, densites, colonnes primaires accumulees — ne
depend que de la **hauteur** de visee, pas de son azimut : le trajet est le meme
pour les soixante-quatre azimuts d'une ligne. Elle est pourtant recalculee
soixante-quatre fois.

La corriger est **exact**, fonde sur une symetrie, et economiserait **8 ms sur
74, soit 11 %**.

Elle n'a pas ete prise. Le raisonnement est explicite : ces 74 ms sont deja
etalees sur seize images, l'application tient soixante images par seconde, et le
gain porterait le p99 de l'avance rapide de 31,7 a peut-etre 30 ms. Contre cela,
il faudrait refactoriser le chemin le plus valide du moteur — celui dont
dependent quatre cents controles.

Le chiffre est mesure et note ; la decision est de ne pas payer ce prix
maintenant.

### Ce qui n'a pas ete fait, et pourquoi

**Reduire le nombre de pas ou de bandes** economiserait proportionnellement, et
serait un troc de precision contre des images par seconde. La mesure dit qu'il
n'y a rien a acheter : le moteur tient deja la cadence.

**Le noyau GPU**, lui, est a **0,04 ns/pixel** depuis la phase 9 — 0,31 ms a
1920×1080@dpr2, soit 2 % d'une image, contre 44 % pour l'ancien noyau
analytique. Il n'y a rien a y gagner.

---

*Derniere mise a jour : phases 0, 0.5, 1 a 17, 19 et 20 (sauf 2 partielle, 18 non
prioritaire) ; le ciel physique, les objets, la courbure des rayons et la
scintillation sont a l'ecran ; champ 3D, mirages et couronnes sont valides et
attendent leur rendu.*
