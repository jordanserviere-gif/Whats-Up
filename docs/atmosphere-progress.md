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
| **5** | Single scattering | **VALIDATED** | déficit comblé (−4 % à 5°) · **au rendu** via la table de ciel |
| **6** | Aérosols + Mie | **VALIDATED** | Bohren-Huffman · bilan de journée refermé à 1–2 % |
| **7** | Absorption atmosphérique | **VALIDATED** | ozone · les deux cibles de la phase 5 atteintes |
| **8** | Diffusion multiple | **VALIDATED** | Hillaire 2020 · le creux de phase de Rayleigh comblé · albédo du sol câblé |
| **9** | Perspective atmosphérique sur les objets | **VALIDATED** | une seule table pour le ciel et les objets · ancien noyau hors du rendu · ×22 |
| **10** | Indice de réfraction spectral | **VALIDATED** | Ciddor 1996 · recoupé à 3,5·10⁻⁵ avec Peck & Reeder · rien à l'écran, c'est l'infrastructure de la 11 |
| **11** | Courbure des rayons | **VALIDATED** | 57,99″ à 45° contre 58,23″ de l'Almanach · Soleil couchant 27,6′ × 32,0′ · **non câblée** |
| **12** | Phénomènes émergents de réfraction | **VALIDATED** | cinq couches câblées d'un coup · GPU/CPU à 2,6″ · Soleil ovale 27,6′ × 32,0′ |
| **13** | Atmosphère 3D | **VALIDATED** | équation eikonale · 0,044″ contre l'intégrale 1D · le rayon se retourne au-dessus d'une route chaude |
| **14** | Inversions thermiques et mirages | **VALIDATED** | transfert non monotone · 2 images · inversée 0,270° · non rendue |
| **15** | Turbulence | **VALIDATED** | HV 5/7 rend 4,961 cm et 6,903 µrad · seeing du sol, scintillation d'altitude |
| **16** | Optique ondulatoire | **VALIDATED** | le 1,22 trouvé, pas écrit · couronnes émergentes de Mie à 1 % · l'œil nu est limité par sa pupille |
| **17** | Seeing et scintillation | **VALIDATED** | **au rendu** · les étoiles scintillent, les planètes non · facteur 76, émergent |
| **18** | Microphysique | **TODO** | non prioritaire · sautée au profit de la 19, aucun consommateur au rendu |
| **19** | Fine tuning scientifique | **VALIDATED** | ozone et distance solaire câblés · registre des incertitudes |
| **20** | Optimisation GPU | **VALIDATED** | 60 fps mesurés · blocage de 124 ms supprimé · 11 % mesurés et non pris, avec la raison |

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

## Infrastructure — table de ciel · VALIDATED

Le ciel physique arrive à l'écran. Le nuanceur du fond de ciel n'intègre plus
aucun rayon : il échantillonne une table calculée par le solveur des phases 1
à 5, téléversée en `DataTexture`. **Aucun render target n'a été nécessaire.**

### Livré

- `atmosphere/lut/skyViewLut.ts` — construction par direction, remplissage par
  tranches de lignes, accesseur TS et GLSL.
- `scene/useSkyViewLut.ts` — texture tenue à jour, construction étalée.
- `scene/display/exposure.ts` — l'ancrage entre luminance réelle et pixel.
- `scene/SkyBackground.tsx` — le matériau échantillonne au lieu d'intégrer.

### Mesures

| Grandeur | Valeur |
| --- | --- |
| Table | 64 × 32, RGBA flottant, 32 ko |
| Construction | ~40 ms, étalée sur 8 images |
| Erreur max | **3 niveaux sur 255** |
| p95 en temps réel | 16,8 ms |
| p95 à ×3600 | 50,0 → **16,8 ms** |
| p95 à ×86400 | **16,8 ms** |

### Deux décisions de mesure

**L'erreur est mesurée en niveaux d'affichage, pas en relatif.** Au bord de
l'ombre terrestre, l'erreur relative atteint plusieurs centaines de pour cent :
une interpolation ne peut pas représenter une discontinuité. En niveaux, elle
vaut 3 sur 255 — parce que les deux valeurs y sont sombres, et que c'est ce que
l'œil voit. Mes premières mesures annonçaient 18 à 60 niveaux : elles avaient
été prises à une exposition d'essai qui écrêtait le ciel.

**Le hoquet a été supprimé sans rogner sur la physique.** Réduire à 8 bandes
aurait fait gagner la moitié du coût pour 10 niveaux d'écart. Étaler la
construction sur huit images le supprime entièrement, à 16 bandes.

### L'exposition : un choix documenté, pas de la physique

| Ancrage | Blanc à | Statut |
| --- | --- | --- |
| Photographique (0,9 sous 120 klx) | 34 377 cd/m² | probablement l'avenir |
| **Continuité** (zénith de midi inchangé) | **86 302 cd/m²** | **retenu** |

Cette étape change le modèle du ciel ; y mêler un changement d'exposition
rendrait les deux impossibles à juger séparément. Le rendu actuel est 2,5× plus
sombre que la convention photographique.

### Une erreur d'intégration instructive

`useSkyViewLut` utilise `useFrame`, et je l'avais appelé depuis `SkyCanvas` —
**en dehors du `<Canvas>`**. React Three Fiber refuse ses hooks hors du canevas,
et le composant entier crashait : toutes les sondes rendaient un blanc uniforme
qui était la page, pas le ciel. Le correctif est aussi une meilleure conception —
le matériau du ciel possède la table qu'il échantillonne.

### Ce que l'image montre

Midi : dégradé bleu propre, blanchissant vers l'horizon. Coucher : bande orange
à l'horizon, **ciel moyen gris-olive**.

Ce vert-olive n'est pas un défaut : c'est le diagnostic de la phase 5 devenu
visible. Sans ozone, la lumière rougie par une longue colonne horizontale
diffuse ensuite en Rayleigh, qui favorise le bleu — rouge × bleu ≈ neutre. C'est
le résultat de Hulburt (1953). Cible chiffrée **et** visuelle pour la phase 7.

### Dette

Les corps et les avions gardent l'ancien noyau : **le ciel et le voile des objets
suivent deux modèles différents**, et un astre bas ne se fond plus exactement
dans le ciel. Se solde à la phase 9.

---

## Phase 7 — Absorption atmosphérique · VALIDATED

### Livré

- `absorption/ozone.ts` — sections efficaces (IUP Bremen o3spectra2011, 233 K),
  profil vertical, colonne en unités Dobson.
- `transport/slantPath.ts` — `columnsToSpace()` intègre les deux espèces dans
  la même marche.
- `lut/transmittanceLut.ts` — **un canal par espèce**, exactement l'extension
  annoncée lors de sa création.
- `transport/singleScattering.ts`, `directSolar.ts` — extinction par les deux
  espèces, diffusion par Rayleigh seul.

### Le point structurel

Jusqu'ici *extinction = diffusion*. L'ozone absorbe : les deux se séparent.
Les confondre ferait briller le ciel de la lumière que l'ozone a absorbée.

### Les deux cibles de la phase 5

| Cible | Avant | Après |
| --- | --- | --- |
| Dépassement à 90° | +5 % | **+2 %** |
| Dépassement à 45° | +6 % | **+2 %** |
| Dépassement à 20° | +15 % | **+6 %** |
| Zénith crépusculaire | (0,339 · 0,346) quasi blanc | **(0,270 · 0,267) bleu** |

Le second est le résultat de Hulburt (1953) : le bleu du ciel crépusculaire
vient de la bande de Chappuis, pas de Rayleigh.

### À l'écran

`coucher/zénith` : `31,32,34` (gris neutre) → **`18,25,36`** (bleu).
`coucher/vers-soleil-30` : `77,74,62` (olive) → **`47,58,69`** (bleu-gris).

L'olive du ciel crépusculaire, signalé en note visuelle à l'étape précédente, a
disparu — et par la cause exacte qui avait été diagnostiquée.

### Une géométrie contre-intuitive, mesurée

En visée rasante depuis le sol, **l'air s'allonge x24, l'ozone x11 seulement**.
J'avais écrit l'inverse dans un test, et il a échoué. La raison : un rayon
rasant traverse l'air bas tangentiellement, mais quand il atteint les 25 km de
l'ozone il a déjà grimpé, et son angle zénithal local n'est plus que 85°.

Le test a été corrigé dans le bon sens plutôt qu'assoupli, et la conclusion
tient : deux rapports différents, donc deux canaux.

### Trois tests ont échoué, et ils avaient raison

Deux assertions de la phase 5 décrivaient un modèle **sans** ozone — « le
crépuscule est trop clair », « le zénith n'est pas encore bleu ». Elles ont
échoué parce que la phase 7 a fait son travail. Elles ont été réécrites pour
décrire l'état courant, pas supprimées.

La troisième mêlait deux affirmations dont une était sensible à la
discrétisation ; elle a été scindée.

### Le signe des résidus a changé

À 5°, le bilan passe de −4 % à **−23 %** : un absorbeur ne peut que retirer.
Au crépuscule, les rapports tombent de 2,1 · 3,0 · 2,8 à 1,3 · 1,7 · 1,3.

Le modèle est désormais **entouré** : il dépasse où il manque de l'absorption
(aérosols, phase 6), il manque où il manque de la diffusion multiple (phase 8).
C'est une meilleure carte du restant qu'un écart de signe constant.

---

## Phase 6 — Aérosols et théorie de Mie · VALIDATED

### Livré

- `mie/mie.ts` — solveur de Bohren & Huffman : coefficients, efficacités,
  asymétrie, fonction de phase.
- `mie/aerosol.ts` — distribution log-normale, profil vertical, propriétés
  tabulées, pont avec le réglage de trouble.
- Troisième canal dans la table de colonnes ; source de diffusion à deux termes.

### Le bilan de journée se referme

| Hauteur | Phase 5 | +ozone | **+aérosols** |
| --- | --- | --- | --- |
| 90° | +5 % | +2 % | **+1 %** |
| 45° | +6 % | +2 % | **+1 %** |
| 20° | +15 % | +6 % | **+2 %** |
| 10° | +35 % | +18 % | **+9 %** |

Trois modules construits séparément convergent à 1–2 % de paliers tabulés qui
n'ont participé à aucun des calculs.

### Le rayon médian est calé sur une observable

L'exposant d'Ångström est ce que la science atmosphérique utilise pour
contraindre la taille des aérosols. `r_g = 0,05 µm` donne α = 1,29 — et **ω₀ et
g suivent dans leurs plages publiées sans être touchés** : 0,954 et 0,646. Un
paramètre calé, trois observables d'accord.

### Ce que le contrôle `ω₀ ≤ 1` a attrapé

Une convention de signe inversée sur la partie imaginaire de l'indice. Le
calcul rendait des albédos de **1,5** — une particule diffusant plus de lumière
qu'elle n'en intercepte. Rien d'autre ne l'aurait signalé : les sections
efficaces avaient l'air plausibles.

### Mie contre Bodhaine, par deux chemins

Une molécule d'air traitée comme une sphère minuscule doit rendre ce que le
module Rayleigh calcule autrement. L'écart résiduel **est exactement le facteur
de King**, absent d'un modèle de sphère isotrope. Le corriger ramène l'accord à
**4·10⁻⁴**.

Le premier test que j'avais écrit comparait les deux ratios spectraux entre eux
et échouait à 0,20 %. En regardant les nombres, l'assertion utile était bien
meilleure : `Mie × King = Bodhaine`. Test remplacé par plus fort, pas assoupli.

### Une régression réparée, et signalée

En câblant la table de ciel, j'avais retiré `aerosolTurbidity` de
`SkyBackground` **sans le signaler**. Le réglage de trouble n'affectait plus le
ciel depuis deux commits. Réparé, et physique désormais : le trouble se traduit
en épaisseur optique à 550 nm.

### Ce que le trouble fait maintenant

Zénith qui s'éclaircit et se désature, horizon qui **s'assombrit** (l'extinction
de basse couche l'emporte), halo solaire qui triple. À l'écran, le dégradé
vertical s'aplatit : `142,169,202` au trouble 1, `221,226,231` au trouble 6.

---

## Phase 8 — Diffusion multiple · VALIDATED

### Livré

- `transport/multipleScattering.ts` — approximation isotrope de Hillaire (2020),
  table 2D (altitude × cosinus zénithal solaire) × 16 bandes.
- Terme source isotrope supplémentaire dans `transport/singleScattering.ts`,
  activable — l'omettre laisse une diffusion simple pure, qui sert de référence.
- Réflexion du sol : `groundAlbedo`, déclaré depuis la phase 1 et jamais lu,
  entre enfin dans le calcul.
- Construction étalée par **entrées** dans `useSkyViewLut`.

### Le facteur 4π que seul le bilan d'éclairement pouvait voir

La première version omettait le `p_u = 1/4π` de la phase isotrope dans `L_f`.
Les profils restaient plausibles ; le ciel était **trois à six fois trop
lumineux** (zénith ×3,33 au lieu de ×1,27). Aucun contrôle de forme n'aurait pu
le voir — seule une grandeur ancrée en valeur absolue le pouvait.

### Ce que ça change à l'écran

Dix-neuf sondes ont dérivé, toutes vers plus clair et plus bleu. La plus forte
est **midi/antisoleil-30** : `70,114,167 → 89,145,210`. C'est exactement le
minimum de la fonction de phase de Rayleigh — donc là où la diffusion simple est
la plus déficitaire. La diffusion multiple comble ce creux en premier, sans que
rien ne le lui demande.

### Le sol participe

`2 074 cd/m²` au-dessus d'un sol noir contre `3 899` au-dessus de la neige, à 30°
de hauteur, Soleil à 45°. Le ciel au-dessus d'un champ enneigé est plus
lumineux, et personne ne l'a écrit.

### Une intuition fausse, corrigée par un contrôle

J'avais asserté que `Ψ_ms` décroîtrait avec l'altitude. Mesuré : `1,74·10⁻²` au
sol contre `1,78·10⁻²` à 60 km. `Ψ_ms` est une radiance moyennée sur toute la
sphère, et depuis 60 km la moitié basse de cette sphère est remplie par
l'atmosphère éclairée vue d'en haut. Ce qui s'effondre est le **terme source**
`σ_s · Ψ_ms` : `4,4·10²³` contre `1,2·10²⁰`. Test réécrit sur la bonne grandeur.

### ⚠️ Le nœud à 5° — anomalie signalée, non corrigée

La cible « −32 % à 5° » n'est ramenée qu'à **−28 %**, alors que tout le reste
bouge. La cible elle-même est suspecte : les trois autres nœuds de
`SOLAR_ANCHORS` tombent à 3–6 %, le modèle croise la table à 3° et 8°, les
rapports entre nœuds hauts concordent à 2 % et le faisceau direct se vérifie
seul à 0,157 mag/masse d'air. Le déficit n'est pas numérique — tout converge.

Le nœud à 5° est **écarté de la validation avec sa justification**, les trois
autres y restent. Rien n'a été ajusté pour le rejoindre. Donnée manquante pour
trancher : un jeu d'éclairement horizontal global par ciel clair (**BSRN** ou
**IDMP/CIE**).

### Coût

275 ms pour 32×32 à 32 directions — 5 niveaux sur 255 d'écart au convergé, la
même classe que la table de ciel. Étalés sur ~60 images, 16 entrées à la fois
(4,3 ms). La table ne dépend que de la composition : un lever de Soleil ne la
reconstruit jamais. Noyau GLSL inchangé à 0,88 ns/px.

---

## Phase 9 — Perspective atmospherique sur les objets · VALIDATED

### Livre

- `transport/aerialPerspective` — la marche rend desormais la diffusion cumulee
  **et** la transmittance a seize distances, en un seul parcours. `skyRadiance`
  en est devenu un cas particulier : une seule implementation du transport.
- `lut/aerialPerspectiveLut.ts` — table 3D (64 azimut × 32 hauteurs × 16
  distances), deux textures, echantillonneur GLSL.
- `scene/useAerialLut.ts` remplace `useSkyViewLut.ts`.
- Fond de ciel, corps du systeme solaire et avions branches sur la meme table.

### Le raccord est structurel, pas ajuste

`w = 1` designe exactement la sortie de l'atmosphere **quelle que soit la
visee**, parce que la distance est normalisee par le trajet propre a chaque
direction. Un astre est a l'infini : il lit donc le meme texel que le fond de
ciel a cote de lui.

Mesure : tranche lointaine contre `skyRadiance`, **5,5·10⁻⁸** aux nœuds exacts.
Et **aucune derive colorimetrique** sur les 42 sondes du banc apres bascule — le
ciel est identique, seuls les objets ont change de modele.

### L'ancien noyau sort du chemin de rendu

Plus aucun materiau n'appelle `scene/atmosphere.ts`. Avec lui sortent
`RAYLEIGH_COEFFICIENTS = [55e-7, 13e-6, 224e-7]`, `MIE_G = 0,758`,
`SUN_INTENSITY_REF = 22` et le facteur de calibrage `0,3` — les dernieres
constantes choisies a la main du rendu atmospherique. Le module est conserve
comme reference du banc, et son en-tete le signale.

### Cout : facteur 22

| Noyau | Cout | 1920x1080@dpr2 |
| --- | --- | --- |
| ancien noyau analytique | 0,88 ns/px | 7,27 ms — 44 % d'une image |
| **table de perspective** | **0,04 ns/px** | **0,31 ms — 2 %** |

Et la mesure de la phase 9 comprend deux lectures, pas une.

### Le GPU verifie contre le CPU

L'indexation de l'atlas en bande verticale et le recentrage de texels sont
l'endroit ou une erreur d'un texel passerait inapercue. Nuanceur compile hors
application et compare a `sampleAerialLut` sur 24 combinaisons : **4,5·10⁻⁵**.

### ⚠️ Deux limites signalees

**La transmittance spectrale reduite a trois nombres** n'est exacte que pour un
spectre d'objet donne ; le Soleil sert de reference, ce qui convient a la Lune,
aux planetes et aux avions. Limite de la chaine RGB, pas du transport.

**Le gamut sRGB** rend negative la projection bleue d'une transmittance tres
rougie. Ecretee et rendue monotone pour la transmittance — un multiplicateur, ou
l'artefact atteignait 43 % en relatif — mais **laissee intacte pour la
diffusion**, terme additif toujours positif dont l'artefact reste a 2,8·10⁻⁴.
Le spectre, lui, est monotone a zero violation dans les deux cas : les tests ont
ete reecrits sur la grandeur ou l'invariant est vrai.

---

## Phase 10 — Indice de refraction de l'air · VALIDATED

### Livre

- `refraction/airIndex.ts` — formulation de **Ciddor (1996)**, standard
  metrologique : `n(λ, T, p, humidite, CO₂)`, equation d'etat du CIPM,
  profil vertical `n(z)`, pont vers l'etat de l'atmosphere.
- Peck & Reeder **reste** dans `rayleigh/standardAir.ts` : la section efficace de
  Rayleigh exige `n` et `N` aux memes conditions de reference. Deux indices, deux
  questions differentes.

### Le probleme de validation, et sa reponse

Ce module est presque entierement fait de constantes publiees. Une coquille y
serait invisible : l'indice de l'air vaut 1,0003, et il vaudrait encore 1,0003.
Les controles de forme ne servent a rien ; seuls comptent les recoupements
independants.

| Recoupement | Resultat |
| --- | --- |
| Ciddor contre Peck & Reeder (380–780 nm) | **3,5·10⁻⁵** |
| `n` à 633 nm, 20 °C — valeur de l'article | **1,000271800** |
| Densité CIPM contre US1976 | 0,0375 % mesuré, 0,0408 % prédit par `1/Z` |
| svp Ciddor contre Buck | 0,039 % |
| **Réfraction à 45°** | **58,3″** contre 58,2″ des éphémérides |

Le premier est le garde-fou. Le dernier fait retomber une formule de metrologie
sur une constante d'ephemeride, a 0,2 %.

### L'humidite abaisse l'indice

Un invariant de **signe**, teste explicitement parce qu'une inversion y serait
invisible : `n−1` passe de 2,7308·10⁻⁴ a sec a 2,7224·10⁻⁴ a saturation, soit
**−0,31 %**.

### Deux formules pour la meme grandeur, volontairement

Le moteur porte maintenant deux pressions saturantes et deux facteurs
d'accroissement — Buck pour la meteorologie, Ciddor pour l'indice. Une
formulation doit etre employee avec les relations sur lesquelles ses coefficients
ont ete ajustes. L'ecart est mesure (0,039 % et 0,018 %) plutot que masque.

**Dette de phase 1 soldee** : le coefficient de Buck, `1,0007 + 3,46·10⁻⁶ P`, est
confirme conforme a la publication.

### Rien a l'ecran, et c'est voulu

Aucun materiau ne lit ce module ; le banc le confirme — aucune derive, noyaux GPU
dans le bruit. C'est l'infrastructure de la phase 11.

Gradient d'indice au sol : **−2,67·10⁻⁸ m⁻¹**. Et deja, a 85° de distance
zenithale, **661″ de refraction dans le bleu contre 651″ dans le rouge** — les
dix secondes d'arc qui feront le rayon vert.

---

## Phase 11 — Courbure des rayons · VALIDATED (non câblée)

### Livré

- `refraction/rayBending.ts` — invariant de Bouguer `n·r·sin z = L`, intégrale de
  réfraction, branches montante **et** descendante, dépression de l'horizon,
  aplatissement du disque, profil à inversion de surface.
- `refraction/refractionTable.ts` — table 512 entrées, lecture en 0,023 µs.

### La singularité, et son traitement

À l'horizon `tan z → ∞`. Le changement de variable `r = r₀ + w²` supprime la
divergence **exactement** : `cos z ∝ w`, et le `2w dw` du jacobien annule le
`1/w` de la tangente. C'est la seule façon d'atteindre l'horizon, là où tout se
joue.

### Confrontation

| Grandeur | Modèle | Référence |
| --- | --- | --- |
| Réfraction à 45° | **57,99″** | 58,23″ — Almanach (**0,4 %**) |
| Réfraction horizontale | 33,53′ | 34,48′ — Bennett |
| Dépression de l'horizon | 0,911 | ~0,92 |
| **Disque solaire couchant** | **27,6′ × 32,0′** | ~28′ observé |
| Astre visible dès | −33,0′ | −34′ |
| Dispersion bleu-rouge | 53,9″ | germe du rayon vert |

L'intégrateur est validé séparément contre l'asymptotique exponentielle : l'écart
suit **proportionnellement** le paramètre de développement `N₀R/H`, et s'annule
quand il tend vers zéro. Un écart constant aurait signalé une erreur.

### Ce qui émerge sans être écrit

L'aplatissement du Soleil sort d'une **dérivée** de la fonction de réfraction, pas
d'un paramètre. La réponse aux conditions (41,7′ à −40 °C, 30,2′ à +40 °C)
reproduit la dispersion observée de 30′ à 42′.

### Une erreur révélée par le profil tabulé

La dérivée de l'indice se prend sur un mètre : à dix centimètres d'altitude elle
interroge `n(−0,9 m)`. Écrêter y **halve le gradient**, exactement là où la
réfraction horizontale se joue — 9,3″ d'erreur. Extrapoler sous le sol la ramène
à 2,4″.

### ⚠️ Deux choses signalées

**Le mirage ne peut pas encore apparaître.** Le crochet existe et le gradient se
retourne bien (−2,67·10⁻⁸ → +1,19·10⁻⁵ m⁻¹ pour 15 K sur 1 m), mais un mirage
demande `dn/dr < −1/r`, soit **six fois le gradient standard**, pour que la
racine du point tangent cesse d'être unique. La dichotomie n'en trouve qu'une.

**Le câblage n'est pas fait, délibérément.** Corps, étoiles, ciel profond,
constellations et étiquettes suivent des chemins différents. Une réfraction à
moitié câblée détacherait une planète de sa constellation de plus d'un diamètre
lunaire près de l'horizon — le commentaire de `astro/bodies.ts` met justement en
garde contre cela. Le câblage doit se faire d'un seul tenant.

---

## Phase 12 — Phénomènes émergents de réfraction · VALIDATED

### Livré

- `scene/refractionTexture.ts` — table et texture partagées, mémoïsées par site.
- Câblage **simultané** des cinq mécanismes de placement du ciel : corps,
  étoiles, ciel profond, constellations, étiquettes.
- `ConstellationLines` passe d'un `lineBasicMaterial` à un matériau propre : la
  réfraction n'est pas linéaire, aucune matrice ne peut la porter.
- Aplatissement du disque, par une échelle verticale sur le groupe porteur.

### Une seule table, deux lecteurs

Processeur et nuanceur lisent les mêmes valeurs. Mesuré, nuanceur compilé hors
application contre `refractSceneDirection` sur 45 directions : **2,6 secondes
d'arc**, pour un pixel qui en vaut une centaine. Un astre et une étoile dans la
même direction atterrissent au même endroit.

### Ce qui se voit

Le Soleil reste visible jusqu'à **−33,0′** de hauteur vraie — plusieurs minutes
de jour de plus à chaque extrémité. Et son disque devient un ovale de
**27,6′ × 32,0′** à l'horizon, par la **dérivée** de la fonction qui l'a placé.

### La discontinuité qu'il fallait supprimer

Sous l'horizon apparent il n'y a aucune image. Rendre la hauteur vraie telle
quelle faisait sauter la fonction de 33′ à la frontière — **1377″ d'erreur
d'interpolation** dans la texture. Le prolongement à réfraction horizontale
constante la ramène à **2,0″**, en gardant l'astre caché.

### ⚠️ Un mot réservé, et sa leçon

`flat` est un qualificateur d'interpolation GLSL. En faire un nom de variable a
fait échouer les trois nuanceurs — pendant que le chemin **processeur**
fonctionnait parfaitement. Exactement le mode de défaillance que la phase visait
à éviter, et invisible pour TypeScript, pour la suite de validation et pour le
banc colorimétrique. Seule la console de l'application chargée l'a montré.

### ⚠️ Ce qui n'est pas réfracté, et pourquoi

**Le fond de ciel** : sa table est construite le long de rayons droits ; en
courber l'échantillonnage serait incohérent. **Les avions et satellites** : ils
sont *dans* l'atmosphère, leur réfraction est une autre intégrale. **Le rayon
vert** : 53,9″ de dispersion, plus fin que la pixellisation du disque, et il
demande trois tables et un disque spectral.

---

## Phase 13 — Atmosphère 3D · VALIDATED

### Livré

- `field/AtmosphereField.ts` — champ d'indice adressable en 3D, repère
  géocentrique, observateur sur +Y. Perturbations **composables** : dalle
  surchauffée locale, gradient horizontal saturé.
- `field/rayTracer.ts` — intégration de l'équation eikonale par Runge-Kutta 4,
  pas croissant avec l'altitude, sans aucune hypothèse de symétrie.

### Le contrôle qui porte la phase

Le traceur **n'utilise jamais** l'invariant de Bouguer, et doit pourtant le
conserver et retomber sur la phase 11.

| Contrôle | Résultat |
| --- | --- |
| Traceur 3D contre intégrale 1D | **0,044″** sur 1980″ |
| Invariant de Bouguer sur 24 035 pas | **1,6·10⁻⁷** |
| Perturbation nulle contre champ de base | **égalité stricte** |

Deux algorithmes sans rien de commun, un seul nombre — et une loi de
conservation que le schéma numérique ignore.

### Ce que ça produit

Un front de 2 K/km donne **30,74′ vers l'air chaud contre 35,64′ vers l'air
froid** : presque cinq minutes d'arc d'un bord à l'autre, sans que rien ne
l'écrive.

Et un rayon visé à −0,2° au-dessus d'une route à 35 K descend jusqu'à **0,88 m
puis remonte**, là où l'atmosphère standard le laisse rencontrer le sol. C'est la
condition du mirage inférieur.

### ⚠️ Un bug que seul le mirage pouvait révéler

La couche chaude prenait l'altitude de l'**observateur** comme origine de ses
hauteurs au lieu de celle du **sol**. Avec un œil à 1,7 m, il n'y avait donc
aucun échauffement sous 1,7 m — exactement là où l'inversion existe.
`surfaceInversionProfile` de la phase 11 portait la même faute, masquée par un
défaut à zéro.

Rien d'autre ne pouvait l'attraper : la réfraction restait juste, les invariants
étaient conservés, les valeurs restaient plausibles. Seule la question « le rayon
remonte-t-il ? » avait une réponse fausse.

### ⚠️ Ce qui reste sphérique

Les tables de ciel et de perspective atmosphérique. Les rendre 3D ajouterait deux
dimensions pour un gain visuel nul — un dégradé ne se juge pas au dixième de
degré. La phase 14 n'en a pas besoin : un mirage est un phénomène de **rayon**.

---

## Phase 14 — Inversions thermiques et mirages · VALIDATED

### Livré

- `field/mirageTransfer.ts` — fonction de transfert `visée → source`, construite
  en ne traçant que la couche limite puis en raccordant à la table de la
  phase 11. **24 ms par visée** au lieu de 400.
- `analyseMirage` — détection de la bande de retournement, de la perte de
  monotonie, de l'épaisseur de l'image inversée et du nombre d'images.
- `trueFromTable` — l'inverse de `apparentFromTable`, qui manquait.

### Ce qui émerge

Route à 20 K sur 80 cm : la fonction de transfert **cesse d'être monotone**,
passe par un minimum à −0,020° de visée, et rend **deux images** dont une
inversée de **0,270°** — l'ordre du demi-degré solaire, donc le régime du Soleil
« vase étrusque ». À 50 K sur 50 cm : 0,450°.

La bande de −0,290° à −0,005° rend du **ciel** là où il devrait y avoir du sol.
C'est la flaque d'eau sur une route sèche.

### ⚠️ Deux erreurs de repère révélées par le raccord

Le raccord doit être indifférent à l'endroit de la coupe. Ce contrôle a attrapé
`apparentFromTable` employée à l'envers (20″ à 118″ de dérive) puis l'angle de
sortie mesuré sur l'axe **Y global** au lieu de la **verticale locale** (350″ à
1001″, croissant en `√(sommet)` — la signature de la distance horizontale).
Corrigé : **1,3″** de dispersion. Aucun des deux ne se voyait sur la forme du
mirage, qui restait plausible.

### ⚠️ Deux limites, dites

**La ligne de fuite est une caustique** : son bord reste sensible au pas, parce
qu'un rayon qui se retourne de justesse et un rayon qui touche le sol y sont
voisins. Le corps de la fonction, lui, est convergé.

**Rien à l'écran.** Un mirage rend `visée → objet` **multivaluée** ; un maillage
ne peut être qu'à un endroit. Le Soleil « vase étrusque » demande que le disque
soit rendu *à travers* la fonction de transfert, pas déplacé par elle — un
changement de rendu distinct, et le faire à moitié serait pire.

---

## Phase 15 — Turbulence · VALIDATED

### Livré

- `turbulence/structureConstant.ts` — fonction de structure de Kolmogorov,
  spectres de Kolmogorov et de von Kármán, lien `C_T² → C_n²` par la
  thermodynamique.
- `turbulence/turbulenceProfile.ts` — profil de Hufnagel-Valley, moments de
  `C_n²`, paramètre de Fried, seeing, angle isoplanétique, indice de
  scintillation, fréquence de Greenwood, vent de Bufton.

### Le modèle porte son nom

HV 5/7 est nommé d'après ce qu'il doit produire : **`r₀ = 4,961 cm`** contre 5
attendus, **`θ₀ = 6,903 µrad`** contre 7. Une constante mal recopiée les ferait
manquer — le modèle se valide lui-même.

Seeing 2,04″, Greenwood 72 Hz : un site ordinaire, ce que HV 5/7 décrit.

### Les lois d'échelle sont exactes

`r₀ ∝ λ^(6/5)` et `∝ (cos ζ)^(3/5)` vérifiées à **4·10⁻¹⁶** — ce sont des
identités algébriques, pas des mesures. L'exposant 2/3 de la fonction de
structure aussi.

### Un recoupement gratuit

La refractivité à **un seul terme** de la littérature turbulente,
`79·10⁻⁶ P/T`, retombe sur les quinze constantes de Ciddor à **0,018 %**.

### Ce qui émerge

| Couche | Part de `r₀` | Part de la scintillation |
| --- | --- | --- |
| 0 – 100 m | **49,2 %** | 4,4 % |
| 5 – 15 km | 5,7 % | **49,5 %** |

**Le seeing vient du sol, la scintillation de la haute troposphère.** Rien ne
l'écrit : c'est la différence des poids en altitude, `h⁰` contre `h^(5/6)`.

### ⚠️ Deux limites

**L'échelle externe** reste la grandeur la plus mal contrainte du domaine —
quelques mètres à plusieurs centaines selon le site. Vivable parce que `r₀` n'en
dépend pas du tout.

**La scintillation n'est valable qu'en régime faible.** À 70° de distance
zénithale le modèle rend σ_I² = 1,67, déjà hors du domaine où la théorie de
perturbation s'applique. Signalé, non corrigé.

### Rien à l'écran

La phase 15 fournit les grandeurs ; la **phase 17** les appliquera aux images
d'étoiles.

---

## Phase 16 — Optique ondulatoire · VALIDATED

### Livré

- `wave/diffraction.ts` — fonction de Bessel `J₁`, tache d'Airy, critère de
  Rayleigh, arbitrage diffraction / seeing, pupille de l'œil.
- `wave/corona.ts` — couronnes calculées par le solveur de Mie de la phase 6,
  moyennées sur une distribution de tailles de gouttelettes.

### Le 1,22 est trouvé, pas écrit

Premier zéro de `J₁` par dichotomie : **3,8317059703** contre 3,8317059702
tabulé. Le critère de Rayleigh en découle.

### La question que l'application posait

Le seeing vaut 2,00″, mais la pupille diurne est limitée à **58,4″** par sa
propre diffraction — un facteur **29**. **L'œil nu ne peut pas voir le flou
atmosphérique**, alors qu'il voit parfaitement la scintillation, qui est une
variation d'intensité et non de forme.

### Le croisement retrouve `r₀`

Diamètre au-delà duquel l'atmosphère l'emporte : **5,8 cm** par la tache d'Airy,
contre **5,6 cm** pour le paramètre de Fried obtenu par une intégrale de `C_n²`.
Deux chemins sans rien de commun.

### Les couronnes émergent de Mie

| Gouttelette | Mie | Diffraction | Écart |
| --- | --- | --- | --- |
| 5 µm | 3,703° | 3,844° | −3,7 % |
| 20 µm | 0,951° | 0,961° | **−1,0 %** |

Colorée dans le bon sens : bleu à 1,551°, rouge à 2,234°, rapport 1,4409 pour
1,4444 attendu. Et la lecture inverse redonne 8,17 µm pour 8,00 réels.

### ⚠️ Une assertion fausse, corrigée par la physique

J'affirmais qu'à 3 µm la prédiction par diffraction « cessait de valoir », sur un
écart de 43 %. C'était la **structure de résonances** d'une gouttelette unique
que la détection prenait pour l'anneau. Un nuage réel n'est jamais monodisperse,
et la dispersion des tailles lisse ces résonances — c'est pour cela que les
couronnes observées ont des anneaux nets. Moyenner sur 5 % de dispersion n'était
pas un lissage de confort, **c'était ce qui manquait au modèle** : l'écart tombe
de 43 % à 4,4 %.

### ⚠️ Rien à l'écran

Aucune couronne : le transport suppose une atmosphère **claire**, sans nuage ni
gouttelette. La limite de diffraction, elle, sert dès maintenant.

---

## Phase 17 — Seeing et scintillation · VALIDATED · **AU RENDU**

### Livré

- `turbulence/scintillation.ts` — altitude effective de la couche, rayon de
  Fresnel, moyennage d'ouverture et **de taille de source**, fraction perçue par
  l'œil, statistique log-normale.
- `scene/Starfield.tsx` — les étoiles scintillent, avec une amplitude et une
  bande passante issues de `C_n²`.

### La décision de rendu, appuyée sur une mesure

**On ne rend pas le seeing.** 2,00″ contre 16,7″ de limite pupillaire même
dilatée (phase 16) : l'œil ne peut pas le voir, et le champ n'a de toute façon
que 42″ par pixel. Le rendre serait une erreur, pas un raffinement.

### Pourquoi les planètes ne scintillent pas

Aucune règle ne le dit — c'est le rapport de la taille projetée au rayon de
Fresnel :

| | Projetée à 7,4 km | σ à 30° |
| --- | --- | --- |
| étoile | 0 m | **0,210 mag** |
| Jupiter 40″ | 1,44 m | **0,0028 mag** |

Facteur **76**, et la transition tombe à **1,8″** — pile où sont Uranus et
Neptune.

### L'exposant qui permet le rendu

La variance perçue suit `sec^(7/3)` : 11/6 pour la variance, plus 1/2 pour
l'allongement du trajet qui abaisse la fréquence et augmente donc la part visible.
Mesuré **2,341** contre 2,333. Une addition, pas un ajustement — et c'est ce qui
permet de ne porter au GPU **qu'une constante**, `7,55·10⁻³`.

### Ce qui est physique, ce qui est un tirage

Le nuanceur module l'intensité par trois sinusoïdes normalisées à variance unité.
La réalisation est arbitraire ; l'**amplitude** et la **bande passante** viennent
de `C_n²`. Temps réel et non simulé : en avance rapide, les étoiles frémissent au
même rythme.

### ⚠️ Le plafond est une borne de validité

À 5° de hauteur le modèle rend σ_I² = 18,3 ; au-delà de 1 la théorie de
perturbation surestime et la scintillation réelle sature. Le plafond de 0,5 —
0,69 mag — est la borne du domaine, pas un réglage esthétique.

---

## Phase 19 — Calage scientifique · VALIDATED · **AU RENDU**

### Livré

- `absorption/ozoneClimatology.ts` — colonne d'ozone selon la latitude et la
  saison, en remplacement d'une constante unique.
- Distance du Soleil et colonne d'ozone **câblées** jusqu'à la table de ciel :
  le transport savait les prendre en compte, personne ne les lui donnait.
- **Registre des incertitudes** dans `docs/atmosphere-engine.md` — ce qui est
  mesuré, ce qui est choisi, ce qui manque.

### Ce que ça change

| Colonne d'ozone | Luminance du crépuscule | Bleu/rouge |
| --- | --- | --- |
| 245 DU (tropiques) | 20,2 cd/m² | **1,60** |
| 400 DU (haute latitude, printemps) | 14,7 | **2,57** |

**61 % d'écart sur le rapport bleu/rouge** : un observateur norvégien en avril et
un observateur équatorial ne voient pas le même crépuscule.

Distance solaire : **6,91 %** d'écart périhélie/aphélie, exactement
`(1,0167/0,9833)²`.

### ⚠️ La paramétrisation de l'ozone est une interpolation

Les coefficients ne viennent d'aucune publication. Ils reproduisent les bornes
observées (245–413 DU contre 240–450) et la forme qualitative — invariance
équatoriale, croissance vers les pôles, maximum printanier, hémisphères en
opposition de phase à 6,5·10⁻⁴ près. **van Heuklon (1979)** est la référence à
adopter. Le trou d'ozone antarctique n'est pas représenté : c'est une chronologie,
pas une formule.

### Le registre

Trois tableaux : dix grandeurs **mesurées et recoupées** par un chemin
indépendant, huit paramètres **choisis et signalés**, sept manques **nommés** —
dont l'ancre d'exposition, le nœud à 5°, le socle nocturne peint et le rendu des
mirages.

---

## Phase 20 — Optimisation · VALIDATED

### La mesure d'abord, et une ratée

La première mesure donnait **146 ms par image — 7 fps**. Faux : Chromium sans
argument tourne en **rendu logiciel**. C'est l'erreur de la phase 0 qui se
répète. Avec le GPU activé :

| Cadence | Médiane | p99 |
| --- | --- | --- |
| temps réel | **16,60 ms** | 23,4 |
| ×86400 | 18,10 | 31,7 |

L'application est verrouillée sur la synchro verticale, à 60 images par seconde.

### Où passe le temps

Une reconstruction coûte 74 ms : **23,4 ms d'exponentielles** — l'intégrale du
transfert radiatif, deux millions d'`exp(−τ)`, incompressible — 8,1 de géométrie,
7,6 de colonnes solaires, 11 de conversions.

### Corrigé : le seul blocage visible

La table de colonne coûtait **124 ms** et se construisait **dans une image**.
Elle est désormais étalée par tranches de huit lignes, validée à **égalité
stricte** avec un pas de découpe qui ne divise pas la hauteur.

Somme des images de plus de 40 ms au démarrage : **1214 → 1076 ms**.

### ⚠️ Ce que la mesure a contredit

Je croyais les blocages du démarrage imputables au moteur. **Ils ne le sont
pas** : il restait 422, 349 et 103 ms, et ils viennent de l'amorçage de
l'application — React, three.js, catalogues. Le moteur n'y comptait que pour 124
sur 1214.

### Une optimisation mesurée et **non prise**

La géométrie d'un rayon ne dépend que de la **hauteur** de visée, pas de son
azimut : elle est recalculée 64 fois par ligne. La corriger est exact et
économiserait **11 %**. Non prise : ces 74 ms sont déjà étalées, l'application
tient 60 fps, et il faudrait refactoriser le chemin dont dépendent quatre cents
contrôles. Le chiffre est noté ; la décision est de ne pas payer ce prix
maintenant.

### Refusé

Réduire les pas ou les bandes serait troquer de la précision contre des images
par seconde. La mesure dit qu'il n'y a rien à acheter.

---

## Dette — socle nocturne · **forme calculée**

`emission/airglow.ts` : couche émissive à 90 km, facteur de van Rhijn, spectre de
raies normalisé sur `AIRGLOW_LUX`.

Le dégradé nocturne **émerge** du produit van Rhijn × extinction — maximum de
**2,18× à 15°**, effondrement à **0,175× à 1°** — là où un `smoothstep` peint
l'imitait. Van Rhijn seul croît encore à 1° : c'est l'extinction qui retourne la
courbe.

Dix-huit sondes ont dérivé : le ciel nocturne **s'assombrit** désormais vers
l'horizon. C'est correct — la lumière naturelle traverse toute l'atmosphère ; ce
qui éclaire un horizon nocturne est la pollution lumineuse, terme séparé.

⚠️ **L'amplitude ne peut pas être physique à exposition fixe** : l'airglow vaut
4·10⁻¹⁰ du blanc d'affichage. **Cette dette ne peut donc pas être soldée avant
celle de l'exposition** — l'ordre que j'avais annoncé était faux, et la mesure l'a
montré.

⚠️ Bandes de OH retirées plutôt que repondérées ; ancre `AIRGLOW_LUX` signalée
basse d'un facteur cinq, non corrigée ; et une troisième mesure ratée
(`getImageData` sur canevas WebGL) prise pour une régression.

---

## Dette — adaptation visuelle · **RÉSOLUE**

`scene/display/adaptation.ts` : l'exposition suit la luminance moyenne du ciel,
**mesurée sur la table qui s'affiche**.

L'exposant n'est pas choisi — `1 − décades_écran/décades_scène` = **0,747**, une
adaptation à 75 %. Le seul choix est de consacrer **deux décades** d'écran à
l'écart jour/nuit, et la validation en mesure la conséquence exacte.

La continuité de midi est **exacte au bit près**. Dix-neuf sondes ont dérivé,
toutes vers le crépuscule :

| Sonde | Fixe | Adaptative |
| --- | --- | --- |
| coucher / zénith | 18,24,37 | **62,79,103** |
| crépuscule civil / vers le Soleil 30° | 7,9,17 | **57,88,140** |

**Le crépuscule existe enfin.**

### ⚠️ Deux erreurs de pondération, attrapées par le recoupement

La moyenne de la table doit égaler celle du solveur. Le jacobien omettait son
`cos(hauteur)` (**24,6 %** d'écart), puis la pondération en **cosinus** — qui est
l'éclairement d'une surface, non ce que voit l'œil — faisait saturer l'horizon
crépusculaire à `254,246,194`. Corrigé en moyenne d'**angle solide** : **1,2 %**.

### ⚠️ Ce qui reste

Adaptation **instantanée** ; vision **scotopique** absente (`V'(λ)` non
embarquée) ; et la **courbe de tonalité** devient le facteur limitant — la bande
claire de l'horizon vaut jusqu'à 37× la moyenne et l'ACES approché l'écrête.

### ⚠️ Une quatrième mesure ratée

`import()` dynamique depuis la page créait une **seconde instance** du module
après rechargement à chaud — je lisais des zéros et j'ai conclu à un câblage
rompu. Quatrième fois de la session ; le rendu n'a été en cause aucune.

---

## Passe globale — socle nocturne **entièrement physique**

L'amplitude de l'airglow était bloquée par l'exposition fixe. L'adaptation l'a
débloquée : le plancher d'adaptation **est** la luminance de l'airglow, et la
couleur peinte a disparu.

| Sonde de nuit | Peinte | Calculée |
| --- | --- | --- |
| zénith | 3,4,10 | **3,3,3** |
| vers le Soleil, 30° | 5,7,14 | **5,5,5** |

### La vision scotopique était indispensable

L'airglow est physiquement **verdâtre** (raie à 557,7 nm). Le brancher tel quel
donnait un ciel vert — non parce que le calcul est faux, mais parce que **l'œil
ne voit pas les couleurs à ces luminances** : les bâtonnets ne portent qu'un
pigment. C'est de l'anatomie, pas une approximation.

### ⚠️ Deux erreurs sur la bascule

**Locale, non globale** : employer la moyenne du ciel grisait la bande orange de
l'horizon (`220,220,220`), alors que la dominance des cônes dépend de
l'éclairement **local** — c'est pourquoi on voit la couleur d'un feu la nuit.

**Logarithmique, non linéaire** : à 1,8 cd/m², l'interpolation linéaire donnait
34 % de bâtonnets ; en décades, 2,3 %. Bande orange rétablie à **238,217,152**.

### ⚠️ Restent

Décalage de Purkinje (faute de `V'(λ)` — la nuit sort grise, non gris-bleu) ;
lueur lunaire et halo urbain toujours peints.

---

## La marge sous l'horizon — **trois bornes au même endroit**

Un astre qui passait l'horizon *redevenait normal, puis s'éteignait*. Trois
défauts distincts, dans trois modules sans rapport, qui n'avaient en commun que
d'avoir borné leur domaine **exactement** à la hauteur zéro.

| Module | À la frontière | Ce qu'on voyait |
| --- | --- | --- |
| `columnsToSpace` | colonne **infinie** | le disque s'éteint d'un coup |
| `apparentFromTable` | prolongement à **pente un** | le disque redevient rond |
| nuanceur du ciel | `dir.y < 0` donne zéro | le ciel se coupe net |

Or l'horizon visible n'est pas à zéro : réfraction 0,57°, demi-diamètre solaire
0,27°, abaissement d'horizon à 3 000 m 1,76°. Couper là, c'est couper **à
l'intérieur** de ce qu'on voit encore.

| Marche à la traversée | Avant | Après |
| --- | --- | --- |
| compression verticale | 0,168 | **0,0037** |
| teinte du disque | 100 % | **0,10 %** |

Effet de bord : la texture de réfraction passe de **1,97″ à 0,81″** — le coude
qu'elle devait interpoler n'existe plus.

### ⚠️ L'en-tête du sol affirmait une chose fausse

Il prétendait que le tampon de profondeur masquait tout ce qui est couché,
« planètes, satellites, étoiles et grilles comprises ». Vrai pour la seconde
moitié, faux pour la première : `sceneDepth` place les étoiles à 200 mais
Neptune à 72, la Lune à 42, un avion à 8 — **tout le système solaire est à
l'intérieur** de la calotte de rayon 150, et une planète couchée se dessinait
par-dessus le sol.

Le sol ne teste plus la profondeur : dessiné en dernier, il recouvre sans
condition tout ce qui tombe dans sa géométrie.

### ⚠️ Ce que 675 contrôles ne voyaient pas

Tous portaient sur la **valeur** des fonctions ; aucun sur leur **dérivée**, ni
sur la continuité d'une teinte à la traversée d'une frontière. Cinq contrôles
ajoutés, dont les deux qui auraient suffi.

### ⚠️ Restent

Les **étiquettes** ne sont pas occultées (`LabelLayer` est du DOM, hors scène).
Et le **sol lui-même reste peint** — il entre au registre comme la dernière
grande surface peinte du moteur.

---

## Banc de relief — **la distance devient visible**

La table de perspective atmosphérique a seize tranches de distance ; une seule
servait. Rien dans la scène ne faisait varier la distance **à l'intérieur d'une
même image**.

Une chaîne **rectiligne** à 15 km à l'est, longue de 600 : tout y est constant
sauf la distance, qui va de 15 à 300 km. Chaque écart d'aspect le long de la
chaîne **est** un effet de distance.

| Distance | Sommet à 4 000 m |
| --- | --- |
| 15 km | +14,75° |
| 100 km | +1,89° |
| 244 km | **−0,01°** — il atteint l'horizon |

### L'éclairement est calculé

`measureSkyIrradiance` — ce que le ciel **dépose sur un plan**, là où le moteur
ne savait que ce qu'il **rayonne dans une direction**. Pondération en cosinus,
et non en angle solide : l'inverse exact de la luminance d'adaptation. Invariant
qui le garantit — un ciel uniforme rend `π·L` à **0,06 %**.

### Ce que le banc a mesuré du moteur

T = 0,573 à 15 km, soit une **portée visuelle de 105 km** : atmosphère très pure,
pas un voile excessif. Le massif ressort clair parce qu'une roche ensoleillée
rend 6 000 cd/m² contre 3 800 pour le ciel moyen — c'est vrai.

### ⚠️ Trois erreurs

**La tangente prise pour un angle** : `(z−h)/d` vaut −1,75 à vingt mètres d'un
œil posé à trente-cinq. Le cosinus changeait de signe et les anneaux proches se
projetaient **à l'azimut opposé**.

**Une somme d'octaves ne visite pas [0, 1]** : une crête nominale de 4 000 m
culminait à 2 735. Après étirement du bruit : **3 868 m**.

**Une mesure ratée**, attrapée tout de suite : le chronomètre englobait mon
propre `setTimeout`. Coût réel **34 ms**, une fois ; rendu 6,10 ms/image avec
comme sans.

### ⚠️ Deux défauts signalés à l'usage

**Le sol s'arrêtait net.** L'observateur est **à l'intérieur** du maillage : les
anneaux proches forment un cône dont on ne voit que la face interne, et
l'élimination des faces arrière les supprimait. `side: DoubleSide`.

**Un pas de différences finies fixe ne peut pas éclairer un maillage à échelle
variable.** 25 m pour une maille allant de 1 m à 15 km : au loin les normales
décrivaient un micro-relief invisible, et l'ombrage n'avait plus de rapport avec
le Soleil. Elles viennent maintenant du **maillage lui-même**. Vérification : au
lever, Soleil derrière la chaîne, elle est franchement à contre-jour.

**Deux mesures ratées de plus** : captures prises **pendant la reconstruction de
la table**, ciel noir en plein midi, conclusion hâtive à une régression.

### ⚠️ Restent

Ni ombres portées, ni occlusion du ciel par le relief voisin ; le champ de
hauteur est une surface de test, pas un modèle géologique.

---

### ⚠️ L'atmosphère coupée net à zéro degré

Le ciel s'arrêtait **exactement à la hauteur zéro**, alors que l'horizon d'un
observateur en hauteur est plus bas. La calotte du sol, devenue totalement
occultante, masquait la bande de ciel entre l'horizontale et l'horizon réel.

| Colonne à 3° de champ | Avant | Après |
| --- | --- | --- |
| le ciel descend jusqu'à | +0,003° | **−0,173°** |
| sol plat parasite | 54 px | **4 px** |

Le bord du sol suit maintenant `horizonDipDeg`, et le fondu de marge part de
l'horizon apparent, non de l'horizontale.

### ⚠️ Deux horizons dans la même image

Le terrain utilisait le `k = 1/7` de la géodésie, le sol l'intégrale de Ciddor :
**3,1 %** d'écart. Le rayon effectif se **déduit désormais de la dépression
mesurée** — les deux partagent leur horizon par construction.

### ⚠️ Une image par seconde, et une mesure non refaite

Le `DoubleSide` du tour précédent avait fait tomber le rendu à **1 fps en plein
écran**. Je ne l'ai pas vu parce que la mesure de performance datait d'**avant**
ce changement — manquement de méthode. Diagnostic : 6,1 ms en 640 × 400 contre
une seconde en 1920 × 1080, donc un coût de **remplissage**. Premier anneau porté
à 60 m, `forceSinglePass`, maillage 384 × 160 → retour à **6,1 ms**.

---

## Sous l'horizon — **la table cessait d'exister**

Le nuanceur écrêtait toute visée descendante à la ligne rasante, et la table
n'était construite que de 0° à 90°. Sans conséquence tant que rien ne vivait sous
l'horizon ; faux dès qu'une **surface** s'y trouve.

Le rayon rasant de la table ne rencontre **jamais** le sol, quand le vrai
descendant s'y arrête :

| visée | distance | colonne en trop |
| --- | --- | --- |
| −0,2° | 20 km | **23,5 %** |
| −0,5° | 5 km | **16,5 %** |
| −4° | 500 m | 0,17 % |

La table couvre maintenant les deux hémisphères, avec `totalPath` borné par le
sol en dessous. **65 lignes** — impair, pour que l'horizon tombe sur un texel ;
32 de chaque côté, donc résolution du haut inchangée.

### ⚠️ Ce qu'il a fallu reprendre

Les deux **mesures d'adaptation** parcouraient toute la table : les y laisser
aurait fait s'adapter l'œil à un paysage plutôt qu'à la voûte.
L'**échantillonneur processeur** gardait l'ancienne formule — trois contrôles
l'ont attrapé.

Contrôle qui porte le changement : à mi-course, transmittance verte **1,000 à
−20° contre 0,004 au ras**.

### ⚠️ Une image par seconde qui n'existait pas

J'avais conclu à un effondrement du rendu et réduit le maillage. **Faux** : un
onglet sans focus voit son `requestAnimationFrame` cadencé à 1 Hz. La même mesure
rendait 1000,5 ms **sans terrain ni atmosphère**. Réductions annulées ; focus
rendu, **6,1 ms**. Cinquième mesure mal conditionnée du projet.

---

## L'horizon n'est plus à zéro degré — **passe de fond**

Règle : rien n'est borné à l'**horizontale**. Toute limite basse se prend à
l'**horizon du site**, avec une **marge** au-delà. Un observateur peut choisir
plusieurs kilomètres d'altitude, et son horizon descend d'autant.

| altitude | dépression | horizon vrai | plancher des tables |
| --- | --- | --- | --- |
| 0 m | 0,000° | −0,549° | −3,549° |
| 1 000 m | 0,928° | −1,662° | −4,662° |
| 10 000 m | 3,014° | −4,032° | −7,032° |

### Ce qui bornait encore

**La table de réfraction** partait de zéro apparent — elle suit maintenant la
branche descendante jusqu'à `−dip`. **Le plancher de la texture** valait 4° pour
tout le monde ; il suit le site. **La masse d'air** était bornée à zéro, et le
nuanceur des étoiles en portait une **seconde copie** :

| depuis 10 km | bornée | réelle |
| --- | --- | --- |
| −1° | 38,75 | **63,5** |
| −3° | 38,75 | **218,8** |

Elle est désormais la colonne du moteur, et voyage dans le **canal vert** de la
texture de réfraction — libre, même domaine, lecture gratuite.

### ⚠️ Le plafond qui annulait tout le reste

`extinctionMagnitudes` plafonnait à **12 masses d'air**, atteintes dès 4° : un
astre à 4°, un au ras et un sous l'horizontale rendaient **identiquement**.

Levé. Rien ne change au-dessus de 4° ; en dessous, l'extinction atteint **9,86
magnitudes à l'horizon** — la valeur de la littérature. Vega y passe à mag 9,9 :
les étoiles s'éteignent avant l'horizon, ce qu'on observe.

---

## L'ombre du relief entre dans le transport

La table est calculée pour une atmosphère **sans relief** : l'air y est partout
éclairé. Soleil levant derrière une chaîne, la brume devant elle brillait comme
si la montagne n'existait pas.

**Ce n'est pas un facteur d'ombre, c'est le domaine d'intégration.** L'intégrale
étant linéaire, la table donne d'elle-même la contribution d'un segment :
`L(a→b) = L(0→b) − L(0→a)`. Il suffit de **sommer les segments éclairés**.

La carte d'ombre stocke une **altitude**, pas une couleur — celle à laquelle le
Soleil se lève en chaque point. Balayage linéaire par récurrence ; le relief,
qui ne dépend pas du Soleil, n'est échantillonné qu'une fois. Le pas de
requantification suit `tan(a)`, parce que c'est ainsi que la longueur des ombres
varie.

| hauteur | avant | après | rapport |
| --- | --- | --- | --- |
| +8° | 229,193,0 | 29,27,18 | **×7,0** |
| +1° | 233,188,0 | 8,19,3 | **×11,9** |

La chaîne redevient une **silhouette à contre-jour**. Coût : **6,1 ms**, inchangé.

### ⚠️ Sur-correction assumée

Un segment ombré perd **toute** sa diffusion, alors que seule la part solaire
directe devrait disparaître : les ombres sortent trop noires là où elles
devraient rester bleues du ciel. Séparer les deux demanderait une seconde table,
sans source solaire. **Pénombre** ignorée.

---

## Le Soleil se cache, le ciel non

Le solveur coupait **les deux sources d'un coup** dès qu'un point entrait dans
l'ombre de la Terre : le rayon direct, ce qui est juste, et la diffusion
multiple, ce qui ne l'est pas. Un point privé de Soleil baigne encore dans la
lumière du reste du ciel.

Mesure du défaut : à deux degrés sous l'horizon, le voile à quinze kilomètres
valait **exactement zéro**, et une crête lointaine se découpait en noir absolu
sur un ciel encore clair.

Le même passage éteignait la source ambiante par le trajet Soleil → point, déjà
compté dans la construction de `Ψ_ms` — une **seconde extinction** qui atteint
la dizaine près de l'horizon. Chaque source porte désormais la sienne.

| voile à 15 km, anti-solaire | avant | après |
| --- | --- | --- |
| Soleil +3° | 178 cd/m² | 587 cd/m² |
| Soleil −2° | **0** | **30,9 cd/m²** |

### L'ombre du relief y trouve sa réponse

Le solveur publie maintenant, à côté du voile total, **la même intégrale privée
de sa source solaire**. Un segment ombré ne disparaît plus de l'intégrale : il
retombe sur cette table. Ce n'est ni un facteur ni une soustraction, c'est un
**changement de terme source**.

| point mesuré | avant | après |
| --- | --- | --- |
| crête, Soleil à −2° | 23,16,13 | **33,40,66** |
| crête à contre-jour, Soleil à +3° | 28,28,20 | **41,67,98** |

B/R passe de 0,5 à 2,2 : l'ombre devient bleue. Coût : une texture de 1,06 Mo et
**0,03 ms** sur 3,49 ms par ligne ; **6,10 ms** par image, inchangé.

### ⚠️ Ce qui reste

**Pénombre** toujours ignorée. Et l'ambiante suppose le ciel **entièrement**
visible depuis le point ombré, alors que la crête lui en masque une part :
l'ombre est désormais légèrement trop claire là où elle était trop sombre.

---

## Le relief devient le monde reel

Le banc synthetique cede la place au **modele numerique de terrain reel a trente
metres**, sur quatre cent cinquante kilometres de rayon. Ni Cesium ni
quantized-mesh : ce dernier est un maillage triangulaire irregulier, et les deux
consommateurs du relief — le maillage radial et le balayage d'ombre — demandent
tous deux l'altitude en un point **arbitraire**. On l'aurait rematricise.

### La geodesie, par elimination mesuree

| methode | ecart au geodesique WGS84 a 450 km |
| --- | --- |
| premier ordre (`lat += nord/R`) | **20,9 km** — 2,65° apparents |
| sphere de rayon gaussien | **814 m** — trois pixels |
| **Vincenty sur l'ellipsoide** | exact |

Les equations imbriquees sont iteratives, mais la projection n'est evaluee que
sur un treillis de 65 par 65 et par niveau : douze mille appels, pas douze
millions. La validation ne compare pas Vincenty a Vincenty — l'arc meridien
obtenu par integration de Simpson se referme a **9·10⁻⁸ m**.

### Trois niveaux, une empreinte fixe

| niveau | couvre | pas | l'ecran demande |
| --- | --- | --- | --- |
| L2 | 28 km | 27 m | 15 m a 25 km |
| L1 | 112 km | 110 m | 61 m a 100 km |
| L0 | 450 km | 440 m | 273 m a 450 km |

**25 Mo residents**, quel que soit le rayon. Mesure : Chamonix 217 tuiles,
Paris 244, Nice 206 — 26,2 Mo et 16 s a Chamonix, aucun echec.

⚠️ Nice en reclamait d'abord **703**. Les zooms allant de deux en deux, le niveau
fin etait choisi comme le premier tenant **strictement** sous la taille d'une
cellule : a Nice le zoom 12 echouait d'**un pour cent**, et le zoom 13 le
remplacait — quatre fois plus de tuiles. Un quart de tolerance supprime la
falaise. Cout par image **2,9 ms sur 9,2 Mpx** — sous la
milliseconde au format nominal.

### Le sol peint devient un globe

`Ground` etait la derniere grande surface peinte du moteur. Elle est remplacee
par une sphere **resolue par pixel** : chaque fragment calcule son intersection
avec le globe, puis recoit la meme equation du transfert que le relief. La
normale s'inclinant avec la distance, le globe porte un **terminateur** — Soleil
sous l'horizon, le sol lointain dans sa direction peut encore etre eclaire.

### ⚠️ L'oeil etait dans le sol

Le defaut de la phase, et il ne pouvait pas exister avant. Le banc avait une
plaine a zero sous un oeil a trente-cinq metres ; le relief reel place l'altitude
du site et celle du terrain **a la meme valeur**, et l'oeil se retrouvait sous la
surface. L'hemisphere inferieur se vidait, laissant voir les constellations sous
ses pieds.

L'oeil repose desormais sur le sol, a 1,7 m. Et surtout : **cette altitude n'est
plus arrondie**. Le maillage etait reconstruit sur une altitude quantifiee a dix
metres — un arrondi inoffensif quand l'oeil dominait de trente-cinq metres,
fatal quand il ne domine que de 1,7 m, ou il l'enfonce sous terre une fois sur
deux et **retourne le maillage**.

### Choisir un lieu sur la carte

La carte de selection ne charge aucun fond de carte : elle est dessinee a partir
des memes tuiles d'altitude, la mer par le signe et le relief par un ombrage
cartographique. Elle montre donc **exactement ce que le moteur sait du terrain**.

La **hauteur au-dessus du sol** est un reglage distinct de l'altitude du lieu :
celle-ci est une propriete du terrain, celle-la dit ou est l'observateur par
rapport a lui. Elle abaisse l'horizon — de 23 km a 342 km entre le sol et huit
mille metres.

---

## ⚠️ Trois couches, trois horizons

Signale en altitude : une bande sombre, parfois noire, juste sous l'horizon.

Trois couches dessinent la limite entre le ciel et la Terre. Le relief prenait la
depression de l'**oeil** ; la calotte du globe et le fondu du fond de ciel, celle
du **site**. Au sol les deux coincidaient et rien ne se voyait — la hauteur
ajoutee les a separees, et la bande entre les deux horizons n'appartenait a
personne.

| site → oeil | bande | le ciel y tombe a |
| --- | --- | --- |
| 1035 → 1035 m | 0,000° | — |
| 1035 → 7035 m | **1,564°** | 47 % |
| 35 → 10035 m | **2,847°** | 1 %, soit un trait noir |

**Une seule altitude pour les trois**, celle de l'oeil. Et la calotte du globe
s'ouvre maintenant a l'horizontale : la geometrie ne decide plus ou est
l'horizon, c'est l'intersection **par pixel** qui le taille — donc forcement au
meme endroit que le relief, qui resout la meme sphere.

Un invariant le verifie sur huit altitudes d'oeil, de deux metres a quinze
kilometres : silhouette du relief, horizon du globe et ancrage du fondu du ciel
restent egaux a **2,6·10⁻³°** pres — un dixieme de pixel, et c'est la difference
entre la tangente exacte et le modele petit-angle, pas du bruit.

L'altitude du sol est en outre **publiee par le modele numerique** : choisir un
sommet sur la carte ne laisse plus le panneau afficher l'altitude du lieu
precedent.

---

## ⚠️ La coordonnee de distance prenait la rasance du globe pour une limite

Signale trois fois, manque trois fois : une rupture nette du voile, a hauteur
apparente fixe, posee **par-dessus le relief**.

La coordonnee de distance valait `sqrt(distance / trajet_propre)`, et ce trajet
bascule d'une branche a l'autre a la rasance du globe. A trente-cinq metres
d'altitude, pour quatre milliemes de degre :

| hauteur | trajet | tranche | relief a 15 km |
| --- | --- | --- | --- |
| −0,1879° | 1154 km | 1,71 | `26,42,75` |
| −0,1919° | 18,3 km | 13,59 | `75,90,124` |

Pourquoi trois enquetes l'ont manquee : elles mesuraient **depuis douze
kilometres**, ou la rasance designe du terrain a plus de trois cents kilometres,
la ou le voile est deja sature. Au sol, elle designe du relief a quinze
kilometres, et l'ecart eclate.

**La loi de distance est devenue globale** — logarithmique, la meme pour toutes
les directions. Le melange des lignes redevient legitime, la coordonnee est
continue, et le nuanceur ne connait plus la sphere : il ne peut plus prendre sa
rasance pour une limite.

Il a fallu **32 tranches au lieu de 16** (la loi globale n'adapte plus sa finesse
a chaque rayon) et **4 pas par tranche** — deux auraient donne 0,199 % de
quadrature contre 0,07 % a l'ancienne marche, et on ne degrade pas la quadrature
pour economiser. Une ligne passe de 2,9 a 4,8 ms, une par image au lieu de deux.

Apres : **un niveau d'ecart au lieu de quarante-neuf**. A l'ecran, au zoom le
plus serre possible (0,0031°/pixel), le plus grand saut de l'image vaut 0,3
niveau.

---

## ⚠️ La re-saturation detruisait le degrade du crepuscule

Signale au Ventoux : « une transition tres bizarre entre le halo jaune qui est
intense, et la nuit noire ».

La physique etait juste — 0,428 lx a −8,5°, 0,041 a −10,3°, l'echelle de la
litterature — et aucun bleu negatif ne sortait du solveur. C'est la chaine
d'affichage qui cassait.

`DISPLAY_SATURATION` valait **1,4**, valeur heritee de l'atmosphere artistique
et appliquee **apres** la courbe de rendu. Elle envoie un canal sous zero des que
son ecart a la luminance depasse `luma/(S−1)` : au ras de l'horizon crepusculaire
le bleu ressortait a **−0,134**, ecrete a zero, et la bande devenait un aplat
orange sans degrade.

| Soleil | part du ciel ecretee | ecart introduit |
| --- | --- | --- |
| +30° | 0,0 % | 25 niveaux |
| 0° | 1,0 % | **127 niveaux** |
| −14° | **12,9 %** | 79 niveaux |

Borner la saturation au gamut ne suffisait pas : la borne vaut 1,13 en ce point,
et le bleu y ressort encore a zero. **`DISPLAY_SATURATION = 1`** : la chaine est
ACES puis sRGB, sans retouche. Le bleu vaut 72 sur 255 et le degrade existe.

Le controle qui epinglait 1,4 epingle maintenant la propriete qui l'interdit.

⚠️ Le meme signalement disait « le halo reste longtemps » : c'est voulu, et c'est
l'exposant d'adaptation — quarante fois moins de lumiere ne rend que 2,5 fois
plus sombre, parce qu'un ecran ne montre que deux des huit decades de la scene.

---

## La diffusion multiple cesse de fermer sa serie sur place

La table refermait la serie cellule par cellule — `Ψ_ms = L_f/(1 − f_ms)` —
ce qui suppose que ce qui repart pour un tour de plus **retombe au meme endroit**
du plan (altitude, angle solaire). De jour l'hypothese tient. Sous −10°, la
diffusion simple est nulle et la lumiere qui eclaire un point d'ombre vient d'air
ensoleille a des centaines de kilometres : elle ne tient plus du tout.

    Ψ^{n+1}(x) = ⟨ ∫ T(x,x') σ_s(x') Ψ^n(x') dt ⟩ sur 4π

`Ψ^n(x')` est lu **au point d'echantillonnage** et non au point calcule. Deux
ordres explicites suffisent — le troisieme ne deplace plus que 1,5 %.

L'angle solaire etait par ailleurs echantillonne uniformement en cosinus, soit
3,7° d'angle zenithal entre deux colonnes au terminateur, la ou la luminance
change d'un facteur deux par degre. Loi quadratique desormais, et deux fois plus
de colonnes.

### ⚠️ Les deux erreurs se compensaient

| configuration | −10° | −14° | chute par degre |
| --- | --- | --- | --- |
| l'ancien | ×0,65 | ×0,30 | **1,90 a 3,92** |
| le nouveau | ×0,64 | ×0,29 | **2,56 a 3,53** |

Les magnitudes n'ont presque pas bouge : une table sous-resolue surestimait, une
fermeture locale sous-estimait. Ce qui change est la **regularite** — et c'est
elle qu'on voyait, sous forme d'une transition abrupte entre le halo et la nuit.

Un controle la tient desormais : « le crepuscule s'eteint sans a-coups ».
L'ancienne table donnait ×1,54 a ×9,51 et passait tous les controles existants,
parce qu'aucun ne regardait la pente.

**Reste** : l'accord est bon jusqu'a −8° puis se degrade — ×0,64 a −10°, ×0,29 a
−14°, ×0,10 a −16°. Une table indexee sur (altitude, angle solaire) reste une
representation locale d'un champ qui ne l'est pas.

**Demarrage** : la premiere passe est traitee a part, car elle suffit a rendre la
table utilisable. Premier ciel a **6,0 s** au lieu de 12,1.

---

## ⚠️ La table jetait 93 % du ciel crepusculaire

Le « halo blanc post-crepusculaire », audite pixel par pixel.

La table de l'application et son recalcul independant s'accordaient a 6 % : le
materiau faisait bien ce qu'on croyait. Compare au **solveur direct**, en
revanche, la table rendait **7 % de la vraie valeur** au ras de l'horizon et
redevenait exacte au-dela de quatre degres. Le raccord entre les deux formait la
bande brillante signalee.

Cause : `AERIAL_FAR_M` valait 800 km, borne justifiee sur un rayon rasant **de
jour**. Au crepuscule, l'air proche est dans l'ombre de la Terre et toute la
lumiere vient de l'air lointain et haut — 93 % de la radiance est collectee
au-dela de 800 km a 0,09° de hauteur. La borne est desormais la longueur reelle
du plus long trajet, 1133 km arrondis a 1200.

Aucun controle ne l'avait vue : « la tranche lointaine est numeriquement le
ciel » ne tournait qu'a vingt degres de hauteur solaire. Il tourne maintenant
aussi a -6° et -15°.

Le meme controle a revele 8,5 % de residu de quadrature a -15° — l'ombre de la
Terre fait une arete franche dans l'integrande. Huit pas par tranche au lieu de
quatre : 1,0 %, pour 1,2 ms de plus par ligne.

**Echelle crepusculaire remesuree** (les chiffres de la veille passaient par la
table tronquee) : x0,98 a -6°, x0,72 a -8°, x0,70 a -10°, x0,71 a -12°, x0,33 a
-14°, x0,11 a -16°. Table et solveur direct s'accordent a 1 %.

L'audit a aussi etabli que le halo **n'est pas l'airglow** — 1 a 2 % du total
sous trois degres — et qu'il est gris parce que la desaturation scotopique vaut
100 % dans tout le ciel a ces luminances.

---

## Le halo qui ne s'eteignait pas etait une affaire de presentation

Ce n'etait ni la Lune — le meme halo apparait avec elle a −4° et 1 % eclairee —
ni un exces de lumiere : le moteur emet ×0,33 de la courbe de reference a −14°.
Un balayage en azimut montre une lueur strictement directionnelle, rapport neuf
entre la direction du Soleil et l'opposee : l'arche crepusculaire.

`DISPLAY_DECADES` valait **deux**. Meme ciel physique, a un degre au-dessus de
l'horizon vers le Soleil :

| Soleil | 2 decades | 3 decades |
| --- | --- | --- |
| −6° | 161 | 93 |
| −12° | **145** | 43 |
| −15° | **106** | 17 |

Le ciel perd un facteur mille entre −6° et −15° ; l'ecran passait de 161 a 106.
L'ecart jour-nuit n'etait pas represente dans la plage ou il se joue. A trois
decades la decroissance existe, et le jour ne bouge pas (250 contre 249).

**Prix assume** : la nuit profonde tombe a zero au lieu de rendre l'airglow a
quatre niveaux. C'est le contraste a l'interieur de l'image nocturne qu'on paye.

---

## Trois reglages choisis remplaces par trois grandeurs calculees

**Etoiles trop coloriees.** La desaturation scotopique ne vivait que dans le fond
de ciel ; les etoiles portaient la chromaticite pleine de leur corps noir. Une
source ponctuelle n'a pas de luminance — c'est l'oeil qui lui en donne une, en
l'etalant sur sa tache de diffusion. La tache, mal definie dans la litterature,
est **deduite** du seuil observationnel et vaut 2,25′, dans l'intervalle publie.
Sirius garde sa couleur, une etoile de sixieme magnitude n'en a plus (90 % de
batonnets).

**Lumiere cendree cent cinquante fois trop forte.** 0,012 pour la Lune, 0,003
pour les autres planetes — alors que rien n'eclaire leur face nuit. Elle se
calcule : `A·(R_T/d)²·Φ(α_terre)` plafonne a 8,4·10⁻⁵, soit 10,2 magnitudes sous
la face jour. Et la complementarite des phases, qui n'etait pas modelisee, fait
que la cendree est maximale sur un croissant fin et nulle sur une gibbeuse.

**La carte d'ombre prenait zero degre pour l'horizon.** Faux des qu'on prend de
l'altitude : un sommet reste eclaire quand la vallee ne l'est plus. Meme faute
que « les trois horizons », que la correction d'alors n'avait pas atteinte. La
borne est desormais la depression de l'horizon au point le plus haut du globe.

| Soleil | sommet 3000 m | plaine 500 m |
| --- | --- | --- |
| −0,9° | **eclaire** | a l'ombre |
| −2,6° | **eclaire** | a l'ombre |
| −3,2° | a l'ombre | a l'ombre |

---

## La radiance du ciel n'a plus qu'une expression

La face sombre de la Lune n'emet rien, et la Lune est **au-dela de toute
l'atmosphere** : tout ce qui diffuse est devant elle, rien n'est occulte. Sa face
nuit **est** le ciel, au sens strict — ce que montre n'importe quelle
photographie.

La grandeur etait ecrite deux fois : le fond de ciel sommait diffusion, airglow
et termes peints, le disque d'un astre ne reprenait que la diffusion. Six niveaux
sur 255 d'ecart, prouves en forcant a zero le halo lunaire peint — le ciel
tombait alors exactement sur la face nuit.

Un avion, lui, est **dans** l'atmosphere et cache la couche d'airglow : sa place
n'est pas la. La regle est : au-dela de l'atmosphere, le fond est le ciel entier.

| | ciel | face nuit |
| --- | --- | --- |
| plein jour | 131,3 | **131,3** |
| nuit | 21,0 | **20,9** |

Un controle tient desormais l'unicite : `aerialPerspectiveToSpace` ne doit avoir
qu'un seul appelant. Il a attrape un appelant restant des sa premiere execution.
⚠️ Il est structurel, non numerique — troisieme fois qu'une propriete vraie « par
construction » finit par ne plus l'etre faute d'un controle qui la tienne.

---

## Le relief simule inventait de la lumiere, et de plus en plus au zoom

La face a l'ombre d'un astre s'eclairait a mesure qu'on grossissait, jusqu'a
paraitre pleine. Ni la cendree, ni le halo, ni le voile, ni le bloom.

La carte d'albedo sert de carte de hauteur, et sans borne elle inclinait la
normale jusqu'a **42°** — bien au-dela de ce qu'une pente peut faire. Le zoom
l'aggravait : la difference finie entre texels est lissee par le filtrage quand
le disque est petit, pleine quand il est grand.

| champ | face nuit au-dessus du ciel |
| --- | --- |
| 2° a 0,3° | 0 |
| **0,15°** | **+48 niveaux** |

Preuve directe : a `uRelief = 0`, la face nuit reste au niveau du ciel a tous les
zooms.

**Pente bornee a 15°** — celle d'une surface lunaire a l'echelle d'un texel,
5,3 km de base. La propriete qui en decoule est geometrique : sous
`L = -sin(pente)`, aucune normale du cone ne voit le Soleil. Le controle le
verifie, et verifie aussi qu'au terminateur le relief accroche encore.

⚠️ L'amplitude reste dependante du zoom : la borne plafonne l'effet, elle ne le
rend pas invariant.

---

## Le maillage du terrain est plus grossier que la donnee qu'il lit

Signale : en zoomant vers l'horizon, il ne reste que « trois aretes qui se
battent en duel ».

Phase 0 du chantier `terrain-mesh-resolution` : **on ne corrige rien, on mesure**,
et on ecrit le controle qui retiendra la propriete une fois acquise.

### La propriete

> Le maillage n'est jamais plus grossier que la donnee qu'il echantillonne.

Si elle est fausse, aucune amelioration des tuiles ne se verra : le relief est
jete entre deux sommets. Charger plus fin, etendre un niveau ou streamer un
quadtree reviendrait a telecharger du detail que le maillage ne sait pas
dessiner.

### Ce que la mesure dit

Depuis le Ventoux, 1912 m — la ou le defaut a ete signale :

| distance | donnee | azimut | rapport | anneau | rapport |
| --- | --- | --- | --- | --- | --- |
| 2,2 km | 0,7029° | 0,7031° | **1,0x** | 1,8638° | 2,7x |
| 14 km | 0,1120° | 0,7031° | 6,3x | 0,4892° | 4,4x |
| 27,9 km | 0,0562° | 0,7031° | **12,5x** | 0,2433° | 4,3x |
| 112 km | 0,0562° | 0,7031° | **12,5x** | 0,0336° | 0,6x |
| 170 km (horizon) | 0,1481° | 0,7031° | 4,7x | **0,0028°** | 0,02x |

**L'azimut ne resout la donnee que jusqu'a 2,23 km.** Au-dela il saute des
cellules, jusqu'a douze au bord de chaque niveau de la pyramide. Le pas est
uniforme sur trois cent soixante degres et ignore le champ : a plein zoom on
paie des colonnes derriere sa tete et l'on n'en obtient aucune devant soi.

### ⚠️ Ce que la mesure a corrige

J'avais conclu que l'axe des distances etait « mesure correct, ne pas y
toucher ». **C'est vrai a l'horizon et faux avant.** Les anneaux y sont jusqu'a
**4,4x trop grossiers a 14 km** ; la conclusion initiale avait ete tiree du seul
champ lointain, et le chiffre annonce pour l'horizon — 0,026° — etait celui d'un
observateur au niveau de la mer, non d'un sommet a 1912 m.

Ce que les anneaux font bien, en revanche, merite d'etre garde : la hauteur
apparente du sol est **stationnaire a l'horizon**, sa derivee `h/d² − 1/2R` s'y
annulant. Les anneaux s'y resserrent donc d'eux-memes, a 0,0028° — cinquante
fois plus fin que la donnee, exactement la ou l'oeil regarde. Ce n'est pas un
reglage, c'est une consequence de la geometrie, et un controle la retient
desormais.

### Deux controles echouent volontairement

Ils enoncent la cible : le rapport doit descendre a un, et le pas d'azimut doit
se resserrer quand le champ se resserre. Un troisieme garde la **solution** :
le budget de sommets ne doit pas bouger. Resserrer l'azimut en multipliant les
colonnes rendrait la reconstruction plus longue que plusieurs images — elle
coute 18 ms pour 106 496 sommets, mesuree sous Node sur une pyramide remplie.

### Les references

`node scripts/shoot.mjs terrain-ventoux` — meme instant, meme visee, trois
champs : 20°, 2° et 0,5°. Tout y est constant sauf le grossissement, donc
**chaque difference entre ces trois images est un effet de resolution**.

La visee porte au nord-nord-est et traverse les deux frontieres de la pyramide,
a 28 et 112,5 km. L'heure n'est pas choisie pour la lumiere mais pour l'angle de
diffusion : a 08:00 UTC le Soleil est a quatre-vingt-dix degres de la visee,
soit le minimum du voile de Mie, dont le pic est vers l'avant.

⚠️ Le calque de relief est **eteint par defaut** : sans lui le composant n'est
pas monte, aucune tuile n'est demandee, et la capture montre une mer plate qu'on
prendrait pour un defaut de rendu.

---

## L'azimut du maillage suit desormais la camera

Phase 1 du chantier `terrain-mesh-resolution`. **Le budget de sommets n'a pas
bouge** : 512 colonnes x 208 anneaux, comme avant. Il est redistribue.

### La loi

Les colonnes sont equirepartis dans un parametre `t ∈ [−1, 1[`, puis deformees
autour de la visee par

    θ(t) = 2·atan( s·tan(π t / 2) )

dont la derivee s'ecrit sans tangente :

    pas(θ) = (360 / (N·s)) · ( s²·cos²(θ/2) + sin²(θ/2) )

Trois proprietes en font le bon choix, et aucune n'est cosmetique : elle est
**exacte et inversible**, elle **referme le cercle** — `t = ±1` donne le meme
point, verifie a 10⁻¹³ degre — et elle **degenere en uniforme** a `s = 1`, donc
le comportement d'avant est un cas particulier de la loi et non un chemin de
code separe.

⚠️ Un secteur fin a bord franc aurait ete plus simple, et faux : la densite y
sauterait d'un facteur dix en une colonne, et cette frontiere balaierait l'image
a chaque panoramique.

La concentration vaut `s = max(champ/2, 3°)/2` en radians. La marge de trois
degres n'est pas un confort : c'est **la latence de reconstruction convertie en
angle**, et elle sert de plancher sous trois degres de champ.

### Ce que ca donne

| champ | pas au bord du champ | contre la donnee | avant |
| --- | --- | --- | --- |
| 0,02° | 0,0184° | **0,33x** | 12,5x |
| 0,5° | 0,0185° | **0,33x** | 12,5x |
| 2° | 0,0205° | **0,36x** | 12,5x |
| 9° | 0,0552° | **0,98x** | 12,5x |
| 20° | 0,1221° | 2,2x | 12,5x |
| 110° | — | 10,3x | 12,5x |

A 0,5° de champ, le maillage est **38 fois plus fin** qu'avant, et il resout
desormais la donnee avec trois fois de marge.

⚠️ **La propriete ne peut pas tenir a tout champ**, et la limite se calcule : le
pas de bord vaut au mieux le demi-champ en radians, d'ou **9,2° de champ** a
budget constant. Le controle porte la condition dans son intitule plutot que
dans un commentaire.

⚠️ Ce qui est donne devant est pris derriere : a 2° de champ, le pas atteint 27°
a l'oppose de la visee. Invisible — mais seulement tant que la reconstruction
rattrape le panoramique.

### La reconstruction ne bloque plus

Le maillage se refait **pendant qu'on regarde**, et il coute dix-huit
millisecondes : d'un bloc, il aurait echange un defaut de resolution contre un
a-coup a chaque mouvement. Il est donc bati par tranches de vingt-quatre
anneaux dans un tampon a part, l'ancien restant affiche jusqu'a l'achevement.

⚠️ Une construction en cours n'est **jamais** abandonnee au profit d'une cle plus
recente : un panoramique continu changerait la cle a chaque image et le maillage
ne serait jamais fini.

La quantification de la visee est un quart de champ, donc **proportionnelle au
champ comme la vitesse de rotation de la camera** : les deux se compensent, et
le nombre de reconstructions par seconde de panoramique ne depend pas du
grossissement.

Mesure, panoramique continu de quatre secondes balayant deux champs entiers :

| champ | mediane | p95 | max |
| --- | --- | --- | --- |
| 0,5° | 16,6 ms | 19,1 ms | 21,7 ms |
| 2° | 16,6 ms | 19,2 ms | 21,4 ms |
| 20° | 16,5 ms | 19,4 ms | 21,9 ms |
| 110° | 16,7 ms | 19,9 ms | 25,3 ms |

Soixante images par seconde tenues, aucun a-coup.

### Ce que la phase 1 a rendu visible

Deux choses, attendues l'une et l'autre, et qui sont la matiere de la phase 2 :

- la **couture a 28 km**, ou le pas de la pyramide passe de 27 a 110 m. Elle
  etait noyee sous un maillage plus grossier qu'elle ; elle ne l'est plus.
- le **deficit des anneaux dans le champ proche**, jusqu'a 4,4x a 14 km. Les
  silhouettes de cretes y montrent desormais une marche d'escalier en distance,
  la ou l'azimut, lui, est devenu lisse.

---

## Le maillage obeit a une erreur d'espace ecran

Phase 2 du chantier `terrain-mesh-resolution`. Une constante gouverne desormais
le maillage : `MAX_SCREEN_ERROR_PX = 16`, le `maximumScreenSpaceError` par defaut
de CesiumJS, dont le critere de raffinement est

    SSE = erreur_geometrique × hauteur_ecran / (distance × 2·tan(champ/2))

### ⚠️ Ce que la phase 1 n'avait pas

Sa marge fine valait trois degres — une constante en **degres**. Sous six degres
de champ, c'est elle qui fixait la concentration, et la loi **cessait de suivre
l'ecran** : neuf pixels par colonne a deux degres de champ, mais trente-trois a
un demi. Elle arretait de zoomer sans que rien ne le signale.

La concentration se deduit maintenant, au lieu d'etre choisie. Apres :

| champ | erreur par colonne |
| --- | --- |
| 0,02° | 16,0 px |
| 0,5° | 16,0 px |
| 2° | 16,0 px |
| 9° | 8,8 px |
| 110° | 5,3 px |

Constante par construction dans le regime ou l'ecran commande, et **plus fine**
que la cible au-dela, ou c'est la donnee qui commande.

### Deux bornes, et la plus serree gagne

- **L'ecran** : une colonne ne doit pas depasser seize pixels, soit
  `k·champ/hauteur` degres. Elle commande a fort grossissement.
- **La donnee** : `DATA_FINEST_PITCH_DEG = atan(2/(CLIPMAP_SIZE−1))`, soit
  0,056°. Ce n'est pas une mesure mais une **propriete de construction de la
  pyramide** : chaque niveau couvre `2·halfSpan` avec `CLIPMAP_SIZE` cellules,
  donc les trois offrent le meme pas angulaire depuis le bord de leur domaine.

⚠️ Prendre la seule borne d'ecran laissait le maillage **trois fois plus
grossier que la pyramide a neuf degres de champ** — seize pixels y sont plus
larges qu'une cellule. Prendre la seule borne de donnee figeait la loi en
degres. Il faut les deux.

La concentration sort d'une equation du second degre : le pas au bord du champ
devant valoir la cible, `s²·c² − (cible/A)·s + n² = 0`. On prend la **racine la
plus grande**, qui atteint la cible avec le secteur fin le plus large, donc la
marge la plus genereuse. Discriminant negatif : la cible est hors d'atteinte a
budget constant, et l'on retombe sur `s = tan(bord/2)`, qui minimise le pas de
bord.

### ⚠️ Deux erreurs de la phase 1, trouvees en resserrant les controles

**Le seuil resolvable valait 9,2°, il vaut 5,7°.** Le controle mesurait le pas
au demi-champ **vertical** alors que l'azimut se compte a l'horizontale : il
etait plus indulgent qu'il ne croyait, d'un facteur egal au rapport d'aspect.

**La visee plongeante sortait du secteur fin.** Le champ porte par la camera est
vertical ; l'etendue en **azimut** qu'il couvre s'elargit en `1/cos(hauteur)`.
Vise vers ses pieds, un champ d'un degre couvre vingt degres d'azimut, et le
secteur fin dimensionne sur le seul champ les laissait dehors. Quatre controles
tiennent desormais la couverture, de zero a quatre-vingt-neuf degres de
plongee.

### Le dernier a-coup ne venait pas du calcul

Six megaoctets de tampons par reconstruction, plusieurs reconstructions par
seconde de panoramique : vingt megaoctets de dechets par seconde, et le
ramasse-miettes rendait une image a **132 ms** a champ large. Deux jeux de
tampons recycles en alternance l'ont supprime — on batit toujours dans celui que
la geometrie affichee n'utilise pas.

Panoramique continu, six secondes par mesure, 2160 images :

| champ | mediane | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| 0,5° | 16,6 ms | 20,2 ms | 22,5 ms | 22,9 ms |
| 2° | 16,6 ms | 20,1 ms | 21,6 ms | 24,6 ms |
| 20° | 16,7 ms | 19,9 ms | 20,9 ms | 24,6 ms |
| 110° | 16,6 ms | 20,6 ms | 23,4 ms | 29,7 ms |
| 0,5° au nadir | 16,5 ms | 20,4 ms | 22,6 ms | 24,2 ms |

### ⚠️ La reparametrisation des anneaux annoncee etait fausse

Elle ne sera pas faite, et c'est le resultat le plus utile de cette phase.

L'idee etait d'equirepartir les anneaux en **hauteur apparente**, ce qui revient
a leur donner une empreinte ecran constante. Calcul fait : les anneaux
couvriraient 71,7° de hauteur apparente entre le premier et l'horizon, ce qui
demanderait deux mille anneaux pour tenir seize pixels. Avec les deux cent huit
disponibles, le pas deviendrait **0,345° partout** — contre 0,0028° aujourd'hui
a l'horizon. Cent fois pire, exactement la ou l'oeil regarde.

Et la raison est plus profonde : sur l'axe des distances, **l'erreur n'est pas
geometrique mais topographique**. Ce qui fait l'erreur, ce n'est pas l'ecart de
hauteur apparente entre deux anneaux sur un sol plat, c'est le relief qu'ils
sautent — une crete entre deux anneaux est simplement absente. Cette erreur vaut
`pente × Δd/d`, donc elle est **constante quand `Δd/d` est constant** : c'est
exactement ce que fait un espacement logarithmique.

**La loi des anneaux est deja optimale au sens de la SSE.** Elle n'est pas mal
parametree, elle est **sous-dotee** : a raison 1,0685, l'erreur vaut environ 0,8°
pour une pente de 0,2, quand la cible en demande vingt fois moins. Aucune
redistribution ne corrige un facteur vingt ; seuls un budget different ou une
autre representation le feraient.

---

## Le nombre d'anneaux suit l'ecran, comme l'azimut

Phase 3. L'axe des distances passe sous le meme critere que l'azimut — non pas
en reparametrant la loi, ce qui aurait ete faux, mais en choisissant **combien**
d'anneaux dessiner.

### Ce que la mesure a tranche

Quatre cent seize anneaux au lieu de deux cent huit : a deux degres de champ,
l'escalier qui restait sur les silhouettes de crete disparait, et les versants
deviennent des surfaces continues. Le plafond d'allocation double donc,
**deliberement** — le controle qui l'interdisait a ete mis a jour avec la mesure
qui le justifie, pas contourne.

Ce plafond coute de la **memoire** — deux jeux de tampons recycles, huit
megaoctets — et non du temps.

### Le compte, lui, se deduit

L'erreur de l'axe des distances n'est pas geometrique mais **topographique** :
ce qui manque a l'image, c'est la crete que deux anneaux sautent. La hauteur
manquee vaut `pente × Δd`, vue sous `pente × Δd/d` — d'ou

    anneaux = 1 + ln(portee/proche) / ln(1 + cible/pente)

| champ | anneaux |
| --- | --- |
| 0,02° a 20° | 416 (plafond) |
| 60° | 156 |
| 110° | 89 |

⚠️ `CHARACTERISTIC_SLOPE = 0,2` est **la seule valeur posee** du module. Une
mesure de rugosite par region, calculee avec la pyramide, la remplacerait — c'est
ce que fait une erreur geometrique au sens strict. Au registre.

### ⚠️ `setDrawRange` borne le dessin, pas le televersement

A cent dix degres de champ, quatre-vingt-neuf anneaux suffisent — mais three
expediait au GPU tout ce que portait l'attribut, soit les quatre cent seize.
Douze megaoctets par reconstruction. Les attributs sont desormais construits sur
des `subarray`, qui n'exposent que la portion utile du meme tampon recycle sans
rien copier.

### Le transitoire qui reste, et que je n'explique pas

Vingt-quatre secondes de panoramique continu a cent dix degres de champ,
**1435 images** : une seule au-dessus de cinquante millisecondes, a 132 ms,
survenue a deux secondes puis jamais reproduite.

Isole par elimination — il ne survient qu'a champ large, **en panoramique**, et
**avec le terrain** :

| condition | images > 60 ms |
| --- | --- |
| 110° panoramique, terrain | **1** sur 355 |
| 110° panoramique, sans terrain | 0 |
| 110° statique, terrain | 0 |
| 20° panoramique, terrain | 0 |

Trois hypotheses ont ete testees et **refutees** : la taille du maillage (le
compte d'anneaux a ete divise par quatre sans effet), le volume televerse (les
`subarray` ne l'ont pas supprime), la pression memoire (les tampons sont
recycles). Ce qui reste plausible est un ramasse-miettes majeur sur les objets
de trois lui-meme, non mesure. Non explique, non recurrent, consigne.

### La dette de l'axe des distances, en pixels

Le critere permet enfin de la chiffrer. Erreur laissee par la crete sautee entre
deux anneaux, cible a seize pixels :

| champ | erreur | anneaux |
| --- | --- | --- |
| 0,02° | 17 320 px | plafond |
| 0,5° | 693 px | plafond |
| 2° | 173 px | plafond |
| 20° | 17 px | plafond |
| 60° | 15,9 px | 156 |
| 110° | 15,8 px | 89 |

Au-dela de vingt degres de champ la cible est tenue ; en deca elle ne l'est pas,
et **le facteur ne se rattrape pas** : tenir seize pixels a deux degres
demanderait quatre mille anneaux. C'est la limite de la representation radiale,
pas un reglage.

---

## Le clair de lune devient de la diffusion

Le socle nocturne etait peint : `uMoonGlow × uMoonFactor × (0,25 + 0,75·cos⁶)`,
une couleur d'interface et un cosinus a la puissance six. Il portait **3 a 25 %**
de la luminance du ciel une heure et demie apres le coucher au Ventoux, et ne
connaissait ni l'extinction, ni la diffusion de Mie vers l'avant, ni le
bleuissement loin de la source.

### Aucun modele nouveau

La diffusion est **lineaire en l'eclairement de la source**. Le ciel de pleine
Lune est donc, terme a terme, le ciel de jour avec le Soleil place ou est la
Lune, divise par cinq cent mille. Meme solveur, meme diffusion multiple, meme
colonne de transmittance — une seconde table de ciel, bidimensionnelle,
soixante-quatre par trente-deux, remplie deux lignes par image apres tout le
reste.

Tout tient dans un nombre, `moonToSunIrradianceRatio`, qui se recoupe par deux
chemins independants :

| grandeur | obtenu | publie |
| --- | --- | --- |
| eclairement de la pleine Lune au zenith | **0,267 lx** | 0,25 a 0,3 lx |
| rapport a l'eclairement solaire | 1/449 438 | ~1/400 000 |
| au premier quartier | 9,1 % de la pleine Lune | ~10 % |
| **brillance du ciel de pleine Lune** | **6,65·10⁻³ cd/m²** | 2,7 a 6,8·10⁻³ |

Le dernier traverse **tout** le solveur — geometrie, Rayleigh, Mie, ozone,
diffusion multiple. Une erreur d'echelle nulle part ailleurs ne passerait.

⚠️ Le `sin(hauteur)^0,8` de `lunarLux` n'y figure pas : ce facteur decrit
l'extinction sur l'eclairement recu **au sol**, et le solveur applique la sienne
le long de chaque trajet. L'inclure la compterait deux fois.

### ⚠️ L'exposition ne voyait pas la Lune

Premier rendu : le ciel gris uniforme, **toutes les etoiles effacees**. La
cause n'etait pas la physique mais l'adaptation — `meanSkyLuminanceCdPerM2`
etait relevee sur la seule table solaire, nulle la nuit. L'oeil restait donc
regle sur une nuit sans Lune, et le clair de lune y arrivait en saturation.

L'adaptation somme desormais les deux ciels, en une seule expression, pour la
meme raison que la radiance du ciel n'en a qu'une : deux exposants calcules a
deux endroits finissent par diverger.

### Ce que la geometrie rend d'elle-meme

Vise vers la Lune, le ciel est clair et s'eclaircit vers l'horizon — le trajet
y est plus long. Vise a l'oppose, il est nettement plus sombre. Aucun de ces
deux comportements n'est ecrit : ils sortent du transport, la ou un `cos⁶` peint
ne pouvait rendre ni l'un ni l'autre.

### ⚠️ Un defaut anterieur, rendu visible

Les etoiles sont eteintes **deux fois** : par `pointIntensity` pres de la
magnitude limite photometrique, et par l'exposition adaptative. La photometrie
est juste — 3,57 sous pleine Lune contre 4,0 publie, 6,59 sans Lune contre 6,5 —
mais le rendu en montre moins que la trentaine attendue. Tant que l'exposition
ne bougeait pas la nuit, le double comptage restait cache. Au registre.

### Ce qui reste peint

Le halo urbain, et lui seul. C'est une **emission** renvoyee par l'atmosphere,
que decrit le modele de Garstang (1989). Sa magnitude est deja ancree —
`lightPollutionLux` par classe de Bortle — c'est sa **distribution angulaire**
qui manque, et je ne vais pas l'inventer.

---

## La carte d'ombre : ce que la mesure a refuse

J'avais annonce que la carte d'ombre etait devenue le maillon faible visible, et
qu'il fallait la traiter en priorite. **La mesure ne le confirme pas**, et cette
page existe pour que personne n'y revienne sans raison.

### Le raisonnement de depart

La carte porte, en chaque point du sol, l'altitude a laquelle le Soleil se leve
au-dessus du relief. Elle couvre 120 km sur 512 points, soit **234 metres par
texel** — huit fois plus grossier que le relief lui-meme. Ramene a l'ecran, un
texte de cette carte couvre 201 pixels a trente kilometres et **1209 a cinq**,
quand une maille du terrain en occupe seize.

Le chiffre est juste. La conclusion qu'on en tire ne l'etait pas.

### Ce qui a ete construit, puis retire

Une seconde carte, dix fois plus etroite et donc dix fois plus fine — sept
kilometres, 27 metres par texel, exactement le pas du relief. Elle **herite** de
la carte large a sa frontiere : la recurrence du balayage ne demande au monde
exterieur qu'une seule chose, la hauteur d'ombre du voisin situe un pas vers le
Soleil, et tout ce qui est au-dela y est deja resume. Une carte etroite n'a donc
pas besoin de s'etendre vers le Soleil pour connaitre l'ombre d'un sommet
lointain.

C'etait juste, ca compilait, ca coutait cinq millisecondes de plus, et **ca ne
changeait rien** :

| comparaison | pixels modifies |
| --- | --- |
| banc synthetique, 10 000 points testes | **0** |
| relief reel, trois vues au lever du Soleil | **0,00 a 0,01 %** |

### Ce que la recherche a quand meme trouve

Le nuanceur appliquait une **tolerance de 300 metres** sur l'altitude avant de
tester l'ombre. Sans tolerance, une surface s'ombre elle-meme : la hauteur lue
est interpolee entre des points distants de 234 metres et depasse localement le
sol. Mais 300 metres, c'est deux fois et demie ce que cette raison exige, et
c'est pose et non deduit.

Or **une tolerance de trois cents metres interdit a toute ombre plus fine
d'exister**. Affiner la carte sans y toucher ne pouvait rien donner — ce qui
explique les zeros ci-dessus. Elle vaut desormais un demi-texel, calcule depuis
l'etendue de la carte : 117 metres.

Mesure du seul changement de tolerance, cascade constante : **0,92 %** des
pixels sur une vue au lever du Soleil, rien sur deux autres. Reel, mais petit.

### Pourquoi la cascade ne prend pas, et ce qu'il faudrait pour le savoir

Trois explications restent en lice, et **je ne les ai pas departagees** :

- le relief est lisse a ces echelles — le banc synthetique le montre nettement,
  zero point sur dix mille change de verdict ;
- le sol a moins de sept kilometres est rarement a l'ecran depuis un sommet : a
  six degres sous l'horizon on regarde deja dix-huit kilometres ;
- mes trois cadrages etaient mauvais, et un quatrieme montrerait autre chose.

Ce qu'il faudrait pour trancher : une vue ou une crete proche porte une ombre
franche sur une pente eclairee, a fort grossissement. Je n'ai pas su la
construire.

### La lecon, qui vaut au-dela de ce cas

**Un texel grossier n'est pas une erreur visible.** Le rapport 1209 pixels est
une propriete geometrique de la carte ; il ne dit rien de l'ecart entre l'image
obtenue et l'image juste. Les deux se confondent quand le contenu varie a
l'echelle du texel — ce qui etait vrai du maillage, ou l'azimut jetait douze
cellules de relief sur treize, et faux ici, ou l'ombre portee varie lentement.

C'est la difference entre mesurer une **resolution** et mesurer une **erreur**.
La premiere se calcule au tableau, la seconde se constate.

---

## Le relief proche passe a trois metres

Tu m'as demande le quadtree et le lidar. J'ai pris le lidar d'abord, et pour la
raison que la carte d'ombre venait de nous apprendre : **le quadtree sert a mieux
repartir la donnee, donc il faut d'abord prouver qu'une donnee plus fine change
quelque chose.** Si elle ne change rien, le quadtree meurt a bon compte.

### Ce que la source vaut

L'IGN diffuse pour la France un modele de terrain bien plus fin que les tuiles
mondiales. Mesure faite sur la tuile du Ventoux avant d'ecrire la moindre ligne
de rendu — denivele type entre deux points voisins :

| ecart entre points | denivele type |
| --- | --- |
| 27,4 m — ce qu'on avait | 7,81 m |
| 13,7 m | 3,98 m |
| 6,9 m | 2,01 m |
| **3,4 m** | **1,01 m** |

Le relief garde de la structure a toutes les echelles jusqu'en bas. Ce n'est pas
de l'interpolation lissee : c'est du terrain qu'on n'avait pas.

Le service repond sans clef d'acces, autorise les requetes depuis le navigateur,
et dit proprement « pas de donnee ici » par un 404 partout hors de France.
**Quatre-vingt-dix-neuf tuiles servies, aucun refus** au Ventoux.

### Ce qui a ete construit

Un champ proche de sept kilometres de cote a 3,42 metres — le pas exact de la
source a cette latitude. Huit megaoctets.

⚠️ **Il n'est pas un quatrieme niveau de la pyramide**, et ce n'etait pas un
detail d'organisation. Cette grille vient d'une autre source, d'une autre
projection — geographique et non Mercator —, stocke ses altitudes au quart de
metre et non au metre, et **n'existe qu'en France**. Prendre trois de ces
differences pour des details afin de gagner une case dans un tableau aurait
produit une abstraction qui ment. Elle se compose donc avec la pyramide au lieu
de s'y inserer, avec un fondu sur son bord.

⚠️ **Le quart de metre n'est pas de la coquetterie.** Le denivele type a 3,4
metres vaut 1,01 metre : arrondir au metre, comme le fait la pyramide, aurait
detruit la moitie de ce qu'on venait chercher.

### Ce que ca donne, et ce que ca ne donne pas encore

**Soixante-quatre pour cent des pixels changent.** La donnee passe, elle arrive
a l'ecran, elle n'est pas jetee en route.

Mais le sol proche reste **visuellement plat**. La raison est celle qu'on avait
deja chiffree et consignee : l'axe des distances du maillage. A trois kilometres
sept, deux anneaux consecutifs sont distants de cent vingt-quatre metres, quand
la donnee en decrit un tous les trois. En baissant les yeux on ne voit donc que
deux ou trois anneaux sur toute la hauteur de l'ecran — le meme defaut que les
« trois aretes » de l'azimut, transpose a la profondeur.

### Ce que ca dit du quadtree

Que **ce n'est toujours pas le moment**. Le goulot n'est pas l'allocation de la
donnee : c'est le maillage qui ne sait pas la montrer de pres. La suite logique
est de faire suivre la **repartition des anneaux** a la camera, exactement comme
l'azimut le fait depuis la phase 1 — concentrer les anneaux sur la bande de
distance regardee au lieu de les etaler du demi-metre a quatre cent cinquante
kilometres.

Le quadtree viendra apres, s'il vient : il repond a une question — quelles
tuiles charger — que personne ne se pose encore.

---

## Le mont Blanc a 288 kilometres, et une loi d'anneaux qui n'a pas tenu

### La loi essayee, et retiree

Apres le relief a trois metres, le goulot etait l'axe des distances : a
3,7 kilometres, un anneau tous les 124 metres pour une donnee tous les trois.
L'idee etait la meme que pour l'azimut — faire suivre la repartition a la
camera, en sondant le relief le long de la visee pour trouver la bande de
distances que l'ecran couvre reellement.

Sur le papier elle donnait ce qu'il fallait : un anneau tous les 2,8 metres a
3,1 kilometres au lieu de 124.

⚠️ **Elle a casse la vue a l'horizon**, franchement. Vu d'un sommet, l'ecran vise
l'horizon et la bande visible commence alors vers seize kilometres ; les
anneaux laisses en dessous doivent couvrir du demi-metre a seize kilometres, ce
qui donne **28 % d'ecart entre anneaux voisins**. Le relief proche devient une
facette geante qui masque tout le paysage.

Elle est retiree. Le principe reste juste, et l'erreur est identifiee : les
queues, en dehors de la bande, ne peuvent pas etre reparties en logarithme de la
distance. Elles doivent l'etre en **hauteur apparente**, qui est ce qui compte
pour ce qui sort de l'ecran. C'est la meme distinction resolution/erreur que
pour la carte d'ombre.

### Le banc que Jordan a propose

Le pic Cassini, sur le mont Lozere. Par temps clair on y voit le mont Blanc a
**288 kilometres**, et il y definit l'horizon vers le nord-est. C'est une
observation documentee, donc un temoin — pas un jugement a l'oeil.

**La geometrie tombe juste.** Le mont Blanc culmine a 4808 m ; la source le donne
a 4638 m au niveau le plus grossier. Depuis 1695 m, il doit apparaitre a
**-0,50°**, soit 0,71° au-dessus de l'horizon apparent. La silhouette rendue y
monte a **-0,517°** — un pixel d'ecart au champ de trois degres.

⚠️ **Sans preuve que ce soit lui.** Sa reponse a la hauteur de l'observateur
correspond plutot a une crete vers quarante-quatre kilometres, qui se trouverait
a la meme hauteur apparente. Distinguer les deux demanderait de suivre le sommet
en changeant d'azimut, ce qui n'a pas ete fait.

### Ce que la geometrie de l'eclairage change

La meme vue, deux heures :

| moment | ce qu'on voit |
| --- | --- |
| a l'aube, face au Soleil levant | tout delave, aucune crete lisible |
| au couchant, Soleil dans le dos | cretes etagees en bleu jusqu'a l'horizon |

Ce n'est pas un reglage : c'est le pic de diffusion avant de Mie. Viser le
Soleil, c'est regarder dans la direction ou l'air renvoie le plus de lumiere.

Sur le trajet reel vers le mont Blanc — qui monte a 4808 m et traverse donc de
l'air bien plus mince qu'un rayon rasant :

| distance | transmittance | voile / ciel |
| --- | --- | --- |
| 50 km | 46 % | 55 % |
| 120 km | 22 % | 82 % |
| 288 km | **9,8 %** | **96,7 %** |

Un sommet enneige eclaire par le couchant ressort donc **plus clair** que le
ciel, de quelques pour cent. C'est au ras du seuil de l'oeil, et c'est
probablement juste : ces observations demandent des conditions exceptionnelles.

### Une couture trouvee en chemin

Une **ligne sombre horizontale traverse l'image a zero degre d'elevation exact**,
visible sur toutes les vues lointaines. Ce n'est pas l'horizon — qui est a
-1,21° depuis cette altitude — mais le bord de la calotte du globe, qui s'ouvre
a l'horizontale. Au registre.

---

## La ligne d'horizon devient un maximum

C'est la reponse au constat de Jordan : zoome sur le mont Blanc et compare a un
logiciel de panorama, **rien ne coincide**. Ce n'etait pas la resolution, ni la
geodesie.

### Deux operations, pas deux qualites

Un logiciel de panorama calcule la ligne d'horizon comme le **maximum** de
hauteur apparente le long du rayon. Le maillage prenait **un echantillon** tous
les anneaux. Ce ne sont pas deux qualites de la meme chose.

A 286 kilometres, les anneaux sont espaces de 9,7 km. Ligne d'horizon vraie,
marchee tous les 400 metres : **−0,464°**, portee par le mont Blanc. Ce que
donnait l'echantillonnage, selon ou tombait la phase :

| decalage | horizon obtenu | distance | ecart |
| --- | --- | --- | --- |
| 0 % | −0,710° | 177 km | −0,246° |
| 20 % | −0,537° | 285 km | −0,073° |
| 40 % | −0,689° | 287 km | −0,225° |
| 60 % | −0,685° | 163 km | −0,221° |
| 80 % | −0,665° | 165 km | −0,201° |

**Trois fois sur cinq, ce n'etait meme pas la bonne montagne** — et laquelle
dependait d'une phase qui bouge avec l'altitude de l'observateur. D'ou
l'impression, juste, que rien ne correspond.

### Le geste

Chaque anneau ne prend plus l'altitude **a** sa distance, mais le point le plus
haut de **sa tranche de profondeur** — les mi-distances geometriques avec ses
voisins. Les tranches partitionnant exactement la portee, le maximum sur leur
union est le maximum sur tout le rayon.

Le nombre de sondages se deduit : assez pour ne sauter aucune cellule de la
pyramide, plafonne a huit. Pres de l'observateur la tranche est plus mince
qu'une cellule et **un seul sondage suffit** — la loi contient donc exactement
celle d'avant.

### La mesure

Ligne d'horizon rendue depuis le pic Cassini, comparee au profil vrai sur
vingt-cinq azimuts :

| | erreur quadratique |
| --- | --- |
| un sondage partout | 0,130° |
| enveloppe partout | 0,105° |
| **enveloppe au-dela de 130 km** | **0,067°** |

⚠️ **La premiere version enveloppait partout, et c'etait faux deux fois.** Elle
degradait la surface proche — plateaux plats separes de falaises, la capture de
reference l'a montre sans appel — et elle degradait aussi la **silhouette** la
ou celle-ci est portee par une crete proche, que l'enveloppe relevait a tort.
Restreindre l'enveloppe au-dela de 130 km corrige les deux.

Le detail, sur la version retenue :

| azimut | avant | apres |
| --- | --- | --- |
| 53,54° | −0,181° | **−0,014°** |
| 54,33° | −0,069° | **−0,004°** |
| 55,93° | −0,068° | **−0,006°** |
| 56,73° | −0,070° | **−0,023°** |

Quatre azimuts sur cinq passent d'un dixieme de degre a quelques millièmes.

### Ou s'arrete l'enveloppe, et pourquoi la

Prendre le point le plus haut d'une tranche remplace le relief par son
**enveloppe superieure**. C'est ce qu'on veut au loin, ou seule la silhouette se
lit ; c'est un desastre de pres, ou les versants deviennent des mesas.

C'est le contraste qui tranche — ce qui reste de la luminance propre du relief
apres l'extinction, mesure au Ventoux :

| distance | contraste restant |
| --- | --- |
| 56 km | 40 % |
| 113 km | 15 % |
| **175 km** | **5 %** |
| 250 km | 1,9 % |

⚠️ Le seuil de dix pour cent est un **jugement**, pas une mesure : il place la
bascule vers 130 km. En deca on echantillonne, au-dela on enveloppe. Les
silhouettes fautives mesurees se trouvaient a 163, 165, 177 et 286 km — toutes
au-dela.

⚠️ Le cinquieme — celui du mont Blanc — reste a 0,18°. Deux explications
plausibles, non departagees : son contraste est si faible, transmittance 9,8 %
et voile a 96,7 %, que le detecteur de silhouette lui prefere probablement une
crete plus proche et plus nette ; et un sommet plus etroit que l'ecart entre
deux sondages reste rabote — le controle le chiffre a 43 % sur une bosse de
synthese.

**Le maximum par tranche borne l'erreur, il ne l'annule pas.**

### Ce que ca coute

Trois fois et demie plus de sondages du relief. Panoramique continu, huit
secondes par champ :

| champ | mediane | p99 | max |
| --- | --- | --- | --- |
| 0,5° | 16,7 ms | 23,7 ms | 27,2 ms |
| 2° | 16,8 ms | 24,2 ms | 26,6 ms |
| 20° | 16,7 ms | 23,2 ms | 24,5 ms |
| 110° | 16,7 ms | 27,5 ms | 91,1 ms |

Aucune degradation : la construction etant deja etalee sur plusieurs images,
elle absorbe le surcout. Le pic de 91 ms a champ large est le transitoire connu,
une image sur 476.

### ⚠️ Deux erreurs de mesure, de moi, sur le chemin

**J'ai vise le mauvais azimut.** J'avais calcule 56,43° en projetant a plat ; le
vrai azimut geodesique est **55,13°**. Un degre et demi d'ecart, soit 6,5 km de
cote a 286 km — une autre montagne. Ma conclusion precedente « le mont Blanc est
rendu au bon endroit » etait une coincidence, et elle est retiree.

**Mon detecteur de silhouette mesurait le ciel.** Il comparait chaque ligne au
ciel pris tout en haut de l'image ; le ciel ayant son propre degrade, il
declenchait dessus des que la crete etait basse. Il cherche desormais la
**marche** verticale.

---

## Le sol recoit une texture de normales, assumee fausse

Demande : une gestion plus fine de la lumiere sur le terrain, pour ne plus avoir
de grands aplats en plaine. Le motif est **invente** et c'est assume — ce qui ne
l'est pas, c'est son amplitude.

### L'amplitude sort d'une mesure

Pente efficace relevee sur des tuiles RGE ALTI a 3,4 metres :

| site | pente efficace |
| --- | --- |
| Beauce, plaine cerealiere | 0,012 — 0,7° |
| Camargue, delta | 0,017 — 1,0° |
| Landes, plaine boisee | 0,017 — 1,0° |
| Vallee du Rhone | 0,087 — 5,0° |
| Mont Ventoux | 0,291 — 16,2° |

Une plaine francaise vit donc entre un et cinq degres. La valeur retenue, 0,06,
tombe dedans : le motif ne decrit rien, son ampleur est celle d'une vraie
plaine.

⚠️ Elle reste un **choix**, pas une deduction. Au registre.

Et la pente ne depend pas de l'echelle — exposant de Hurst **0,980** sur un
facteur huit — ce qui rend l'extrapolation sous la resolution du modele
numerique legitime en statistique, sinon en geographie.

### Trois pieges, tous rencontres

**La frequence collee au pixel fait nager le motif.** Premiere version : la
maille du bruit suivait continument l'empreinte du pixel, donc son echelle
changeait avec la distance et le motif se deformait des que la camera bougeait,
comme une salissure sur l'ecran. Les echelles sont desormais **quantifiees en
octaves**, comme un mipmap : le motif est ancre dans le monde, et l'on ne fait
que fondre d'une octave a la suivante.

**Le hachage ecrit d'instinct a une structure.** `sin(a·x + b·y)` est constant
le long des droites `a·x + b·y = cte`, et le sol se couvrait de hachures
obliques bien visibles. Le remplacant — melange de composantes — n'etait pas
meilleur sur une grille d'entiers. Mesure sur quarante mille noeuds :

| hachage | moyenne | pire correlation |
| --- | --- | --- |
| melange puis repliement | 0,374 | 0,336 |
| sinus d'une somme | 0,501 | 0,013 |
| **treillis entier** | **0,502** | **0,005** |

**Un entier injecte dans le GLSL casse le nuanceur en silence.** JavaScript rend
`0.0` comme `"0"`, et GLSL refuse de l'affecter a un `float` : le fragment ne
compile plus et le terrain disparait. Le defaut ne se montre jamais pendant
qu'on regle une valeur fractionnaire, et toujours quand on la met a zero pour
comparer — ce qui est arrive, et a produit une mesure de reference invalide.
Un controle verifie desormais que chaque constante porte son point decimal.

### Ce que ca donne

Contraste local, mesure au Ventoux vers la plaine du Comtat :

| vue et zone | avant | apres |
| --- | --- | --- |
| champ 25°, sol proche | 0,16 | **5,64** |
| champ 25°, plaine lointaine | 0,27 | 0,28 |
| champ 6°, sol proche | 0,14 | 0,42 |
| champ 6°, plaine lointaine | 0,22 | 0,26 |

Aucun cout mesurable : mediane 16,7 ms, maximum 26 ms a tous les champs.

### ⚠️ Ce que ca ne donne pas, et pourquoi c'est correct

**Au loin, presque rien.** La demande portait surtout sur les plaines
lointaines, et c'est la que l'effet est le plus faible — un facteur 1,0 a 1,2
contre 3 a 36 de pres.

Ce n'est pas un defaut du micro-relief : c'est que **la texture d'une surface
est attenuee par la transmittance**, qui vaut 15 % a 113 km et 5 % a 175 km. A
ces distances, ce qu'on voit n'est plus le sol mais le voile. Forcer du contraste
la reviendrait a peindre ce que l'atmosphere retire — exactement l'astuce que le
projet s'interdit.

Si les plaines lointaines paraissent uniformes, c'est parce qu'elles le sont.

---

## Le sol prend la couleur du sol reel — sa couleur seulement

L'orthophotographie de l'IGN est drapee sur le terrain. Pas comme une image :
comme une **teinte**.

### ⚠️ Une orthophoto n'est pas un albedo

C'est une image deja eclairee. Elle porte le Soleil du jour de la prise de vue,
ses ombres portees, et la balance des couleurs du traitement. La brancher telle
quelle sur `sortante = albedo × eclairement / π` reviendrait a **compter la
lumiere deux fois** — on descendrait le Soleil au couchant, et les ombres de
midi resteraient cuites dans le sol, contredisant tout le travail d'ombre porte.

On n'en garde donc que la **chrominance** :

    teinte = ortho / luminance(ortho)
    albedo = albedoPhysique × teinte

Les champs, les bois, la roche nue, l'eau et les villages peignent la couleur ;
le moteur garde toute la brillance. Un controle tient la propriete qui separe ce
drape d'une astuce : **la teinte est de luminance exactement un**, donc l'image
ne peut pas apporter de lumiere. Une ombre cuite dans la photo a une teinte
presque neutre, et son effet est presque nul.

⚠️ Ce qu'on perd avec la luminance : les vrais ecarts d'albedo, une foret a 0,08
contre un calcaire a 0,35. Au registre.

### La source

`HR.ORTHOIMAGERY.ORTHOPHOTOS` sur la Geoplateforme — la meme que le RGE ALTI,
sans clef, avec CORS ouvert. Sa grille est `PM_6_19`, le **pseudo-Mercator** :
la meme projection que les tuiles d'altitude, donc aucune trigonometrie
nouvelle.

⚠️ Le satellite proprement dit — SPOT 2025, Pleiades 2025 — repond 400 : acces
restreint. L'imagerie aerienne est de toute facon plus fine.

### ⚠️ La couverture comptait plus que la finesse

Premiere version : zoom quinze, 3,4 metres par pixel sur sept kilometres, la
maille du champ proche d'altitude. Mesure depuis le mont Ventoux — le drape ne
changeait que **0,2 %** de la chrominance.

La raison etait bete : depuis un sommet a 1912 metres, **presque rien de ce
qu'on voit n'est a moins de trois kilometres et demi**. Le domaine ne croisait
pas l'image.

Zoom treize : 13,7 metres par pixel sur vingt-huit kilometres, l'etendue exacte
du niveau fin de la pyramide. A cinq kilometres un pixel y sous-tend 0,16 degre
— amplement suffisant pour une couleur, qui n'a pas besoin de la resolution
qu'exige une silhouette. Quatre-vingt-une tuiles, comme avant.

⚠️ La demi-etendue **depend de la latitude** : le pseudo-Mercator se resserre en
`cos(latitude)`. Vingt-huit kilometres en France, vingt a Reykjavik. Ce n'est
donc pas une constante mais une valeur publiee avec la mosaique.

### La mesure

Depuis Carpentras, dans la plaine du Comtat :

| | |
| --- | --- |
| pixels changes | **100 %** |
| chrominance | **+3,0 %** |
| luminance | +6 niveaux sur 255 |

⚠️ La luminance devait rester intacte, et elle bouge de trois pour cent. **Ce
n'est pas un defaut** : la teinte est bien de luminance unite, mais l'eclairement
solaire est spectral. Un albedo decale vers le vert renvoie moins sous une
lumiere rougie par l'atmosphere. C'est la couleur de l'illuminant qui parle, et
c'est physiquement juste.

### Ce qui reste

⚠️ **France seulement**, comme le RGE ALTI. Ailleurs le service repond 404 et
l'albedo reste celui du modele.

Et **rien au-dela de vingt-huit kilometres**, ou de toute facon la transmittance
efface la couleur du sol comme elle efface sa texture.

---

## Le sol emet — les lumieres des villes

Jusqu'ici le sol ne faisait que **renvoyer** de la lumiere. Il en **emet**
desormais la nuit, la ou les hommes en mettent. Le terme s'ajoute a la radiance
sortante, donc il traverse l'atmosphere par le meme chemin que le reste : une
ville a trente kilometres sort attenuee et rougie sans qu'on ecrive une ligne
pour cela, et une crete qui la masque la masque.

### Trois questions, trois reponses independantes

**Ou ?** Le fond de carte OSM sombre de terrestris, en WMS, sans clef.

**Combien ?** L'**EN 13201-2** fixe la luminance moyenne d'une chaussee
eclairee : 2,0 cd/m² en classe M1, 1,5 en M2, **1,0 en M3**, 0,75 en M4, 0,5 en
M5. La M3 est la classe urbaine courante.

**De quelle couleur ?** Un spectre de Planck a 2700 K, **remis a l'echelle pour
porter exactement la luminance de la norme**, puis converti par le meme
operateur spectral que le Soleil et le ciel. Ce n'est pas une couleur choisie
dans un nuancier : la couleur et l'intensite sortent ensemble d'une chaine
photometrique, sans constante d'ajustement.

Verification : le spectre remis a l'echelle porte 1,0000 cd/m², sa temperature
de couleur se retrouve a 2700 K, et son rapport rouge/bleu vaut 10.

### ⚠️ La carte n'est pas noire

Elle est gris fonce. Le mode de son histogramme vaut **48 sur 255**, identique
au Causse Mejean desert, en foret de la Sainte-Baume, a Avignon et a Marseille —
c'est une constante du style, pas une estimation. On la nivele donc a zero, sans
quoi la campagne entiere brillerait presque autant que les villes.

Ce qui depasse suit l'urbanisation : 4,8 % du Causse, 13 % de la foret, 26 %
d'Avignon et de Marseille.

### ⚠️ Une seule carte ne pouvait pas suffire

La premiere version en avait une, a cent kilometres, soit 98 metres par pixel.
Le resultat etait juste au loin — villages et routes a leur place — et **faux au
premier plan** : le sol proche visible tient dans une poignee de texels autour du
centre de la carte, et le centre, c'est l'observateur. La route qui monte au
Ventoux allumait alors tout le paysage proche d'un seul tenant.

Deux echelles desormais : quatorze kilometres a 13,7 metres par pixel, ou une
route occupe un texel et non une region ; cent kilometres a 98 metres, qui porte
les villes que la premiere ne voit plus. Fondu sur la frange.

### Ce qui reste approche

⚠️ **La temperature de couleur est un choix dans un intervalle reglementaire.**
L'arrete du 27 decembre 2018 plafonne l'eclairage exterieur francais a 3000 K,
2700 K en peripherie de parc national, 2400 K dans les coeurs. Le sodium haute
pression encore en service tire vers 2000 K.

⚠️ **Un spectre de Planck n'est pas un spectre de lampe.** Le sodium emet des
raies, un blanc LED un pic bleu et un phosphore. La courbe de Planck en
reproduit la couleur, pas la structure — et l'extinction dependant de la
longueur d'onde, l'ecart n'est pas nul.

⚠️ **La carte exagere la surface eclairee.** Une route y est dessinee a la
largeur du trait cartographique, pas a la sienne. La repartition est juste,
l'aire eclairee surestimee.

### Ce que ca ouvre

Le halo urbain reste **peint** — la derniere couleur d'interface du ciel de
nuit. Une carte d'emission geolocalisee est precisement l'entree qui manque pour
le calculer : le dome cesserait d'etre une teinte pour devenir la lumiere
d'Avignon diffusee par l'air, au bon azimut et a la bonne distance.

---

## Les lumieres s'allument au crepuscule, eclairent l'air, et cessent d'etre des points

Trois defauts du premier jet, corriges.

### Le terminateur n'est pas une limite en degres

Les lampes etaient allumees en permanence. Elles suivent desormais un **seuil
d'eclairement** — ce que mesure la cellule photoelectrique qui les commande —
et non la hauteur du Soleil. Le critere s'adapte ainsi de lui-meme a la saison
et a la latitude.

⚠️ Premiere tentative avec les bornes d'**une** cellule, vingt et quarante lux :
la bascule tenait dans **un degre** de hauteur solaire, quatre minutes, et
dessinait une frontiere nette au sol. C'est le comportement d'une lampe, pas
d'un paysage — qui en porte des dizaines de milliers, sur des circuits
differents, des cellules reglees differemment, une part sur horloge.

Bornes elargies a cinq et cent lux, ce qui etale la bascule sur trois degres :

| hauteur du Soleil | part allumee |
| --- | --- |
| −2° | 0 % |
| **−3°** | **47 %** |
| −4° | 92 % |
| −5° | 100 % |

⚠️ L'elargissement est **assume** : ce qui est mesure, c'est le seuil d'une
cellule ; ce qui est pose, c'est la dispersion du parc.

### Les lampes eclairent l'air, pas seulement le sol

C'est ce qui fait le halo qu'on voit d'une ville a distance, et il ne vient pas
de ses pixels mais de l'atmosphere entre elle et l'oeil.

Le compte se boucle **sans constante libre**. Un sol lambertien de radiance `L`
emet une exitance `πL` ; au-dessus d'un plan emetteur etendu, l'eclairement ne
depend pas de la hauteur. L'air en diffuse vers l'oeil ce qu'il **eteint**,
c'est-a-dire la chute de transmittance du segment. En diffusion isotrope, le
quart de `1/4π` compense le `π` de l'exitance :

    lueur = L × (T_avant − T_apres) / 4

⚠️ Trois approximations, toutes assumees : diffusion **isotrope** — vraie pour
Rayleigh, fausse pour le pic avant de Mie ; albedo de diffusion suppose
**unite**, donc pas d'absorption ; **plan emetteur infini**, ce qui surestime
pres du bord d'une ville.

### Le flou, en metres au sol

La carte rend des traits nets ; une lampe eclaire une tache. Dix-sept
prelevements sur deux couronnes, de rayon cinquante metres — la portee utile
d'un lampadaire urbain. Le rayon etant en **metres au sol** et non en pixels, le
flou appartient au paysage et ne se deforme pas au zoom.

⚠️ Il ne pouvait pas etre applique a la lueur dans l'air : celle-ci se calcule
sur chaque segment du trajet, et dix-sept prelevements par carte et par segment
faisaient **plus de deux cent soixante-dix par pixel**. La lueur prend donc un
seul prelevement — une integrale le long du rayon lisse deja tout ce que le flou
lissait.

### ⚠️ Et une limite que la correction ne traite pas

Le premier plan du Ventoux s'allumait en entier. Verification en changeant de
site : **Causse Mejean 0,0 niveau, Ventoux 29,9** — le modele faisait ce qu'il
annonce, et c'est le proxy qui sur-attribue. OSM connait la route du sommet, la
tour et l'observatoire ; il ne sait pas qu'aucun n'est eclaire la nuit.

Le flou donnant deja la densite locale, l'elever a une puissance separe le trait
isole du tissu dense. Balayage depuis le Ventoux :

| exposant | plaine (villes) | premier plan (route isolee) |
| --- | --- | --- |
| 1,0 | 13,5 %, max 139 | **100 %**, max 38 |
| 1,3 | 13,3 %, max 120 | **100 %**, max 14 |
| **1,6** | **4,4 %, max 102** | **13 %, max 4** |
| 2,0 | 0,02 %, max 48 | 0 %, max 0 |

⚠️ **Aucun exposant ne separe proprement**, et c'est le signe que la correction
ne traite pas la cause : la carte dit *bati*, pas *eclaire*. A 1,6 le premier
plan s'eteint et les coeurs de villes tiennent, mais des villages disparaissent
au passage. Une carte de radiance nocturne mesuree — VIIRS — rendrait tout ceci
inutile.

Cout de nuit, panoramique continu : mediane 16,6 ms, p99 22,5 ms.

### ⚠️ Une lecon de methode, deux fois payee

Un premier balayage de l'exposant a donne des chiffres **non monotones** —
exposant 1 et 2 rendant le meme resultat. La cause n'etait pas physique : les
modifications du fichier n'atteignaient pas le navigateur assez vite, et je
mesurais l'etat precedent. Le balayage n'a ete refait qu'apres avoir **verifie
ce que le serveur servait reellement** a chaque pas.

---

## Le ciel profond cesse d'ignorer l'atmosphère, perd ses couleurs, et reçoit de vraies images

Signalé : la lueur des objets du ciel profond semble ignorer l'atmosphère, et ils
sont trop colorés. Les deux sont vrais, et le second est pire que « trop
coloré ».

### ⚠️ Le seul calque sans transport

Le nuanceur du ciel profond ne contenait **aucun** terme atmosphérique — ni
extinction, ni transmittance, ni voile. Les étoiles, les astres, le fond de ciel
et le terrain y passent tous ; celui-là seul y échappait. Une galaxie brillait
donc autant à l'horizon qu'au zénith.

Le reste de sa photométrie était pourtant juste : l'opacité d'un objet étendu
vient du **contraste** entre sa brillance de surface et celle du fond de ciel,
ce qui est la bonne grandeur. Il ne lui manquait que l'extinction.

Pour une source **étendue**, celle-ci s'applique à la brillance de surface
exactement comme à une magnitude — elle atténue la radiance le long du rayon, et
l'angle solide, lui, ne change pas :

    mu_observée = mu_intrinsèque + k · X

Ce que ça donne pour M31, sur un ciel à 21,5 mag/arcsec² :

| hauteur | perte | contraste |
| --- | --- | --- |
| 90° | 0,28 mag | −0,78 |
| 30° | 0,56 mag | −1,06 |
| 10° | 1,56 mag | −2,06 |
| 5° | 2,86 mag | −3,36 |

Elle fond donc en descendant, au lieu de rester identique.

### La couleur ne venait pas d'une mesure mais de la charte graphique

Chaque type d'objet recevait un jeton CSS — `--app-dso-galaxy`,
`--app-dso-nebula-emission`. Toutes les galaxies partageaient une teinte.

Et physiquement, c'est doublement faux : **à l'œil nu, un objet du ciel profond
est gris**. Sa brillance de surface le place en plein régime scotopique, où les
cônes ne répondent plus ; seule une pose longue révèle une couleur.

La conversion qui le montre n'introduit **aucune constante** — `ZERO_MAGNITUDE_LUX`
sert déjà aux étoiles, le reste est de la géométrie :

    L = E_mag0 · 10^(−0,4·mu) / arcsec²

Recoupement : 22 mag/arcsec² rend **1,71·10⁻⁴ cd/m²** contre 1,7·10⁻⁴ publié
pour un ciel très noir.

| objet | brillance | luminance | part de gris |
| --- | --- | --- | --- |
| **cœur de M42** | 13 mag/arcsec² | 6,8·10⁻¹ cd/m² | **17 %** |
| M31, cœur | 20 | 1,1·10⁻³ | 100 % |
| M31, bras | 22 | 1,7·10⁻⁴ | 100 % |

⚠️ **La loi prédit la seule exception connue.** Le cœur de M42 est le seul objet
à franchir le plafond scotopique, et c'est précisément le seul dont les
observateurs rapportent une teinte à l'œil nu. Rien n'a été réglé pour obtenir ce
résultat : il tombe de la même loi mésopique que les étoiles et le fond de ciel.

### Les vraies images : un atlas de 548 profils

À la place du noyau gaussien et de son halo, les relevés eux-mêmes. Le service
**hips2fits du CDS** rend n'importe quelle vignette du DSS2 rouge, sans clef.
548 objets dépassent cinq minutes d'arc — en deçà, aucune image ne les
distinguerait d'une tache. L'atlas est construit **hors ligne** et livré avec
l'application : **2,58 Mo, 548 tuiles, aucun échec, 27 s de fabrication**.

#### ⚠️ Une plaque photographique n'est pas une carte de radiance

Le même piège que l'orthophoto drapée sur le terrain. La lire comme une
luminance contredirait la photométrie ci-dessus, qui déduit déjà la brillance de
surface de la magnitude et des dimensions du catalogue.

L'atlas ne porte donc que le **profil** : où est la lumière dans l'objet, ramené
à une moyenne de un sur l'ellipse. L'octet stocke `log10` de ce profil, ce qui
revient à un **écart de magnitude** par rapport à la brillance moyenne :

    mu_locale = mu_moyenne − 2,5·log10(p) = mu_moyenne + 5 − 10·q

Dix magnitudes sur 255 niveaux, soit **0,039 magnitude** par niveau, du cœur au
halo. Un premier jet stockait le profil linéairement : le rapport pic sur
moyenne atteignait **9 241** sur une tuile, où le pas de quantification valait
alors trente-six fois la moyenne.

Le service est interrogé en **FITS** pour la même raison : il rend les valeurs
linéaires du relevé, quand un PNG ou un JPEG imposeraient au profil une courbe
de contraste arbitraire et écrêteraient les percentiles extrêmes.

#### L'orientation a été mesurée, pas supposée

Je tenais pour acquis que passer l'angle de position du catalogue amènerait le
grand axe à la verticale de la tuile. Faux, et du mauvais côté. Angle du grand
axe mesuré par les moments d'ordre deux, compté depuis le haut :

| objet | PA catalogue | rot = 0 | rot = +PA | rot = −PA |
| --- | --- | --- | --- | --- |
| NGC 247 | 167° | 9,9° | 23,1° | **176,1°** |
| NGC 891 | 22° | 156,2° | 134,7° | **177,4°** |
| NGC 3109 | 93° | 90,3° | 178,1° | **4,9°** |
| NGC 4236 | 161° | 22,3° | 40,4° | **1,7°** |

À `rotation_angle = 0` le service rend déjà le nord en haut et l'est à gauche ;
c'est **`−PA`** qui redresse le grand axe. Confirmé par un second chemin : la
matrice de passage du FITS de M31 porte une rotation de +35° quand on demande
−35°. Sur l'atlas complet, l'écart médian du grand axe à la verticale vaut
**3,1° sur 154 objets allongés**.

#### Le fond de ciel, mesuré là où le catalogue dit qu'il n'y a rien

La tuile couvrant exactement le grand axe, l'ellipse y est inscrite : ses coins
sont hors de l'objet. La médiane y est prise comme niveau de ciel, puis
soustraite — même geste que pour la carte des lumières urbaines.

#### Relecture de ce qui est livré

La moyenne du profil vaut un **par construction** : raison de plus pour la
vérifier sur les octets écrits, entre lesquels se glissent l'encodage
logarithmique, le plancher à deux décades et l'arrondi à huit bits. Écart
maximal sur les 548 tuiles : **0,9 %**, soit 0,01 magnitude, sur NGC 1499.

Et à l'écran, M31 depuis Paris cesse d'être une ellipse floue : le disque
incliné, la bande de poussière, le noyau, M32 et M110 par leurs propres tuiles.
Seule sa partie centrale ressort, ce qui est la bonne réponse — sa brillance
moyenne de 22,30 mag/arcsec² passe sous le seuil de contraste d'un ciel de
ville, et seules les régions dix fois plus brillantes que la moyenne le
franchissent.

### ⚠️ Un nuanceur livré qui ne compilait pas

L'extinction et la couleur ont été commitées (`93a41fb`) avec un fragment qui
appelait `airmassAt`, laquelle vit dans la table de réfraction incluse dans le
seul nuanceur de sommets. Validé en TypeScript, jamais fait tourner. Corrigé en
calculant la masse d'air au sommet et en la passant en varying — c'est déjà ce
que font les étoiles.

⚠️ **La leçon** : une suite de validation qui reproduit une loi en TypeScript ne
dit rien de ce que le GPU en fait. Elle a mesuré une physique juste dans un
calque qui n'affichait rien.

### ⚠️ Ce qui reste

- **Un seul filtre.** Le DSS2 rouge donne une structure en rouge ; une nébuleuse
  à émission y est plus contrastée qu'à l'œil.
- **Les étoiles de champ des plaques** s'ajoutent à celles du catalogue du
  moteur. Elles sont bien plus faibles que sa limite, mais le compte est double.
- **L'ellipse du catalogue coupe l'objet.** Un objet réel la déborde : le fond
  mesuré dans les coins est donc légèrement surestimé, et les extensions les
  plus ténues tronquées. Le bord est éteint en douceur pour ne pas se voir.
- **96 pixels par tuile.** À très petit champ, M31 est agrandie près de trois
  fois et l'image devient molle.
- **La teinte reste un jeton d'interface**, mais elle ne sort du gris qu'au-delà
  du plafond scotopique, c'est-à-dire pratiquement jamais.
- **La référence colorimétrique est périmée** : `atmo:baseline` relève 37
  dérives — vérifié, elles sont là aussi sans ce changement, et viennent des
  phases terrain qui ont modifié le ciel sans réécrire la référence.

---

## Le ciel profond cesse d'être une tache, et le zoom devient un instrument

Signalé : « m31 est trop visible, je suppose que c'est un problème sur les
autres objets » — et « ça reste en noir et blanc, quand on zoome à fond on est
censé avoir l'objet en meilleure résolution ».

### ⚠️ 169 niveaux sur un ciel à 0

Le cœur de M31 rendait **169 sur 255**, sur un fond de ciel à zéro. La cause
n'était pas un réglage mais une loi : le calque avait la sienne, un contraste
décalé de 1,5 puis divisé par 3,5, plafonné, multiplié par 0,42. Trois
constantes inventées, et une saturation atteinte dès deux magnitudes au-dessus
du fond — le cœur de M31 en est à quatre et demie.

### Détecter et paraître brillant sont deux questions distinctes

C'est la confusion des deux qui rendait la galaxie aveuglante, et la séparer
supprime les trois constantes.

**Détecter** profite de la sommation spatiale : ce que l'œil compare au seuil,
c'est le flux tombant dans l'aire sur laquelle il intègre.

    m_détection = mu − 2,5·log10(Omega_eff)     Omega_eff = min(Omega_œil, Omega_objet)

Le plafond n'est pas une commodité : sans lui, un petit objet rendrait une
magnitude **plus brillante que sa magnitude intégrée**, ce qui n'a pas de sens.
Avec lui, un objet plus petit que l'aire de sommation retombe exactement sur sa
magnitude de catalogue — la loi des sources ponctuelles n'est plus un cas
particulier, c'est la limite de celle-ci.

**Paraître brillant** n'en profite pas. L'image rétinienne d'une source étendue
a la même brillance de surface que l'objet, quelle que soit sa taille : la
grandeur comparable est le flux dans la seule tache de diffusion.

### ⚠️ L'aire de sommation est déduite, et vérifiée sur des objets qui n'ont pas servi à la déduire

La littérature va de dix minutes d'arc à un degré selon la luminance et le
protocole ; choisir dedans serait choisir le résultat. On pose donc que **M33
est exactement au seuil** sous un ciel vierge — l'objet limite du ciel à l'œil
nu, et le seuil vient des paliers de magnitude limite du moteur. Il en sort
**32,9 minutes d'arc** de diamètre, dans l'intervalle publié sans y avoir été
pris.

| objet | brillance | m_détection | plafonné | modèle | observé |
| --- | --- | --- | --- | --- | --- |
| M42 | 21,96 | 5,75 | non | le plus facile | oui |
| M31 | 22,30 | 6,09 | non | demande un ciel correct | oui |
| M33 | 22,81 | 6,60 | non | à la limite | ancrage |
| M13 | 20,52 | **5,80** | oui | source ponctuelle de magnitude 5,8 | oui |
| M81 | 21,51 | 6,92 | oui | hors de portée | oui |
| M101 | 23,39 | 7,90 | oui | hors de portée | oui |

**M81 est le contrôle qui compte** : elle a la brillance de surface de M42 et
n'est pourtant pas un objet à l'œil nu. C'est le plafond qui l'écarte. M13 dit
la même chose autrement — plafonnée, elle rend exactement 5,80, sa magnitude de
catalogue.

Résultat : le cœur de M31 passe de **169 à 32 niveaux** à champ large, et reste
parfaitement gris.

### Le zoom est un instrument, et l'instrument se déduit

Un objet du ciel profond est gris **à l'œil** : le cœur de M31 vaut
0,013 cd/m², deux cent trente fois sous le seuil où les cônes répondent, et
grossir n'y change rien — la brillance de surface ne monte pas avec le
grossissement. Pour avoir de la couleur il faut assumer que le rendu n'est plus
un œil.

Un seuil de champ serait arbitraire. On pose donc la seule question qui ait une
réponse : **quelle est la plus petite ouverture capable de résoudre le pixel
affiché ?** Le critère de Rayleigh la donne, et la bascule tombe toute seule là
où cette ouverture dépasse la pupille adaptée.

| champ (900 px) | pixel | ouverture | gain |
| --- | --- | --- | --- |
| 60° | 4,0′ | 0,6 mm | 0 — l'œil |
| **4,99°** | 20″ | **7 mm** | **0 — la bascule** |
| 2° | 8″ | 17 mm | 1,98 mag |
| 0,5° | 2″ | 70 mm | 4,99 mag |
| 0,05° | 0,2″ | 698 mm | 9,98 mag |

⚠️ **Un capteur n'a pas de bâtonnets.** Première version fausse : j'appliquais
la loi mésopique de l'œil en lui donnant le flux de l'instrument. Le gris du
ciel profond est une propriété de la rétine, pas de la lumière — la loi cesse
donc de s'appliquer à mesure que l'instrument prend le relais, et la part qu'il
prend se déduit, `1 − 10^(−0,4·gain)`, la fraction de lumière que l'œil seul
n'aurait pas pu collecter.

### La couleur cesse de venir d'une feuille de style

Chaque type d'objet recevait un jeton CSS. Le catalogue porte pourtant des
magnitudes B **calibrées** pour 87 % des objets de l'atlas : `B−V` donne une
vraie couleur, par la conversion déjà employée pour les étoiles. M31 vaut 0,85,
soit 5 135 K.

⚠️ **La cale de transition ne conserve pas la teinte.** `radianceFromDisplay`
inverse la courbe d'affichage canal par canal ; c'est exact quand la couleur
ressort telle quelle, mais elle est ici multipliée par une opacité faible, et
l'inversion diverge dès qu'un canal touche un. Le rapport 1 : 0,91 : 0,83
devenait **1 : 0,26 : 0,15**, et une galaxie à peine jaune sortait orange vif.
La cale ne porte plus que la luminance ; la teinte passe par le linéaire, où
elle a un sens. Mesuré après correction : **1 : 0,88 : 0,78**.

⚠️ Le même défaut guette le champ d'étoiles, qui emploie la même cale.

### La résolution suit la taille de l'objet

Une tuile unique gaspillerait sur les 462 objets de moins d'un quart de degré
ce qui manque aux vingt-deux qui dépassent quarante minutes d'arc — ceux dans
lesquels on zoome. Trois paliers : 96, 192 et 384 pixels, soit 9,9 Mpx contre
35,9 si tout le monde recevait 256. L'atlas pèse **4,35 Mo** pour 548 images.

Le cadrage prend en plus **quinze pour cent** du grand axe : la première version
coupait exactement sur l'ellipse du catalogue, et la coupure se voyait.

### ⚠️ Ce qui reste faux

**Le profil n'est pas lissé à l'échelle de sommation.** L'œil intègre sur
trente-trois minutes d'arc ; la loi est pourtant appliquée à la brillance
locale. Un cœur plus petit que cette aire se voit un peu trop tôt.

**Aucun temps de pose.** L'instrument ne porte que son ouverture. Une vraie
pose longue ajouterait une intégration temporelle, et c'est elle qui manque
pour qu'une nébuleuse se colore depuis un ciel de ville.

**Un seul filtre.** Le profil vient du rouge du DSS2 : une nébuleuse à émission
y est plus contrastée qu'à l'œil, sa raie Hα tombant en plein dans ce filtre.
Et `B−V` suppose un corps noir, ce qui est faux pour un objet qui rayonne en
raies.

**Les étoiles de champ de la plaque** s'ajoutent à celles du catalogue.

**La pollution lumineuse ne vient pas du site** mais d'un réglage : les
captures de « site noir » et de Paris partagent le même ciel tant qu'on ne
touche pas au curseur. La classe Bortle par défaut vaut 1.

Coût : aucune régression mesurable — 16,6 ms de médiane avec et sans le calque,
au champ large comme au zoom. ⚠️ Tout est plafonné par la synchronisation
verticale, ce qui prouve l'absence de régression plus que ça ne mesure le coût.

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
| 2026-08-26 | Table de ciel ; **le ciel physique est à l'écran** ; construction étalée, p95 inchangé à ×86400 ; **379 contrôles** |
| 2026-08-26 | Phase 7 — ozone ; les deux cibles de la phase 5 atteintes ; le crépuscule devient bleu ; **405 contrôles** |
| 2026-08-26 | Phase 6 — aérosols et Mie ; bilan de journée refermé à 1–2 % ; trouble rendu physique ; **440 contrôles** |
| 2026-08-27 | Phase 8 — diffusion multiple ; facteur 4π attrapé par le bilan d'éclairement ; albédo du sol câblé ; nœud à 5° signalé ; **461 contrôles** |
| 2026-08-27 | Phase 9 — perspective atmosphérique ; une seule table pour le ciel et les objets ; ancien noyau analytique hors du rendu ; GPU ×22 ; **480 contrôles** |
| 2026-08-27 | Phase 10 — indice de Ciddor ; recoupé avec Peck & Reeder à 3,5·10⁻⁵ et avec les éphémérides à 0,2 % ; dette de phase 1 soldée ; **507 contrôles** |
| 2026-08-27 | Phase 11 — courbure des rayons ; 57,99″ à 45° contre 58,23″ de l'Almanach ; Soleil couchant à 27,6′ × 32,0′ ; non câblée, et pourquoi ; **536 contrôles** |
| 2026-08-27 | Phase 12 — réfraction câblée aux cinq couches ; GPU/CPU à 2,6″ ; le Soleil se couche après s'être couché ; **541 contrôles** |
| 2026-08-27 | Phase 13 — champ 3D et équation eikonale ; 0,044″ contre l'intégrale 1D ; bug d'origine de couche révélé par le mirage ; **555 contrôles** |
| 2026-08-27 | Phase 14 — mirages ; transfert non monotone, 2 images ; deux erreurs de repère attrapées par le raccord ; **566 contrôles** |
| 2026-08-27 | Phase 15 — turbulence ; HV 5/7 se valide lui-même ; seeing du sol et scintillation d'altitude émergent des poids ; **591 contrôles** |
| 2026-08-27 | Phase 16 — optique ondulatoire ; couronnes émergentes de Mie ; assertion fausse corrigée par la dispersion des tailles ; **611 contrôles** |
| 2026-08-27 | Phase 17 — scintillation **au rendu** ; les planètes ne scintillent pas, par un rapport de longueurs ; seeing écarté sur mesure ; **629 contrôles** |
| 2026-08-27 | Phase 19 — ozone et distance solaire câblés ; crépuscule 61 % plus bleu aux hautes latitudes ; registre des incertitudes ; **645 contrôles** |
| 2026-08-27 | Phase 20 — 60 fps mesurés ; blocage de 124 ms supprimé ; mesure ratée en rendu logiciel, corrigée ; **646 contrôles** |
| 2026-08-29 | Dette du socle nocturne — airglow calculé, dégradé émergent ; l'amplitude reste bloquée par l'exposition fixe ; **658 contrôles** |
| 2026-08-29 | Dette de l'exposition — adaptation visuelle ; exposant dérivé, pas choisi ; le crépuscule existe enfin ; **670 contrôles** |
| 2026-08-29 | Passe globale — socle nocturne entièrement physique ; désaturation scotopique locale et logarithmique ; **675 contrôles** |
| 2026-08-30 | Marge sous l'horizon — trois bornes de domaine corrigées ; sol totalement occultant ; **683 contrôles** |
| 2026-08-30 | Banc de relief — la distance devient visible ; éclairement diffus du ciel mesuré ; **688 contrôles** |
| 2026-08-30 | Horizon apparent — le sol cessait de masquer le ciel à zéro degré ; horizons unifiés |
| 2026-08-30 | Table étendue sous l'horizon — l'écrêtage coûtait 15 à 23 % de colonne ; **695 contrôles** |
| 2026-08-30 | Plus rien borné à zéro degré — réfraction, masse d'air et extinction suivent l'altitude du site |
| 2026-08-30 | Ombre du relief dans le transport — segments éclairés seuls ; chaîne à contre-jour ×7 à ×12 |
| 2026-08-30 | Le Soleil se cache, le ciel non — la source ambiante survit à l'ombre ; voile crépusculaire 0 → 30,9 cd/m² |
| 2026-08-31 | Relief réel à 30 m sur 450 km — géodésie de Vincenty, pyramide à trois niveaux, 26 Mo par site |
| 2026-08-31 | Le sol peint devient un globe physique — dernière grande surface peinte du moteur |
| 2026-08-31 | Carte de sélection du lieu tirée du MNT, et hauteur au-dessus du sol |
| 2026-08-31 | Un seul horizon pour les trois couches — la bande orpheline en altitude disparaît |
| 2026-09-01 | Loi de distance globale — la rupture du voile à la rasance du globe disparaît |
| 2026-09-01 | Re-saturation ramenée à 1 — le dégradé du crépuscule cesse d'être écrêté |
| 2026-09-01 | Diffusion multiple itérée — la décroissance crépusculaire redevient régulière |
| 2026-09-01 | Troncature de la coordonnée de distance — 93 % du ciel crépusculaire était jeté |
| 2026-09-02 | Trois décades d'écart jour-nuit — la lueur crépusculaire s'éteint enfin |
| 2026-09-02 | Couleur des étoiles, lumière cendrée et ombre en altitude — trois constantes calculées |
| 2026-09-02 | Une seule expression de la radiance du ciel — la face nuit d'un astre redevient le ciel |
| 2026-09-02 | Pente du relief simulé bornée — la face nuit cesse de s'allumer au zoom |
| 2026-09-01 | Phase 0 du maillage de terrain — le défaut devient un nombre, deux contrôles échouent |
| 2026-09-01 | Phase 1 — l'azimut suit la caméra : 38x plus fin à fort zoom, budget inchangé |
| 2026-09-02 | Phase 2 — le maillage obéit à une erreur d'espace écran ; la réparametrisation des anneaux est réfutée |
| 2026-09-02 | Phase 3 — le nombre d'anneaux suit l'écran ; l'escalier des crêtes disparaît à 2° |
| 2026-09-02 | Le clair de lune devient de la diffusion calculée ; l'exposition voit enfin la Lune |
| 2026-09-02 | Carte d'ombre : cascade construite puis retirée faute de gain mesurable ; tolérance déduite |
| 2026-09-02 | Relief proche à 3 m par le RGE ALTI de l'IGN ; le goulot passe à l'axe des distances |
| 2026-09-02 | Loi d'anneaux suivant la caméra : essayée, cassait l'horizon, retirée. Banc longue distance au pic Cassini |
| 2026-09-02 | La ligne d'horizon devient un maximum par tranche — l'erreur passe de 0,07-0,18° à 0,004-0,023° |
| 2026-09-02 | Micro-relief du sol : texture inventée, amplitude mesurée sur cinq sites RGE ALTI |
| 2026-09-02 | Orthophoto IGN drapée sur le terrain — sa teinte seulement, jamais sa clarté |
| 2026-09-02 | Le sol émet : lumières urbaines depuis OSM, calibrées par l'EN 13201 et un spectre de Planck |
| 2026-09-02 | Les lumières s'allument au crépuscule, éclairent l'air, et sont floutées en mètres au sol |
| 2026-09-02 | Le ciel profond reçoit l'extinction, et devient gris comme il l'est à l'œil |
| 2026-09-06 | Le ciel profond reçoit de vraies images : atlas de 548 profils DSS2, en écarts de magnitude |
| 2026-09-07 | Le ciel profond cesse d'être une tache : loi de détection déduite, couleur B−V, et le zoom devient un instrument |
