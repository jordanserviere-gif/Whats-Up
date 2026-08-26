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
| **0.5** | Passe d'affichage HDR linéaire | **VALIDATED** | 11 matériaux portés · nuit identique au bit près |
| **2** | Base spectrale (`SpectralGrid`, `SolarSpectrum`, `SpectralSensor`) | **VALIDATED** | données acquises et commitées ; invariance à la résolution vérifiée |
| **3** | Rayleigh physique | **VALIDATED** | τ_R(550) = 0,09711 · cible de la phase 2 atteinte à 0,7 % |
| **4** | Soleil direct + extinction | **VALIDATED** | 3 paliers de `photometry.ts` retrouvés à < 2 % |
| **5** | Single scattering | **VALIDATED** | déficit comblé (−4 % à 5°) · solveur de référence, pas encore au rendu |
| **6** | Aérosols + Mie | **TODO** | cible : retirer une part du dépassement de +5 à +35 % |
| **7** | Absorption atmosphérique | **TODO** | cible : crépuscule ×2,8 trop clair et zénith pas assez bleu |
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
| 1440×900 @ dpr 2 | **~4,9 ms** | **~30 %** |
| 1920×1080 @ dpr 2 | ~7,9 ms | ~47 % |

**0,95 ns/pixel ±7 %**, limité par le remplissage.

> Chiffre corrigé le 26 août 2026. La première mesure annonçait 1,53 ns/px :
> le banc tournait dans l'onglet de l'application et chauffait trop peu. Voir
> la phase 4 pour la méthode.

### Défauts chiffrés par les sondes

- **Le crépuscule est mort.** À −5,9° de hauteur solaire, toutes les directions
  rendent ≈ `4,6,13` — c'est le socle nocturne peint, pas de la physique.
- **La nuit est entièrement peinte** : `3,4,10` identique dans toutes les
  directions.
- **Saturation à l'horizon** : `254,250,241` — écrêtage du tone mapping matériau.
- **Horizon anti-solaire au coucher** : `91,27,18`, rouge saturé du côté opposé
  au Soleil. À confronter à la diffusion multiple.

---

## Phase 0.5 — Passe d'affichage HDR linéaire · VALIDATED

Refactor de plomberie, sans nouvelle physique. C'était le blocage structurel
identifié par l'audit : le tone mapping vivait *à l'intérieur* de chaque
matériau et écrêtait à [0,1], donc aucune grandeur physique ne survivait au
fragment shader.

### Livré

- `scene/display/tonemap.ts` — le transform d'affichage et son inverse, en TS et
  en GLSL, source unique.
- `scene/display/DisplayEffect.tsx` — la passe, via `wrapEffect`.
- **11 matériaux portés en radiance linéaire** : fond de ciel, corps, disque
  solaire, halo, réticule, anneaux de Saturne, avions, traînées, sol, étoiles,
  ciel profond, satellites, grilles, figures de constellations.
- Chaîne de rendu : composeur **inconditionnel** en `HalfFloatType`, bloom
  optionnel à l'intérieur, passe d'affichage en dernier.

### La cale de transition

Les matériaux pas encore physiques gardent des couleurs d'affichage héritées.
`radianceFromDisplay()` les remonte en radiance, exactement, de sorte que la
passe les restitue à l'identique. **Ce n'est pas un réglage : c'est une cale
calculée, et chaque phase supprime la sienne** — le Soleil en 4, le ciel en 5,
le sol en 9, l'airglow en 11.

Le sur-éclat du Soleil suit la même logique : la valeur brute 6 signifiait « six
fois le blanc » dans un espace où le blanc valait 1. En linéaire, cela se dit
`6 × RADIANCE_AT_DISPLAY_WHITE`. La traduction préserve le sens de la constante
au lieu de la deviner.

### Mesures

| Régime | Dérive |
| --- | --- |
| Nuit, crépuscule nautique | **zéro** — identique au pixel près |
| Ciel de jour | +3 à +7 niveaux, plus clair |
| Horizon au coucher, canal bleu | 18 niveaux, tombe à 0 |
| Disque solaire | 255,255,255 — inchangé |
| Coût GPU du noyau | inchangé (voir la note de méthode en phase 4) |

**La nuit identique au bit près** est la vérification qui compte : là où la
diffusion est nulle, la cale restitue exactement l'original. L'inverse est donc
juste.

**Le jour plus clair est plus correct** : le socle nocturne est désormais
additionné *en radiance* avant la courbe, au lieu d'être plaqué sur une valeur
déjà compressée.

### Artefact mis à nu, pas introduit

Au coucher, le canal bleu de l'horizon tombe à 0. La cause est la
**re-saturation ×1,4** : sur un orange très saturé elle pousse le bleu en
négatif, et l'écrêtage le ramène à zéro. Le socle nocturne, ajouté après coup
dans l'ancienne chaîne, masquait le phénomène. `DISPLAY_SATURATION` est un
facteur cosmétique déjà signalé comme tel ; il disparaîtra quand la physique
pourra le remplacer.

### Erreur de méthode corrigée

Le banc GPU tournait **dans l'onglet de l'application** et mesurait donc le
noyau *plus* la charge de la scène. Le chiffre est monté à 2,74 ns/px alors que
le GLSL mesuré n'avait pas changé d'un caractère. Le banc s'exécute désormais
dans une page vierge servie par Vite. Un second défaut — une chauffe trop
courte — a été trouvé et corrigé en phase 4.

### Décision : pas de feature flag

La phase 0 le proposait, et je l'avais différé ici. Il n'a finalement pas été
introduit : le conserver aurait imposé deux variantes de chaque nuanceur, pour
un chemin destiné à disparaître. **La référence de comparaison existe déjà** —
les sondes committées et l'historique git — et c'est elle qui a servi à mesurer
la dérive. Un flag n'aurait rien ajouté qu'un doublement de la surface de code.

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

## Phase 3 — Rayleigh physique · VALIDATED

### Livré

- `rayleigh/standardAir.ts` — indice de Peck & Reeder (1972), facteur de King et
  dépolarisation par composition (Bodhaine 1999).
- `rayleigh/rayleigh.ts` — section efficace, coefficient de diffusion, fonction
  de phase dépolarisée, colonne moléculaire, épaisseur optique, transmittance
  spectrale.

### Résultats

| Grandeur | Obtenue | Référence |
| --- | --- | --- |
| n(550 nm) − 1 | 2,7782·10⁻⁴ | 2,7782·10⁻⁴ |
| Facteur de King F(550) | 1,0488 | ~1,0484 |
| Dépolarisation ρ(550) | 0,02832 | 0,027–0,030 |
| σ(550 nm) | 4,510·10⁻³¹ m² | — |
| **τ_R(550 nm), niveau de la mer** | **0,09711** | **0,0973** (Bodhaine) |
| β(550 nm), niveau de la mer | 1,149·10⁻⁵ m⁻¹ | — |
| Exposant spectral effectif | 4,095 | ~4,09 |

### La cible de la phase 2 est atteinte

| Chemin | Éclairement, Soleil au zénith |
| --- | --- |
| Spectre ASTM G173 → CMF CIE → luminance | **133,1 klx** hors atmosphère |
| … × transmittance Rayleigh | **120,9 klx** au sol |
| `astro/photometry.ts` | **120 klx** au sol |

**0,7 % d'écart entre deux chaînes qui ne partagent aucune ligne de code.**
Transmission obtenue 90,81 % (photopique) contre 90,2 % visés — cible écrite
avant l'existence du module.

L'écart résiduel est attendu et a un nom : il manque l'ozone (phase 7) et les
aérosols (phase 6). Le Rayleigh seul devait transmettre *un peu plus* que la
réalité.

### Contrôles sans référence externe

- Fonction de phase normalisée sur la sphère : écart 10⁻¹⁵ (forme idéalisée
  **et** forme dépolarisée).
- Colonne moléculaire vs équilibre hydrostatique `P₀·N_A/(M·g₀)` : 2,3·10⁻³ —
  **recoupement direct entre les phases 1 et 3**.
- `β ∝ N(z)` exactement (10⁻¹²) : la section efficace ne dépend pas de
  l'altitude, sous peine de compter deux fois la densité.
- τ au Pic du Midi proportionnel au rapport de pression : 7,9·10⁻⁴.

### Émergence obtenue

À masse d'air 38, la transmittance vaut **0,00 % dans le bleu et 46,7 % dans le
rouge**. Le rougissement du Soleil couchant sort de Beer-Lambert appliqué à une
section efficace en λ⁻⁴·⁰⁹⁵ — aucune couleur n'est écrite nulle part.

De même, `σ(450)/σ(650) = 4,50` : le ciel bleu, sans qu'aucun bleu n'apparaisse
dans le code.

### Correction apportée à l'audit

L'audit annonçait `β_R(550 nm) ≈ 1,35·10⁻⁵ m⁻¹` comme valeur de référence. Le
calcul depuis Bodhaine donne **1,149·10⁻⁵**. La valeur de l'audit était erronée,
vraisemblablement contaminée par la constante de rendu `13,0·10⁻⁶` du shader
actuel. `docs/atmosphere-engine-audit.md` est corrigé.

### Ce que cela dit du rendu actuel

Le shader code `[5,5 · 13,0 · 22,4]·10⁻⁶ m⁻¹` en dur. La valeur physique pour le
vert est 1,149·10⁻⁵ : **le rendu surestime la diffusion moléculaire d'environ
13 %**, et ne la fait dépendre ni de la composition, ni de l'altitude de
l'observateur, ni de l'état de l'atmosphère.

---

## Phase 4 — Soleil direct + extinction · VALIDATED

### Livré

- `transport/slantPath.ts` — colonne moléculaire en géométrie sphérique, sans
  approximation plan-parallèle.
- `transport/directSolar.ts` — Beer-Lambert spectral, XYZ, sRGB, éclairement.
- `scene/Bodies.tsx` — le disque solaire prend teinte **et** éclat de la
  physique ; `extinctionTint()` et le facteur `0,5` arbitraire disparaissent
  pour le Soleil.
- `scene/SkyCanvas.tsx` — calcul quantifié au vingtième de degré (le Soleil
  parcourt 15°/h, soit 1/20° en douze secondes).

### Les paliers de photometry.ts, par un chemin indépendant

| Hauteur | Publié | Calculé | Écart |
| --- | --- | --- | --- |
| 90° | 120 000 lx | 120,9 klx | 0,7 % |
| 45° | 82 000 lx | 82,2 klx | 0,2 % |
| 20° | 34 000 lx | 34,5 klx | 1,5 % |
| 10° | 15 000 lx | 13,7 klx | −9 % |
| 5° | 8 000 lx | 4,5 klx | −44 % |

**Le déficit à basse hauteur est attendu et mesure ce qui manque** : ce module
ne calcule que le direct, et à Soleil bas le ciel diffus domine. C'est la cible
chiffrée de la phase 5.

### Masse d'air vs Pickering

Écart de 2·10⁻⁷ à 90°, 4·10⁻⁴ à 20°, 3·10⁻³ à 10°. À l'horizon : 35,18 contre
38,75 — **écart physique**, Pickering étant ajusté sur une atmosphère réfractée.
Devrait se refermer en phase 11.

### Émergence

CCT de 5 353 K au zénith à 2 322 K à 2°. Transmittance à l'horizon : 0,00 % dans
le bleu, 46,7 % dans le rouge. Aucune couleur écrite nulle part.

### Limite connue

Le disque rasant rend `255,255,164` : le bleu est retiré, mais R et V restent
écrêtés faute de modèle d'adaptation à l'exposition. Le disque lit jaune-blanc
plutôt qu'orange. À traiter avec la mise à l'échelle radiométrique commune
Soleil/ciel de la phase 5.

### Correction majeure : le banc GPU

Un second défaut du banc a été trouvé — après celui de la phase 0.5. Même
isolé, il rendait 0,95 · 0,96 · 1,37 ns/px sur trois exécutions du **même
code**. Cause : quatre passes de chauffe seulement, quand un GPU au repos met
des centaines de millisecondes à quitter ses fréquences d'attente.

Le banc chauffe désormais 400 ms, calibre son nombre de passes, prend la
médiane de neuf échantillons et **rend sa dispersion avec sa mesure**.

**Conséquence : tous les chiffres de performance publiés jusqu'ici étaient
surestimés d'environ 90 %.**

| | Publié | Corrigé |
| --- | --- | --- |
| Coût du noyau | 1,53–1,83 ns/px | **0,95 ns/px ±7 %** |
| Voûte à dpr 2 | 7,9–9,5 ms | **~4,9 ms** |
| Part d'une image à 60 Hz | 48–57 % | **~30 %** |

`docs/atmosphere-engine-audit.md` est corrigé, avec l'erreur documentée plutôt
qu'effacée. Le raisonnement sur le budget tient ; son échelle change.

---

## Phase 5 — Single scattering · VALIDATED

### Livré

- `transport/singleScattering.ts` — radiance du ciel, éclairement diffus
  hémisphérique, colonne vers l'espace avec test d'ombre terrestre.

### La cible de la phase 4 est atteinte

Direct 4,50 klx + diffus 3,15 klx = **7,65 klx** à 5°, contre 8,0 publiés. Le
déficit de 44 % était bien le ciel.

### Le bilan, et le signe de l'écart

| Hauteur | Calculé | Publié | Écart |
| --- | --- | --- | --- |
| 90° | 125,9 klx | 120,0 | **+5 %** |
| 45° | 87,0 klx | 82,0 | **+6 %** |
| 20° | 39,0 klx | 34,0 | +15 % |
| 10° | 17,6 klx | 13,0 | +35 % |
| 5° | 7,6 klx | 8,0 | −4 % |

Le dépassement croît avec la longueur du trajet : c'est la signature d'une
**extinction manquante**. Cible chiffrée des phases 6 et 7. Un accord parfait
aurait signalé deux erreurs qui se compensent.

**Requalification de la phase 4** : elle comparait un éclairement *direct* à des
paliers *globaux*. Son excellent accord masquait un direct trop fort.

### Émergences

| Structure | Mesure |
| --- | --- |
| Zénith bleu | (0,243 · 0,251) · B/R = 3,33 |
| Blanchiment vers l'horizon | (0,244 · 0,253) → (0,308 · 0,336) |
| Gradient | 1 013 → 5 923 cd/m² |
| Minimum à 90° du Soleil | 3 207 · **1 905** · 2 110 cd/m² |
| Arche crépusculaire (−4°) | 355 · 9,0 · **0,00** cd/m² |
| Ombre de la Terre | zéro exact à l'horizon anti-solaire |

Aucune n'est écrite. Toutes sortent de la géométrie, de λ⁻⁴·¹ et du test
d'ombre.

### Le crépuscule trop clair, et son diagnostic

×2,1 à 0°, ×3,0 à −2°, ×2,8 à −4°. Deux manques agissent en sens contraire :
la diffusion multiple *ajouterait* de la lumière, l'ozone en *retirerait*. Le
signe dit que **l'absorption domine** — ce qui recoupe Hulburt (1953) : le bleu
du ciel crépusculaire vient de la bande de Chappuis. Le modèle le confirme par
défaut, son zénith crépusculaire étant quasi blanc.

Réserve : les paliers sont interpolés en logarithme et le modèle n'a pas de
réfraction. Seuls l'ordre de grandeur et le signe sont exploitables.

### Non fait, et pourquoi

**Le solveur n'est pas branché au rendu.** Le chemin passe par une LUT de
transmittance 2D (altitude, cosinus zénithal) remplaçant l'intégration du rayon
secondaire.

> ⚠️ **Chiffres corrigés.** Cette section annonçait 5,5 ms par direction et une
> LUT de ciel à onze secondes. Les deux étaient faux — la mesure avait été
> prise sur le premier appel, donc dominée par la compilation JIT. Les valeurs
> réelles sont 0,25 ms par direction, et 34 ms pour une LUT de ciel 64×32. Voir
> l'étape « table de colonne ».

Le rendu continue d'afficher `glsl-atmosphere` en attendant.

---

## Infrastructure — table de colonne moléculaire · VALIDATED

Première LUT du moteur. Elle remplace le poste dominant du solveur de
diffusion simple : l'intégration du rayon secondaire vers le Soleil, refaite à
chaque pas du rayon primaire.

### Un seul canal suffit, et c'est une propriété du modèle

Bruneton stocke une transmittance à trois composantes. Ce n'est pas nécessaire
ici :

```
T(λ) = exp(−σ(λ)·C)
```

Tant que **Rayleigh est la seule espèce**, la colonne `C` ne compte que des
molécules : elle ne dépend pas de λ et se factorise hors du spectre. Un seul
canal porte donc toute l'information, et **le nombre de bandes reste libre** au
lieu d'être figé à trois par le format de la texture.

> Cette factorisation **cessera** avec l'ozone et les aérosols, dont les profils
> verticaux diffèrent. Il faudra alors un canal par espèce — ce que le format
> permet sans toucher à la paramétrisation.

### Mesures

| Grandeur | Valeur |
| --- | --- |
| Table | 256 × 64, un canal, **64 ko** |
| Construction | **85 ms**, une seule fois |
| Erreur max sur la transmittance | **0,082 %** |
| Écart sur la radiance de ciel | ≤ 2,9·10⁻⁴ |
| Coût par direction | 0,25 → **0,067 ms** (×4) |
| Hémisphère 16×32 | 110 → **15 ms** |
| **LUT de ciel 64×32** | **34 ms** |

**L'erreur est dominée par l'interpolation, pas par l'intégration.** Passer de
128 à 512 pas par entrée laisse l'erreur inchangée à 0,086 % pour trois fois le
temps de construction ; doubler la résolution de la table la divise par trois.
Le choix — 128 pas — sort de cette mesure, pas de l'habitude.

### Le test d'ombre reste hors de la table

Les rayons qui rencontrent la Terre ont une colonne infinie, et la table n'en
dit rien. C'est délibéré : ce test produit **l'ombre de la Terre**, et
l'interpoler la rendrait floue.

### Une non-injectivité, et pourquoi elle est inoffensive

Au sommet exact de l'atmosphère, toute visée montante donne `d = 0` — le rayon
est déjà dehors — et tous les `µ` positifs s'y projettent sur `u = 0`. La
direction n'y est pas récupérable. Le test d'aller-retour l'a signalé, et
l'examen a montré que c'est une propriété de la paramétrisation, pas un défaut :
la colonne y vaut zéro pour chacune de ces directions. Le contrôle le vérifie
explicitement plutôt que d'élargir une tolérance.

### Correction de chiffres

Les « 5,5 ms par direction » et les « onze secondes pour une LUT de ciel »
publiés en phase 5 étaient faux : mesurés sur le **premier appel**, donc dominés
par la compilation JIT. Les valeurs réelles sont 0,25 ms et 34 ms — deux ordres
de grandeur plus bas. Le chemin vers un ciel physique à l'écran est par
conséquent bien plus court que je ne l'avais écrit.

---

## Journal

| Date | Événement |
| --- | --- |
| 2026-08-25 | Audit d'intégration — verdict **GO WITH REFACTOR** |
| 2026-08-25 | Phases 0 et 1 — baseline GPU et sondes committées |
| 2026-08-25 | Phase 2 — base spectrale ; données CIE et solaires acquises ; **222 contrôles, aucun échec** |
| 2026-08-25 | Phase 3 — Rayleigh ; cible de la phase 2 atteinte à 0,7 % ; **249 contrôles, aucun échec** |
| 2026-08-26 | Phase 0.5 — chaîne HDR linéaire ; 11 matériaux portés ; nuit identique au bit près ; **268 contrôles** |
| 2026-08-26 | Phase 4 — Soleil direct ; paliers de photometry.ts retrouvés à < 2 % ; banc GPU corrigé (−90 % sur les chiffres publiés) ; **305 contrôles** |
| 2026-08-26 | Phase 5 — diffusion simple ; déficit de 44 % comblé ; ciel bleu, arche crépusculaire et ombre terrestre émergents ; **329 contrôles** |
| 2026-08-26 | Table de colonne moléculaire ; solveur ×4 ; LUT de ciel ramenée à 34 ms ; chiffres de la phase 5 corrigés ; **359 contrôles** |
