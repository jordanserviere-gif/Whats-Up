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

**État : 541 contrôles, 23 suites, aucun échec.**

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

*Derniere mise a jour : phases 0, 0.5, 1 a 12 (sauf 2 partielle) ; le ciel
physique, les objets qui s'y trouvent et la courbure des rayons sont a l'ecran.*
