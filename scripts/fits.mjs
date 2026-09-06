/**
 * Lecture d'un FITS simple, et ecriture d'un PNG en niveaux de gris.
 *
 * Juste ce qu'il faut pour l'atlas du ciel profond : une image bidimensionnelle
 * dans l'unite primaire, et une sortie a un seul canal. Rien de general.
 */
import { deflateSync } from 'node:zlib'

/**
 * Ouvre un FITS et rend ses pixels en nombres.
 *
 * ⚠️ L'ordre est celui du fichier : le FITS compte ses lignes **depuis le bas**,
 * si bien que la premiere ligne du tableau est le bas de l'image.
 *
 * Les valeurs sont ramenees en unites physiques par `BZERO + BSCALE·v`, et les
 * pixels marques `BLANK` rendus `NaN`.
 */
export function readFits(buffer) {
  const carte = {}
  let position = 0
  let fini = false
  while (!fini) {
    for (let k = 0; k < 36; k++) {
      const ligne = buffer.toString('ascii', position + k * 80, position + k * 80 + 80)
      const clef = ligne.slice(0, 8).trim()
      if (clef === 'END') {
        fini = true
        break
      }
      if (ligne[8] === '=') carte[clef] = ligne.slice(9).split('/')[0].trim()
    }
    position += 2880
  }

  const bitpix = Number(carte.BITPIX)
  const largeur = Number(carte.NAXIS1)
  const hauteur = Number(carte.NAXIS2)
  const zero = carte.BZERO === undefined ? 0 : Number(carte.BZERO)
  const echelle = carte.BSCALE === undefined ? 1 : Number(carte.BSCALE)
  const vide = carte.BLANK === undefined ? null : Number(carte.BLANK)

  const n = largeur * hauteur
  const pixels = new Float64Array(n)
  const lire = {
    8: (o) => buffer.readUInt8(o),
    16: (o) => buffer.readInt16BE(o),
    32: (o) => buffer.readInt32BE(o),
    '-32': (o) => buffer.readFloatBE(o),
    '-64': (o) => buffer.readDoubleBE(o),
  }[String(bitpix)]
  if (!lire) throw new Error(`BITPIX ${bitpix} non gere`)
  const octets = Math.abs(bitpix) / 8
  for (let k = 0; k < n; k++) {
    const brut = lire(position + k * octets)
    pixels[k] = vide !== null && brut === vide ? NaN : zero + echelle * brut
  }
  return { largeur, hauteur, pixels, carte }
}

// --- PNG, un seul canal ----------------------------------------------------
//
// Le canevas ne sait ecrire qu'en RVBA : quatre fois le poids pour une image
// qui ne porte qu'une seule grandeur. Un encodeur d'une centaine de lignes
// evite de livrer trois canaux identiques et un canal opaque.

const TABLE_CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = TABLE_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function bloc(type, donnees) {
  const entete = Buffer.alloc(8)
  entete.writeUInt32BE(donnees.length, 0)
  entete.write(type, 4, 'ascii')
  const cs = Buffer.alloc(4)
  cs.writeUInt32BE(crc32(Buffer.concat([entete.subarray(4), donnees])), 0)
  return Buffer.concat([entete, donnees, cs])
}

/** Predicteur de Paeth, tel que le definit la norme PNG. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Ecrit un PNG en niveaux de gris a huit bits.
 *
 * Le filtre est choisi ligne par ligne selon l'heuristique de la norme : celui
 * dont la somme des valeurs absolues signees est la plus faible.
 */
export function writeGrayPng(pixels, largeur, hauteur) {
  const brut = Buffer.alloc(hauteur * (largeur + 1))
  const essai = Buffer.alloc(largeur)
  const garde = Buffer.alloc(largeur)
  for (let y = 0; y < hauteur; y++) {
    const ligne = pixels.subarray(y * largeur, (y + 1) * largeur)
    const dessus = y > 0 ? pixels.subarray((y - 1) * largeur, y * largeur) : null
    let meilleur = 0
    let meilleurCout = Infinity
    for (let f = 0; f < 5; f++) {
      let cout = 0
      for (let x = 0; x < largeur; x++) {
        const a = x > 0 ? ligne[x - 1] : 0
        const b = dessus ? dessus[x] : 0
        const c = dessus && x > 0 ? dessus[x - 1] : 0
        const v =
          f === 0 ? ligne[x]
          : f === 1 ? ligne[x] - a
          : f === 2 ? ligne[x] - b
          : f === 3 ? ligne[x] - ((a + b) >> 1)
          : ligne[x] - paeth(a, b, c)
        essai[x] = v & 0xff
        cout += Math.abs((essai[x] << 24) >> 24)
      }
      if (cout < meilleurCout) {
        meilleurCout = cout
        meilleur = f
        essai.copy(garde)
      }
    }
    brut[y * (largeur + 1)] = meilleur
    garde.copy(brut, y * (largeur + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(largeur, 0)
  ihdr.writeUInt32BE(hauteur, 4)
  ihdr[8] = 8 // huit bits
  ihdr[9] = 0 // niveaux de gris
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc('IHDR', ihdr),
    bloc('IDAT', deflateSync(brut, { level: 9 })),
    bloc('IEND', Buffer.alloc(0)),
  ])
}
