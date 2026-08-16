# Ciel — observation en direct

Webapp d'observation du ciel : vue en direct du ciel local avec frise temporelle,
corps majeurs du système solaire, et un outil de tracé satellite piloté par des
éléments orbitaux képlériens.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # bundle de production
npm run verify     # vérification numérique de la couche astronomique
```

## Choix techniques

**React 18 + TypeScript + Vite, avec react-three-fiber pour la 3D.**
L'observateur est à l'origine et la caméra pivote en azimut/hauteur, mais la scène
n'est **pas** une voûte : chaque corps occupe une profondeur propre, dérivée de sa
distance réelle. Three.js pilote le rendu via react-three-fiber, ce qui permet de
décrire la scène en composants tout en gardant les boucles critiques (positions,
projections d'étiquettes) hors du cycle de rendu React.

**astronomy-engine** fournit les éphémérides (VSOP87 tronqué, ELP2000 pour la
Lune) : précision de l'ordre de la seconde d'arc, sans dépendance réseau.

**Zustand** porte l'état applicatif ; les préférences (lieu, calques, satellites)
sont persistées, l'instant simulé ne l'est pas.

### Profondeur et tailles réelles

Le système solaire couvre quatre ordres de grandeur, d'un satellite à 400 km
jusqu'à Neptune à 4,5 milliards de km. Les placer à l'échelle ferait exploser la
précision du tampon de profondeur. La scène comprime donc le rayon en logarithme :

```
profondeur(d) = 7,375 · log₁₀(d_km) − 11,19
rayon_rendu   = rayon_km × profondeur(d) / d_km
```

La première fonction est strictement croissante, donc **l'ordre des occultations
est préservé**. La seconde conserve le rapport rayon/distance, donc **le diamètre
apparent est exact** (vérifié à 10⁻⁶ degré près). Géométrie angulaire juste,
profondeur juste : l'éclipse du 12 août 2026 se joue toute seule dans le tampon de
profondeur — la Lune tombe à 29,8 unités, le Soleil à 49,1 — sans aucun ordre de
dessin choisi à la main. Il en va de même d'un satellite passant devant Jupiter ou
d'une occultation lunaire.

Les corps sont de vraies sphères éclairées par la direction réelle corps → Soleil,
transportée depuis le repère équatorial. Le croissant lunaire, la phase de Vénus et
l'orientation du terminateur ne sont donc pas dessinés : ils tombent du produit
scalaire entre la normale et la lumière.

À taille réelle, Jupiter mesure une quarantaine de secondes d'arc, soit une
fraction de pixel à champ large. Le champ descend jusqu'à 0,15° pour résoudre les
disques ; en deçà, c'est le halo photométrique qui porte l'objet (voir plus bas).
Un réglage de grossissement des disques existe, à 1× par défaut.

Le sol est une calotte opaque placée entre les corps du système solaire et les
étoiles : il masque par la profondeur tout ce qui est couché, sans qu'aucun calque
n'ait à le savoir. Un disque plan ne conviendrait pas — l'observateur étant à
hauteur zéro, un plan coplanaire ne projette qu'une ligne.

### Performance

- Les 5 000 étoiles du catalogue sont posées **une fois** dans le repère
  équatorial ; la rotation diurne est appliquée par la matrice du groupe, pas en
  retouchant les sommets.
- Les éphémérides sont recalculées à 10 Hz, le rendu tourne à la fréquence de
  l'écran : le mouvement reste fluide sans recalculer les positions à chaque image.
- Les étiquettes du ciel sont des nœuds DOM positionnés par projection directe
  dans `useFrame`, sans passer par React — elles gardent ainsi la typographie MD3.
- L'orientation de la caméra vit dans une référence locale et n'est publiée dans
  le store qu'à 10 Hz : glisser dans le ciel ne reconstruit pas l'interface.

## Material 3 Expressive

Tout le système visuel est tokenisé sous `src/styles/tokens/`. Aucun composant
ne code une couleur, un rayon, une durée ou une graisse en dur.

| Fichier | Contenu | Généré ? |
| --- | --- | --- |
| `color.css` | 54 rôles de couleur × clair/sombre × 3 niveaux de contraste | `npm run color` |
| `motion.css` | ressorts Expressive convertis en courbes CSS `linear()` | `npm run motion` |
| `typography.css` | échelle à 30 styles : 15 de base + 15 « emphasized » | à la main |
| `shape.css` | échelle de forme, paliers `increased` et `extra-extra-large` inclus | à la main |
| `elevation.css`, `dimension.css` | ombres, couches d'état, espacements, tailles | à la main |
| `sky.css` | tokens applicatifs : couleurs des corps, couches de la scène | à la main |

### Le système de mouvement

M3 Expressive remplace les courbes de Bézier par un système **physique** : chaque
transition est un ressort défini par une raideur et un amortissement. Les tokens
« spatial » (position, taille, forme) admettent un dépassement ; les tokens
« effects » (couleur, opacité) sont amortis de façon critique.

`scripts/gen-motion.mjs` échantillonne la réponse indicielle de chaque ressort de
`MotionScheme.expressive()` et l'exprime en `linear()` CSS — ce qu'une
`cubic-bezier` ne peut pas faire, puisqu'elle ne dépasse jamais 1 proprement.
Les durées obtenues (389 / 465 / 629 ms en spatial) recoupent les valeurs
publiées par Material.

### Formes et couleurs

L'échelle de forme sert la **morphologie** : un bouton sélectionné passe de
`full` à `medium`, un élément de liste s'arrondit davantage à la sélection, une
pastille de couleur devient un cercle. Le mouvement de forme utilise le ressort
spatial, donc rebondit légèrement.

La palette dérive d'une couleur source (`#4C6FFF`) par
`@material/material-color-utilities`, variante `SchemeVibrant` : elle conserve la
teinte source pour le primaire, là où `SchemeExpressive` la fait fortement pivoter
— ce qui donnait un primaire vert, incohérent avec un fond de ciel nocturne.

## Composants

`src/ui/` contient une bibliothèque MD3 autonome, sans dépendance UI externe :

`Badge` · `Button` (5 variantes × 5 tailles × 2 formes) · `Card` · `Chip` /
`ChipSet` · `DataRow` / `DataGrid` / `StatTile` · `Dialog` · `Divider` · `Fab` ·
`Icon` · `IconButton` (4 variantes × 4 tailles × 3 largeurs) · `List` ·
`LoadingIndicator` / `LinearProgress` · `NavigationRail` · `Ripple` ·
`SegmentedButton` · `Section` · `Select` · `SidePanel` · `Slider` · `Snackbar` ·
`Surface` · `Switch` · `TextField` · `ThemeProvider` · `Toolbar` · `Tooltip`

`Surface` est la brique de base : elle traduit un niveau d'élévation et un palier
de l'échelle de forme en tokens. Tous les conteneurs en dérivent.

## Astronomie

`src/astro/` est une couche pure, sans React, vérifiable en isolation.

- `time.ts` — jour julien, temps sidéral, formatage francophone
- `coords.ts` — équatorial ↔ horizontal, précession, repère SEZ, WGS84
- `bodies.ts` — éphémérides, lever/coucher/culmination, phase lunaire
- `photometry.ts` — éclairement du ciel, extinction, magnitude limite, éclipses
- `kepler.ts` — propagation képlérienne + dérives séculaires J2
- `satellite.ts` — position topocentrique, ombre terrestre, traces, passages
- `catalog.ts` — catalogue HYG (5 071 étoiles ≤ mag 6,0) et 89 figures

### Le modèle photométrique

Jour, nuit, crépuscules, clair de lune et éclipses ne sont pas traités comme des
cas particuliers : tout passe par **une seule grandeur physique**, l'éclairement
horizontal en lux.

```
E = E_soleil(h) × (1 − obscuration)  +  E_lune(h, phase)  +  airglow
```

`E_soleil` interpole en logarithme les paliers classiques de la littérature sur
les crépuscules (400 lx au lever, 3,4 lx en fin de crépuscule civil, 8 mlx au
nautique). `E_lune` part de la magnitude visuelle réelle de la Lune, déduite de son
angle de phase. `obscuration` est l'aire d'intersection du disque lunaire et du
disque solaire, rapportée à celle du Soleil — calculée à partir des rayons
topocentriques, ce qui distingue une éclipse totale d'une annulaire.

De cette unique échelle découlent, sans code dédié :

- la **couleur de la frise temporelle**, par une rampe éclairement → couleur : une
  Lune haute éclaircit visiblement la nuit (×469 par rapport au fond de ciel), une
  éclipse creuse une encoche sombre en plein jour ;
- la **magnitude limite**, qui commande l'apparition des étoiles. À Reykjavík le
  12 août 2026, l'éclairement tombe de 64 575 lx à 32 lx pendant la totalité et la
  magnitude limite passe à 0,4 : les étoiles brillantes ressortent d'elles-mêmes ;
- la **taille et l'éclat des sources ponctuelles**, étoiles, planètes et satellites
  partageant la même loi photométrique, en rapport de flux `10^(−0,4 Δm)` ;
- l'**extinction atmosphérique** (Pickering + 0,28 mag/masse d'air), qui affaiblit
  et rougit ce qui approche l'horizon.

Le plancher de 8·10⁻⁴ appliqué pendant la totalité représente l'atmosphère éclairée
hors de l'ombre : le ciel devient crépusculaire, pas noir — ce qu'on observe.

### Le modèle satellite

L'outil prend les six éléments képlériens classiques — demi-grand axe,
excentricité, inclinaison, longitude du nœud ascendant, argument du périgée,
anomalie moyenne — plus une époque de référence. La taille de l'orbite se saisit
au choix en demi-grand axe, en mouvement moyen (le champ *n* des TLE) ou en
altitude circulaire ; les trois se convertissent entre elles à la saisie.

Avec l'option J2 active, le modèle applique les dérives séculaires dues à
l'aplatissement terrestre sur Ω, ω et le mouvement moyen — ce qui produit la
régression du nœud d'une orbite basse et le gel d'une héliosynchrone.

**Ce que le modèle ne fait pas :** ni traînée atmosphérique, ni termes de courte
période. Ce n'est pas un SGP4 : alimenté par un TLE, il divergerait au bout de
quelques jours. Il décrit fidèlement la géométrie d'une orbite donnée par ses
éléments osculateurs, ce qui est l'usage visé ici.

L'illumination utilise un modèle d'ombre cylindrique et une fonction de phase
lambertienne pour estimer la magnitude — suffisant pour distinguer un passage
observable d'un passage en éclipse.

### Vérification

`npm run verify` confronte la couche astronomique à des références externes :

- temps sidéral et conversions équatorial → horizontal contre astronomy-engine,
  sur trois lieux (dont une latitude polaire) et trois époques ;
- position topocentrique reconstruite depuis un vecteur ECI, comparée à la
  référence — c'est ce chemin qu'empruntent les traces satellites ;
- matrice équatorial → scène 3D confrontée à la conversion trigonométrique ;
- propagateur : équation vis-viva, rayon au périgée, immobilité d'un
  géostationnaire sur 6 heures ;
- photométrie : plancher nocturne, plausibilité du midi d'été, cas limites
  analytiques du recouvrement de deux disques, écart mesuré entre une nuit noire et
  une nuit de pleine lune ;
- **éclipse du 12 août 2026** : obscuration maximale et heure du maximum sur trois
  sites, chute d'éclairement pendant la totalité, ordre de profondeur Lune/Soleil
  dans la scène, conservation du diamètre apparent à 10⁻⁶ degré.

Les valeurs obtenues recoupent les éphémérides publiées : totalité à 17:49 UTC à
Reykjavík, 18:27 à Oviedo, 92 % de partielle à Paris.

Cette suite a effectivement attrapé une inversion de signe sur l'axe est de la
matrice de scène, invisible au zénith et au pôle, puis un double comptage du fond
de ciel entre le terme solaire et l'airglow.

## Catalogues

`src/data/stars.json` et `constellations.json` sont générés par
`npm run data` depuis la base HYG v4.1 et les figures de d3-celestial, puis
commités : l'application ne fait aucun appel réseau à l'exécution.

## Raccourcis

| Touche | Action |
| --- | --- |
| `Espace` | suspendre / relancer le temps |
| `N` | revenir à l'instant présent |
| `Échap` | fermer le panneau latéral |
| glisser | balayer le ciel |
| molette | régler le champ de vision |
