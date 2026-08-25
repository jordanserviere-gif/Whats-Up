/**
 * Passe d'affichage — dernier maillon de la chaine de rendu.
 *
 * Elle prend le tampon HDR lineaire produit par la scene et lui applique, une
 * seule fois, le transform d'affichage : exposition, courbe filmique,
 * re-saturation. Le composeur se charge ensuite de l'encodage sRGB.
 *
 * ## Sa place dans la chaine
 *
 * ```
 * scene → tampon demi-flottant → Bloom → DisplayEffect → sRGB → ecran
 * ```
 *
 * **Le bloom passe avant, et c'est deliberé.** Un halo lumineux est un
 * phenomene optique : il se produit sur la lumiere, pas sur des pixels deja
 * compresses. Le seuiller sur une radiance a de plus un sens physique, la ou le
 * seuil de 1 de l'ancienne chaine se comparait a des valeurs deja ecretees —
 * ce qui interdisait structurellement au ciel de deborder, quelle que soit sa
 * luminance reelle.
 *
 * ## Ce qu'elle ne fait pas
 *
 * Pas de correction de gamut, pas de courbe par canal, pas de LUT artistique.
 * L'exposition qu'elle porte est une exposition d'affichage globale ; celle qui
 * decrit l'adaptation de l'oeil ou d'un capteur viendra plus tard, et elle
 * s'exprimera en grandeurs photometriques, pas en facteur multiplicatif.
 */
import { BlendFunction, Effect } from 'postprocessing'
import { Uniform } from 'three'
import { wrapEffect } from '@react-three/postprocessing'
import { DISPLAY_TONEMAP_GLSL } from './tonemap'

const fragmentShader = /* glsl */ `
  ${DISPLAY_TONEMAP_GLSL}

  uniform float exposure;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    outputColor = vec4(displayTransform(inputColor.rgb * exposure), inputColor.a);
  }
`

export interface DisplayEffectOptions {
  /**
   * Exposition d'affichage, sans dimension.
   *
   * Vaut 1 par defaut : la scene emet aujourd'hui des radiances deja mises a
   * l'echelle par `uAtmosphereExposure`. C'est ici que remontera l'exposition
   * lorsqu'elle deviendra une grandeur physique unique, en phase 4.
   */
  exposure?: number
}

class DisplayEffectImpl extends Effect {
  constructor({ exposure = 1 }: DisplayEffectOptions = {}) {
    super('DisplayEffect', fragmentShader, {
      // SRC remplace entierement l'entree : cette passe n'est pas un effet
      // qu'on melange, c'est la conversion finale.
      blendFunction: BlendFunction.SRC,
      uniforms: new Map([['exposure', new Uniform(exposure)]]),
    })
  }
}

export const DisplayEffect = wrapEffect(DisplayEffectImpl)
