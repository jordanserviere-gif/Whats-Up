import { useEffect } from 'react'
import { IconButton, NavigationRail, SidePanel, Tooltip, useTheme, type NavDestination } from '@/ui'
import { SkyCanvas } from '@/scene/SkyCanvas'
import { SkyHud } from '@/features/SkyHud'
import { TimelineBar } from '@/features/TimelineBar'
import { ObjectsDetail, ObjectsPanel } from '@/features/ObjectsPanel'
import { SatelliteDetail, SatellitesPanel } from '@/features/SatellitesPanel'
import { AircraftDetail } from '@/features/AircraftDetail'
import { SettingsPanel } from '@/features/SettingsPanel'
import { NightFilter } from '@/features/NightFilter'
import { Logo } from '@/brand/Logo'
import { AppLoader } from '@/features/AppLoader'
import { useSkyStore, type ViewTab } from '@/state/store'
import { useTimeEngine } from '@/state/hooks'
import './App.css'

const DESTINATIONS: ReadonlyArray<NavDestination<ViewTab>> = [
  { value: 'ciel', label: 'Ciel', icon: 'nights_stay' },
  { value: 'objets', label: 'Objets', icon: 'public' },
  { value: 'satellites', label: 'Satellites', icon: 'satellite_alt' },
  { value: 'reglages', label: 'Réglages', icon: 'tune' },
]

const PANEL_TITLES: Record<ViewTab, { title: string; subtitle: string }> = {
  ciel: { title: 'Vue du ciel', subtitle: 'Observation' },
  objets: { title: 'Système solaire', subtitle: 'Éphémérides' },
  satellites: { title: 'Satellites', subtitle: 'Éléments orbitaux' },
  reglages: { title: 'Réglages', subtitle: 'Configuration' },
}

export function App() {
  useTimeEngine()

  const tab = useSkyStore((s) => s.tab)
  const setTab = useSkyStore((s) => s.setTab)
  const panelOpen = useSkyStore((s) => s.panelOpen)
  const setPanelOpen = useSkyStore((s) => s.setPanelOpen)
  const setPlaying = useSkyStore((s) => s.setPlaying)
  const goLive = useSkyStore((s) => s.goLive)
  const satelliteCount = useSkyStore((s) => s.satellites.length)
  const selectedAircraftHex = useSkyStore((s) => s.selectedAircraftHex)
  const { mode, toggleNight } = useTheme()

  // Raccourcis clavier : espace = pause, N = maintenant, Echap = fermer le panneau.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.code === 'Space') {
        e.preventDefault()
        setPlaying(!useSkyStore.getState().playing)
      } else if (e.key === 'n' || e.key === 'N') {
        goLive()
      } else if (e.key === 'Escape') {
        setPanelOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPlaying, goLive, setPanelOpen])

  const meta = PANEL_TITLES[tab]

  return (
    <div className="app">
      <NightFilter />
      <AppLoader />
      <NavigationRail
        destinations={DESTINATIONS.map((d) =>
          d.value === 'satellites' && satelliteCount > 0 ? { ...d, badge: satelliteCount } : d,
        )}
        value={tab}
        onChange={(v) => {
          if (v === tab) setPanelOpen(!panelOpen)
          else setTab(v)
        }}
        header={<Logo className="app__logo" />}
        /* Le night est la bascule qu'on cherche dehors, dans le noir : elle a
           sa place fixe dans le rail. Clair et sombre, choix d'une fois pour
           toutes, vivent dans les reglages. */
        footer={
          <Tooltip content={mode === 'night' ? 'Quitter le mode night' : 'Mode night'} placement="end">
            <IconButton
              icon="nightlight"
              label="Mode night"
              selected={mode === 'night'}
              onClick={toggleNight}
            />
          </Tooltip>
        }
      />

      <main className="app__stage">
        <SkyCanvas />
        <SkyHud />
        <div className="app__timeline">
          <TimelineBar />
        </div>
      </main>

      <SidePanel
        open={panelOpen}
        title={meta.title}
        subtitle={meta.subtitle}
        onClose={() => setPanelOpen(false)}
        className="app__panel"
        /* La fiche de l'objet designe est ancree sous la liste : on parcourt le
           catalogue sans jamais perdre de vue ce que l'on vient de choisir. Un
           avion designe prend le pas sur le contenu habituel de l'onglet — il
           n'appartient a aucun catalogue et n'a pas sa propre place fixe. */
        detail={
          selectedAircraftHex ? (
            <AircraftDetail />
          ) : tab === 'satellites' ? (
            <SatelliteDetail />
          ) : tab === 'reglages' ? undefined : (
            <ObjectsDetail />
          )
        }
      >
        {tab === 'ciel' && <ObjectsPanel />}
        {tab === 'objets' && <ObjectsPanel />}
        {tab === 'satellites' && <SatellitesPanel />}
        {tab === 'reglages' && <SettingsPanel />}
      </SidePanel>
    </div>
  )
}
