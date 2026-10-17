/**
 * 实际消耗账本单元测试：采样折叠、差值判定（消耗/重置/持平）、按日/月汇总、
 * 过期清理与响应行排序。
 */

import { describe, expect, it } from 'vitest'
import {
  actualDeltaOf, actualRowsOf, actualSpendOf, emptyActualLedger, foldActualSample,
  MAX_SAMPLES, SAMPLE_MAX_AGE_MS,
  type ActualLedger, type ActualSample, type ActualProviderLedger,
} from '../src/actual.ts'

const DAY = '2026-08-16'
const MONTH = '2026-08'

/** 造一个采样：默认 CNY 100 元、无分项。 */
function sample(overrides: Partial<ActualSample> = {}): ActualSample {
  return { at: 1_000, value: 100, granted: 0, topped: 0, currency: 'CNY', ...overrides }
}

/** 造一个只有一条采样的来源序列。 */
function ledgerOf(samples: ActualSample[], provider = 'deepseek'): ActualProviderLedger {
  return { provider, displayName: provider, currency: samples[samples.length - 1]?.currency ?? 'CNY', samples }
}

describe('foldActualSample', () => {
  it('appends a sample for a balance row and reports absorption', () => {
    const ledger = emptyActualLedger()
    const absorbed = foldActualSample(ledger, { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: 88.5, grantedBalance: 8.5, toppedUpBalance: 80 }, 5_000)
    expect(absorbed).toBe(true)
    const entry = ledger.providers['deepseek'] as ActualProviderLedger
    expect(entry.samples).toHaveLength(1)
    expect(entry.samples[0]).toMatchObject({ at: 5_000, value: 88.5, granted: 8.5, topped: 80, currency: 'CNY' })
  })

  it('skips rows without a finite balance or with an error', () => {
    const ledger = emptyActualLedger()
    expect(foldActualSample(ledger, { provider: 'a', displayName: 'a', currency: 'CNY' }, 1_000)).toBe(false)
    expect(foldActualSample(ledger, { provider: 'b', displayName: 'b', currency: 'CNY', totalBalance: Number.NaN }, 1_000)).toBe(false)
    expect(foldActualSample(ledger, { provider: 'c', displayName: 'c', currency: 'CNY', totalBalance: 5, error: 'unauthorized' }, 1_000)).toBe(false)
    expect(ledger.providers).toEqual({})
  })

  it('trims samples beyond MAX_SAMPLES (oldest first)', () => {
    const ledger = emptyActualLedger()
    for (let i = 0; i < MAX_SAMPLES + 50; i += 1) {
      foldActualSample(ledger, { provider: 'p', displayName: 'p', currency: 'CNY', totalBalance: i }, i)
    }
    const entry = ledger.providers['p'] as ActualProviderLedger
    expect(entry.samples).toHaveLength(MAX_SAMPLES)
    // 最旧的 50 条被裁掉：首条 at = 50。
    expect(entry.samples[0]?.at).toBe(50)
  })
})

describe('actualDeltaOf', () => {
  it('reports the drop as spent', () => {
    expect(actualDeltaOf(sample(), sample({ value: 93.5, at: 2_000 }))).toEqual({ kind: 'spent', spent: 6.5 })
  })

  it('stays flat on an increase or a sub-cent drop', () => {
    expect(actualDeltaOf(sample(), sample({ value: 101, at: 2_000 })).kind).toBe('flat')
    expect(actualDeltaOf(sample(), sample({ value: 100 - 0.005, at: 2_000 })).kind).toBe('flat')
  })

  it('resets when currency changes', () => {
    expect(actualDeltaOf(sample(), sample({ currency: 'USD', value: 90, at: 2_000 }))).toEqual({ kind: 'reset', spent: 0 })
  })

  it('resets when granted or topped balance rises (充值/授信)', () => {
    expect(actualDeltaOf(sample(), sample({ granted: 10, at: 2_000 })).kind).toBe('reset')
    expect(actualDeltaOf(sample(), sample({ topped: 50, at: 2_000 })).kind).toBe('reset')
    // 充值同时推高总额：仍然只记重置，不把充值误记为负消耗。
    expect(actualDeltaOf(sample(), sample({ topped: 50, value: 150, at: 2_000 })).kind).toBe('reset')
  })
})

describe('actualSpendOf', () => {
  it('treats the first sample as baseline only (首采不记消耗)', () => {
    const spend = actualSpendOf(ledgerOf([sample()]), DAY, MONTH, 2_000)
    expect(spend).toEqual({ today: 0, month: 0, total: 0, byDay: {}, lastSampleAt: 1_000 })
  })

  it('accumulates drops into day/month/total buckets by the later sample time', () => {
    // 消耗归属「观测到下降的那次采样」的本地日/月。
    const spend = actualSpendOf(ledgerOf([
      sample({ at: dayStart(DAY) }),
      sample({ value: 90, at: dayStart(DAY) + 60_000 }),
      sample({ value: 85, at: dayStart('2026-08-17') }),
    ]), DAY, MONTH, dayStart('2026-08-17') + 60_000)
    expect(spend.today).toBeCloseTo(10)
    expect(spend.month).toBeCloseTo(15)
    expect(spend.total).toBeCloseTo(15)
    // 按日拆分：15 = 今日 10 + 次日 5，供界面按统计范围聚合。
    expect(spend.byDay[DAY]).toBeCloseTo(10)
    expect(spend.byDay['2026-08-17']).toBeCloseTo(5)
    expect(spend.lastSampleAt).toBe(dayStart('2026-08-17'))
  })

  it('ignores samples older than 90 days and resets on structural changes', () => {
    const spend = actualSpendOf(ledgerOf([
      sample({ at: 0, value: 100 }),
      // 超过 90 天：连同基线一起被过滤，50 是过滤后新基线，不记消耗。
      sample({ value: 50, at: SAMPLE_MAX_AGE_MS + 10_000 }),
      sample({ value: 45, at: SAMPLE_MAX_AGE_MS + 20_000 }),
      // 充值重置：差值不记。
      sample({ value: 95, topped: 50, at: SAMPLE_MAX_AGE_MS + 30_000 }),
      sample({ value: 90, at: SAMPLE_MAX_AGE_MS + 40_000 }),
    ]), DAY, MONTH, SAMPLE_MAX_AGE_MS + 50_000)
    // 50→45 记 5；45→95 是充值重置不记；95→90 记 5：合计 10。
    expect(spend.total).toBeCloseTo(10)
  })

  it('returns an empty spend for an empty series', () => {
    expect(actualSpendOf(ledgerOf([]), DAY, MONTH, 2_000)).toEqual({ today: 0, month: 0, total: 0, byDay: {}, lastSampleAt: 0 })
  })
})

describe('actualRowsOf', () => {
  it('returns one row per provider sorted by provider id and prunes expired series', () => {
    const now = SAMPLE_MAX_AGE_MS * 2
    const ledger = emptyActualLedger()
    foldActualSample(ledger, { provider: 'zhipu', displayName: '智谱', currency: 'CNY', totalBalance: 100 }, now - 3_000)
    foldActualSample(ledger, { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: 100 }, now - 3_000)
    foldActualSample(ledger, { provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', totalBalance: 95 }, now - 2_000)
    // 完全过期的来源：行不返回，序列从账本剔除。
    foldActualSample(ledger, { provider: 'stale', displayName: 'Stale', currency: 'CNY', totalBalance: 10 }, now - SAMPLE_MAX_AGE_MS - 10_000)
    const rows = actualRowsOf(ledger, DAY, MONTH, now)
    expect(rows.map(row => row.provider)).toEqual(['deepseek', 'zhipu'])
    expect(rows[0]).toMatchObject({ provider: 'deepseek', displayName: 'DeepSeek', currency: 'CNY', today: 0, month: 0, total: 5, lastSampleAt: now - 2_000 })
    expect(ledger.providers['stale']).toBeUndefined()
    expect(ledger.providers['deepseek']).toBeDefined()
  })
})

/** 本地时区当日零点的 epoch ms（构造跨日/跨月采样的锚点）。 */
function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d).getTime()
}
