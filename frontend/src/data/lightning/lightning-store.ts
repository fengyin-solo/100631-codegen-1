import type { LightningState } from './types'

const STORAGE_KEY = 'urban-utility-tunnel:lightning'

function emptyState(): LightningState {
  return { records: [], todos: [], backfilled: false, backfilledAt: '', recordSeq: 0, todoSeq: 0 }
}

let cache: LightningState | null = null

export function loadState(): LightningState {
  if (cache) return cache
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = emptyState()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = emptyState()
    return cache
  }
  try {
    cache = { ...emptyState(), ...(JSON.parse(raw) as LightningState) }
  } catch {
    cache = emptyState()
  }
  return cache
}

/**
 * 唯一落盘入口：台账与保养计划待办必须在同一次提交里一起写，
 * 不允许两边各存各的（原子双写，先在内存里改完整再整体持久化）。
 */
export function commitState(next: LightningState): LightningState {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

export function resetState(): LightningState {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
  cache = emptyState()
  return cache
}

export function lightningStorageKey(): string {
  return STORAGE_KEY
}
