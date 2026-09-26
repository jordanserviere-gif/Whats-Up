/**
 * Les cinq etoiles du cartouche « UP? » du logo, extraites de son trace.
 *
 * Dans le logo, ce sont des evidements ; isolees ici, chacune redevient une
 * forme pleine, avec son centre et son demi-empan pour la placer et la faire
 * vivre independamment des autres.
 */
export interface LogoStar {
  d: string
  /** Centre, unites du `viewBox` du logo. */
  cx: number
  cy: number
  /** Demi-empan : de la pointe au centre. */
  half: number
}

export const LOGO_STARS: readonly LogoStar[] = [
  {
    d: 'M247.1,83.73c0-3.86-3.12-6.98-6.98-6.98,3.86,0,6.98-3.13,6.98-6.98,0,3.85,3.13,6.98,6.99,6.98-3.86,0-6.99,3.12-6.99,6.98Z',
    cx: 247.1,
    cy: 76.75,
    half: 6.99,
  },
  {
    d: 'M273.1,99.29c0-3.03-2.46-5.5-5.5-5.5,3.04,0,5.5-2.46,5.5-5.5,0,3.04,2.47,5.5,5.51,5.5-3.04,0-5.51,2.47-5.51,5.5Z',
    cx: 273.1,
    cy: 93.79,
    half: 5.51,
  },
  {
    d: 'M292.75,93.59c0-4.6-3.73-8.33-8.33-8.33,4.6,0,8.33-3.72,8.33-8.33,0,4.61,3.73,8.33,8.33,8.33-4.6,0-8.33,3.73-8.33,8.33Z',
    cx: 292.75,
    cy: 85.26,
    half: 8.33,
  },
  {
    d: 'M313.27,110.22c0-5.28-4.28-9.56-9.57-9.56,5.29,0,9.57-4.29,9.57-9.57,0,5.28,4.28,9.57,9.57,9.57-5.29,0-9.57,4.28-9.57,9.56Z',
    cx: 313.27,
    cy: 100.66,
    half: 9.57,
  },
  {
    d: 'M329.97,82.85c0-4.57-3.71-8.28-8.28-8.28,4.57,0,8.28-3.71,8.28-8.28,0,4.57,3.7,8.28,8.27,8.28-4.57,0-8.27,3.71-8.27,8.28Z',
    cx: 329.97,
    cy: 74.57,
    half: 8.28,
  },
]
