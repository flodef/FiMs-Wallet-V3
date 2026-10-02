import { useSyncExternalStore } from 'react'

export const DEMO_MNEMONIC = 'pill tomorrow foster begin walnut borrow virtual kick shift mutual shoe scatter'

export interface DemoState {
  active: boolean
  airdropRequested: boolean
  previousAccountId: null | string
  previousNetworkId: null | string
  stepIndex: number
  walletCreated: boolean
}

const initialState: DemoState = {
  active: false,
  airdropRequested: false,
  previousAccountId: null,
  previousNetworkId: null,
  stepIndex: 0,
  walletCreated: false,
}

let state = initialState
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
