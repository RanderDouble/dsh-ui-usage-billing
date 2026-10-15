import { applyBuiltinCatalog } from '../src/client/pricing.ts'
import { BUILTIN_MODEL_CATALOG, BUILTIN_MODEL_KEY_ALIASES } from '../src/builtin-catalog.ts'

// 测试套件承担宿主注入角色：目录与别名表在模块加载时全量注入（宿主 activate
// 同一入口），否则聚合/计价消费方读到空目录。
applyBuiltinCatalog(BUILTIN_MODEL_CATALOG, BUILTIN_MODEL_KEY_ALIASES)

/**
 * 映射 Tab（ModelAliasCard）：目标目录 combobox 的输入过滤与键盘选择、自动归一
 * 命中的直显与「自动」标、真正映射不到的「未映射」高亮、渠道组默认展开判定与
 * 折叠开关、组头渠道种类覆盖 POST。
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from './bind-snapshot-selector'
import { UsageBilling, notifiedKeys } from '../src/client/UsageBilling.tsx'
import { createBillingBudgetStore } from '../src/client/budget-store.ts'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  localStorage.clear()
  notifiedKeys.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = (key: string): string => (zh as Record<string, string>)[key] ?? key

/** 探活目录：一条自动归一命中（sn- 前缀剥离 → flash），一条无归宿（未收录）。 */
const PROBE_CATALOG = [
  { id: 'sn-deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash', provider: 'DeepSeek', providerId: 'deepseek' },
  { id: 'space-bunny-free', name: 'Space Bunny', provider: 'Space', providerId: 'space' },
]

/** 统计快照：rawModelsByProvider 里重复探活已给出的 id（并集去重键按站点键 + id）。 */
const STATS = {
  total: { calls: 0, input: 0, output: 0, cacheHit: 0, cacheMiss: 0, cost: 0, reasoning: 0 },
  byModel: {},
  byDay: {},
  byDayModels: {},
  rawModelsByProvider: { deepseek: ['sn-deepseek-v4-1-flash'] },
  updatedAt: 0,
}

/** 捕获所有请求：POST 体供断言。 */
let calls: { url: string; method: string; body: unknown }[] = []

function makeProps(checkModels?: () => Promise<{
  checked: boolean; available: boolean; models: number; failures: number
  okProviders: readonly string[]; badProviders: readonly string[]
  catalog: readonly { id: string; name?: string; provider: string; providerId?: string }[]
}>): ComponentProps<typeof UsageBilling> {
  const budgetStore = createBillingBudgetStore().create()
  return {
    wide: true,
    t,
    checkModels: checkModels ?? (async () => ({
      checked: true, available: true, models: PROBE_CATALOG.length, failures: 0,
      okProviders: ['deepseek', 'space'], badProviders: [], catalog: PROBE_CATALOG,
    })),
    publishCosts: () => {},
    registerOpen: () => () => {},
    renderSlot: () => null,
    useStore: bindSnapshotSelector(budgetStore),
    actions: budgetStore.actions,
  } as unknown as ComponentProps<typeof UsageBilling>
}

/** stub 后端：pricing 文档、别名读写、渠道覆盖读写、其余端点回统计快照。 */
function stubBackend(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
    calls.push({ url, method, body })
    const json = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/api/billing/pricing')) return json({ source: 'builtin' })
    if (url.includes('/api/billing/aliases')) {
      return json(method === 'POST' ? { aliases: (body as { aliases: unknown }).aliases } : { aliases: {} })
    }
    if (url.includes('/api/billing/channels')) {
      return json(method === 'POST' ? { kinds: (body as { kinds: unknown }).kinds } : { kinds: {} })
    }
    return json(STATS)
  }))
}

/** 打开仪表盘并进入映射 Tab。 */
async function openAliasesTab(): Promise<HTMLElement> {
  const { container } = render(<UsageBilling {...makeProps()} />)
  fireEvent.click(container.querySelector('button')!)
  await screen.findByText('使用统计')
  fireEvent.click(await screen.findByTestId('billing-tab-aliases'))
  return screen.findByTestId('billing-tab-panel-aliases')
}

/** 取某渠道组的外层容器（按站点键定位，避开组间排序的影响）。 */
function groupOf(channel: string): HTMLElement {
  const found = screen.getAllByTestId('billing-alias-group')
    .find(group => group.getAttribute('data-channel') === channel)
  if (found === undefined) throw new Error(`channel group not rendered: ${channel}`)
  return found
}

/** 组头（折叠开关）。 */
function headOf(channel: string): HTMLElement {
  const head = groupOf(channel).querySelector('[data-testid="billing-alias-group-head"]')
  if (head === null) throw new Error(`group head missing: ${channel}`)
  return head as HTMLElement
}

function inputOf(channel: string): HTMLInputElement {
  const input = groupOf(channel).querySelector('[data-testid="billing-alias-to"]')
  if (input === null) throw new Error(`combobox input missing: ${channel}`)
  return input as HTMLInputElement
}

function optionValues(): string[] {
  return screen.getAllByTestId('billing-alias-option')
    .map(option => option.getAttribute('data-value') ?? '')
}

describe('model alias card', () => {
  beforeEach(() => {
    calls = []
    stubBackend()
  })

  it('展开含未映射模型的渠道组，收起只有自动命中的渠道组', async () => {
    await openAliasesTab()
    // 探活与真实流量到达后组才渲染。
    await waitFor(() => { expect(groupOf('direct:space')).toBeTruthy() })
    // space 组含无归宿的模型 → 默认展开，行在文档中。
    expect(headOf('direct:space').getAttribute('aria-expanded')).toBe('true')
    expect(groupOf('direct:space').querySelector('[data-testid="billing-alias-row"]')).not.toBeNull()
    // deepseek 组只有自动命中的模型 → 默认收起，行不在文档中。
    expect(headOf('direct:deepseek').getAttribute('aria-expanded')).toBe('false')
    expect(groupOf('direct:deepseek').querySelector('[data-testid="billing-alias-row"]')).toBeNull()
    // 点组头展开：自动命中的行出现，显示归一键与「自动」标。
    fireEvent.click(headOf('direct:deepseek'))
    expect(headOf('direct:deepseek').getAttribute('aria-expanded')).toBe('true')
    const row = groupOf('direct:deepseek').querySelector('[data-testid="billing-alias-row"]')!
    expect((row.querySelector('[data-testid="billing-alias-to"]') as HTMLInputElement).value).toBe('flash')
    expect(row.querySelector('[data-testid="billing-alias-auto"]')?.textContent).toBe(t('modelAliasAuto'))
    expect(row.querySelector('[data-testid="billing-alias-unmatched"]')).toBeNull()
    // 键盘（Enter）收起。
    fireEvent.keyDown(headOf('direct:deepseek'), { key: 'Enter' })
    expect(headOf('direct:deepseek').getAttribute('aria-expanded')).toBe('false')
  })

  it('把无归宿的模型行标为未映射并高亮', async () => {
    await openAliasesTab()
    await waitFor(() => { expect(groupOf('direct:space')).toBeTruthy() })
    const row = groupOf('direct:space').querySelector('[data-testid="billing-alias-row"]')!
    expect(row.querySelector('[data-testid="billing-alias-from"]')?.textContent).toContain('space-bunny-free')
    expect(row.querySelector('[data-testid="billing-alias-unmatched"]')?.textContent).toBe(t('modelAliasUnmapped'))
    expect(row.querySelector('[data-testid="billing-alias-auto"]')).toBeNull()
    expect((row.querySelector('[data-testid="billing-alias-to"]') as HTMLInputElement).value).toBe('')
  })

  it('输入即过滤目录候选，选中写入草稿并在保存时提交该行', async () => {
    await openAliasesTab()
    await waitFor(() => { expect(groupOf('direct:space')).toBeTruthy() })
    const input = inputOf('direct:space')
    fireEvent.change(input, { target: { value: 'qwen' } })
    const values = optionValues()
    expect(values.length).toBeGreaterThan(0)
    expect(values.every(value => value.includes('qwen'))).toBe(true)
    expect(values).not.toContain('flash')
    // 无匹配输入：面板显示「无匹配条目」，无候选可点。
    fireEvent.change(input, { target: { value: 'zzz-no-such-model' } })
    expect(screen.getByTestId('billing-alias-no-match').textContent).toBe(t('modelAliasNoMatch'))
    expect(screen.queryAllByTestId('billing-alias-option')).toHaveLength(0)
    // 回到可匹配输入并点选：mousedown 提交（阻止默认以免输入框先失焦）。
    fireEvent.change(input, { target: { value: 'qwen' } })
    const target = screen.getAllByTestId('billing-alias-option')
      .find(option => option.getAttribute('data-value') === 'qwen-max')!
    fireEvent.mouseDown(target)
    expect(input.value).toBe('qwen-max')
    expect(screen.queryByTestId('billing-alias-options')).toBeNull()
    // 保存：只提交手动改动过的行。
    fireEvent.click(screen.getByTestId('billing-alias-save'))
    await waitFor(() => {
      expect(calls.some(call => call.url.includes('/api/billing/aliases') && call.method === 'POST')).toBe(true)
    })
    const post = calls.find(call => call.url.includes('/api/billing/aliases') && call.method === 'POST')!
    expect(post.body).toEqual({ aliases: { 'space-bunny-free': 'qwen-max' } })
    await waitFor(() => { expect(screen.getByTestId('billing-alias-notice').textContent).toBe(t('modelAliasSaved')) })
  })

  it('键盘在过滤结果中移动并用回车选中，Escape 还原当前值', async () => {
    await openAliasesTab()
    await waitFor(() => { expect(groupOf('direct:space')).toBeTruthy() })
    const input = inputOf('direct:space')
    // 输入中途 Escape：丢弃未提交的输入，回到行当前值（此行无任何映射 → 空串）。
    fireEvent.change(input, { target: { value: 'qwen' } })
    expect(screen.queryByTestId('billing-alias-options')).not.toBeNull()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
    expect(screen.queryByTestId('billing-alias-options')).toBeNull()
    // Escape 只关 combobox 面板：仪表盘本身仍在（Modal 的 document 级 Escape 未被波及）。
    expect(screen.queryByTestId('billing-tab-panel-aliases')).not.toBeNull()
    // 重新输入：向下再向上回到首项，回车把首项写入行草稿。
    fireEvent.change(input, { target: { value: 'qwen' } })
    const first = optionValues()[0]!
    expect(first).toContain('qwen')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe(first)
    expect(screen.queryByTestId('billing-alias-options')).toBeNull()
  })

  it('组头种类按钮写入渠道覆盖表，且不改变折叠状态', async () => {
    await openAliasesTab()
    await waitFor(() => { expect(groupOf('direct:deepseek')).toBeTruthy() })
    const group = groupOf('direct:deepseek')
    const before = headOf('direct:deepseek').getAttribute('aria-expanded')
    // 初次挂载拉取的覆盖表为空：种类按站点键推导（direct 组为直连）。
    expect(group.querySelector('[data-testid="billing-alias-kind-direct"]')?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(group.querySelector('[data-testid="billing-alias-kind-site"]')!)
    expect(headOf('direct:deepseek').getAttribute('aria-expanded')).toBe(before)
    await waitFor(() => {
      expect(calls.some(call => call.url.includes('/api/billing/channels') && call.method === 'POST')).toBe(true)
    })
    const post = calls.find(call => call.url.includes('/api/billing/channels') && call.method === 'POST')!
    expect(post.body).toEqual({ kinds: { 'direct:deepseek': 'site' } })
    expect(group.querySelector('[data-testid="billing-alias-kind-site"]')?.getAttribute('aria-pressed')).toBe('true')
    // 组头徽章随覆盖表更新，且三种种类共用一个分段控件（复用仪表盘既有的段控样式）。
    expect(group.querySelector('[data-testid="billing-alias-kind-badge"]')?.textContent).toBe(t('relayTag'))
    const segmented = group.querySelector('[data-testid="billing-alias-kind-direct"]')?.parentElement
    expect(segmented?.getAttribute('role')).toBe('group')
    expect(segmented?.querySelectorAll('button').length).toBe(3)
  })
})
