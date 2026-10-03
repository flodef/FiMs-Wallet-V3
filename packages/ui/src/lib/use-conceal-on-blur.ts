import { useEffect, useRef } from 'react'

// Re-masks sensitive content (recovery phrase, secret key) as soon as the
// window loses focus or the tab is hidden — defeats shoulder-surfing and
// overlay capture tools. The web platform offers no way to block OS-level
// screenshots entirely; concealment on focus loss is the practical limit.
export function useConcealOnBlur(revealed: boolean, conceal: () => void) {
  const concealRef = useRef(conceal)
  concealRef.current = conceal
  useEffect(() => {
    if (!revealed) {
      return
    }
    const hide = () => concealRef.current()
    const onVisibility = () => {
      if (document.hidden) {
        hide()
      }
    }
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [revealed])
}
