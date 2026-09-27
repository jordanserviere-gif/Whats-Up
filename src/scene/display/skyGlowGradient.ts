/**
 * Le fond de ciel n'est pas uniforme : il s'eclaircit vers l'horizon.
 *
 * ## Le probleme
 *
 * La magnitude limite du moteur est **une** valeur, celle du zenith : les
 * paliers de Bortle sont ancres sur la brillance du fond **au zenith**, et la
 * relation de Schaefer en tire la limite. Tout ce qui compare un astre a cette
 * limite — etoiles, ciel profond, Voie lactee — le jugeait donc sur le ciel du
 * zenith, quelle que soit sa hauteur.
 *
 * Or le ciel pres de l'horizon est bien plus clair, et pour deux raisons
 * independantes. Sous un ciel de banlieue, le nuage du Sagittaire, bas depuis
 * l'Europe, restait ainsi franchement visible la ou un observateur ne voit que
 * le halo des lumieres.
 *
 * ## Les deux lois
 *
 * **La lueur naturelle** vient d'une couche mince, vers 90 km (les raies de
 * l'oxygene et de l'hydroxyle). Une visee oblique la traverse plus longuement,
 * d'un facteur que la geometrie donne exactement — la loi de van Rhijn :
 *
 *     V(z) = 1 / √(1 − (R/(R+h))² · sin² z)
 *
 * Emise au-dessus de l'air, elle est ensuite eteinte le long de la visee :
 * `V(z) · 10^(−0,4·k·(X−1))`.
 *
 * **Le halo urbain** est de la lumiere diffusee **dans** l'air, produite tout le
 * long de la visee et eteinte en chemin. Pour une couche uniforme eclairee de
 * facon uniforme, la diffusion simple donne
 *
 *     L(X) / L(1) = (1 − e^(−τX)) / (1 − e^(−τ)),   τ = 0,921·k
 *
 * qui croit comme la masse d'air quand elle est faible, puis sature : on ne
 * voit pas plus loin que la lumiere ne porte. Un premier jet l'eteignait comme
 * une source placee derriere l'atmosphere, et le halo ne gagnait que 0,5
 * magnitude a quinze degres. C'est une approximation de couche uniforme — un
 * vrai dome de ville est dirige, plus clair du cote de la ville, ce que le
 * moteur ne sait pas.
 *
 * ## Ce qui en sort
 *
 * La brillance locale donne, par la meme relation de Schaefer, une limite
 * locale. On ne garde que l'**ecart** a celle du zenith, retranche a la limite
 * globale : la Lune, le crepuscule et tout ce qui fixe cette derniere restent
 * inchanges au zenith.
 *
 * ⚠️ L'ecart est calcule sur le fond **nocturne** — lueur naturelle et
 * pollution. Sous la Lune ou au crepuscule, la repartition du fond est autre
 * (plus claire du cote de l'astre) ; on garde la meme, faute de mieux.
 */
import { AIRGLOW_LUX, limitingMagnitudeFromSkyBrightness, skySurfaceBrightness } from '@/astro/photometry'

/** Rayon terrestre, km. */
const EARTH_RADIUS_KM = 6371
/** Altitude de la couche d'emission de la lueur naturelle, km. */
export const AIRGLOW_LAYER_KM = 90
/** Magnitudes vers profondeur optique : `0,4·ln 10`. */
const MAG_TO_TAU = 0.4 * Math.LN10

const RATIO2 = (EARTH_RADIUS_KM / (EARTH_RADIUS_KM + AIRGLOW_LAYER_KM)) ** 2

/** Facteur de van Rhijn pour une hauteur donnee, degres. Un au zenith. */
export function vanRhijn(altitudeDeg: number): number {
  const z = ((90 - Math.max(0, altitudeDeg)) * Math.PI) / 180
  return 1 / Math.sqrt(1 - RATIO2 * Math.sin(z) ** 2)
}

/** Etat du fond de ciel au zenith, tel que les nuanceurs le recoivent. */
export interface SkyGlow {
  /** Brillance du fond nocturne au zenith, mag/arcsec². */
  zenithSb: number
  /** Part de la lueur naturelle dans ce fond, de 0 a 1. */
  naturalFraction: number
  /** Faux sans atmosphere : aucun gradient. */
  active: boolean
}

export function skyGlowFor(pollutionLux: number, atmosphere: boolean): SkyGlow {
  const pollution = Math.max(0, pollutionLux)
  return {
    zenithSb: skySurfaceBrightness(AIRGLOW_LUX + pollution),
    naturalFraction: AIRGLOW_LUX / (AIRGLOW_LUX + pollution),
    active: atmosphere,
  }
}

/**
 * Brillance relative du fond a une hauteur donnee, rapportee au zenith.
 *
 * `airmass` est la masse d'air de la visee, `k` le coefficient d'extinction.
 */
export function skyGlowGain(altitudeDeg: number, airmass: number, k: number, glow: SkyGlow): number {
  const x = Math.max(1, airmass)
  const f = glow.naturalFraction
  const natural = vanRhijn(altitudeDeg) * Math.pow(10, -0.4 * k * (x - 1))
  const tau = Math.max(1e-6, MAG_TO_TAU * k)
  const scattered = (1 - Math.exp(-tau * x)) / (1 - Math.exp(-tau))
  return f * natural + (1 - f) * scattered
}

/** Perte de magnitude limite a cette hauteur, par rapport au zenith. Jamais negative. */
export function limitShift(altitudeDeg: number, airmass: number, k: number, glow: SkyGlow): number {
  if (!glow.active) return 0
  const gain = Math.max(1e-6, skyGlowGain(altitudeDeg, airmass, k, glow))
  const local = glow.zenithSb - 2.5 * Math.log10(gain)
  return Math.max(0, limitingMagnitudeFromSkyBrightness(glow.zenithSb) - limitingMagnitudeFromSkyBrightness(local))
}

/** Uniformes du gradient, a etaler dans ceux d'un materiau. */
export function skyGlowUniforms() {
  return {
    uGlowZenithSb: { value: 21.8 },
    uGlowNatural: { value: 1 },
    uGlowActive: { value: 0 },
  }
}

export function applySkyGlow(uniforms: ReturnType<typeof skyGlowUniforms>, glow: SkyGlow): void {
  uniforms.uGlowZenithSb.value = glow.zenithSb
  uniforms.uGlowNatural.value = glow.naturalFraction
  uniforms.uGlowActive.value = glow.active ? 1 : 0
}

/**
 * Meme calcul, cote nuanceur. `limitShiftAt` prend la hauteur **vraie**, la
 * masse d'air de la table et le coefficient d'extinction du materiau.
 */
export const SKY_GLOW_GLSL = /* glsl */ `
  uniform float uGlowZenithSb;
  uniform float uGlowNatural;
  uniform float uGlowActive;

  float schaeferLimit(float sb) {
    return 7.93 - 5.0 * log(pow(10.0, 4.316 - sb / 5.0) + 1.0) / log(10.0);
  }

  float limitShiftAt(float trueAltDeg, float airmass, float k) {
    if (uGlowActive < 0.5) return 0.0;
    float z = radians(90.0 - max(0.0, trueAltDeg));
    float s = sin(z);
    float vr = 1.0 / sqrt(1.0 - ${RATIO2.toFixed(6)} * s * s);
    float x = max(1.0, airmass);
    float natural = vr * pow(10.0, -0.4 * k * (x - 1.0));
    float tau = max(1e-6, ${MAG_TO_TAU.toFixed(6)} * k);
    float scattered = (1.0 - exp(-tau * x)) / (1.0 - exp(-tau));
    float gain = max(1e-6, uGlowNatural * natural + (1.0 - uGlowNatural) * scattered);
    float local = uGlowZenithSb - 2.5 * log(gain) / log(10.0);
    return max(0.0, schaeferLimit(uGlowZenithSb) - schaeferLimit(local));
  }
`
