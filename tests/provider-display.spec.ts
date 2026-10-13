/**
 * 通道显示名：bySite 桶 key（`site:<origin>` / `direct:<provider>` / `unknown`）
 * → 面板组头的人话名。断言「已知渠道给品牌名、direct 已知路由给品牌名、
 * 未知名裸路由不空白」三条不变量，防止新桶 key 落回裸 id 或 undefined。
 */

import { describe, expect, it } from 'vitest'

import { channelDisplayName, directChannelRoute } from '../src/client/provider-display.ts'

describe('channelDisplayName', () => {
  it('maps known site origins to brand names in both languages', () => {
    expect(channelDisplayName('site:https://api.deepseek.com')).toBe('DeepSeek 官方')
    expect(channelDisplayName('site:https://api.deepseek.com', 'en')).toBe('DeepSeek Official')
    expect(channelDisplayName('site:https://tokenhub.tencentmaas.com')).toBe('腾讯云 TokenHub')
  })

  it('falls back to the host for an unlisted site origin', () => {
    expect(channelDisplayName('site:https://relay.example.com/v1')).toBe('relay.example.com')
  })

  it('homes the built-in official direct route to the official name', () => {
    expect(channelDisplayName('direct:deepseek')).toBe('DeepSeek 官方')
    expect(channelDisplayName('direct:deepseek', 'en')).toBe('DeepSeek Official')
    expect(channelDisplayName('direct:deepseek-official')).toBe('DeepSeek 官方')
  })

  it('names known adapter-plugin routes by brand instead of the bare route id', () => {
    // workbuddy 通道归位 direct:workbuddy 后，组头必须是「直连 · WorkBuddy」，
    // 而不是裸路由名「直连 · workbuddy」或误判成「DeepSeek 官方」。
    expect(channelDisplayName('direct:workbuddy')).toBe('直连 · WorkBuddy')
    expect(channelDisplayName('direct:workbuddy', 'en')).toBe('Direct · WorkBuddy')
    expect(channelDisplayName('direct:workbuddy-ai')).toBe('直连 · WorkBuddy AI')
    expect(channelDisplayName('direct:workbuddy-ai', 'en')).toBe('Direct · WorkBuddy AI')
  })

  it('keeps unlisted direct routes on the raw route name', () => {
    expect(channelDisplayName('direct:tencent')).toBe('直连 · tencent')
    expect(channelDisplayName('direct:tencent', 'en')).toBe('Direct · tencent')
  })

  it('returns undefined for the unknown bucket so the renderer uses its locale copy', () => {
    expect(channelDisplayName('unknown')).toBeUndefined()
  })
})

describe('directChannelRoute', () => {
  it('strips the direct prefix from a bare route display name', () => {
    expect(directChannelRoute('直连 · tencent')).toBe('tencent')
    expect(directChannelRoute('Direct · tencent')).toBe('tencent')
  })

  it('leaves brand names without the direct prefix untouched', () => {
    expect(directChannelRoute('DeepSeek 官方')).toBeUndefined()
    expect(directChannelRoute('直连 · WorkBuddy')).toBe('WorkBuddy')
  })
})

describe('channelDisplayName case handling (nit from PR #90 review)', () => {
  it('maps case variants of a known adapter route to its brand name', () => {
    // 聚合层 isKnownAdapterProvider 大小写不敏感；显示层必须同姿态，
    // 否则会出现「已归位 direct 并按目录价计价，但组头显示裸路由名」的两侧不一致。
    expect(channelDisplayName('direct:WorkBuddy')).toBe('直连 · WorkBuddy')
    expect(channelDisplayName('direct:WORKBUDDY-AI', 'en')).toBe('Direct · WorkBuddy AI')
    expect(channelDisplayName('direct: workbuddy ')).toBe('直连 · WorkBuddy')
  })
})
