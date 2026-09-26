import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSkyStore } from './store'
import { elementsFromGp } from '@/astro/sgp4'
import { ALL_CELESTRAK_GROUPS, fetchGroups, type CelestrakGroup } from '@/data-sources/celestrak'
import { DEFAULT_STATUS, type SourceStatus } from '@/data-sources/types'
import { readToken } from '@/scene/sceneMath'
import {
  BODIES,
  BODY_BY_ID,
  computeAllBodies,
  computeMoonInfo,
  computeRiseSet,
  computeSkyConditions,
} from '@/astro/bodies'
import { bortleFromSkyBrightness, lightPollutionLux } from '@/astro/photometry'
import { fetchSurfaceAerosol } from '@/data-sources/airQuality'
import { airAt, fetchUpperAir, profileAt, shearAt } from '@/data-sources/upperAir'
import { loadScenario, scenarioUpperAir } from '@/data-sources/weatherScenario'
import { DEFAULT_ENVIRONMENT } from '@/atmosphere/cloud/contrail'
import { contrailConditions } from '@/atmosphere/cloud/contrailFormation'
import { fetchSkyBrightness } from '@/data-sources/lightPollution'
import { turbidityFromSurfaceAerosol } from '@/scene/atmosphere'
import { computeSatelliteStates, findPasses, sampleSkyTrack } from '@/astro/satellite'
import { computeAircraftState, forgetAircraftTracks, type AircraftState } from '@/astro/aircraft'
import { ensureAircraftPolling, getAircraftFeedSnapshot, stopAircraftPolling, subscribeAircraftFeed } from './aircraftFeed'
import type { BodyId, BodyState, GeoLocation, OrbitalElements, SatellitePass } from '@/astro/types'

/**
 * Cadence de recalcul des ephemerides a vitesse reelle. Rien ne bouge a l'oeil
 * en une seconde de ciel : dix mises a jour suffisent, et menagent la machine.
 */
const IDLE_EPHEMERIS_HZ = 10
/**
 * Plafond du pas d'integration, en millisecondes de temps reel. Un onglet mis
 * en arriere-plan suspend requestAnimationFrame ; sans ce plafond, le retour
 * ferait bondir l'instant simule de plusieurs minutes a x86400.
 */
const MAX_STEP_MS = 250

/**
 * Moteur temporel : avance l'instant simule selon la vitesse choisie.
 *
 * La cadence de publication s'adapte a la vitesse. Au repos elle reste bridee
 * a 10 Hz. Des que le temps est accelere, elle passe a une publication par
 * image : a 10 Hz, un ciel avance a x86400 saute de deux heures et demie de
 * rotation d'un coup, et le mouvement se lit comme une suite de secousses.
 * Lier le pas a l'image ne peut pas etre moins fluide que l'inverse — le ciel
 * avance alors exactement de ce que l'ecran est capable de montrer.
 */
export function useTimeEngine() {
  const playing = useSkyStore((s) => s.playing)
  const speed = useSkyStore((s) => s.speed)
  const live = useSkyStore((s) => s.live)

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let lastWall = performance.now()
    let lastCommit = 0

    const minInterval = speed === 1 ? 1000 / IDLE_EPHEMERIS_HZ : 0

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastCommit < minInterval) return
      lastCommit = now
      // Le temps ecoule se compte depuis le dernier commit, pas depuis la
      // derniere image : quand la publication est bridee, ne retenir que le
      // delta d'une image ferait avancer l'horloge cinq a six fois trop
      // lentement, et le facteur dependrait de la frequence de l'ecran.
      const dt = Math.min(now - lastWall, MAX_STEP_MS)
      lastWall = now

      const store = useSkyStore.getState()
      if (live && speed === 1) {
        useSkyStore.setState({ time: Date.now() })
      } else {
        useSkyStore.setState({ time: store.time + dt * speed })
      }
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, live])
}

/**
 * Memos a une case, partages par tous les appelants.
 *
 * Une demi-douzaine de composants demandent les memes ephemerides au meme
 * instant : la vue du ciel, la liste d'objets, la recherche, le panneau de
 * details. Un `useMemo` par composant les recalculerait tous separement a
 * chaque image — quatre fois le meme travail. La cle est l'instant et le lieu,
 * donc le cache est juste par construction : un resultat n'est reutilise que
 * pour des arguments identiques.
 */
const siteKey = (l: GeoLocation) => `${l.latitude}|${l.longitude}|${l.elevation}`

let dateSlot = { time: Number.NaN, value: new Date(0) }
const dateFor = (time: number): Date => {
  if (dateSlot.time !== time) dateSlot = { time, value: new Date(time) }
  return dateSlot.value
}

let bodiesSlot = { key: '', value: [] as BodyState[] }
const bodiesFor = (date: Date, location: GeoLocation): BodyState[] => {
  const key = `${date.getTime()}|${siteKey(location)}`
  if (bodiesSlot.key !== key) bodiesSlot = { key, value: computeAllBodies(date, location) }
  return bodiesSlot.value
}

let conditionsSlot = { key: '', value: null as ReturnType<typeof computeSkyConditions> | null }
const conditionsFor = (date: Date, location: GeoLocation, pollutionLux: number) => {
  const key = `${date.getTime()}|${siteKey(location)}|${pollutionLux}`
  if (conditionsSlot.key !== key) conditionsSlot = { key, value: computeSkyConditions(date, location, pollutionLux) }
  return conditionsSlot.value!
}

/** Instant simule sous forme de `Date` stable entre deux recalculs. */
export function useSimulatedDate(): Date {
  const time = useSkyStore((s) => s.time)
  return useMemo(() => dateFor(time), [time])
}

/** Ephemerides de tous les corps affiches. */
export function useBodyStates(): BodyState[] {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  return useMemo(() => bodiesFor(date, location), [date, location])
}

/** Conditions d'observation courantes, pollution lumineuse du site comprise. */
export function useSkyConditions() {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  const lightPollution = useSkyStore((s) => s.lightPollution)
  return useMemo(
    () => conditionsFor(date, location, lightPollutionLux(lightPollution)),
    [date, location, lightPollution],
  )
}

/** Intervalle entre deux mesures de qualite de l'air tant que le mode automatique est actif. */
const AEROSOL_REFRESH_MS = 30 * 60_000

/**
 * Asservit `aerosolTurbidity` a une mesure reelle de qualite de l'air quand le
 * mode automatique est actif — voir `data-sources/airQuality.ts`.
 *
 * Une seule instance doit tourner : c'est `SkyCanvas` qui l'appelle, au meme
 * titre que les autres sources externes de la scene. Elle ne fait rien tant
 * que `aerosolAuto` est faux — le curseur manuel garde alors la main, sans
 * aucun appel reseau.
 */
export function useAerosolAutoSync() {
  const auto = useSkyStore((s) => s.aerosolAuto)
  const location = useSkyStore((s) => s.location)
  // Arrondi : un tremblement de quelques metres dans la position geolocalisee
  // ne doit pas relancer la mesure.
  const lat = Math.round(location.latitude * 10) / 10
  const lon = Math.round(location.longitude * 10) / 10

  useEffect(() => {
    if (!auto) return

    let cancelled = false
    const refresh = async () => {
      const result = await fetchSurfaceAerosol(lat, lon)
      if (cancelled) return
      if (result) {
        useSkyStore.setState({
          aerosolTurbidity: turbidityFromSurfaceAerosol(result.value),
          autoAerosolStatus: result.status,
        })
      } else {
        useSkyStore.setState((s) => ({
          autoAerosolStatus: { ...s.autoAerosolStatus, note: 'mesure indisponible, reglage manuel conserve' },
        }))
      }
    }

    refresh()
    const interval = setInterval(refresh, AEROSOL_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [auto, lat, lon])
}

/** L'air en altitude est republie a l'heure : une demi-heure suffit. */
const UPPER_AIR_REFRESH_MS = 30 * 60_000

/**
 * Tient a jour l'air en altitude — voir `data-sources/upperAir.ts` — tant que
 * les avions sont affiches. Rien a interroger sans eux.
 */
export function useUpperAirSync() {
  const enabled = useSkyStore((s) => s.layers.aircraft)
  const location = useSkyStore((s) => s.location)
  const lat = Math.round(location.latitude * 10) / 10
  const lon = Math.round(location.longitude * 10) / 10
  const scenarioId = useSkyStore((s) => s.weatherScenario?.id ?? null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    if (scenarioId) {
      // Journee figee : un seul chargement, rien a rafraichir.
      useSkyStore.setState({ upperAir: null })
      loadScenario(scenarioId)
        .then((s) => {
          if (!cancelled) useSkyStore.setState({ upperAir: scenarioUpperAir(s) })
        })
        .catch(() => {})
      return () => {
        cancelled = true
      }
    }
    const refresh = async () => {
      const result = await fetchUpperAir(lat, lon)
      if (!cancelled && result) useSkyStore.setState({ upperAir: result.value })
    }
    // Le lieu a change : l'ancien profil ne decrit plus l'air au-dessus de nous.
    useSkyStore.setState({ upperAir: null })
    refresh()
    const interval = setInterval(refresh, UPPER_AIR_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [enabled, lat, lon, scenarioId])
}

/**
 * Formation et duree de vie de la trainee d'un avion, d'apres l'air a son
 * altitude. La formation est lissee sur ±1 Pa de marge : un avion qui frole le
 * seuil voit sa trainee s'amincir plutot que clignoter.
 */
function withContrailWeather(state: AircraftState, upperAir: ReturnType<typeof profileAt>): AircraftState {
  if (!upperAir) return state
  const air = airAt(upperAir, state.altitudeKm * 1000)
  if (!air) return { ...state, contrailLikelihood: 0, contrailEnvironment: null }
  const c = contrailConditions(air.temperatureK, air.relativeHumidityWater, air.pressurePa)
  const x = Math.min(1, Math.max(0, (c.formationMarginPa + 1) / 2))
  const shear = shearAt(upperAir, state.altitudeKm * 1000) ?? DEFAULT_ENVIRONMENT.shearPerS
  return {
    ...state,
    contrailLikelihood: x * x * (3 - 2 * x),
    contrailEnvironment: { shearPerS: shear, excessVapourKgM3: c.excessVapourKgM3 },
  }
}

/**
 * Asservit `lightPollution` a l'atlas mesure quand le mode automatique est
 * actif — voir `data-sources/lightPollution.ts`.
 *
 * Aucun rafraichissement periodique, contrairement aux aerosols : l'atlas est
 * annuel, la valeur ne change qu'avec le lieu. Une mesure par changement de
 * position suffit donc, et la tuile reste en cache un mois.
 */
export function useLightPollutionAutoSync() {
  const auto = useSkyStore((s) => s.lightPollutionAuto)
  const location = useSkyStore((s) => s.location)
  // L'atlas a une resolution d'un cent-vingtieme de degre : arrondir au
  // millieme garde tout son detail sans relancer la lecture pour un tremblement
  // de la position geolocalisee.
  const lat = Math.round(location.latitude * 1000) / 1000
  const lon = Math.round(location.longitude * 1000) / 1000

  useEffect(() => {
    if (!auto) return

    let cancelled = false
    ;(async () => {
      const result = await fetchSkyBrightness(lat, lon)
      if (cancelled) return
      if (result) {
        useSkyStore.setState({
          lightPollution: bortleFromSkyBrightness(result.value.skyBrightness),
          measuredSkyBrightness: result.value.skyBrightness,
          autoLightPollutionStatus: result.status,
        })
      } else {
        useSkyStore.setState((s) => ({
          measuredSkyBrightness: null,
          autoLightPollutionStatus: {
            ...s.autoLightPollutionStatus,
            note: 'atlas indisponible ou lieu hors couverture, reglage manuel conserve',
          },
        }))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [auto, lat, lon])
}

/** Donnees lunaires : recalculees a la minute, la phase evolue lentement. */
export function useMoonInfo() {
  const time = useSkyStore((s) => s.time)
  const minute = Math.floor(time / 60000)
  return useMemo(() => computeMoonInfo(new Date(minute * 60000)), [minute])
}

/** Lever / culmination / coucher d'un corps, recalcules a l'heure. */
export function useRiseSet(id: BodyId | null) {
  const time = useSkyStore((s) => s.time)
  const location = useSkyStore((s) => s.location)
  const hour = Math.floor(time / 3_600_000)

  return useMemo(() => {
    if (!id) return null
    const def = BODY_BY_ID.get(id)
    if (!def) return null
    try {
      return computeRiseSet(def, new Date(hour * 3_600_000), location)
    } catch {
      return null
    }
  }, [id, hour, location])
}

/** Ephemerides de lever/coucher pour tous les corps (panneau « objets »). */
export function useAllRiseSets() {
  const time = useSkyStore((s) => s.time)
  const location = useSkyStore((s) => s.location)
  const hour = Math.floor(time / 3_600_000)

  return useMemo(() => {
    const map = new Map<BodyId, ReturnType<typeof computeRiseSet> | null>()
    for (const def of BODIES) {
      try {
        map.set(def.id, computeRiseSet(def, new Date(hour * 3_600_000), location))
      } catch {
        map.set(def.id, null)
      }
    }
    return map
  }, [hour, location])
}

/**
 * Nombre maximal d'objets propages simultanement.
 *
 * Un etat complet — propagation SGP4, position apparente, trace au sol,
 * eclairement, magnitude — coute deux microsecondes par objet et par instant,
 * mesure dans le navigateur. A 10 Hz, quatre mille objets tiennent donc dans
 * huit millisecondes, soit la moitie d'une image a soixante par seconde.
 *
 * Ce plafond est cale sur une machine quatre fois plus lente que celle de
 * developpement : le cout y reste supportable jusqu'a quatre mille objets, et
 * s'effondre au-dela de six mille, la passe debordant alors l'intervalle entre
 * deux tiques. C'est donc la marge d'un telephone qui fixe la valeur, pas celle
 * d'un ordinateur de bureau.
 *
 * La reunion de tous les groupes depasse ce plafond — Starlink pese a lui seul
 * neuf objets sur dix. On tronque alors dans l'ordre de priorite des groupes, et
 * l'interface dit ce qui a saute plutot que de ramer en silence.
 */
export const MAX_TRACKED_SATELLITES = 4000

/**
 * Satellites reels du groupe CelesTrak choisi.
 *
 * La recuperation est differee et tolerante : `fetchGroup` ne leve jamais, et
 * retombe sur le cache si le reseau manque. Rien n'est place dans le store —
 * plusieurs centaines de jeux d'elements n'ont pas a etre serialises dans le
 * stockage local a chaque changement d'instant.
 */
export interface CelestrakFeed {
  elements: OrbitalElements[]
  loading: boolean
  /** Statut de la source : mesuree, en cache, ou repli. Nul tant que rien n'a abouti. */
  status: SourceStatus | null
  /** Nombre d'objets ecartes par le plafond de propagation. */
  truncated: number
  /** Groupes dont une partie des objets a ete ecartee par ce plafond. */
  truncatedGroups: CelestrakGroup[]
  /** Objets dont les elements ont plus de trois jours : leur position derive. */
  staleCount: number
}

/**
 * Etat partage du flux CelesTrak.
 *
 * Le hook est appele par la barre haute, le panneau et la scene. Avec un etat
 * local par appelant, chacun lancait sa propre recuperation et conservait sa
 * propre copie des elements : quatre requetes pour un meme groupe, et surtout
 * quatre tableaux d'identites differentes, ce qui ruinait toute memorisation en
 * aval. L'etat vit donc ici, hors de React, et les composants s'y abonnent.
 */
interface FeedState extends CelestrakFeed {
  /** Selection de groupes ayant produit cet etat, sous forme canonique. */
  key: string | null
}

const IDLE_FEED: FeedState = {
  key: null,
  elements: [],
  loading: false,
  status: null,
  truncated: 0,
  truncatedGroups: [],
  staleCount: 0,
}

/**
 * Forme canonique d'une selection de groupes : l'ordre de priorite, jamais
 * celui du clic. Deux selections identiques doivent donner la meme cle, sans
 * quoi cocher puis recocher relancerait la recuperation.
 */
const feedKey = (groups: readonly CelestrakGroup[]) =>
  ALL_CELESTRAK_GROUPS.filter((g) => groups.includes(g)).join(',')

let feedState: FeedState = IDLE_FEED
let feedRequest: string | null = null
const feedListeners = new Set<() => void>()

function publishFeed(next: FeedState) {
  feedState = next
  for (const listener of feedListeners) listener()
}

function ensureFeed(groups: readonly CelestrakGroup[]) {
  // Une recuperation par selection, quel que soit le nombre d'abonnes.
  const key = feedKey(groups)
  if (feedRequest === key) return
  feedRequest = key
  publishFeed({ ...IDLE_FEED, key, loading: true })

  // Les objets du catalogue partagent une teinte, distincte des orbites
  // saisies : on la resout au moment du chargement, donc apres le theme.
  const color = readToken('--app-body-satellite', '#7fd6ff')

  fetchGroups(groups).then((sourced) => {
    // La selection a pu changer pendant la requete : le resultat est perime.
    if (feedRequest !== key) return
    if (!sourced) {
      publishFeed({ ...IDLE_FEED, key, status: DEFAULT_STATUS })
      return
    }
    // `fetchGroups` rend les objets dans l'ordre de priorite des groupes : la
    // troncature ecarte donc les plus nombreux et les moins identifiables, pas
    // la fin de l'alphabet.
    const records = sourced.value
    const kept = records.slice(0, MAX_TRACKED_SATELLITES)
    const cut = new Set<CelestrakGroup>()
    for (let i = kept.length; i < records.length; i++) cut.add(records[i].group)
    publishFeed({
      key,
      loading: false,
      elements: kept.map((r) =>
        elementsFromGp(r.gp, { id: `celestrak-${r.noradId}`, color, epochAgeDays: r.epochAgeDays }),
      ),
      status: sourced.status,
      truncated: records.length - kept.length,
      truncatedGroups: ALL_CELESTRAK_GROUPS.filter((g) => cut.has(g)),
      staleCount: kept.filter((r) => r.stale).length,
    })
  })
}

const subscribeFeed = (listener: () => void) => {
  feedListeners.add(listener)
  return () => {
    feedListeners.delete(listener)
  }
}

const EMPTY_GROUPS: CelestrakGroup[] = []

export function useCelestrakSatellites(): CelestrakFeed {
  const enabled = useSkyStore((s) => s.layers.celestrak)
  const groups = useSkyStore((s) => s.celestrakGroups)
  const shared = useSyncExternalStore(subscribeFeed, () => feedState)
  const key = feedKey(groups)

  useEffect(() => {
    if (enabled && groups.length > 0) ensureFeed(groups)
    else {
      feedRequest = null
      publishFeed(IDLE_FEED)
    }
    // `key` resume la selection : son ordre ne compte pas, seul son contenu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key])

  // Une selection encore en cours de chargement ne doit pas afficher la
  // precedente : ce serait montrer des satellites qu'on a cesse de suivre.
  const current = enabled && shared.key === key ? shared : null

  return {
    elements: current?.elements ?? EMPTY_ELEMENTS,
    loading: Boolean(current?.loading),
    status: current?.status ?? null,
    truncated: current?.truncated ?? 0,
    truncatedGroups: current?.truncatedGroups ?? EMPTY_GROUPS,
    staleCount: current?.staleCount ?? 0,
  }
}

const EMPTY_ELEMENTS: OrbitalElements[] = []

/**
 * Memoire d'une seule entree pour la reunion des deux familles.
 *
 * Le `useMemo` d'un hook appartient a son composant : la scene et la recherche
 * appelant chacune `useAllSatellites`, elles obtenaient deux tableaux de meme
 * contenu mais d'identites differentes. La memoire de propagation, qui compare
 * justement des identites, etait alors mise en defaut a chaque tique et le
 * catalogue entier se propageait deux fois par instant. La reunion est donc
 * etablie ici, hors de React, pour que tous les appelants partagent le meme
 * tableau.
 */
let allKey: { manual: readonly OrbitalElements[]; showManual: boolean; fetched: readonly OrbitalElements[] } | null =
  null
let allValue: OrbitalElements[] = []

function allSatellitesFor(
  manual: readonly OrbitalElements[],
  showManual: boolean,
  fetched: readonly OrbitalElements[],
): OrbitalElements[] {
  if (allKey && allKey.manual === manual && allKey.showManual === showManual && allKey.fetched === fetched) {
    return allValue
  }
  const out: OrbitalElements[] = []
  if (showManual) out.push(...manual)
  out.push(...fetched)
  allKey = { manual, showManual, fetched }
  allValue = out
  return out
}

/**
 * Tous les satellites affichables : ceux saisis a la main et ceux du catalogue.
 * Les deux familles suivent ensuite exactement le meme chemin.
 */
export function useAllSatellites(): OrbitalElements[] {
  const manual = useSkyStore((s) => s.satellites)
  const showManual = useSkyStore((s) => s.layers.satellites)
  const { elements: fetched } = useCelestrakSatellites()

  return useMemo(() => allSatellitesFor(manual, showManual, fetched), [manual, showManual, fetched])
}

/**
 * Memoire d'une seule entree pour la propagation d'un lot.
 *
 * Cinq composants demandent les memes etats au meme instant — la scene, la
 * recherche, la barre haute, le panneau et sa fiche. Chacun avait son propre
 * `useMemo` : le catalogue etait donc propage cinq fois par rafraichissement.
 * Comme tous partagent desormais le meme tableau d'elements, une memoire d'une
 * entree suffit a ramener le travail a une seule passe.
 */
let statesKey: { list: readonly OrbitalElements[]; time: number; location: GeoLocation } | null = null
let statesValue: ReturnType<typeof computeSatelliteStates> = new Map()
let statesWall = -Infinity

/**
 * Cadence maximale de propagation du catalogue, en millisecondes d'horloge
 * reelle.
 *
 * En temps reel, les ephemerides sont deja commises a 10 Hz et ce plafond ne
 * change rien. En temps accelere, elles le sont a chaque image — ce qui est
 * necessaire aux corps du systeme solaire, dont le mouvement doit rester
 * continu, mais absurde pour un satellite : a x600, un objet en orbite basse
 * traverse deja dix degres de ciel d'une image a l'autre. Le propager sur
 * soixante images par seconde ne rend donc pas son passage plus lisible, cela
 * ne fait que payer six fois le meme saut.
 */
const SATELLITE_MIN_INTERVAL_MS = 80

function satelliteStatesFor(list: readonly OrbitalElements[], date: Date, location: GeoLocation) {
  const time = date.getTime()
  if (statesKey && statesKey.list === list && statesKey.time === time && statesKey.location === location) {
    return statesValue
  }
  // Le catalogue ou le lieu ont change : la reponse precedente ne decrit plus
  // le meme ciel, le plafond de cadence ne s'y applique pas.
  const sameSky = statesKey !== null && statesKey.list === list && statesKey.location === location
  const now = performance.now()
  if (sameSky && now - statesWall < SATELLITE_MIN_INTERVAL_MS) return statesValue

  statesWall = now
  statesValue = computeSatelliteStates(list, date, location)
  statesKey = { list, time, location }
  return statesValue
}

/** Etats instantanes de tous les satellites definis. */
export function useSatelliteStates(satellites?: readonly OrbitalElements[]) {
  const date = useSimulatedDate()
  const location = useSkyStore((s) => s.location)
  const stored = useSkyStore((s) => s.satellites)
  const list = satellites ?? stored

  return useMemo(() => satelliteStatesFor(list, date, location), [list, date, location])
}

/**
 * Traces dans le ciel. Recalculees seulement toutes les 30 s de temps simule :
 * la forme de la trace evolue lentement par rapport a la position du satellite.
 */
export function useSatelliteTracks(satellites: readonly OrbitalElements[]) {
  const time = useSkyStore((s) => s.time)
  const location = useSkyStore((s) => s.location)
  const windowMinutes = useSkyStore((s) => s.trackWindowMinutes)
  const bucket = Math.floor(time / 30_000)

  return useMemo(() => {
    const map = new Map<string, ReturnType<typeof sampleSkyTrack>>()
    for (const el of satellites) {
      try {
        map.set(el.id, sampleSkyTrack(el, location, new Date(bucket * 30_000), windowMinutes, 400))
      } catch {
        /* ignore */
      }
    }
    return map
  }, [satellites, location, bucket, windowMinutes])
}

/**
 * Recherche asynchrone des passages : le calcul balaye plusieurs milliers
 * d'instants, on le differe pour ne pas bloquer la saisie dans le formulaire.
 */
export function useSatellitePasses(
  element: OrbitalElements | null,
  location: GeoLocation,
  hours: number,
  visibleOnly: boolean,
): { passes: SatellitePass[]; loading: boolean } {
  const [passes, setPasses] = useState<SatellitePass[]>([])
  const [loading, setLoading] = useState(false)
  const token = useRef(0)

  const key = element
    ? `${element.id}|${element.semiMajorAxisKm}|${element.eccentricity}|${element.inclination}|${element.raan}|${element.argPerigee}|${element.meanAnomaly}|${element.epoch}|${element.useJ2}`
    : ''

  useEffect(() => {
    if (!element) {
      setPasses([])
      return
    }
    const myToken = ++token.current
    setLoading(true)
    const handle = window.setTimeout(() => {
      try {
        const result = findPasses(element, location, new Date(), {
          hours,
          minPeakAltitude: 10,
          visibleOnly,
        })
        if (token.current === myToken) setPasses(result)
      } catch {
        if (token.current === myToken) setPasses([])
      } finally {
        if (token.current === myToken) setLoading(false)
      }
    }, 120)
    return () => window.clearTimeout(handle)
    // `key` resume les elements orbitaux : inutile de reagir a la couleur ou au nom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, location, hours, visibleOnly])

  return { passes, loading }
}

/** Tolerance de decalage temporel : au-dela, l'instant simule n'est plus « maintenant ». */
const AIRCRAFT_LIVE_TOLERANCE_MS = 5 * 60_000

const EMPTY_AIRCRAFT: AircraftState[] = []

export interface AircraftFeed {
  aircraft: AircraftState[]
  status: SourceStatus | null
  loading: boolean
  /**
   * Faux si l'instant simule s'est trop eloigne du present.
   * L'ADS-B n'a pas d'archive gratuite : reculer ou avancer la frise ne peut
   * pas montrer des avions d'hier ou de demain, seulement ceux d'a l'instant.
   */
  live: boolean
}

/**
 * Avions reels a portee du lieu d'observation, recuperes en direct.
 *
 * Le minuteur qui interroge le relais vit hors de React (`aircraftFeed.ts`) et
 * survit aux montages/demontages des composants consommateurs — la barre haute
 * reste affichee en permanence et sert de point d'ancrage naturel a
 * l'interrogation, mais rien n'empeche la scene ou une fiche de detail de s'y
 * abonner en parallele sans relancer de requete.
 */
export function useNearbyAircraft(): AircraftFeed {
  const enabled = useSkyStore((s) => s.layers.aircraft)
  const location = useSkyStore((s) => s.location)
  const time = useSkyStore((s) => s.time)
  const simulated = useSkyStore((s) => s.aircraftSimulated)
  const upperAir = useSkyStore((s) => s.upperAir)
  // Une flotte simulee existe a toute heure : elle est « disponible » meme
  // quand l'instant affiche n'est pas le present.
  const live = simulated || Math.abs(time - Date.now()) < AIRCRAFT_LIVE_TOLERANCE_MS
  const active = enabled && live

  // Arrondi : un tremblement de quelques metres dans la position geolocalisee
  // ne doit pas relancer l'interrogation.
  const lat = Math.round(location.latitude * 100) / 100
  const lon = Math.round(location.longitude * 100) / 100

  useEffect(() => {
    if (active) ensureAircraftPolling(lat, lon, simulated)
    else stopAircraftPolling()
  }, [active, lat, lon, simulated])

  const snapshot = useSyncExternalStore(subscribeAircraftFeed, getAircraftFeedSnapshot)

  const aircraft = useMemo(() => {
    if (!active) {
      forgetAircraftTracks(new Set())
      return EMPTY_AIRCRAFT
    }
    const profile = profileAt(upperAir, time)
    const out: AircraftState[] = []
    for (const a of snapshot.raw) {
      const s = computeAircraftState(a, location)
      if (s) out.push(withContrailWeather(s, profile))
    }
    // Les appareils sortis du rayon n'ont plus de raccord a memoriser.
    forgetAircraftTracks(new Set(out.map((a) => a.hex)))
    return out
    // L'heure n'entre que par le profil horaire : la recalculer a chaque tic
    // de l'horloge serait inutile, d'ou l'arrondi a l'heure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, snapshot.raw, location, upperAir, Math.round(time / 3600_000)])

  return { aircraft, status: active ? snapshot.status : null, loading: active && snapshot.loading, live }
}

export { AIRCRAFT_RADIUS_KM, getAircraftHistory, type AircraftHistoryPoint } from './aircraftFeed'
