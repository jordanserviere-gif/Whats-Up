/**
 * Atlas d'images du ciel profond.
 *
 * ## Pourquoi hors ligne
 *
 * Cinq cent quarante objets, une requete chacun : c'est une minute de reseau,
 * pas quelque chose qu'on demande a l'utilisateur a chaque ouverture. L'atlas
 * est donc construit une fois et livre avec l'application, comme les catalogues.
 *
 * ## ⚠️ Une plaque photographique n'est pas une carte de radiance
 *
 * C'est le meme piege que l'orthophoto drapee sur le terrain. Employer une
 * image comme luminance contredirait la photometrie du moteur, qui calcule deja
 * la brillance de surface a partir de la magnitude et des dimensions du
 * catalogue.
 *
 * On n'en garde donc que le **profil** : la maniere dont la lumiere se repartit
 * dans l'objet, ramenee a une moyenne de un sur l'ellipse du catalogue. C'est
 * la photometrie du moteur qui lui donne ensuite son niveau absolu.
 *
 * Le service est interroge en **FITS** pour cette raison precise : il rend
 * alors les valeurs lineaires du releve, sans etirement ni ecretage en
 * percentiles. Un JPEG ou un PNG auraient impose une courbe de contraste
 * arbitraire au profil.
 *
 * ## Le stockage : un ecart de magnitude, pas une intensite
 *
 * Le profil couvre quatre decades. Range lineairement sur huit bits, le pas de
 * quantification vaudrait plusieurs fois la moyenne pour les objets les plus
 * piques — mesure sur un premier jet : un rapport pic sur moyenne de 9 241.
 *
 * L'octet stocke donc `log10(p)`, ce qui revient a stocker un **ecart de
 * magnitude** par rapport a la brillance moyenne :
 *
 *     mu_locale = mu_moyenne − 2,5·log10(p) = mu_moyenne + 5 − 10·q
 *
 * Dix magnitudes reparties sur 255 niveaux : un pas de 0,039 magnitude,
 * constant du coeur au halo, tres au-dessous de tout seuil perceptible.
 *
 * ## Le cadrage et l'orientation
 *
 * La tuile couvre **exactement** le grand axe du catalogue, ce qui rend la
 * correspondance avec le quad du rendu triviale — celui-ci a la meme etendue.
 *
 * ⚠️ L'orientation a ete **mesuree**, pas supposee. A `rotation_angle = 0` le
 * service rend deja le nord en haut et l'est a gauche ; c'est `−PA` qui amene
 * le grand axe a la verticale, et non `+PA`. Verifie de deux facons : par les
 * moments d'ordre deux de six galaxies tres allongees, et par la matrice de
 * passage du FITS lui-meme.
 *
 * Usage : node scripts/build-dso-atlas.mjs [nombre max d'objets]
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFits, writeGrayPng } from './fits.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Releve HiPS interroge. Le rouge du DSS2 couvre tout le ciel et va profond. */
const HIPS = 'CDS/P/DSS2/red'

/**
 * Taille apparente minimale pour meriter une image, minutes d'arc.
 *
 * En dessous, l'objet occupe si peu de pixels qu'aucune image ne le distinguera
 * d'une tache : cinq minutes d'arc font trente pixels a deux degres de champ.
 */
const MIN_MAJOR_ARCMIN = 5

/** Cote d'une tuile, en pixels. */
const TILE = 96

/** Tuiles par rangee. 24 x 24 = 576 emplacements pour 548 objets. */
const GRID = 24

/** Requetes simultanees. Assez pour tenir la minute, assez peu pour rester poli. */
const PARALLEL = 6

/**
 * Bornes de l'encodage, en decades autour de la brillance moyenne.
 *
 * De cent fois plus faible a cent fois plus brillant que la moyenne, soit dix
 * magnitudes. ⚠️ Ce qui depasse est ecrete : le tout coeur des amas globulaires
 * et les etoiles de champ les plus vives.
 */
const PROFILE_LO_DEX = -2
const PROFILE_HI_DEX = 2

const catalogue = JSON.parse(readFileSync(join(ROOT, 'src/data/deepsky.json'), 'utf8'))
const limite = Number(process.argv[2] ?? Infinity)

const retenus = []
for (let i = 0; i < catalogue.count && retenus.length < limite; i++) {
  if (catalogue.major[i] >= MIN_MAJOR_ARCMIN) retenus.push(i)
}
console.log(`${retenus.length} objets retenus sur ${catalogue.count} (grand axe >= ${MIN_MAJOR_ARCMIN} arcmin)`)
if (retenus.length > GRID * GRID) {
  console.error(`atlas trop petit : ${GRID}x${GRID} = ${GRID * GRID} emplacements`)
  process.exit(1)
}

const url = (i) =>
  'https://alasky.cds.unistra.fr/hips-image-services/hips2fits' +
  `?hips=${encodeURIComponent(HIPS)}` +
  `&ra=${catalogue.ra[i]}&dec=${catalogue.dec[i]}&fov=${catalogue.major[i] / 60}` +
  `&width=${TILE}&height=${TILE}&projection=TAN` +
  // ⚠️ Le signe est mesure, voir l'en-tete.
  `&rotation_angle=${-catalogue.angle[i]}` +
  '&format=fits'

/** Mediane d'un tableau de nombres finis. */
function mediane(valeurs) {
  const v = valeurs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

const largeurAtlas = TILE * GRID
const atlas = Buffer.alloc(largeurAtlas * largeurAtlas)
const index = []
const echecs = []
/** Ecart du grand axe a la verticale, pour les objets nettement allonges. */
const orientations = []
let ecretesHaut = 0
let totalEllipse = 0

async function traiter(i, slot) {
  let fits = null
  for (let essai = 0; essai < 3 && !fits; essai++) {
    try {
      const reponse = await fetch(url(i), { signal: AbortSignal.timeout(90_000) })
      if (!reponse.ok) continue
      fits = readFits(Buffer.from(await reponse.arrayBuffer()))
    } catch {
      /* on retente */
    }
  }
  if (!fits || fits.largeur !== TILE || fits.hauteur !== TILE) return false

  const demi = TILE / 2
  const a = demi
  const rapport = catalogue.minor[i] > 0 ? catalogue.minor[i] / catalogue.major[i] : 1
  const b = Math.max(1e-6, demi * rapport)

  // --- Le fond de ciel, mesure la ou le catalogue dit qu'il n'y a rien -------
  //
  // La tuile couvrant exactement le grand axe, l'ellipse y est inscrite : ses
  // coins sont hors de l'objet. ⚠️ Un objet reel deborde son ellipse de
  // catalogue, si bien que ce fond est legerement surestime et les extensions
  // les plus tenues tronquees.
  const dehors = []
  const rayon = new Float64Array(TILE * TILE)
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const dx = (x + 0.5 - demi) / b
      const dy = (y + 0.5 - demi) / a
      const d = Math.sqrt(dx * dx + dy * dy)
      rayon[y * TILE + x] = d
      if (d > 1) dehors.push(fits.pixels[y * TILE + x])
    }
  }
  const ciel = mediane(dehors)
  if (!Number.isFinite(ciel)) return false

  // --- Le profil, ramene a une moyenne de un sur l'ellipse ------------------
  const profil = new Float64Array(TILE * TILE)
  let somme = 0
  let dedans = 0
  for (let k = 0; k < TILE * TILE; k++) {
    const v = fits.pixels[k]
    profil[k] = Number.isFinite(v) ? Math.max(0, v - ciel) : 0
    if (rayon[k] <= 1) {
      somme += profil[k]
      dedans++
    }
  }
  if (!(somme > 0) || dedans === 0) return false
  const moyenne = somme / dedans

  // --- L'orientation, verifiee sur ce qui est reellement arrive -------------
  //
  // Moments d'ordre deux sur le disque inscrit — un masque circulaire, donc
  // sans biais d'angle, contrairement au masque elliptique.
  if (rapport < 0.6) {
    let s = 0
    let mxx = 0
    let myy = 0
    let mxy = 0
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = x + 0.5 - demi
        const dy = y + 0.5 - demi
        if (dx * dx + dy * dy > demi * demi) continue
        const v = profil[y * TILE + x]
        s += v
        mxx += v * dx * dx
        myy += v * dy * dy
        mxy += v * dx * dy
      }
    }
    if (s > 0) {
      mxx /= s
      myy /= s
      mxy /= s
      const theta = (0.5 * Math.atan2(2 * mxy, mxx - myy) * 180) / Math.PI
      // Angle depuis la verticale, ramene dans [0, 90].
      let ecart = Math.abs(90 - theta) % 180
      if (ecart > 90) ecart = 180 - ecart
      orientations.push(ecart)
    }
  }

  // --- Ecriture : un ecart de magnitude sur huit bits -----------------------
  const ox = (slot % GRID) * TILE
  const oy = Math.floor(slot / GRID) * TILE
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const p = profil[y * TILE + x] / moyenne
      const dex = p > 0 ? Math.log10(p) : -Infinity
      if (rayon[y * TILE + x] <= 1) {
        totalEllipse++
        if (dex > PROFILE_HI_DEX) ecretesHaut++
      }
      const t = (dex - PROFILE_LO_DEX) / (PROFILE_HI_DEX - PROFILE_LO_DEX)
      // Hors de l'ellipse, le nuanceur rejette le fragment : ces pixels ne sont
      // jamais lus, et le bruit de fond du releve qu'ils portent ne ferait que
      // peser. Une marge d'un pixel les laisse a l'interpolation bilineaire.
      const q =
        rayon[y * TILE + x] > 1 + 2 / TILE ? 0 : Math.round(255 * Math.min(1, Math.max(0, t)))
      // ⚠️ Le FITS compte ses lignes depuis le **bas**, le PNG depuis le haut :
      // la premiere ligne ecrite est la derniere lue, pour que le nord soit en
      // haut de l'image comme il l'est en haut du quad.
      atlas[(oy + (TILE - 1 - y)) * largeurAtlas + ox + x] = q
    }
  }
  return true
}

const debut = Date.now()
for (let d = 0; d < retenus.length; d += PARALLEL) {
  const lot = retenus.slice(d, d + PARALLEL)
  const faits = await Promise.all(lot.map((i, k) => traiter(i, d + k)))
  faits.forEach((ok, k) => {
    if (ok) index.push({ catalogue: lot[k], slot: d + k })
    else echecs.push(lot[k])
  })
  process.stdout.write(`\r  ${d + lot.length}/${retenus.length}   `)
}
process.stdout.write('\r')

const png = writeGrayPng(atlas, largeurAtlas, largeurAtlas)
mkdirSync(join(ROOT, 'public/textures'), { recursive: true })
writeFileSync(join(ROOT, 'public/textures/dso-atlas.png'), png)

// L'index est colonnaire, comme les catalogues : un tableau par champ plutot
// qu'un objet par entree. Les bornes d'encodage y figurent pour que le nuanceur
// les lise ici plutot que de les redefinir.
const trie = index.sort((x, y) => x.catalogue - y.catalogue)
writeFileSync(
  join(ROOT, 'src/data/dso-atlas.json'),
  JSON.stringify({
    hips: HIPS,
    tile: TILE,
    grid: GRID,
    minMajorArcmin: MIN_MAJOR_ARCMIN,
    profileLoDex: PROFILE_LO_DEX,
    profileHiDex: PROFILE_HI_DEX,
    count: trie.length,
    catalogue: trie.map((e) => e.catalogue),
    slot: trie.map((e) => e.slot),
  }),
)

// --- Relecture de ce qui est reellement livre -------------------------------
//
// La moyenne du profil sur l'ellipse vaut un **par construction** — raison de
// plus pour le verifier sur les octets ecrits plutot que sur l'intention :
// l'encodage logarithmique, le plancher a −2 decades et l'arrondi a huit bits
// se glissent tous entre les deux.
let pireEcart = 0
let pireObjet = -1
for (const { catalogue: i, slot } of index) {
  const demi = TILE / 2
  const rapport = catalogue.minor[i] > 0 ? catalogue.minor[i] / catalogue.major[i] : 1
  const b = Math.max(1e-6, demi * rapport)
  const ox = (slot % GRID) * TILE
  const oy = Math.floor(slot / GRID) * TILE
  let somme = 0
  let dedans = 0
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const dx = (x + 0.5 - demi) / b
      const dy = (y + 0.5 - demi) / demi
      if (dx * dx + dy * dy > 1) continue
      const q = atlas[(oy + y) * largeurAtlas + ox + x] / 255
      somme += 10 ** (PROFILE_LO_DEX + q * (PROFILE_HI_DEX - PROFILE_LO_DEX))
      dedans++
    }
  }
  const ecart = Math.abs(somme / dedans - 1)
  if (ecart > pireEcart) {
    pireEcart = ecart
    pireObjet = i
  }
}

const duree = ((Date.now() - debut) / 1000).toFixed(0)
console.log(`atlas : ${(png.length / 1024 / 1024).toFixed(2)} Mo, ${trie.length} tuiles, ${echecs.length} echec(s), ${duree} s`)
if (echecs.length) console.log(`  echecs : ${echecs.map((i) => catalogue.id[i]).join(' ')}`)
console.log(
  `orientation : ecart du grand axe a la verticale sur ${orientations.length} objets allonges — ` +
    `mediane ${mediane(orientations).toFixed(1)} deg`,
)
console.log(`ecretage haut : ${((100 * ecretesHaut) / Math.max(1, totalEllipse)).toFixed(3)} % des pixels de l ellipse`)
console.log(
  `relecture : moyenne du profil sur l ellipse, ecart maximal ${(100 * pireEcart).toFixed(1)} % ` +
    `(${pireObjet >= 0 ? catalogue.id[pireObjet] : '-'})`,
)
console.log('  public/textures/dso-atlas.png  et  src/data/dso-atlas.json')
