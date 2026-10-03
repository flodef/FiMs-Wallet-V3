import { useSyncExternalStore } from 'react'
import { isInsufficientGasError } from './fims-gas.ts'

// Tiny pub/sub store surfacing "not enough SOL for gas" from any mutation
// error path up to the global top-up dialog mounted in the shell.
type Listener = () => void

const listeners = new Set<Listener>()
let open = false
let promptedThisSession = false

function emit() {
  for (const listener of listeners) {
    listener()
  }
}

export function requestGasTopup(): void {
  open = true
  emit()
}

export function closeGasTopup(): void {
  open = false
  emit()
}

// Called from transaction error paths — opens the dialog only when the
// failure actually looks like a SOL shortage.
export function reportGasTopupError(error: unknown): void {
  if (isInsufficientGasError(error)) {
    requestGasTopup()
  }
}

// Proactive prompt (first deposit / drained reserve): opens at most once per
// session so it cannot nag on every render.
export function requestGasTopupOncePerSession(): void {
  if (promptedThisSession) {
    return
  }
  promptedThisSession = true
  requestGasTopup()
}

export function useGasTopupOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open,
  )
}
