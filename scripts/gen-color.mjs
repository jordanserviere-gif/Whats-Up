/**
 * Genere src/styles/tokens/color.css : l'integralite des roles de couleur
 * Material 3 de What's Up?, en clair, en sombre et en night, chacun decline aux
 * trois paliers de contraste, plus les palettes tonales de reference.
 *
 * Usage : npm run color
 *
 * ## Les palettes
 *
 * - **primary** : le bleu du logo, `#2C4F9E`, a sa chroma propre.
 * - **neutral / neutral-variant** : un noir et blanc a peine bleute — la teinte
 *   du logo a tres faible chroma. Fonds, surfaces, textes et contours en
 *   derivent ; la couleur est reservee a ce qui la merite.
 * - **secondary / tertiary** : exiges par MD3. Le secondaire est le meme bleu,
 *   desature ; le tertiaire pivote vers le cyan, assez pour se distinguer du
 *   primaire (traces satellites, grille equatoriale) sans quitter la famille.
 * - **amber** : l'unique palette du theme night.
 *
 * ## Le theme night
 *
 * Il sert a observer sans perdre l'adaptation de l'oeil a l'obscurite. Tout y
 * est noir, et le strict necessaire est ambre — voir `NIGHT_LEVELS`.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DynamicScheme,
  Hct,
  MaterialDynamicColors,
  TonalPalette,
  Variant,
  hexFromArgb,
  argbFromHex,
} from '@material/material-color-utilities'

// Ce script est bundle par esbuild avant execution (le paquet material-color-utilities
// publie des imports ESM sans extension) : on se repere donc sur la racine du projet.
const OUT = join(process.cwd(), 'src', 'styles', 'tokens')

/** Le bleu du logo What's Up?. */
const SOURCE = '#2C4F9E'

/**
 * Chroma des neutres. MD3 met 4 a 6 dans ses schemas les plus sobres, 10 dans
 * Vibrant : a 3 et 5, le gris est franchement gris, et le bleu ne se lit que
 * par comparaison avec un gris pur.
 */
const NEUTRAL_CHROMA = 3
const NEUTRAL_VARIANT_CHROMA = 5
const SECONDARY_CHROMA = 20
/** Le tertiaire pivote vers le cyan : −40° de teinte HCT. */
const TERTIARY_HUE_SHIFT = -40
const TERTIARY_CHROMA = 36

/**
 * Ambre du theme night. Teinte HCT ~65 : entre l'orange du sodium et le jaune.
 * Assez chaude pour menager les batonnets, assez claire pour rester lisible a
 * faible luminance.
 */
const AMBER = '#FFA31A'
/** L'erreur reste rouge la nuit : c'est la couleur que l'oeil adapte tolere le mieux. */
const NIGHT_ERROR_HUE = 25

const source = Hct.fromInt(argbFromHex(SOURCE))
const amber = Hct.fromInt(argbFromHex(AMBER))

const PALETTES = {
  primary: TonalPalette.fromHct(source),
  secondary: TonalPalette.fromHueAndChroma(source.hue, SECONDARY_CHROMA),
  tertiary: TonalPalette.fromHueAndChroma((source.hue + TERTIARY_HUE_SHIFT + 360) % 360, TERTIARY_CHROMA),
  neutral: TonalPalette.fromHueAndChroma(source.hue, NEUTRAL_CHROMA),
  'neutral-variant': TonalPalette.fromHueAndChroma(source.hue, NEUTRAL_VARIANT_CHROMA),
}

const NIGHT_PALETTES = {
  amber: TonalPalette.fromHct(amber),
  'night-error': TonalPalette.fromHueAndChroma(NIGHT_ERROR_HUE, 70),
}

/** camelCase -> kebab-case, convention des tokens --md-sys-color-*. */
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

const ROLES = Object.getOwnPropertyNames(MaterialDynamicColors)
  .filter((k) => {
    const v = MaterialDynamicColors[k]
    return v && typeof v === 'object' && typeof v.getArgb === 'function'
  })
  .sort()

function makeScheme(dark, contrast) {
  return new DynamicScheme({
    sourceColorHct: source,
    variant: Variant.VIBRANT,
    contrastLevel: contrast,
    isDark: dark,
    primaryPalette: PALETTES.primary,
    secondaryPalette: PALETTES.secondary,
    tertiaryPalette: PALETTES.tertiary,
    neutralPalette: PALETTES.neutral,
    neutralVariantPalette: PALETTES['neutral-variant'],
  })
}

/**
 * Roles imposes par la marque, au contraste standard : le primaire **est** le
 * bleu du logo, en clair comme en sombre, et ce qui s'y pose est blanc. MD3
 * placerait le primaire sombre au ton 80, un bleu pastel qui n'est plus la
 * couleur de What's Up?. Les paliers de contraste moyen et eleve gardent les
 * tons calcules : ils existent pour qui en a besoin, la marque passe apres.
 */
const BRAND_ROLES = {
  primary: SOURCE,
  surfaceTint: SOURCE,
  onPrimary: '#FFFFFF',
}

function scheme(dark, contrast) {
  const s = makeScheme(dark, contrast)
  return ROLES.map((role) => {
    const hex =
      contrast === 0 && role in BRAND_ROLES
        ? BRAND_ROLES[role].toLowerCase()
        : hexFromArgb(MaterialDynamicColors[role].getArgb(s))
    return `  --md-sys-color-${kebab(role)}: ${hex};`
  }).join('\n')
}

/**
 * Niveaux d'emphase du night, en tons de la palette ambre.
 *
 * Le night ne derive pas du schema sombre : il en garde les roles, pas les
 * valeurs. Tout ce qui est un fond — surfaces, conteneurs, roles « fixed » —
 * est noir pur, sans exception. L'ambre ne porte que le contenu, sur cinq
 * niveaux ; c'est lui, et non un aplat, qui dit ce qui est actif.
 *
 * Les tons sont les plus bas que permet WCAG AA sur le noir : 50 donne 4,7:1
 * pour le texte secondaire, 38 donne 3:1 pour un contour de composant.
 */
const NIGHT_LEVELS = {
  /** Actif, selectionne, accent : l'element qu'on doit trouver du regard. */
  active: 68,
  /** Texte courant. */
  text: 60,
  /** Texte secondaire, icones au repos. */
  muted: 50,
  /** Contour de composant. */
  outline: 38,
  /** Separateur, contour decoratif : a peine visible, et c'est voulu. */
  hairline: 16,
}
/** Gain de ton par palier de contraste : moyen, puis eleve. */
const NIGHT_CONTRAST_STEP = 10

const NIGHT_ROLE_LEVEL = {
  primary: 'active',
  secondary: 'active',
  tertiary: 'active',
  surfaceTint: 'active',
  inversePrimary: 'active',
  onPrimaryContainer: 'active',
  onSecondaryContainer: 'active',
  onTertiaryContainer: 'active',
  onPrimaryFixed: 'active',
  onSecondaryFixed: 'active',
  onTertiaryFixed: 'active',
  onSurface: 'text',
  onBackground: 'text',
  inverseOnSurface: 'text',
  onSurfaceVariant: 'muted',
  onPrimaryFixedVariant: 'muted',
  onSecondaryFixedVariant: 'muted',
  onTertiaryFixedVariant: 'muted',
  outline: 'outline',
  outlineVariant: 'hairline',
  primaryPaletteKeyColor: 'outline',
  secondaryPaletteKeyColor: 'outline',
  tertiaryPaletteKeyColor: 'outline',
  neutralPaletteKeyColor: 'outline',
  neutralVariantPaletteKeyColor: 'outline',
}
const NIGHT_ERROR_LEVEL = { error: 'text', onErrorContainer: 'text' }

function nightScheme(contrast) {
  const boost = contrast * 2 * NIGHT_CONTRAST_STEP
  const tone = (level) => Math.min(100, NIGHT_LEVELS[level] + boost)
  return ROLES.map((role) => {
    let argb = 0xff000000 // fonds, conteneurs, « on-* » poses sur un aplat
    if (role in NIGHT_ROLE_LEVEL) argb = NIGHT_PALETTES.amber.tone(tone(NIGHT_ROLE_LEVEL[role]))
    else if (role in NIGHT_ERROR_LEVEL) argb = NIGHT_PALETTES['night-error'].tone(tone(NIGHT_ERROR_LEVEL[role]))
    return `  --md-sys-color-${kebab(role)}: ${hexFromArgb(argb)};`
  }).join('\n')
}

const TONES = [0, 2, 4, 5, 6, 8, 10, 12, 15, 17, 20, 22, 24, 25, 30, 35, 40, 50, 60, 70, 80, 87, 90, 92, 94, 95, 96, 98, 99, 100]

function refPalettes(palettes) {
  const out = []
  for (const [name, p] of Object.entries(palettes)) {
    for (const t of TONES) out.push(`  --md-ref-palette-${name}-${t}: ${hexFromArgb(p.tone(t))};`)
  }
  return out.join('\n')
}

const blocks = []
blocks.push('/* GENERE PAR scripts/gen-color.mjs — NE PAS EDITER A LA MAIN */')
blocks.push(`/* What's Up? — Material 3, primaire ${SOURCE}, neutres chroma ${NEUTRAL_CHROMA}/${NEUTRAL_VARIANT_CHROMA}, night ${AMBER} */`)
blocks.push('')
blocks.push('/* Palettes tonales de reference. */')
blocks.push(`:root {\n${refPalettes({ ...PALETTES, ...NIGHT_PALETTES })}\n}`)
blocks.push('')
blocks.push('/* Clair = base ; le theme sombre est le defaut applicatif (voir base.css). */')
blocks.push(`:root {\n${scheme(false, 0)}\n}`)
blocks.push('')
blocks.push(`:root[data-theme='dark'] {\n${scheme(true, 0)}\n}`)
blocks.push('')
blocks.push(`:root[data-contrast='medium'] {\n${scheme(false, 0.5)}\n}`)
blocks.push(`:root[data-contrast='medium'][data-theme='dark'] {\n${scheme(true, 0.5)}\n}`)
blocks.push('')
blocks.push(`:root[data-contrast='high'] {\n${scheme(false, 1)}\n}`)
blocks.push(`:root[data-contrast='high'][data-theme='dark'] {\n${scheme(true, 1)}\n}`)
blocks.push('')
blocks.push('/* Night — noir pur et ambre, pour garder l oeil adapte a l obscurite. */')
blocks.push(`:root[data-theme='night'] {\n${nightScheme(0)}\n}`)
blocks.push(`:root[data-contrast='medium'][data-theme='night'] {\n${nightScheme(0.5)}\n}`)
blocks.push(`:root[data-contrast='high'][data-theme='night'] {\n${nightScheme(1)}\n}`)
blocks.push('')

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'color.css'), blocks.join('\n'))
console.log(`src/styles/tokens/color.css genere — ${ROLES.length} roles x 9 variantes`)
