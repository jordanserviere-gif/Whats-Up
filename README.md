# What's Up? — observation en direct

Webapp d'observation du ciel : le ciel local en direct, vu depuis le vrai relief
du lieu, avec frise temporelle. Au programme : les corps du système solaire et
le ciel profond, une atmosphère calculée physiquement, l'eau (océans et lacs),
les nuages tirés de la prévision, les avions en direct avec leurs traînées, et
un outil de tracé satellite piloté par des éléments orbitaux képlériens.

```bash
npm install
npm run dev                 # http://localhost:5173 (sert aussi le relais ADS-B)
npm run build               # vérification des types + bundle de production
npm run typecheck           # vérification des types seule
npm run verify              # vérification numérique de la couche astronomique
npm run verify:atmosphere   # suites de validation du moteur physique (atmosphère, nuages, eau, relief)
npm run release             # nouvelle version SemVer — voir « Versions »
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
  dans `useFrame`, sans passer par React — elles gardent ainsi la typographie du design system.
- L'orientation de la caméra vit dans une référence locale et n'est publiée dans
  le store qu'à 10 Hz : glisser dans le ciel ne reconstruit pas l'interface.

## What's Up? Design System

L'interface suit le design system **What's Up?**, tenu dans le projet Claude
Design du même nom. Il remplace Material 3 Expressive. Le parti pris est
bichrome — le bleu du logo et le blanc —, plat et moderne. Tout le système est
tokenisé sous `src/styles/tokens/`, et aucun composant ne code en dur une
couleur, un rayon, une durée ou une graisse.

| Fichier | Contenu |
| --- | --- |
| `color.css` | palette (`--wu-blue-50…950`, signal, ambre) puis rôles (`--bg`, `--surface`, `--ink`, `--line`, `--accent`…) pour quatre thèmes |
| `typography.css` | trois familles, l'échelle `--fs-*` et les classes de rôle `wu-type-*` |
| `fonts.css` | la fonte de titre, chargée depuis `public/fonts/` si elle y est |
| `shape.css` | rayons `0 · 4 · 10 · 18 · pilule`, traits de 1, 2 et 3 px, inclinaison de 12° |
| `motion.css` | deux courbes et quatre durées (80, 140, 220 et 360 ms) |
| `dimension.css` | espacements `--space-*`, tailles de composants, couches |
| `sky.css`, `brand.css` | tokens applicatifs : couleurs des corps, traits de la scène, logo |

### Couleur et thèmes

Il n'y a qu'une teinte, `#2C4F9E`, avec ses nuances. S'y ajoutent un rouge
signal, `#E0452F`, réservé aux erreurs, au direct et à la tête de lecture de la
frise, et l'ambre du thème night. Quatre thèmes, via `data-theme` sur `<html>` :

- **clair** : chrome blanc, encre bleue ;
- **bleu** : l'inverse signature, fond bleu, encre et accent blancs ;
- **sombre** : fond bleu nuit, accent blanc ;
- **night** : ambre sur noir pur.

Les traits et les textes posés dans la scène (grilles, figures, étiquettes,
traces) ne suivent pas le thème de l'interface : ils se posent sur le ciel, et
prennent donc les nuances claires du même bleu (`--app-scene-*`).

### Forme, mouvement, typographie

- **Élévation** : zéro ombre. La hiérarchie tient au trait (1 px, puis 2 px,
  puis 2 px bleu) ou à une bascule pleine sur l'accent.
- **Chrome** : ce qui flotte sur le ciel est un aplat plein à trait fort. Rien
  n'est translucide, sauf le voile des dialogues.
- **États** : le survol pose un aplat d'accent doux, l'appui fonce d'un cran et
  descend d'un pixel. La sélection bascule sur l'accent plein. Il n'y a pas
  d'onde (ripple) ni de ressort.
- **Motif** : l'inclinaison de 12° du logotype est le seul motif décoratif. On
  la trouve sur le bouton flottant, les badges et l'indicateur de chargement.
- **Titres** : Helvetica Neue 93 Black Extended Oblique, en capitales. Cette
  fonte commerciale n'est pas versionnée : déposée dans `public/fonts/`
  (ignoré par git), elle est prise ; sinon le titrage se replie sur Archivo
  élargi et incliné.
- **Texte** : Archivo à la chasse 112.
- **Données** : IBM Plex Mono, chiffres tabulaires.
- **Icônes** : Material Symbols Sharp.

### Le thème night

Pour observer sans perdre l'adaptation de l'œil à l'obscurité. Tout fond est
**noir pur**, et l'ambre ne porte que le contenu. La sélection, que les autres
thèmes signalent par un aplat, passe en night par un contour ambre
(`src/styles/night.css`).

Le **sol** (relief et sol plat) est converti dans son shader : sa radiance est
réduite à sa luminance puis portée par l'ambre — le blanc devient ambre, le noir
reste noir. Le ciel n'est pas converti. Les éléments du DOM qui affichent une
couleur physique (pastilles des corps, frise d'éclairement, cadran lunaire,
étiquettes, carte) passent par la même loi via un filtre SVG (`NightFilter`).

## Composants

`src/ui/` contient la bibliothèque de composants, sans dépendance UI externe.
Les classes sont préfixées `wu-` :

`Badge` · `Button` (5 variantes × 5 tailles × 2 formes) · `Card` · `Chip` /
`ChipSet` · `DataRow` / `DataGrid` / `StatTile` · `Dialog` · `Divider` · `Fab` ·
`Icon` · `IconButton` (4 variantes × 4 tailles × 3 largeurs) · `List` ·
`LoadingIndicator` / `LinearProgress` · `NavigationRail` · `SearchBar` ·
`SegmentedButton` · `Section` · `Select` · `SidePanel` · `Slider` · `Snackbar` ·
`Surface` · `Switch` · `TextField` · `ThemeProvider` · `Toolbar` · `Tooltip`

`Surface` est la brique de base : elle traduit un niveau et un palier de forme en
tokens. Tous les conteneurs en dérivent.

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

## Atmosphère

`src/atmosphere/` est un moteur d'optique atmosphérique physiquement fondé, en
SI strict et spectral. Il ne code pas les phénomènes, il code leurs causes :

```
état physique → propriétés optiques → transport de lumière → image observée
```

Aucun `sunsetColor` ni aucune condition sur la hauteur du Soleil. Les couchers
rouges, les crépuscules, le rayon vert et les mirages sortent de :

- la diffusion Rayleigh et Mie (aérosols) ;
- l'ozone et sa bande de Chappuis ;
- la diffusion multiple ;
- l'indice de réfraction de l'air et la courbure des rayons ;
- les inversions thermiques ;
- la turbulence optique (seeing, scintillation) ;
- l'airglow ;
- le clair de lune diffusé.

À l'écran, tout passe par des tables précalculées : transmittance, ciel vu et
perspective aérienne. L'exposition suit le ciel, comme l'œil (adaptation
photopique / scotopique). La documentation module par module est dans
[`docs/atmosphere-engine.md`](docs/atmosphere-engine.md), et l'avancement dans
[`docs/atmosphere-progress.md`](docs/atmosphere-progress.md).

## Relief

`src/scene/terrain/` pose l'observateur sur le vrai sol du lieu.

- **Données** : les tuiles *terrarium* mondiales (AWS Open Data), assemblées en
  une pyramide de trois niveaux dans un plan local azimutal équidistant. En
  France, le relief proche passe à 3 m avec le RGE ALTI de l'IGN.
- **Maillage** : un maillage radial en anneaux logarithmiques, réglé sur une
  erreur d'espace écran. Son azimut suit la caméra, à budget constant.
- **Couleur du sol** : l'orthophoto de l'IGN est drapée sur le sol, mais on
  n'en garde que la teinte.
- **La nuit** : le sol émet les lumières des villes, en unités photométriques.
  Elles s'allument au crépuscule et éclairent l'air.
- **Au loin** : au-delà du relief chargé, un globe physique prend le relais.
  Il n'y a qu'un seul horizon.

## Eau

Océans et lacs, sur le relief comme sur le globe.

- **Masque** : il vient de la couche `water` des tuiles vectorielles
  OpenFreeMap, qui contient l'océan et les lacs, réservoirs et lagunes d'au
  moins 1 km². Il est tracé dans un worker, sur la grille même du relief.
- **Niveau de l'eau** : chaque plan d'eau a le sien, mesuré dans le relief.
  L'océan est à 0 m, et un lac est à la médiane de son intérieur. Là où le sol
  dépasse ce niveau de plus de 4 m, l'eau lui cède la place ; les creux sous
  l'eau sont remontés à sa surface.
- **Vagues** : elles sont calculées par transformée de Fourier sur le GPU
  (Tessendorf), à partir d'un spectre JONSWAP. L'océan a trois cascades (497,
  53 et 5,3 m), les lacs deux. Les pentes sont filtrées selon LEADR : la
  variance que le filtrage lisse est reportée dans la statistique de Cox & Munk
  au lieu d'être perdue. L'eau reste donc juste de près comme en visée rasante.
- **Lumière** : on suit Bruneton (2010) — Fresnel exact, ciel réfléchi, reflets
  du Soleil et de la Lune (Cox & Munk, masquage de Smith).
- **État de mer** : il vient d'Open-Meteo Marine, en un seul appel par lieu,
  gardé 12 h en local.

## Nuages et météo

Le calque Nuages est éteint par défaut. Tant qu'on ne l'active pas, il ne fait
aucun appel réseau.

- **Données** : la prévision ICON d'Open-Meteo, gardée dans IndexedDB pour ne
  pas redemander ce qui est déjà connu.
- **Scénarios** : des journées réelles archivées, figées dans
  `public/scenarios/`, avec l'image satellite du même instant pour comparaison.
  Elles se fabriquent avec `scripts/build-weather-scenario.mjs`.
- **Genre des nuages** : il est déduit de la donnée (ISCCP, Wang & Sassen). Les
  cumulus sous-maille sortent d'un modèle de panache convectif.
- **Forme** : un bruit Perlin-Worley 3D, borné par la couverture, et une
  turbulence sans divergence (curl noise). Le rendu est une marche de rayons
  avec une diffusion multiple calée sur Eddington.
- **Calcul** : il se fait dans un worker, hors du fil principal. Au changement
  d'heure, les nuages se rechargent en silence, avec une barre discrète en bas
  à gauche. Ils sont coupés au-delà d'une avance rapide de ×60.

## Avions et traînées

- **Positions** : ADS-B en direct depuis adsb.fi, puis adsb.lol en secours, via
  le relais `/relay/…` que sert Vite (`npm run dev` ou `npm run preview`).
  Chaque mesure est datée par l'horloge du serveur, et une position de plus de
  90 s est écartée. L'altitude GNSS est préférée quand elle existe.
- **Modèles** : un modèle 3D (`public/models/*.glb`) quand on s'approche, une
  silhouette sinon.
- **Traînées** : elles se forment et persistent selon l'air réel au niveau de
  vol (critère de Schmidt–Appleman, bilan de glace), un panache par réacteur.
  Elles s'étalent par cisaillement et sont éclairées par l'atmosphère.

## Catalogues et textures

`src/data/stars.json`, `constellations.json` et `deepsky.json` sont générés par
`npm run data` depuis la base HYG v4.1, les figures de d3-celestial et OpenNGC,
puis commités. Les cartes de surface sont récupérées par `npm run textures` dans
`public/textures/`. Rien n'est téléchargé à l'exécution.

## Versions

Numérotation [SemVer](https://semver.org/lang/fr/), déduite des commits, qui suivent la convention `type(portée): sujet`. En 0.x : `feat` fait monter la version mineure, `fix` et `perf` le correctif ; une rupture (`!` après le type, ou `BREAKING CHANGE` dans le corps) fait monter la mineure, puis la majeure à partir de la 1.0.

```sh
npm run release -- --dry      # aperçu : prochain numéro et journal
npm run release               # met à jour package.json et CHANGELOG.md, commite, tague vX.Y.Z
npm run release -- --push     # idem, et pousse le commit et le tag
npm run release -- --as patch # impose le niveau (major, minor, patch)
```

Chaque version est un tag annoté `vX.Y.Z`, dont le message reprend le journal. L'appli affiche sa version et son commit en pied de la section « Sources et licences » des réglages.

## Crédits et licences

| Donnée | Source | Licence |
| --- | --- | --- |
| Éphémérides | [astronomy-engine](https://github.com/cosinekitty/astronomy) (Don Cross) | MIT |
| Étoiles (5 071) | [HYG Database v4.1](https://github.com/astronexus/HYG-Database) (Astronexus) | CC BY-SA 2.5 |
| Figures de constellations | [d3-celestial](https://github.com/ofrohn/d3-celestial) (Olaf Frohn) | BSD 3-Clause |
| Ciel profond (1 738) | [OpenNGC](https://github.com/mattiaverga/OpenNGC) (Mattia Verga) | CC BY-SA 4.0 |
| Cartes de surface | [Solar System Scope](https://www.solarsystemscope.com/textures/) | **CC BY 4.0** |
| Éléments orbitaux | [CelesTrak](https://celestrak.org/) (Dr T.S. Kelso) | usage libre, mise en cache demandée |
| Relief mondial | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen, AWS Open Data) | attribution des sources |
| Relief et orthophoto (France) | [RGE ALTI, BD ORTHO](https://geoservices.ign.fr/) (IGN, Géoplateforme) | Licence Ouverte 2.0 |
| Masque d'eau | [OpenFreeMap](https://openfreemap.org/) (données OpenStreetMap) | ODbL |
| Trame bâtie des lumières | [terrestris](https://www.terrestris.de/) (fond OSM) | ODbL |
| Pollution lumineuse | [Atlas de D. Lorenz](https://djlorenz.github.io/astronomy/lp/) | voir la source |
| Météo, qualité de l'air, état de mer | [Open-Meteo](https://open-meteo.com/) | CC BY 4.0 |
| Images satellite des scénarios | [NASA Worldview](https://worldview.earthdata.nasa.gov/) (GIBS) | usage libre |
| Positions d'avions | [adsb.fi](https://adsb.fi/), [adsb.lol](https://adsb.lol/) | données ouvertes (ODbL pour adsb.lol) |
| Fiches d'avions | [adsbdb](https://www.adsbdb.com/) | voir la source |
| Géocodage | [Photon](https://photon.komoot.io/) (komoot, données OSM) | ODbL |

Les cartes de Solar System Scope sont redimensionnées mais non modifiées. La
licence CC BY 4.0 impose de créditer l'auteur : l'attribution figure donc aussi
**dans l'application**, section « Sources et licences » du panneau Réglages, et
non seulement ici.

Le ciel n'emprunte plus de modèle analytique (l'ancien shader de Preetham de
three.js a été retiré) : il est calculé par le moteur de `src/atmosphere/`, et
ses références scientifiques sont citées dans chaque suite de validation.

## Raccourcis

| Touche | Action |
| --- | --- |
| `Espace` | suspendre / relancer le temps |
| `N` | revenir à l'instant présent |
| `Échap` | fermer le panneau latéral |
| glisser | balayer le ciel |
| molette | régler le champ de vision |
