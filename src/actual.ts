/**
 * 实际消耗账本：对各余额/积分来源定时采样，取相邻两次采样的余额差值得出
 * 该时段实际花掉的钱（或积分折算）。与理论消耗（token × 官网价）分开记账：
 *
 * - 理论消耗在 aggregate.ts 由会话日志折叠而来，按官方目录价估算；
 * - 实际消耗只看真正发生扣减的账户余额变化，由本文件采样与汇总。
 *
 * 差值语义沿用 reconcile.ts 已验证的规则，推广到全部来源：
 * - 余额下降且无充值 → 差值记为该时段实际消耗；
 * - 分项余额上升（充值/授信）或币种变化 → 旧基准失效，重置不记消耗；
 * - 余额不可用（无 totalBalance）→ 跳过，不打断既有序列。
 *
 * 纯函数与持久化句柄分离：fold / 汇总可独立单测，落盘由 index.ts 注入。
 */

import type { ProviderBalance } from './pricing-shared.ts'

/** 一次余额采样：来源 + 时刻 + 余额快照。 */
export interface ActualSample {
  /** 采样时刻（epoch ms）。 */
  at: number
  /** 总可用余额（积分制来源为积分数量，配 creditUnitPrice 时已折算为 CNY）。 */
  value: number
  /** 未过期赠金；缺失记 0。 */
  granted: number
  /** 充值余额；缺失记 0。 */
  topped: number
  /** 余额币种（CNY / USD / 积分折算后恒为 CNY）。 */
  currency: string
}

/** 一个来源的采样序列与派生汇总。 */
export interface ActualProviderLedger {
  /** 来源 id（ProviderBalance.provider，如 `deepseek` / `custom:CodeBuddy`）。 */
  provider: string
  /** 显示名。 */
  displayName: string
  /** 余额币种（取自最近一次成功采样）。 */
  currency: string
  /** 采样序列（按时间升序，裁剪后保留最近 MAX_SAMPLES 条）。 */
  samples: ActualSample[]
}

/** 实际消耗账本的持久化文档。 */
export interface ActualLedger {
  version: 1
  providers: Record<string, ActualProviderLedger>
}

/** 空账本。 */
export function emptyActualLedger(): ActualLedger {
  return { version: 1, providers: {} }
}

/** 每个 provider 保留的采样上限：10 分钟一次约可用 13 天，超过裁掉最旧的。 */
export const MAX_SAMPLES = 2000

/** 采样过期时限（毫秒）：90 天前的采样不再参与汇总，读取时清理。 */
export const SAMPLE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

/**
 * 把一次余额查询结果吸收进账本。余额不可用（无 totalBalance）时原样返回
 * false（本次无采样）；有值时追加采样并裁剪。
 * @param ledger - 账本（就地修改 providers 条目）。
 * @param balance - 本次余额查询的一行。
 * @param nowMs - 采样时刻（epoch ms）。
 * @returns 是否吸收了本次采样。
 */
export function foldActualSample(ledger: ActualLedger, balance: ProviderBalance, nowMs: number): boolean {
  if (typeof balance.totalBalance !== 'number' || !Number.isFinite(balance.totalBalance)) return false
  if (balance.error !== undefined) return false
  const entry = ledger.providers[balance.provider] ?? {
    provider: balance.provider,
    displayName: balance.displayName,
    currency: balance.currency ?? 'CNY',
    samples: [],
  }
  entry.displayName = balance.displayName
  if (balance.currency !== undefined) entry.currency = balance.currency
  entry.samples.push({
    at: nowMs,
    value: balance.totalBalance,
    granted: typeof balance.grantedBalance === 'number' && Number.isFinite(balance.grantedBalance) ? balance.grantedBalance : 0,
    topped: typeof balance.toppedUpBalance === 'number' && Number.isFinite(balance.toppedUpBalance) ? balance.toppedUpBalance : 0,
    currency: balance.currency ?? 'CNY',
  })
  if (entry.samples.length > MAX_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES)
  ledger.providers[balance.provider] = entry
  return true
}

/**
 * 一次差值判定的结果：正常消耗 / 基线重置（充值、币种变化、首采）/ 无可比数据。
 */
export type ActualDeltaKind = 'spent' | 'reset' | 'flat'

/**
 * 相邻两次采样的差值判定。导出供测试：纯函数。
 * @param prev - 上一次采样。
 * @param curr - 本次采样。
 * @returns `spent` 携带消耗金额（来源币种）；`reset`/`flat` 消耗为 0。
 */
export function actualDeltaOf(prev: ActualSample, curr: ActualSample): { kind: ActualDeltaKind; spent: number } {
  // 币种变化：金额不可比，重置基线。
  if (prev.currency !== curr.currency) return { kind: 'reset', spent: 0 }
  // 充值/授信只会让分项余额增加（消费只会减少）：分项变大则旧基线失效，重置不告警。
  if (curr.granted > prev.granted + 0.009 || curr.topped > prev.topped + 0.009) {
    return { kind: 'reset', spent: 0 }
  }
  const spent = prev.value - curr.value
  // 余额未减少：该时段无消耗（或消耗低于一分钱的量化噪声）。
  if (spent <= 0.009) return { kind: 'flat', spent: 0 }
  return { kind: 'spent', spent }
}

/** 一个来源的实际消耗汇总（币种原生值，不做跨币种换算）。 */
export interface ActualSpend {
  /** 本地今日的消耗。 */
  today: number
  /** 本地本月的消耗。 */
  month: number
  /** 全部保留采样的累计消耗。 */
  total: number
  /** 最近一次成功采样的时刻；无采样为 0。 */
  lastSampleAt: number
}

/** 空汇总。 */
export function emptyActualSpend(): ActualSpend {
  return { today: 0, month: 0, total: 0, lastSampleAt: 0 }
}

/**
 * 汇总一个来源的采样序列。差值归属到「观测到下降的那一天/月」的本地时区
 * （采样近似：跨采样间隔的消耗记入后一次采样所在的天）。导出供测试：纯函数。
 * @param entry - 来源的采样序列。
 * @param dayKey - 本地今日键（YYYY-MM-DD，dayStamp 口径）。
 * @param monthKey - 本地本月键（YYYY-MM）。
 * @param nowMs - 当前时刻，用于过期清理（不修改传入序列）。
 */
export function actualSpendOf(entry: ActualProviderLedger, dayKey: string, monthKey: string, nowMs: number): ActualSpend {
  const spend = emptyActualSpend()
  const samples = entry.samples.filter((sample) => nowMs - sample.at <= SAMPLE_MAX_AGE_MS)
  if (samples.length === 0) return spend
  spend.lastSampleAt = samples[samples.length - 1]?.at ?? 0
  let prev = samples[0] as ActualSample
  // 首采只当基线，从第二次开始判差值。
  for (let i = 1; i < samples.length; i += 1) {
    const curr = samples[i] as ActualSample
    const { kind, spent } = actualDeltaOf(prev, curr)
    prev = curr
    if (kind !== 'spent') continue
    const date = new Date(curr.at)
    const pad = (n: number): string => String(n).padStart(2, '0')
    const sampleDay = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const sampleMonth = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
    spend.total += spent
    if (sampleDay === dayKey) spend.today += spent
    if (sampleMonth === monthKey) spend.month += spent
  }
  return spend
}

/** `/api/billing/actual` 的一行：一个来源的实际消耗汇总。 */
export interface ActualSpendRow extends ActualSpend {
  provider: string
  displayName: string
  currency: string
}

/** `/api/billing/actual` 的响应。 */
export interface ActualResponse {
  providers: readonly ActualSpendRow[]
}

/**
 * 汇总整本账本为响应行（按 provider id 排序，保证展示顺序稳定）。
 * 过期采样在汇总时按 actualSpendOf 的规则被排除；这里同时把被完全过期
 * 清空的序列从账本剔除（调用方负责持久化裁剪后的账本）。
 * @param ledger - 账本。
 * @param dayKey - 本地今日键。
 * @param monthKey - 本地本月键。
 * @param nowMs - 当前时刻。
 */
export function actualRowsOf(ledger: ActualLedger, dayKey: string, monthKey: string, nowMs: number): readonly ActualSpendRow[] {
  const rows: ActualSpendRow[] = []
  for (const key of Object.keys(ledger.providers).sort()) {
    const entry = ledger.providers[key] as ActualProviderLedger
    const spend = actualSpendOf(entry, dayKey, monthKey, nowMs)
    const live = entry.samples.filter((sample) => nowMs - sample.at <= SAMPLE_MAX_AGE_MS)
    if (live.length === 0) {
      delete ledger.providers[key]
      continue
    }
    entry.samples = live
    rows.push({ provider: entry.provider, displayName: entry.displayName, currency: entry.currency, ...spend })
  }
  return rows
}
