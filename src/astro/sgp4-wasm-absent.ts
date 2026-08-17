/**
 * Substitut aux modules WebAssembly de satellite.js.
 *
 * La bibliotheque publie, a cote de son SGP4 en JavaScript, une version compilee
 * en WebAssembly destinee a propager des milliers d'objets d'un coup. Nous n'en
 * appelons aucune fonction : quelques dizaines de satellites se propagent en
 * JavaScript sans que l'image en souffre.
 *
 * Ce module la remplace dans le graphe de dependances, pour deux raisons :
 *
 * 1. La variante multi-fils importe `node:worker_threads` et ouvre son module
 *    par une attente de premier niveau. Rollup refuse alors de produire le
 *    paquet, et le prebundle du serveur de developpement echoue de meme.
 * 2. Les deux variantes embarquent leur binaire en base64 — cent-quatre-vingts
 *    kilo-octets — pour du code mort.
 *
 * Le remplacement est declare dans `vite.config.ts`. Il leve plutot que de
 * renvoyer un objet vide : si quelqu'un emprunte un jour cette voie, il doit
 * l'apprendre a la premiere ligne, non par des positions silencieusement fausses.
 */
export default function wasmModuleAbsent(): never {
  throw new Error(
    'Le moteur SGP4 en WebAssembly a ete retire du paquet : la propagation passe ' +
      'par la voie JavaScript de satellite.js. Voir src/astro/sgp4-wasm-absent.ts.',
  )
}
