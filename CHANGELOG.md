# Journal des versions

Chaque version est un tag `vX.Y.Z`, publie par `npm run release`.

## v0.6.0 — 2026-10-04

### Nouveautes

- **photo** : anticrenelage en quatre passes, grille calee sur l'ecran, relief continu entre niveaux (2f86cd3)
- **photo** : relief rendu au pixel — marche de rayons par colonne, tuiles LiDAR au pas du pixel, ombres et ciel par pixel (b8f9533)
- **relief** : portee portee a 560 km — les plus longues lignes de vue connues tiennent dans la pyramide (d2d1536)
- **photo** : mode photo — relief LiDAR HD du cadre, maillage au pixel, ombres par rayon, rendu haute definition (67b6aa4)

### Performances

- **photo** : capture deux fois plus rapide — reprise adaptative entre passes, rayons de Soleil arretes au plus tot, tuiles prechargees pendant l'apercu (c538664)

## v0.5.0 — 2026-09-27

### Nouveautes

- **avions** : les feux — position rouge et vert, queue blanche, anticollision rouge, doubles eclats blancs (55ab3fe)
- **corps** : les quatre satellites galileens — Io, Europe, Ganymede, Callisto (b29a8f3)

### Corrections

- **avions** : feux a leur vraie place, visibles au zoom, icone ecartee (0cd8fb1)
- **voie-lactee** : pas de gain d'instrument — zoomer ne l'eclaircit plus en voile gris raye de noir (fb8c3b6)

## v0.4.0 — 2026-09-27

### Nouveautes

- **ciel** : la Voie lactee — carte Gaia DR2 de la NASA, etalonnee, en couleur, par la loi du ciel profond (6990634)

### Corrections

- **ciel** : la magnitude limite depend de la hauteur — le fond s'eclaircit vers l'horizon, la Voie lactee s'y noie sous un ciel de banlieue (44eff2c)
- **voie-lactee** : URL de la carte suffixee de son empreinte — une version en cache ne la teinte plus en vert (603fa9b)
- **ciel-profond** : plus de gris scotopique — les objets gardent leur teinte, comme dans Stellarium (7dbe223)
- **etoiles** : le ciel noir montre ce qu'il annonce — catalogue a la magnitude 7, extinction du zenith comptee une fois, rien d'eteint sans atmosphere (dd07b13)
- **ciel-profond** : plus de NaN dans le tampon HDR — la nuit ne passe plus au noir sous le bloom (f05b5d1)

## v0.3.0 — 2026-09-27

### Nouveautes

- **ui** : What's Up? Design System a la place de Material 3 — bichrome bleu et blanc, plat, sans ombre ; quatre themes (clair, bleu, sombre, night), Archivo, IBM Plex Mono et titrage Helvetica Neue 93 (local), icones Sharp, classes wu- (398d296)

### Corrections

- **ui** : passe de mise en page — loader au bleu du logo, heures sous la frise, boussole a sa largeur, fiche ancree sans double cadre, grands nombres entiers, resumes lisibles ; traits du theme sombre adoucis (a56f9a1)
- **ui** : titrage oblique (fonte de titre, heure, boussole, conditions, cartes), libelles des badges et du FAB redresses, plus de filet par ligne de donnee, grilles espacees ; theme bleu par defaut, traits adoucis (c18cf98)
- **eau** : chaque plan d'eau a son niveau, mesure dans le relief (ocean 0 m, lac = mediane de son interieur) ; l'eau ne monte plus sur les pentes, les creux sous l'eau sont remontes a sa surface (0d42af6)

### Documentation

- **readme** : atmosphere, relief, eau, nuages et avions decrits ; commandes a jour, sources de donnees creditees (3236b56)

## v0.2.0 — 2026-09-27

### Nouveautes

- **eau** : vagues par transformee de Fourier sur le GPU (Tessendorf) — cascades de 497, 53 et 5,3 m, pentes filtrees LEADR a variance conservee ; eau statistique sur le globe, qui comblait l'horizon en sol mat (b7110e0)
- **eau** : reflet de la Lune — meme loi que le Soleil, eclairement lunaire au sol (phase comprise) (204ac84)
- **eau** : vagues en relief — la houle que le maillage resout souleve vraiment la surface (c64bf69)
- **eau** : ocean et lacs — masque OpenStreetMap sur la pyramide du relief, Fresnel, ciel reflechi, reflet solaire de Cox & Munk, vagues tirees de JONSWAP a variance conservee (Bruneton 2010), etat de mer en un seul appel garde en local (73361a4)

### Corrections

- **eau** : colonnes blanches (reflet solaire au-dela du demi-flottant, etale par le halo), eau limitee aux faces vers le ciel, une seule lecture du ciel de pres (6ac1b07)

## v0.1.0 — 2026-09-27

### Nouveautes

- **loader** : sortie en rideaux — bandes obliques de gauche a droite, la derniere decouvre la vue (5854407)
- **nuages** : calque Nuages (eteint par defaut) et prevision ICON en direct, gardee dans le navigateur (ab93cac)
- **nuages** : turbulence a grande echelle — silhouettes tordues, sommets inegaux (8d03de4)
- **nuages** : turbulence sans divergence (curl noise) sur la forme et l'erosion, octave fine ; carte fine au seuil du pixel ; carte refaite quand l'oeil change d'altitude (fc8c5b3)
- **nuages** : genres deduits de la donnee (ISCCP, Wang & Sassen), forme Perlin-Worley 3D bornee par la couverture, diffusion multiple calee sur Eddington (41381e0)
- **nuages** : marche a deux regimes, erosion par le detail, cone d'ombre et effet powder ; carte fine de la vue pour le zoom (618b8b5)
- **nuages** : rechargement silencieux au changement d'heure — worker, double carte, accumulation, fondu, barre discrete ; coupes au-dela de x60 (1307345)
- **nuages** : volume de l'etage bas pres de l'observateur ; comparaison des scenarios au satellite (d04230e)
- **nuages** : nappes par etage depuis les scenarios — Eddington, Liou, couverture sous-maille (1fc092e)
- **meteo** : scenario altocumulus sur Lyon (169443f)
- **meteo** : mode scenario — rejouer une journee archivee (lieu, date, air en altitude) (bdf7b2f)
- **meteo** : scenarios figes de journees reelles (ICON archive + image satellite) (7f76441)
- **avions** : modele quadrireacteur ; C-17 et An-124 gardent la silhouette (aae5699)
- **avions** : modele gros-porteur biréacteur (4e04013)
- **avions** : le modele 3D quand on s'approche, la silhouette sinon (ab77c54)
- **trainees** : etalement par cisaillement et bilan de glace, plus de durees de vie inventees (7c8f4e7)
- **trainees** : deux panaches, des bords turbulents, l'instabilite de Crow (eacc011)
- **trainees** : formation et persistance selon l'air reel au niveau de vol (1b79670)
- **avions** : des trainees eclairees par l'atmosphere, plus peintes en blanc (4aef9a3)
- **atmosphere** : un milieu nuageux commun aux nuages et aux trainees (85e5537)
- **avions** : une flotte simulee, et la fin du liseré en bout de trainee (a347f0b)
- **lieu** : la validation reduite a l'essentiel, et des phrases au loader (b58e3a7)
- **lieu** : loader aux etoiles du logo, carte MapLibre, favoris (453905f)
- **lieu** : un loader, un lieu a valider, et une carte Google Maps (b298c2f)
- **brand** : le logo What's Up? en tete du rail, et le primaire au bleu du logo (84ba58e)
- **theme** : What's Up? — palettes du logo, et un theme night noir et ambre (f15606c)
- **scene** : le ciel profond cesse d etre une tache, et le zoom devient un instrument (d5db5e4)
- **scene** : le ciel profond recoit de vraies images, en ecarts de magnitude (768cf7f)
- **terrain** : les lumieres s allument au crepuscule et eclairent l air (e5aa811)
- **terrain** : le sol emet — les lumieres des villes, en unites photometriques (1216b7e)
- **terrain** : l orthophoto de l IGN drapee sur le sol, sa teinte seulement (15208ed)
- **terrain** : une texture de normales sur le sol, assumee fausse (c1504f2)
- **terrain** : le relief proche passe a trois metres avec le RGE ALTI (e33a037)
- **atmosphere** : le clair de lune devient de la diffusion calculee (4ad7a6a)
- **terrain** : le nombre d'anneaux suit l'ecran, comme l'azimut (de795f6)
- **terrain** : le maillage obeit a une erreur d'espace ecran (5721509)
- **terrain** : l'azimut du maillage suit la camera, a budget constant (62abb47)
- **scene** : relief reel a 30 m, globe physique, un seul horizon (a6bd8f9)
- **display** : passe globale — socle nocturne entierement physique (e0de30d)
- **display** : adaptation visuelle — l'exposition suit le ciel (66a267a)
- **atmosphere** : socle nocturne — l'airglow devient une emission calculee (d434d9e)
- **atmosphere** : calage scientifique — phase 19 (5cc2aa6)
- **atmosphere** : seeing et scintillation — phase 17 (8a1839e)
- **atmosphere** : optique ondulatoire — phase 16 (f67be1f)
- **atmosphere** : turbulence optique — phase 15 (6e312ea)
- **atmosphere** : inversions thermiques et mirages — phase 14 (37e9bc5)
- **atmosphere** : atmosphere 3D — phase 13 (7e05d83)
- **atmosphere** : phenomenes emergents de refraction — phase 12 (5286ce5)
- **atmosphere** : courbure des rayons — phase 11 (b43dbf9)
- **atmosphere** : indice de refraction de l'air — phase 10 (024b088)
- **atmosphere** : perspective atmospherique — phase 9 (8f5ae0e)
- **atmosphere** : diffusion multiple — phase 8 (22124d6)
- **atmosphere** : aerosols et theorie de Mie — phase 6 (13e13d1)
- **atmosphere** : ozone et bande de Chappuis — phase 7 (73f0576)
- **atmosphere** : le ciel physique arrive a l'ecran — table de ciel (dc20f55)
- **atmosphere** : table de colonne moleculaire — premiere LUT (7a1e67e)
- **atmosphere** : diffusion simple, le ciel — phase 5 (02eb10d)
- **atmosphere** : Soleil direct et extinction spectrale — phase 4 (be12a47)
- **atmosphere** : diffusion Rayleigh physique — phase 3 (e6c2107)
- **atmosphere** : fondations du moteur physique — phases 0 a 2 (3b44039)
- **satellites** : reunir tous les groupes CelesTrak par defaut (bb22ab0)
- **fiches** : page Details pour tous les objets celestes selectionnes (d2c854e)
- **fiches** : magnitude apparente et absolue, altitude d avion en ligne (ecf2f15)
- **panneau** : afficher la fiche d un avion d un seul tenant (a664917)
- **camera** : accrocher la camera a l objet vise jusqu au prochain balayage (a53b0e4)
- **pollution** : pollution lumineuse mesuree au lieu d observation (28d2ab5)
- **atmosphere** : trouble atmospherique coherent partout, mesure automatiquement (bbe3f0f)
- **reglages** : sliders de pollution lumineuse et de trouble atmospherique (16474ae)
- **atmosphere** : rendre la transmittance, attenuer corps et avions (7425211)
- **ciel** : vraie diffusion atmospherique (Rayleigh + Mie) a la place de Preetham (de1058e)
- **ciel** : projection stereographique a la place de la perspective simple (227a670)
- **ui** : avions en live (118c636)
- **satellites** : nuee du catalogue en points blancs, fiche ancree, etiquettes de champ (1cc4654)
- **ciel** : recherche d objets, pointage a la souris, satellites CelesTrak (bc1a787)
- **sources** : client CelesTrak, format GP JSON avec cache de six heures (5927fe7)
- **sources** : couche commune de recuperation avec cache et repli (c4290fa)
- **sources** : calque ciel profond, rendu a la taille apparente reelle (4b4e130)
- **sources** : catalogue OpenNGC embarque au build (0d00215)

### Corrections

- **loader** : la derniere bande ne prend plus la couleur du fond, ou elle etait invisible a l'arrivee (a69abb9)
- **adsb** : relais servi par Vite (adsb.fi puis adsb.lol), mesures datees par l'horloge du serveur, altitude GNSS (97156a6)
- **nuages** : marches horizontales aux bords — lignes d'une passe abandonnee divisees par leur vrai nombre d'echantillons ; turbulence a l'echelle du nuage (e7670d8)
- **nuages** : marche allegee — champ relu par kilometre de rayon, bandes de 24 lignes au plus (a3a3436)
- **nuages** : cumulus sous-maille calcules par panache depuis la surface ; cellules a l'echelle de leur epaisseur (fc0ad5f)
- **trainees** : les panaches partent de leurs reacteurs, vus sous le bon angle (8b7e446)
- **avions** : monocouloir corrige — aretes vives, feu de queue, feux anticollision (de88ec1)
- **trainees** : un panache par reacteur — l'A380 en trace quatre (a91e3f4)
- **loader** : le tremblement des etoiles ramene a ±2,5 % (9aadbad)
- **scene** : le ciel profond recoit l extinction et perd ses couleurs (93a41fb)
- **terrain** : l enveloppe ne remplace la surface que la ou l oeil ne la voit plus (9503ba9)
- **terrain** : la ligne d horizon devient un maximum, plus un echantillon (c7cb42d)
- **terrain** : la tolerance du test d ombre se deduit au lieu d etre posee (3711c10)
- **scene** : une seule expression du ciel, et le relief simule cesse d'inventer (234118c)
- **scene** : trois reglages choisis remplaces par trois grandeurs calculees (84e54e3)
- **display** : trois decades d'ecart jour-nuit, la lueur crepusculaire s'eteint (3caaf6e)
- **atmosphere** : la table jetait 93 % du ciel crepusculaire (f551ac6)
- **atmosphere** : la diffusion multiple cesse de fermer sa serie sur place (dfa2143)
- **display** : la re-saturation cesse d'ecreter le degrade du crepuscule (aff5cfa)
- **atmosphere** : la coordonnee de distance ne connait plus la sphere (5313428)
- **ui** : responsive (257afd8)
- **pollution** : eteindre le halo urbain de jour, et le laisser sans teinte (292a88d)
- **atmosphere** : integrer la transmittance sur toute la longueur du pas (cb6157e)
- **mie** : garder la brume collee a la basse couche (1bafd54)
- **trouble** : piloter la brume par les particules au sol, plus par l AOD (82898f7)
- **rendu** : supprimer le scintillement des traits fins (7562c14)
- **catalogue** : retirer le Soleil du catalogue d etoiles fixes (416cd63)
- **frise** : vitesses conformes aux libelles et frise compacte sur telephone (a5a909e)
- **atmosphere** : trouble automatique bien trop fort (081343d)
- **build** : reparer le script typecheck (930df96)
- **photometrie** : trop d etoiles visibles sous pollution lumineuse (7c35dbf)
- **ciel** : unifier le tone mapping du voile atmospherique, reduire la lumiere cendree (5748267)
- **ciel** : remplacer le voile additif des corps par la vraie diffusion (6dd9cc1)
- **satellites** : calibrer la magnitude par defaut sur un satellite ordinaire (be5a6d7)
- **ui** : sections repliees laissaient depasser leur remplissage (59353e7)
- **ui** : coherence MD3 Expressive et accessibilite (74c7d77)
- **avions** : resorption geometrique anti-recul, trace de vol au clic (91590c7)
- **avions** : supprimer le recul residuel a chaque nouvelle mesure (bfdf308)
- **avions** : position figee, recul a chaque mesure, trainees detachees (2093abc)
- **ui** : contenu ampute dans les panneaux, les puces et les series (e22818f)
- **build** : sortir le moteur WebAssembly de satellite.js du graphe (b57e7f8)
- **scene** : position des corps non refractee, et zoom jusqu a la minute d arc (a8fc0c4)
- **autonomie** : encodage du fichier d etat restaure (990ee4a)
- **scene** : fond de ciel opaque, Soleil blanc, voile atmospherique (231f112)

### Performances

- **nuages** : octaves precalculees en textures (structure 2D, detail 3D), cadence adaptative ; volume plus detaille (09ed151)
- **nuages** : carte des directions calculee par bandes, lue a l'ecran ; volume plus detaille (6bb8843)
- **loader** : des animations hors du fil principal, une scene au rabais dessous (a8b88a5)
- **atmosphere** : la tranche de construction devient une duree, plus un compte (fb6047c)
- **scene** : le tampon par defaut cesse d'etre multi-echantillonne (46c632f)
- **atmosphere** : optimisation — phase 20 (f0175a1)
- **temps** : rendre le temps accelere continu (0ef6892)
- **satellites** : un seul flux CelesTrak et une seule propagation par instant (11533f5)

### Reorganisation du code

- **ui** : l'interface perd ses textes de contexte et ses surtitres (21ae18f)
- **rendu** : chaine d'affichage HDR lineaire — phase 0.5 (e5efa76)

### Apparence

- **loader** : deux bandes au lieu de quatre — transition plus courte, meme vitesse (e044b7f)
- **loader** : rideaux un peu plus lents, ease-in plus appuye (920fb7c)
- **loader** : fond a la couleur du logo (primary), contenu en on-primary ; noir strict en night (cb59f6a)

### Documentation

- **terrain** : le mont Blanc a 288 km, et une loi d anneaux qui n a pas tenu (9222833)
- **terrain** : registre — la carte d ombre devient le maillon grossier (6a746d5)
- **atmosphere** : registre — le halo lunaire peint, mesure sur le disque de la Lune (d9ea387)
- **atmosphere** : registre — deux causes mesurees separement au crepuscule profond (18eec8f)
- **atmosphere** : registre — le crepuscule profond est trop sombre, mesure (17485f1)
- **autonomie** : fichier d etat a jour apres solde des dettes (a3c699a)
- **autonomie** : fichier d etat a jour, boucle de reprise armee (5e1fb61)

