import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl'
import { hexToRgb, readToken } from '@/scene/sceneMath'

/**
 * Style de la carte de selection du lieu.
 *
 * Tuiles vectorielles OpenFreeMap (schema OpenMapTiles), sans cle ni compte.
 * Le style est ecrit ici plutot que charge : il ne garde que ce qui aide a
 * reconnaitre un lieu d'observation — terre et eau, forets, grandes routes,
 * frontieres, localites et sommets — et il est **peint avec les tokens** du
 * theme courant, pour que la carte appartienne a l'interface au lieu d'y
 * plaquer la charte d'un autre.
 */

const TILES = 'https://tiles.openfreemap.org/planet'
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'
const FONT = ['Noto Sans Regular']

/** Melange lineaire de deux couleurs hexadecimales, `t` vers `b`. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const c = (x: number, y: number) =>
    Math.round((x + (y - x) * t) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`
}

/** Nom local de preference francais, a defaut le nom d'usage. */
const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:fr'], ['get', 'name']]

export function buildMapStyle(): StyleSpecification {
  const land = readToken('--md-sys-color-surface-container-high', '#2a2a2d')
  const text = readToken('--md-sys-color-on-surface', '#e4e2e5')
  const textMuted = readToken('--md-sys-color-on-surface-variant', '#c7c6cb')
  const water = readToken('--md-sys-color-primary-container', '#1d4291')
  const outline = readToken('--md-sys-color-outline', '#909095')
  const outlineVariant = readToken('--md-sys-color-outline-variant', '#46464b')
  const tertiary = readToken('--md-sys-color-tertiary', '#8ccff1')

  const wood = mix(land, tertiary, 0.1)
  const grass = mix(land, tertiary, 0.05)

  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { omt: { type: 'vector', url: TILES } },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': land } },
      {
        id: 'wood',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]],
        paint: { 'fill-color': wood },
      },
      {
        id: 'grass',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland', 'wetland']]],
        paint: { 'fill-color': grass },
      },
      {
        id: 'urban',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landuse',
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'industrial', 'commercial']]],
        paint: { 'fill-color': mix(land, outlineVariant, 0.45) },
      },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': water } },
      {
        id: 'river',
        type: 'line',
        source: 'omt',
        'source-layer': 'waterway',
        minzoom: 8,
        paint: { 'line-color': water, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 2] },
      },
      {
        id: 'boundary-region',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        minzoom: 5,
        paint: { 'line-color': outlineVariant, 'line-width': 0.8, 'line-dasharray': [3, 2] },
      },
      {
        id: 'boundary-country',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': outline, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 10, 1.6] },
      },
      {
        id: 'road-minor',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary', 'minor']]],
        minzoom: 11,
        paint: { 'line-color': outlineVariant, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 14, 2] },
      },
      {
        id: 'road-major',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
        minzoom: 5,
        paint: { 'line-color': outline, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 3] },
      },
      {
        id: 'peak',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'mountain_peak',
        minzoom: 10,
        layout: {
          // Un sommet est un site d'observation en puissance : son altitude
          // compte autant que son nom.
          'text-field': ['concat', '▲ ', NAME, '\n', ['to-string', ['get', 'ele']], ' m'],
          'text-font': FONT,
          'text-size': 10,
          'text-anchor': 'top',
        },
        paint: { 'text-color': textMuted, 'text-halo-color': land, 'text-halo-width': 1.2 },
      },
      {
        id: 'place-minor',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['village', 'town']]],
        minzoom: 8,
        layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 11 },
        paint: { 'text-color': textMuted, 'text-halo-color': land, 'text-halo-width': 1.2 },
      },
      {
        id: 'place-major',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'country']]],
        layout: {
          'text-field': NAME,
          'text-font': FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 10, 15],
        },
        paint: { 'text-color': text, 'text-halo-color': land, 'text-halo-width': 1.4 },
      },
    ],
  }
}
