/**
 * Audit de debordement de l'interface.
 *
 * Ouvre chaque onglet a plusieurs largeurs et signale tout element dont le
 * contenu deborde sa boite sans qu'aucun defilement ne soit prevu. C'est le
 * seul moyen fiable de trouver ces defauts : a l'oeil, un depassement de
 * quelques pixels passe inapercu jusqu'a ce qu'un libelle plus long arrive.
 *
 * `overflow: hidden` n'absout de rien : le contenu n'y deborde pas, il y est
 * ampute. Seul `auto` ou `scroll` rend la situation acceptable, puisque le
 * lecteur peut alors atteindre le reste.
 */
import { chromium } from 'playwright'

const URL = process.env.AUDIT_URL ?? 'http://localhost:5211/'

const VIEWPORTS = [
  { name: 'bureau 1440', width: 1440, height: 900 },
  { name: 'portable 1280', width: 1280, height: 800 },
  { name: 'tablette 1024', width: 1024, height: 768 },
  { name: 'mobile 420', width: 420, height: 880 },
]

const TABS = ['ciel', 'objets', 'satellites', 'reglages']

/**
 * Releve execute dans la page.
 *
 * L'etendue du contenu se mesure sur les seuls enfants en flux : une info-bulle
 * ou une graduation en position absolue sort de sa boite par construction, et la
 * signaler noierait les vrais defauts. Les glyphes d'icone sont ecartes pour la
 * meme raison — leur boite de police depasse toujours d'un pixel ou deux.
 */
const PROBE = () => {
  /** Sous ce seuil, l'ecart releve de l'arrondi sous-pixel. */
  const SLACK_PX = 2
  const out = []
  const scrolls = (v) => v === 'auto' || v === 'scroll'
  const IGNORED = ['md-icon', 'md-tooltip', 'md-tooltip-anchor', 'md-ripple']

  for (const el of document.querySelectorAll('body *')) {
    if (IGNORED.some((c) => el.classList.contains(c))) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue

    // Boite de contenu, bordures et defilement deduits.
    const left = rect.left + parseFloat(cs.borderLeftWidth) - el.scrollLeft
    const top = rect.top + parseFloat(cs.borderTopWidth) - el.scrollTop
    const right = left + el.clientWidth
    const bottom = top + el.clientHeight

    let spillX = 0
    let spillY = 0
    let culprit = ''
    for (const child of el.children) {
      const ccs = getComputedStyle(child)
      if (ccs.position === 'absolute' || ccs.position === 'fixed') continue
      if (ccs.display === 'none' || ccs.visibility === 'hidden') continue
      const c = child.getBoundingClientRect()
      if (c.width === 0 || c.height === 0) continue
      const dx = Math.max(left - c.left, c.right - right)
      const dy = Math.max(top - c.top, c.bottom - bottom)
      if (dx > spillX) {
        spillX = dx
        culprit = child.tagName.toLowerCase() + '.' + [...child.classList].join('.')
      }
      if (dy > spillY) {
        spillY = dy
        culprit = child.tagName.toLowerCase() + '.' + [...child.classList].join('.')
      }
    }

    // Texte ampute : la boite n'a pas d'enfant fautif, c'est la ligne elle-meme
    // qui ne tient pas, et rien n'est prevu pour la lire.
    const textX = el.children.length === 0 ? el.scrollWidth - el.clientWidth : 0
    const textY = el.children.length === 0 ? el.scrollHeight - el.clientHeight : 0

    const label = el.tagName.toLowerCase() + '.' + [...el.classList].join('.')
    const push = (axis, over, from) =>
      out.push({ label, axis, over: Math.round(over), from, text: el.textContent.trim().slice(0, 54) })

    const ellipsised = cs.textOverflow === 'ellipsis'
    if (spillX > SLACK_PX && !scrolls(cs.overflowX)) push('x', spillX, culprit)
    if (spillY > SLACK_PX && !scrolls(cs.overflowY)) push('y', spillY, culprit)
    if (textX > SLACK_PX && !scrolls(cs.overflowX) && !ellipsised) push('x', textX, 'texte')
    if (textY > SLACK_PX && !scrolls(cs.overflowY)) push('y', textY, 'texte')
  }
  return out
}

// Sans contexte WebGL, la scene leve et l'interface entiere reste vide : l'audit
// signalerait alors zero debordement pour la seule raison qu'il n'y a rien.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-lcd-text'],
})
let total = 0

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } })
  page.on('pageerror', (e) => console.log(`  !! erreur de page : ${e.message.split('\n')[0]}`))
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.removeItem('ciel.state'))
  await page.reload({ waitUntil: 'networkidle' })

  const mounted = await page.evaluate(() => document.querySelector('.app') !== null)
  if (!mounted) {
    console.log(`[${vp.name}] l'application n'a pas monte — audit sans objet`)
    process.exitCode = 1
    await page.close()
    continue
  }

  for (const tab of TABS) {
    await page.evaluate((t) => window.__skyStore?.getState().setTab(t), tab)
    // Ouvre toutes les sections repliees : un debordement cache n'en est pas moins un.
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('.md-section:not(.is-open) .md-section__toggle')) b.click()
    })
    await page.waitForTimeout(700)

    const found = await page.evaluate(PROBE)
    if (found.length) {
      console.log(`\n=== ${vp.name} · onglet ${tab} ===`)
      for (const f of found) console.log(`  ${f.axis} +${f.over}px  ${f.label}\n      par ${f.from} — « ${f.text} »`)
      total += found.length
    }
  }
  await page.close()
}

await browser.close()
console.log(total === 0 ? '\nAucun debordement detecte.' : `\n${total} debordements releves.`)
