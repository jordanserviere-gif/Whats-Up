import { uniformSpectralGrid } from '../src/atmosphere/spectral/SpectralGrid.ts'
import { createAerialLut, fillAerialRows, measureSkyIrradiance, AERIAL_LUT_HEIGHT } from '../src/atmosphere/lut/aerialPerspectiveLut.ts'
import { createColumnLut, fillColumnLutRows } from '../src/atmosphere/lut/transmittanceLut.ts'
import { createMultipleScatteringLut, fillMultipleScatteringEntries } from '../src/atmosphere/transport/multipleScattering.ts'
import { CONTINENTAL_AEROSOL, aerosolOptics, aodFromTurbidity, withAod } from '../src/atmosphere/mie/aerosol.ts'
const G = uniformSpectralGrid(360, 830, 16)
const Y=(r,g,b)=>683*(0.2126*r+0.7152*g+0.0722*b)
const col = createColumnLut(); fillColumnLutRows(col,0,col.height,{aerosolScaleHeightM:CONTINENTAL_AEROSOL.scaleHeightM})
const base = aerosolOptics(G,{...CONTINENTAL_AEROSOL,aod550:aodFromTurbidity(1)})
const aer = withAod(base, aodFromTurbidity(2.5), aodFromTurbidity(1))
console.log('Eclairement du ciel, lux — cette fois les directions ET les pas sont bien transmis\n')
console.log('grille  dir  pas      -10°       -14°       -18°      f_ms max   temps')
for (const [w,h,dirs,steps] of [[32,32,64,32],[32,32,256,32],[32,32,1024,64],[64,64,1024,64]]) {
  const t0 = performance.now()
  const ms = createMultipleScatteringLut(G, { width:w, height:h })
  fillMultipleScatteringEntries(ms, G, 0, ms.width*ms.height, { columnLut: col, aerosols: aer, directions: dirs, steps })
  const build = performance.now() - t0
  const out = [-10,-14,-18].map((sa)=>{
    const lut = createAerialLut()
    fillAerialRows(lut, G, sa, 0, AERIAL_LUT_HEIGHT, { columnLut: col, aerosols: aer, multipleScattering: ms, observerElevationM: 0 })
    return Y(...measureSkyIrradiance(lut))
  })
  console.log(`${w}x${h} ${String(dirs).padStart(4)} ${String(steps).padStart(3)}  ${out.map(v=>v.toExponential(2)).join('  ')}   ${ms.maxTransferFactor.toFixed(3)}   ${(build/1000).toFixed(1)}s`)
}
console.log('\nreference classique :        1.60e-1   5.50e-3   1.10e-3')
