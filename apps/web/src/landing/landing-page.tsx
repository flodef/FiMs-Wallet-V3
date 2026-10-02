import { useLayoutEffect } from 'react'
import landingHtml from './landing.html?raw'

const THEME_KEY = 'fims-theme'

// Apply the persisted landing theme before first paint (ported from the
// original inline head script). Values: 'light' | 'dark' | 'system'.
function applyInitialTheme() {
  try {
    const mode = localStorage.getItem(THEME_KEY) || 'system'
    const light = mode === 'light' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.classList.toggle('light', light)
  } catch {}
}

// The landing page is a self-contained HTML document (styles + markup)
// injected raw; its original inline script is ported below as effects.
export function LandingPage() {
  useLayoutEffect(() => {
    const htmlEl = document.documentElement
    const previousLang = htmlEl.lang
    applyInitialTheme()
    htmlEl.lang = 'fr'
    document.title = 'FiMs — La finance pour tous'

    // Head assets from the original static page
    const fontLinks = [
      { href: 'https://fonts.googleapis.com', rel: 'preconnect' },
      { crossOrigin: '', href: 'https://fonts.gstatic.com', rel: 'preconnect' },
      {
        href: 'https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&display=swap',
        rel: 'stylesheet',
      },
    ].map((attrs) => {
      const link = document.createElement('link')
      Object.assign(link, attrs)
      document.head.appendChild(link)
      return link
    })

    // Theme (ported from the inline script — 'light' | 'dark' | 'system')
    const buttons = document.querySelectorAll<HTMLButtonElement>('.theme-toggle [data-theme]')
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const current = () => {
      try {
        return localStorage.getItem(THEME_KEY) || 'system'
      } catch {
        return 'system'
      }
    }
    const apply = (mode: string) => {
      const light = mode === 'light' || (mode === 'system' && mq.matches)
      htmlEl.classList.toggle('light', light)
      buttons.forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-theme') === mode)
        b.setAttribute('aria-checked', b.getAttribute('data-theme') === mode ? 'true' : 'false')
      })
    }
    const set = (mode: string) => {
      try {
        mode === 'system' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, mode)
      } catch {}
      apply(mode)
    }
    const listeners = [...buttons].map((b) => {
      const fn = () => set(b.getAttribute('data-theme') ?? 'system')
      b.addEventListener('click', fn)
      return [b, fn] as const
    })
    const onMq = () => {
      if (current() === 'system') apply('system')
    }
    mq.addEventListener('change', onMq)
    apply(current())

    // Nav shrink on scroll
    const nav = document.getElementById('nav')
    const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 24)
    window.addEventListener('scroll', onScroll, { passive: true })

    // Mobile menu
    const burger = document.getElementById('burger')
    const menu = document.getElementById('mobileMenu')
    const toggleMenu = () => menu?.classList.toggle('open')
    burger?.addEventListener('click', toggleMenu)
    const menuLinks = [...(menu?.querySelectorAll('a') ?? [])]
    const closeMenu = () => menu?.classList.remove('open')
    menuLinks.forEach((a) => {
      a.addEventListener('click', closeMenu)
    })

    // Reveal on scroll
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        })
      },
      { threshold: 0.12 },
    )
    document.querySelectorAll('.reveal').forEach((el) => {
      io.observe(el)
    })

    // Spotlight on pillar cards
    const pillarMoves = [...document.querySelectorAll<HTMLElement>('.pillar')].map((card) => {
      const fn = (e: PointerEvent) => {
        const r = card.getBoundingClientRect()
        card.style.setProperty('--mx', `${e.clientX - r.left}px`)
        card.style.setProperty('--my', `${e.clientY - r.top}px`)
      }
      card.addEventListener('pointermove', fn)
      return [card, fn] as const
    })

    // Exclusive FAQ accordion — fallback for browsers without <details name>
    const onToggle = (e: Event) => {
      const el = e.target
      if (!(el instanceof HTMLDetailsElement) || !el.classList.contains('faq') || !el.open) return
      document.querySelectorAll<HTMLDetailsElement>('details.faq[open]').forEach((d) => {
        if (d !== el) d.open = false
      })
    }
    document.addEventListener('toggle', onToggle, true)

    // Live community stats — same-origin API, graceful if unreachable
    const EUR = new Intl.NumberFormat('fr-FR', { currency: 'EUR', maximumFractionDigits: 0, style: 'currency' })
    const countUp = (el: HTMLElement, target: number, format: (v: number) => string) => {
      let start: number | null = null
      const step = (ts: number) => {
        if (!start) start = ts
        const p = Math.min((ts - start) / 1400, 1)
        el.textContent = format(target * (1 - (1 - p) ** 3))
        if (p < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }
    fetch('/api/fims/dashboard')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((metrics: { label: string; ratio: number; value: number }[]) => {
        const get = (label: string) => metrics.find((m) => m.label === label)
        const invested = get('Invested')
        const assets = get('Assets')
        const gains = get('Gains')
        if (!invested || !assets || !gains) return
        const stats = document.getElementById('stats')
        if (!stats) return
        stats.hidden = false
        // Animate only once the numbers scroll into view
        const run = () => {
          const i = document.getElementById('statInvested')
          const a = document.getElementById('statAssets')
          const p = document.getElementById('statPerf')
          if (i) countUp(i, invested.value, (v) => EUR.format(v))
          if (a) countUp(a, assets.value, (v) => EUR.format(v))
          if (p) countUp(p, gains.ratio * 100, (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`)
        }
        const statsIo = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              statsIo.disconnect()
              run()
            }
          },
          { threshold: 0.3 },
        )
        statsIo.observe(stats)
      })
      .catch(() => {})

    return () => {
      htmlEl.lang = previousLang
      htmlEl.classList.remove('light')
      fontLinks.forEach((l) => {
        l.remove()
      })
      listeners.forEach(([b, fn]) => {
        b.removeEventListener('click', fn)
      })
      mq.removeEventListener('change', onMq)
      window.removeEventListener('scroll', onScroll)
      burger?.removeEventListener('click', toggleMenu)
      menuLinks.forEach((a) => {
        a.removeEventListener('click', closeMenu)
      })
      document.removeEventListener('toggle', onToggle, true)
      io.disconnect()
      pillarMoves.forEach(([card, fn]) => {
        card.removeEventListener('pointermove', fn)
      })
    }
  }, [])

  // biome-ignore lint/security/noDangerouslySetInnerHtml: static markup bundled at build time, not user input
  return <div className="landing-root" dangerouslySetInnerHTML={{ __html: landingHtml }} />
}
