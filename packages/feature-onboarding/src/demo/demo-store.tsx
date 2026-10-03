import { useSyncExternalStore } from 'react'

export const DEMO_MNEMONIC = 'pill tomorrow foster begin walnut borrow virtual kick shift mutual shoe scatter'

export interface DemoState {
  active: boolean
  airdropRequested: boolean
  memberRegistered: boolean
  previousAccountId: null | string
  previousNetworkId: null | string
  stepIndex: number
  walletCreated: boolean
}

const initialState: DemoState = {
  active: false,
  airdropRequested: false,
  memberRegistered: false,
  previousAccountId: null,
  previousNetworkId: null,
  stepIndex: 0,
  walletCreated: false,
}

// The tour state survives a page refresh (presenters do reload mid-demo):
// without it, a reload would drop the overlay while leaving the demo account
// active — the presenter would land on an unfamiliar empty wallet with no way
// to tell it apart from their own. sessionStorage (not localStorage) so the
// demo never bleeds into a later browser session.
const STORAGE_KEY = 'fims:demo'

function loadPersisted(): DemoState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return initialState
    }
    return { ...initialState, ...(JSON.parse(raw) as Partial<DemoState>) }
  } catch {
    return initialState
  }
}

let state: DemoState = typeof sessionStorage === 'undefined' ? initialState : loadPersisted()
const listeners = new Set<() => void>()

function getSnapshot() {
  return state
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function demoSetState(partial: Partial<DemoState>) {
  state = { ...state, ...partial }
  try {
    if (state.active) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } else {
      sessionStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Storage may be unavailable (private mode) — the demo just won't resume.
  }
  for (const listener of listeners) {
    listener()
  }
}

export function demoStart(previous: { accountId: null | string; networkId: null | string }) {
  demoSetState({
    ...initialState,
    active: true,
    previousAccountId: previous.accountId,
    previousNetworkId: previous.networkId,
  })
}

export function demoStop() {
  demoSetState(initialState)
}

export function useDemoState(): DemoState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
