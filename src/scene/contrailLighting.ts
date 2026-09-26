import { directSolar } from '@/atmosphere/transport/directSolar'
import { uniformSpectralGrid } from '@/atmosphere/spectral/SpectralGrid'
import { SEA_LEVEL_PRESSURE_PA, standardPressure } from '@/atmosphere/thermodynamics/standardAtmosphere'

/**
 * Eclairage d'une trainee, la ou elle est — pas la ou est l'observateur.
 *
 * ## Le Soleil vu depuis l'altitude de vol
 *
 * A onze kilometres, le Soleil traverse quatre fois moins d'air qu'au sol, et
 * il reste leve bien apres s'etre couche pour nous : l'horizon y est abaisse de
 * 3,4°. C'est ce qui fait les trainees dorees puis roses du crepuscule, allumees
 * sur un ciel deja sombre, puis eteintes d'un coup quand l'ombre de la Terre
 * les rattrape. `directSolar` fait deja tout cela : son trajet est spherique,
 * et un rayon qui rase le sol y devient une colonne infinie.
 *
 * La hauteur du Soleil est aussi corrigee du **lieu** : un avion a 60 km vers
 * l'ouest voit le Soleil un demi-degre plus haut que nous au couchant.
 *
 * ## La lumiere diffuse
 *
 * Un milieu diffusant eclaire de toutes parts par une radiance quasi isotrope
 * renvoie la moyenne de cette radiance. Au-dessus, le ciel — attenue comme la
 * colonne d'air qu'il reste a traverser, la diffusion du ciel lui etant
 * proportionnelle au premier ordre ; en dessous, le sol et les basses couches,
 * d'albedo effectif `UPWELLING_ALBEDO`. D'ou :
 *
 *     L_amb = (E_ciel · f(h) + ρ · (E_soleil,sol · sin h☉ + E_ciel)) / (2π)
 */

const GRID = uniformSpectralGrid(360, 830, 32)

/** Albedo effectif de ce qui est sous l'avion : sol, brume, nuages bas. */
const UPWELLING_ALBEDO = 0.25

const EARTH_RADIUS_KM = 6371

const cache = new Map<string, [number, number, number]>()

/**
 * Irradiance solaire directe a l'altitude `altitudeM`, pour un Soleil de
 * hauteur geometrique `sunAltitudeDeg` en ce lieu — sRGB lineaire, sur la meme
 * echelle que `sunIrradiance` du sol.
 *
 * Quantifiee a 0,05° et 250 m : c'est une integration spectrale le long du
 * trajet, trop chere pour chaque image, et rien ne se voit en dessous.
 */
export function sunIrradianceAtAltitude(sunAltitudeDeg: number, altitudeM: number): [number, number, number] {
  const alt = Math.round(sunAltitudeDeg * 20) / 20
  const h = Math.round(altitudeM / 250) * 250
  const key = `${alt}:${h}`
  let hit = cache.get(key)
  if (!hit) {
    const rgb = directSolar(GRID, alt, { observerElevationM: h }).linearSrgb
    hit = [rgb[0], rgb[1], rgb[2]]
    if (cache.size > 4000) cache.clear()
    cache.set(key, hit)
  }
  return hit
}

/**
 * Hauteur du Soleil vue depuis un point au sol distant de `groundRangeKm`,
 * dans l'azimut `azimuthDeg` : la verticale y est inclinee de l'angle au
 * centre, projete sur la direction du Soleil.
 */
export function sunAltitudeAt(
  sunAltitudeDeg: number,
  sunAzimuthDeg: number,
  azimuthDeg: number,
  groundRangeKm: number,
): number {
  const centralAngleDeg = (groundRangeKm / EARTH_RADIUS_KM) * (180 / Math.PI)
  return sunAltitudeDeg + centralAngleDeg * Math.cos(((azimuthDeg - sunAzimuthDeg) * Math.PI) / 180)
}

/** Radiance diffuse moyenne recue par la trainee — voir l'en-tete. */
export function ambientRadianceAtAltitude(
  altitudeM: number,
  skyIrradiance: readonly [number, number, number],
  groundSunIrradiance: readonly [number, number, number],
  sunAltitudeDeg: number,
): [number, number, number] {
  const above = standardPressure(altitudeM) / SEA_LEVEL_PRESSURE_PA
  const sinSun = Math.max(0, Math.sin((sunAltitudeDeg * Math.PI) / 180))
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const up = UPWELLING_ALBEDO * (groundSunIrradiance[i] * sinSun + skyIrradiance[i])
    out[i] = (skyIrradiance[i] * above + up) / (2 * Math.PI)
  }
  return out
}
