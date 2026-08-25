# Moteur atmosphérique — avancement

États : **TODO** · **IN PROGRESS** · **VALIDATED** · **DEFERRED**

Voir [`atmosphere-engine.md`](atmosphere-engine.md) pour la documentation des
modules, [`atmosphere-engine-audit.md`](atmosphere-engine-audit.md) pour l'audit
d'intégration.

---

## Adaptation de l'ordre des phases

L'ordre proposé a été confronté à la codebase réelle. **Une adaptation
nécessaire, deux décisions différées.**

### Phase 0.5 intercalée — passe d'affichage HDR linéaire

La phase 0 demandait de « vérifier color management, HDR, tone mapping ».
Vérification faite : **la chaîne HDR linéaire n'existe pas**. Le tone mapping
ACES + resaturation ×1,4 est *à l'intérieur* de chaque matériau et **écrête à
[0,1]** ([`atmosphere.ts`](../src/scene/atmosphere.ts)), le renderer étant en
`NoToneMapping`.

Conséquence : le `SpectralSensor` de la phase 2 (`L(λ) → XYZ → RGB linéaire`)
est parfaitement implémentable et testable hors renderer — ce que la phase 2
demande d'ailleurs explicitement — mais **ne pourra pas être branché au rendu**
tant que ce refactor n'est pas fait. La phase 4 (Soleil direct rendu) en dépend
donc, pas la phase 2.

Une phase **0.5** est intercalée : elle sort le tone mapping des 13 matériaux,
rend dans un tampon `HalfFloatType` inconditionnel et applique une passe
d'affichage unique. À faire **avant la phase 4**, jamais après.

### Feature flag ancien/nouveau moteur — différé à la phase 0.5

La phase 0 le proposait. Aujourd'hui il ne commuterait rien et polluerait le
store persisté. Il sera introduit en phase 0.5, au moment où deux chaînes
d'affichage coexisteront réellement.

### Rien d'autre ne bouge

Les phases 1, 2 et 3 sont du TypeScript pur, testable sans GPU : aucun blocage,
aucune réorganisation.

---

## Tableau d'avancement

| Phase | Sujet | État | Note |
| --- | --- | --- | --- |
| **0** | Baseline et infrastructure | **VALIDATED** | coût GPU mesuré · sondes de non-régression |
| **1** | État atmosphérique + thermodynamique | **VALIDATED** | US1976 à 4,4·10⁻⁵ des tables |
| **0.5** | Passe d'affichage HDR linéaire | **TODO** | ⚠️ prérequis de la phase 4 |
| **2** | Base spectrale (`SpectralGrid`, `SolarSpectrum`, `SpectralSensor`) | **VALIDATED** | données acquises et commitées ; invariance à la résolution vérifiée |
| **3** | Rayleigh physique | **TODO** | cible chiffrée posée : transmission zénithale 90,2 % |
| **4** | Soleil direct + extinction | **TODO** | dépend de 0.5 |
| **5** | Single scattering | **TODO** | |
| **6** | Aérosols + Mie | **TODO** | précalcul hors ligne |
| **7** | Absorption atmosphérique | **TODO** | |
| **8** | Multiple scattering | **TODO** | cible : réparer le crépuscule mort |
| **9** | Perspective atmosphérique sur les objets | **TODO** | la couture existe déjà |
| **10** | Indice de réfraction spectral | **TODO** | |
| **11** | Ray bending | **TODO** | |
| **12** | Phénomènes émergents de réfraction | **TODO** | |
| **13** | Atmosphère 3D | **TODO** | |
| **14** | Inversions thermiques et mirages | **TODO** | |
| **15** | Turbulence | **TODO** | |
| **16** | Optique ondulatoire | **TODO** | |
| **17** | Seeing et scintillation | **TODO** | |
| **18** | Microphysique | **TODO** | non prioritaire |
| **19** | Fine tuning scientifique | **TODO** | |
| **20** | Optimisation GPU | **TODO** | |

---

## Phase 0 — Baseline et infrastructure · VALIDATED

### Livré

- `src/atmosphere/core/` — constantes SI sourcées, frontière physique↔rendu.
- `src/atmosphere/validation/harness.ts` — harnais numérique sans renderer,
  quatre formes de contrôle, suites rendues comme **données**.
- `scripts/verify-atmosphere.mjs` + `npm run verify:atmosphere`.
- `scripts/atmosphere-baseline.mjs` + `npm run atmo:baseline` — banc GPU isolé
  et sondes colorimétriques.
- `docs/atmosphere-baseline.json` — référence committée.

### Vérifications de pipeline demandées

| Point | Constat |
| --- | --- |
| Color management | `outputColorSpace = SRGBColorSpace` (défaut three r152+), textures planétaires en `SRGBColorSpace`. Cohérent. |
| **HDR** | **Absent.** Aucun tampon flottant hors de `EffectComposer`, lui-même conditionnel au calque `bloom`. |
| **Tone mapping** | **Dans les matériaux**, pas dans le pipeline. ACES Narkowicz + resaturation ×1,4, **écrêté à [0,1]**. Renderer en `NoToneMapping`. → phase 0.5 |
| Profondeur | Compression logarithmique vérifiée : strictement croissante (ordre des occultations préservé), diamètre apparent exact à 10⁻¹⁶°. |
| Coordonnées | +X est, +Y zénith, −Z nord — vérifié à 10⁻¹² contre `scene/sceneMath.ts`. Les directions traversent la frontière sans conversion. |

### Baseline de performance

| Cible | Voûte seule | Part d'une image à 60 Hz |
| --- | --- | --- |
| 1440×900 @ dpr 1 | 1,98 ms | 12 % |
| 1440×900 @ dpr 2 | **7,93 ms** | **48 %** |
| 1920×1080 @ dpr 2 | 12,69 ms | 76 % |

**1,53 ns/pixel**, limité par le remplissage. Bruit du banc : ~7 %.

### Défauts chiffrés par les sondes

- **Le crépuscule est mort.** À −5,9° de hauteur solaire, toutes les directions
  rendent ≈ `4,6,13` — c'est le socle nocturne peint, pas de la physique.
- **La nuit est entièrement peinte** : `3,4,10` identique dans toutes les
  directions.
- **Saturation à l'horizon** : `254,250,241` — écrêtage du tone mapping matériau.
- **Horizon anti-solaire au coucher** : `91,27,18`, rouge saturé du côté opposé
  au Soleil. À confronter à la diffusion multiple.

---

## Phase 1 — État atmosphérique + thermodynamique · VALIDATED

### Livré

- `thermodynamics/standardAtmosphere.ts` — US Standard Atmosphere 1976,
  7 couches, altitude géopotentielle, pressions de base **dérivées** et non
  recopiées.
- `thermodynamics/waterVapour.ts` — Buck (1981), eau liquide et glace.
- `state/AtmosphereState.ts` — état 1D à profils remplaçables.

### Validation

| Contrôle | Résultat |
| --- | --- |
| T, P, ρ aux 8 altitudes de base vs tables US1976 | écart max **4,4·10⁻⁵** |
| Nombre de Loschmidt (juge extérieur) | 3,7·10⁻⁷ |
| Analytique vs intégration de Simpson indépendante | **< 10⁻¹³** |
| Continuité aux 6 interfaces de couches | < 3,2·10⁻⁷ |
| Monotonie P, ρ, N | ✓ |
| Non-monotonie de T (remontée stratosphérique) | ✓ |
| e_w(0/20/50 °C) vs valeurs connues | 1,6·10⁻⁵ à 4,4·10⁻⁴ |
| Aller-retour géométrique↔géopotentiel | < 1,5·10⁻¹¹ m |

### Enseignement pour la suite

La hauteur d'échelle réelle varie de **6 342 m** (tropopause) à **8 435 m**
(sol), parce qu'elle suit la température. Le moteur de rendu actuel la fige à
8 000 m. Ce n'est pas un détail : c'est le profil de densité que verra la
diffusion Rayleigh en phase 3.

### Points de moindre confiance signalés

- ⚠️ **Facteur d'accroissement de Buck** (`1,0007 + 3,46·10⁻⁶ P`) — +0,42 % au
  niveau de la mer, sans ancre publiée commode. À confronter à la publication
  **avant la phase 10**.
- ⚠️ **Profil d'humidité par défaut non physique** — constant avec l'altitude.
  Sans conséquence aujourd'hui, à remplacer **en phase 10**.
- ⚠️ **Offset thermique à pression inchangée** — approximation du second ordre,
  à revoir **en phase 14** quand les gradients deviennent violents.

---

## Phase 2 — Base spectrale · VALIDATED

### Livré

- `spectral/SpectralGrid.ts` — grille configurable, rééchantillonnage **par
  moyenne de bande**.
- `spectral/colourMatching.ts` — CIE 1931 2°, mémorisées par grille.
- `spectral/blackbody.ts` — Planck, Wien dérivée, B−V → température.
- `spectral/SolarSpectrum.ts` — irradiance AM0, loi en 1/d².
- `spectral/SpectralSensor.ts` — `L(λ) → XYZ → RGB linéaire`, luminance
  photométrique.
- `scripts/build-spectral.mjs` + `npm run data:spectral`.
- `src/data/cie1931.json`, `src/data/solar-am0.json` — **commitées**.

### Données : téléchargées, pas saisies

Sur le patron de `npm run data`. Aucune table de plusieurs centaines de lignes
n'a été recopiée : une valeur fausse au milieu d'une courbe de sensibilité ne se
voit sur aucune image mais décale toutes les couleurs du moteur.

| Donnée | Source | Licence |
| --- | --- | --- |
| CIE 1931 2°, 360–830 nm à 1 nm | `colour-science/colour` | BSD-3-Clause |
| ASTM G173-03 *extraterrestrial* (AM0) | `pvlib/pvlib-python` | BSD-3-Clause |

### Validation

| Contrôle | Résultat |
| --- | --- |
| **Illuminant E : dispersion de chromaticité entre 8 et 471 bandes** | **1,1·10⁻¹⁶** |
| Bouclage Planck(T) → XYZ → CCT, 3 000 à 6 500 K | ≤ 2,2·10⁻³ |
| Bouclage Planck à 5 772 K sur 8 bandes seulement | 2,1·10⁻³ |
| Matrices sRGB inverses l'une de l'autre | < 10⁻⁶ |
| Blanc sRGB → chromaticité D65 (0,3127 · 0,3290) | < 5·10⁻⁴ |
| Luminance à 555 nm = 683 cd/m² (définition de la candela) | 4,9·10⁻⁵ |
| ∫x̄, ∫ȳ, ∫z̄ vs valeurs publiées | ≤ 3,8·10⁻⁶ |
| Constante de Wien dérivée vs publiée | 6,4·10⁻¹¹ |
| Irradiance visible conservée au rééchantillonnage | < 7·10⁻¹⁶ |

### Le contrôle qui compte

**L'invariance à la résolution spectrale.** Un illuminant d'énergie égale rend
la même chromaticité à 8 bandes qu'à 471, à 10⁻¹⁶ près. C'est ce qui distingue
une intégration par bande correcte d'un prélèvement au centre — lequel passerait
tous les autres tests en apparence, tout en perdant de l'énergie d'une manière
qui dépend du nombre de bandes.

Sans cette propriété, le curseur « nombre de bandes » de la phase 19 changerait
les couleurs en même temps que la qualité, et aucune comparaison entre deux
résolutions n'aurait de sens.

### Le bouclage sans donnée externe

Un spectre de Planck à température T, passé dans toute la chaîne, ressort à une
température de couleur corrélée égale à T. Ce seul contrôle teste d'un coup le
chargement des fonctions colorimétriques, l'intégration par bande, la conversion
XYZ et la chromaticité — **sans dépendre d'aucune table extérieure**. Il tient
même à 8 bandes.

### Raccord chiffré avec l'existant, et cible pour la phase 3

| Grandeur | Moteur spectral | `astro/photometry.ts` |
| --- | --- | --- |
| Éclairement solaire, Soleil au zénith | **133,1 klx** hors atmosphère | 120 klx au sol |

Les 133,1 klx recoupent la littérature (127–136 klx). L'écart avec les 120 klx
au sol **est** l'extinction zénithale : la phase 3 devra retrouver une
transmission de **90,2 %** à partir du Rayleigh seul. Cible posée avant
d'écrire le code censé l'atteindre.

Autres valeurs obtenues, sans équivalent dans le rendu actuel : chromaticité du
Soleil hors atmosphère (0,3234 · 0,3326), température de couleur corrélée
**5 933 K** (température effective : 5 772 K — l'écart n'est pas une erreur, le
Soleil n'est pas un corps noir parfait), variation annuelle d'irradiance 6,9 %.

### Ce qui reste explicitement dehors

`SpectralSensor` **ne fait ni exposition ni tone mapping**. Il rend du RGB
linéaire non borné, composantes négatives comprises pour les couleurs hors
gamut. C'est la phase 0.5 qui décidera quoi en faire — le capteur mesure, il ne
juge pas.

### Point d'attention relevé

Un slip d'arithmétique de ma part sur un attendu de test (∫2x dx de 5 à 15) a
été attrapé par le harnais avant d'être commité. C'est le comportement voulu :
les attendus sont aussi faillibles que le code.

---

## Journal

| Date | Événement |
| --- | --- |
| 2026-08-25 | Audit d'intégration — verdict **GO WITH REFACTOR** |
| 2026-08-25 | Phases 0 et 1 — baseline GPU et sondes committées |
| 2026-08-25 | Phase 2 — base spectrale ; données CIE et solaires acquises ; **222 contrôles, aucun échec** |
