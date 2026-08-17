/**
 * Projection stereographique.
 *
 * Une camera three.js ne sait rendre qu'en perspective rectiligne : le rayon
 * a l'ecran vaut `tan(theta)`, theta etant l'angle au boresight. C'est cette
 * fonction qui, a grand champ, etire violemment les bords — l'effet fisheye
 * inverse bien connu des grand-angles rectilignes. La stereographique, elle,
 * vaut `2·tan(theta/2)` : une fonction conforme (elle preserve les angles
 * locaux, donc la forme des objets), qui croit bien plus doucement pres du
 * bord.
 *
 * On ne peut pas configurer une `PerspectiveCamera` pour qu'elle projette
 * autrement — sa matrice est figee sur la division perspective standard.
 * On rend donc la scene normalement (rectiligne), puis on redistribue les
 * pixels obtenus par une passe de post-traitement : pour chaque pixel affiche
 * a un rayon donne, on retrouve l'angle qu'il represente sous la nouvelle
 * projection, puis on va chercher la couleur au rayon ou la scene rectiligne
 * avait effectivement dessine cet angle. Le champ affiche (`fov`) garde
 * exactement le meme sens qu'avant : c'est seulement la loi de croissance
 * entre le centre et le bord qui change.
 *
 * Les etiquettes HTML (`LabelLayer`) et le pointage a la souris
 * (`CameraRig`) appliquent la meme formule, dans un sens ou dans l'autre —
 * voir `rectilinearToStereographicNdc` / `stereographicToRectilinearNdc`
 * dans `sceneMath.ts` — pour rester en phase avec cette image deformee.
 */
import { forwardRef, useImperativeHandle, useRef } from 'react'
import { Uniform, type PerspectiveCamera } from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { Effect } from 'postprocessing'

const DEG = Math.PI / 180
/** Voir la meme constante dans `sceneMath.ts`. */
const ANGLE_CLAMP = 89 * DEG

const fragmentShader = /* glsl */ `
  uniform float aspect;
  uniform float tanHalfFov;
  uniform float tanHalfFovHalf;

  void mainUv(inout vec2 uv) {
    vec2 ndc = uv * 2.0 - 1.0;
    vec2 scaled = vec2(ndc.x * aspect, ndc.y);
    float rOut = length(scaled);
    if (rOut > 1e-6) {
      float theta = min(2.0 * atan(rOut * tanHalfFovHalf), ${ANGLE_CLAMP.toFixed(6)});
      float rIn = tan(theta) / tanHalfFov;
      ndc *= rIn / rOut;
    }
    uv = clamp(ndc * 0.5 + 0.5, 0.0, 1.0);
  }
`

class StereographicEffect extends Effect {
  constructor() {
    super('StereographicEffect', fragmentShader, {
      uniforms: new Map([
        ['aspect', new Uniform(1)],
        ['tanHalfFov', new Uniform(1)],
        ['tanHalfFovHalf', new Uniform(1)],
      ]),
    })
  }

  /** Recu du champ et du format d'image courants, mis a jour par `StereographicProjection`. */
  setFov(fovDeg: number, aspect: number) {
    const halfFov = (fovDeg * DEG) / 2
    this.uniforms.get('aspect')!.value = aspect
    this.uniforms.get('tanHalfFov')!.value = Math.tan(halfFov)
    this.uniforms.get('tanHalfFovHalf')!.value = Math.tan(halfFov / 2)
  }
}

/**
 * Doit etre placee **avant** les autres effets (le halo du Soleil, en
 * particulier) dans `<EffectComposer>` : c'est la seule facon que le halo,
 * calcule sur l'image rectiligne, se retrouve echantillonne au bon endroit
 * une fois l'image redistribuee — sans quoi il se detacherait de sa source
 * a mesure qu'elle s'approche du bord.
 */
export const StereographicProjection = forwardRef<StereographicEffect>(function StereographicProjection(_, ref) {
  const effect = useRef<StereographicEffect>()
  if (!effect.current) effect.current = new StereographicEffect()
  useImperativeHandle(ref, () => effect.current!, [])

  const { camera, size } = useThree()

  useFrame(() => {
    const fov = (camera as PerspectiveCamera).fov ?? 60
    effect.current!.setFov(fov, size.width / size.height)
  })

  return <primitive object={effect.current} />
})
