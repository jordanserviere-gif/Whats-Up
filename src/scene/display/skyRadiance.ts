/**
 * La radiance du ciel dans une direction — **une seule expression**.
 *
 * ## ⚠️ Le defaut que ce module existe pour empecher
 *
 * Cette grandeur etait ecrite **deux fois**, et les deux ont diverge.
 *
 * Le fond de ciel calculait `diffusion + airglow + peint`. Le disque d'un astre,
 * lui, ne reprenait que la `diffusion`. Or un astre au-dela de l'atmosphere
 * **n'occulte rien** : les 384 000 kilometres de la Lune font que toute
 * l'atmosphere — la couche d'airglow a quatre-vingt-dix kilometres comprise, et
 * l'air qui diffuse le clair de lune — se trouve **devant** elle. Rien n'est
 * cache, et sa face nuit, qui n'emet rien, doit donc rendre exactement le ciel.
 *
 * C'est ce que montre une photographie : la partie sombre d'une Lune gibbeuse
 * de jour est **indiscernable** du bleu qui l'entoure.
 *
 * Le rendu, lui, la detachait. Mesure sur une coupe horizontale du disque :
 *
 *     ciel        131  131  131  131
 *     face jour   161  165  166  161  158  157  151
 *     face nuit   133  125  125  125
 *     ciel        131  131  131  131
 *
 * Six niveaux d'ecart. Forcer a zero le halo lunaire peint faisait tomber le
 * ciel a 125 exactement — la preuve directe qu'il manquait au disque.
 *
 * De jour c'etait le halo peint ; de nuit ce serait l'airglow, quatre niveaux
 * sur 255. **Meme faute, deux regimes** — et rendre le halo lunaire physique
 * n'y aurait rien change, puisque l'airglow, lui, l'est deja.
 *
 * ## Ce qui distingue un astre d'un avion
 *
 * Tout ce qui occulte ne doit pas recevoir la meme chose. Un avion vole a dix
 * kilometres : la couche d'airglow est **derriere** lui, il la cache, et son
 * voile est celui de la table a distance finie. Un astre est au-dela de tout.
 *
 * La regle est donc : **au-dela de l'atmosphere, le fond est le ciel entier**.
 *
 * ## Ce qui reste peint, et ce n'est pas ce module qui le corrigera
 *
 * La lueur lunaire est de la diffusion, exactement comme le ciel de jour : sa
 * place est dans le transport, avec la Lune pour source. Le halo urbain est une
 * emission renvoyee par l'atmosphere, que decrit le modele de Garstang (1989).
 * Ni l'un ni l'autre n'est encore calcule — voir le registre. Les rassembler ici
 * ne les rend pas physiques ; cela garantit seulement qu'ils s'appliquent au
 * meme endroit pour tout le monde.
 *
 * ⚠️ Ce module suppose que `AERIAL_LUT_GLSL` et `DISPLAY_TONEMAP_GLSL` ont ete
 * inclus avant lui : il appelle `aerialPerspectiveToSpace` et
 * `radianceFromDisplay`.
 */
import { Color, Vector3 } from 'three'
import { HORIZON_MARGIN_DEG } from '@/atmosphere/horizonMargin'

/**
 * L'unique expression de la radiance du ciel.
 *
 * `transmittance` rend celle du rayon primaire jusqu'a la sortie de
 * l'atmosphere — ce qui reste d'un objet place derriere.
 */
export const SKY_RADIANCE_GLSL = /* glsl */ `
  uniform float uHorizonMargin;
  uniform float uHorizonDip;
  uniform vec3 uAirglowZenith;
  uniform float uAirglowRadiusRatio;
  uniform vec3 uMoonDir;
  uniform float uMoonFactor;
  uniform vec3 uMoonGlow;
  uniform vec3 uPollution;

  vec3 skyRadianceToSpace(vec3 rayDir, out vec3 transmittance) {
    vec3 dir = normalize(rayDir);
    transmittance = vec3(1.0);

    // --- Le fondu de marge sous l'horizon ---------------------------------
    //
    // ⚠️ Il n'a rien de physique : c'est le garde-fou de
    // \`atmosphere/horizonMargin.ts\`, et il agit sous une calotte de sol qui le
    // recouvre entierement.
    //
    // La marge se compte sous l'horizon **apparent**, pas sous l'horizontale :
    // pour un observateur en hauteur les deux different, et faire partir le
    // fondu de zero attenuait une bande de ciel encore parfaitement visible.
    float elevDeg = degrees(asin(clamp(dir.y, -1.0, 1.0)));
    float belowDeg = -(elevDeg + uHorizonDip);
    float horizonFade = 1.0 - smoothstep(0.0, uHorizonMargin, belowDeg);
    vec3 scattered = horizonFade > 0.0
      ? aerialPerspectiveToSpace(dir, transmittance) * horizonFade
      : vec3(0.0);

    // --- L'airglow ---------------------------------------------------------
    //
    // La haute atmosphere brille d'elle-meme : le rayonnement ultraviolet
    // dissocie l'oxygene le jour, les atomes se recombinent la nuit et rendent
    // cette energie en raies. C'est de la chimiluminescence, dans une couche
    // mince a quatre-vingt-dix kilometres.
    //
    // Vue obliquement, cette couche est traversee plus longuement — facteur de
    // van Rhijn, qui atteint six a l'horizon. Mais la lumiere doit ensuite
    // traverser toute l'atmosphere, et une visee rasante y perd presque tout.
    // Leur produit donne un maximum vers dix a quinze degres puis un
    // effondrement au ras de l'horizon : c'est ce qu'on observe.
    float h = clamp(dir.y, -1.0, 1.0);
    float sinZ = sqrt(max(0.0, 1.0 - h * h));
    float shell = uAirglowRadiusRatio * sinZ;
    float vanRhijn = inversesqrt(max(1e-6, 1.0 - shell * shell));
    // La couche suit la meme marge que la diffusion : sans le fondu, elle
    // resterait a pleine intensite sous l'horizon, ou \`transmittance\` n'a pas
    // ete ecrite et vaut encore un.
    vec3 airglow = uAirglowZenith * vanRhijn * transmittance * uAerialExposure * horizonFade;

    // --- Ce qui reste peint -------------------------------------------------
    float toMoon = max(0.0, dot(dir, normalize(uMoonDir)));
    vec3 painted = uMoonGlow * uMoonFactor * (0.25 + 0.75 * pow(toMoon, 6.0));
    float lowSky = pow(1.0 - clamp(h, 0.0, 1.0), 2.0);
    painted += uPollution * (0.3 + 0.7 * lowSky);

    return radianceFromDisplay(painted) + scattered + airglow;
  }
`

/** Etat du ciel que les materiaux partagent, par-dela leurs propres uniformes. */
export interface SkyRadianceState {
  /** Depression de l'horizon apparent, degres. */
  horizonDipDeg: number
  /** Radiance de l'airglow au zenith, sRGB lineaire. */
  airglowZenith: readonly [number, number, number]
  /** `R/(R+h)` de la couche d'airglow — le seul terme du facteur van Rhijn. */
  airglowRadiusRatio: number
  /** Direction de la Lune dans le repere de la scene. */
  moonDirection: readonly [number, number, number]
  /** Amplitude de la lueur lunaire peinte. */
  moonFactor: number
  /** Teinte de la lueur lunaire peinte. */
  moonGlow: string
  /** Teinte du halo urbain peint, deja multipliee par son gain. */
  pollution: Color
}

/** Les uniformes que `SKY_RADIANCE_GLSL` attend. */
export const skyRadianceUniforms = () => ({
  uHorizonMargin: { value: HORIZON_MARGIN_DEG },
  uHorizonDip: { value: 0 },
  uAirglowZenith: { value: new Vector3() },
  uAirglowRadiusRatio: { value: 1 },
  uMoonDir: { value: new Vector3(0, -1, 0) },
  uMoonFactor: { value: 0 },
  uMoonGlow: { value: new Color('#7d8fc4') },
  uPollution: { value: new Color('#000000') },
})

/**
 * Publie l'etat du ciel dans un materiau.
 *
 * A appeler pour **tout** materiau qui remplace le ciel sur ses pixels et se
 * trouve au-dela de l'atmosphere. Un objet situe dedans occulte une partie de
 * ce qui precede et n'a rien a faire ici.
 */
export function applySkyRadianceUniforms(
  uniforms: ReturnType<typeof skyRadianceUniforms>,
  state: SkyRadianceState,
): void {
  uniforms.uHorizonDip.value = state.horizonDipDeg
  uniforms.uAirglowZenith.value.set(
    state.airglowZenith[0],
    state.airglowZenith[1],
    state.airglowZenith[2],
  )
  uniforms.uAirglowRadiusRatio.value = state.airglowRadiusRatio
  uniforms.uMoonDir.value.set(state.moonDirection[0], state.moonDirection[1], state.moonDirection[2])
  uniforms.uMoonFactor.value = state.moonFactor
  uniforms.uMoonGlow.value.set(state.moonGlow)
  uniforms.uPollution.value.copy(state.pollution)
}

/**
 * Etat courant, publie par le fond de ciel et lu par les corps.
 *
 * Meme mecanique que `aerialTextures` : le fond de ciel est le seul a connaitre
 * la Lune, la pollution et l'altitude du site, et les corps ne sont pas dans son
 * arbre de composants. Un objet partage evite de faire remonter tout cet etat.
 */
export const skyRadianceState: SkyRadianceState = {
  horizonDipDeg: 0,
  airglowZenith: [0, 0, 0],
  airglowRadiusRatio: 1,
  moonDirection: [0, -1, 0],
  moonFactor: 0,
  moonGlow: '#7d8fc4',
  pollution: new Color('#000000'),
}
