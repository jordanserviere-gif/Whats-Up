/**
 * RGE ALTI — le modele numerique de terrain de l'IGN, a trois metres.
 *
 * ## Pourquoi une seconde source d'altitude
 *
 * Les tuiles Terrarium plafonnent a la resolution de leur donnee d'origine :
 * **trente metres**, le SRTM, partout hors des Etats-Unis. Les niveaux de zoom
 * superieurs existent mais ne portent que de l'interpolation. C'est le plancher
 * dur du relief mondial, et aucun changement de format ne le releve.
 *
 * L'IGN diffuse pour la France un modele bien plus fin, issu de leves lidar et
 * radar. Mesure sur la tuile du Ventoux, denivele type entre points voisins :
 *
 * | ecart entre points | denivele type |
 * | --- | --- |
 * | 27,4 m — ce que Terrarium donne | 7,81 m |
 * | 13,7 m | 3,98 m |
 * | 6,9 m | 2,01 m |
 * | **3,4 m** | **1,01 m** |
 *
 * Le relief garde donc de la structure a **toutes** les echelles jusqu'a trois
 * metres : ce n'est pas de l'interpolation lissee, c'est du terrain.
 *
 * ## ⚠️ Ce que cette source n'est pas
 *
 * **Elle ne couvre que la France**, metropole et outre-mer. Ailleurs le service
 * repond 404 avec un `ExceptionReport`, et il faut retomber sur Terrarium. Ce
 * n'est pas un cas d'erreur mais le fonctionnement normal.
 *
 * **Elle n'est pas metrique partout.** Le RGE ALTI est a un metre de maille,
 * mais sa precision verticale depend de la methode : lidar en plaine et sur les
 * cotes, a vingt a cinquante centimetres pres ; **radar en montagne**, ou sur
 * les fortes pentes l'erreur atteint sept metres. La grille est fine ; la verite
 * l'est moins. Voir le registre.
 *
 * ## La grille, qui n'est pas celle de Terrarium
 *
 * Terrarium suit la projection de Mercator ; l'IGN diffuse ici une grille
 * **geographique** — degres de longitude et de latitude, sans projection. Au
 * niveau 14 le monde tient en 32768 x 16384 tuiles de 256 points, soit un point
 * tous les 4,3·10⁻⁵ degres. A la latitude du Ventoux cela fait **3,4 m en
 * longitude et 4,8 m en latitude** : la maille n'est pas carree, et elle
 * s'etire vers le nord.
 *
 * Les valeurs arrivent en BIL 32 bits — quatre octets par point, flottant
 * petit-boutiste, sans en-tete. Deux cent cinquante-six mille octets par tuile.
 */
import { fetchBinary } from '@/data-sources/fetchJson'

/** Racine du service WMTS de la Geoplateforme. Aucune cle n'est requise. */
const WMTS = 'https://data.geopf.fr/wmts'

/** Couche du modele numerique de terrain haute resolution. */
const LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES'

/** Grille geographique de la couche, du niveau 6 au niveau 14. */
const MATRIX_SET = 'WGS84G_6_14'

/** Niveau le plus fin publie. */
export const RGE_ALTI_ZOOM = 14

/** Cote d'une tuile, en points. */
export const RGE_ALTI_TILE_SIZE = 256

/** Etendue d'une tuile, en degres — la meme en longitude et en latitude. */
export const rgeAltiTileSpanDeg = (zoom = RGE_ALTI_ZOOM): number => 360 / 2 ** (zoom + 1)

/** Pas entre deux points d'une tuile, en degres. */
export const rgeAltiStepDeg = (zoom = RGE_ALTI_ZOOM): number =>
  rgeAltiTileSpanDeg(zoom) / RGE_ALTI_TILE_SIZE

/**
 * Resolution au sol, metres, a une latitude donnee.
 *
 * Rend les deux directions : la grille etant en degres, la maille se resserre
 * en longitude a mesure qu'on monte vers le pole.
 */
export function rgeAltiResolutionM(
  latitudeDeg: number,
  zoom = RGE_ALTI_ZOOM,
): { eastM: number; northM: number } {
  const stepDeg = rgeAltiStepDeg(zoom)
  const metresPerDegree = 111_320
  return {
    eastM: stepDeg * metresPerDegree * Math.cos((latitudeDeg * Math.PI) / 180),
    northM: stepDeg * metresPerDegree,
  }
}

/** Indice de tuile, et position fractionnaire dedans, pour un point geographique. */
export function rgeAltiTile(
  longitudeDeg: number,
  latitudeDeg: number,
  zoom = RGE_ALTI_ZOOM,
): { col: number; row: number; x: number; y: number } {
  const stepDeg = rgeAltiStepDeg(zoom)
  // Coordonnee en points sur la grille mondiale, origine au coin haut-gauche
  // (-180°, +90°) : la latitude descend quand la ligne monte.
  const gx = (longitudeDeg + 180) / stepDeg
  const gy = (90 - latitudeDeg) / stepDeg
  const col = Math.floor(gx / RGE_ALTI_TILE_SIZE)
  const row = Math.floor(gy / RGE_ALTI_TILE_SIZE)
  return { col, row, x: gx - col * RGE_ALTI_TILE_SIZE, y: gy - row * RGE_ALTI_TILE_SIZE }
}

/** Adresse d'une tuile. */
export const rgeAltiUrl = (col: number, row: number, zoom = RGE_ALTI_ZOOM): string =>
  `${WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${LAYER}&STYLE=normal` +
  `&TILEMATRIXSET=${MATRIX_SET}&TILEMATRIX=${zoom}&TILEROW=${row}&TILECOL=${col}` +
  `&FORMAT=image/x-bil;bits=32`

/**
 * Decode une tuile BIL 32 bits.
 *
 * Aucun en-tete, aucun ordre a deviner : deux cent cinquante-six lignes de deux
 * cent cinquante-six flottants petit-boutistes, du nord-ouest au sud-est. Rend
 * `null` si la taille ne correspond pas — hors couverture, le service renvoie un
 * `ExceptionReport` de cent trente-sept octets, qu'on reconnait ainsi sans
 * analyser du XML.
 */
export function decodeBilTile(buffer: ArrayBuffer): Float32Array | null {
  const expected = RGE_ALTI_TILE_SIZE * RGE_ALTI_TILE_SIZE * 4
  if (buffer.byteLength !== expected) return null
  const view = new DataView(buffer)
  const out = new Float32Array(RGE_ALTI_TILE_SIZE * RGE_ALTI_TILE_SIZE)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

/** Duree de conservation d'une tuile — le relief ne bouge pas. */
const TILE_TTL_MS = 30 * 24 * 3600 * 1000

/**
 * Recupere et decode une tuile. Rend `null` hors couverture.
 *
 * ⚠️ Le 404 n'est pas un incident : c'est ainsi que le service dit « pas de
 * donnee ici ». L'appelant retombe sur la source mondiale.
 */
export async function fetchRgeAltiTile(
  col: number,
  row: number,
  zoom = RGE_ALTI_ZOOM,
): Promise<Float32Array | null> {
  try {
    const sourced = await fetchBinary(
      rgeAltiUrl(col, row, zoom),
      {
        key: `rgealti:${zoom}/${col}/${row}`,
        ttlMs: TILE_TTL_MS,
        timeoutMs: 12_000,
        attempts: 2,
      },
      decodeBilTile,
    )
    return sourced?.value ?? null
  } catch {
    return null
  }
}
