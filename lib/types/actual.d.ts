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
import type { ProviderBalance } from './pricing-shared.ts';
/** 一次余额采样：来源 + 时刻 + 余额快照。 */
export interface ActualSample {
    /** 采样时刻（epoch ms）。 */
    at: number;
    /** 总可用余额（积分制来源为积分数量，配 creditUnitPrice 时已折算为 CNY）。 */
    value: number;
    /** 未过期赠金；缺失记 0。 */
    granted: number;
    /** 充值余额；缺失记 0。 */
    topped: number;
    /** 余额币种（CNY / USD / 积分折算后恒为 CNY）。 */
    currency: string;
}
/** 一个来源的采样序列与派生汇总。 */
export interface ActualProviderLedger {
    /** 来源 id（ProviderBalance.provider，如 `deepseek` / `custom:CodeBuddy`）。 */
    provider: string;
    /** 显示名。 */
    displayName: string;
    /** 余额币种（取自最近一次成功采样）。 */
    currency: string;
    /** 采样序列（按时间升序，裁剪后保留最近 MAX_SAMPLES 条）。 */
    samples: ActualSample[];
}
/** 实际消耗账本的持久化文档。 */
export interface ActualLedger {
    version: 1;
    providers: Record<string, ActualProviderLedger>;
}
/** 空账本。 */
export declare function emptyActualLedger(): ActualLedger;
/** 每个 provider 保留的采样上限：10 分钟一次约可用 13 天，超过裁掉最旧的。 */
export declare const MAX_SAMPLES = 2000;
/** 采样过期时限（毫秒）：90 天前的采样不再参与汇总，读取时清理。 */
export declare const SAMPLE_MAX_AGE_MS: number;
/**
 * 把一次余额查询结果吸收进账本。余额不可用（无 totalBalance）时原样返回
 * false（本次无采样）；有值时追加采样并裁剪。
 * @param ledger - 账本（就地修改 providers 条目）。
 * @param balance - 本次余额查询的一行。
 * @param nowMs - 采样时刻（epoch ms）。
 * @returns 是否吸收了本次采样。
 */
export declare function foldActualSample(ledger: ActualLedger, balance: ProviderBalance, nowMs: number): boolean;
/**
 * 一次差值判定的结果：正常消耗 / 基线重置（充值、币种变化、首采）/ 无可比数据。
 */
export type ActualDeltaKind = 'spent' | 'reset' | 'flat';
/**
 * 相邻两次采样的差值判定。导出供测试：纯函数。
 * @param prev - 上一次采样。
 * @param curr - 本次采样。
 * @returns `spent` 携带消耗金额（来源币种）；`reset`/`flat` 消耗为 0。
 */
export declare function actualDeltaOf(prev: ActualSample, curr: ActualSample): {
    kind: ActualDeltaKind;
    spent: number;
};
/** 一个来源的实际消耗汇总（币种原生值，不做跨币种换算）。 */
export interface ActualSpend {
    /** 本地今日的消耗。 */
    today: number;
    /** 本地本月的消耗。 */
    month: number;
    /** 全部保留采样的累计消耗。 */
    total: number;
    /** 按本地日期（YYYY-MM-DD）拆分的消耗，供界面按统计范围聚合。 */
    byDay: Record<string, number>;
    /** 最近一次成功采样的时刻；无采样为 0。 */
    lastSampleAt: number;
}
/** 空汇总。 */
export declare function emptyActualSpend(): ActualSpend;
/**
 * 汇总一个来源的采样序列。差值归属到「观测到下降的那一天/月」的本地时区
 * （采样近似：跨采样间隔的消耗记入后一次采样所在的天）。导出供测试：纯函数。
 * @param entry - 来源的采样序列。
 * @param dayKey - 本地今日键（YYYY-MM-DD，dayStamp 口径）。
 * @param monthKey - 本地本月键（YYYY-MM）。
 * @param nowMs - 当前时刻，用于过期清理（不修改传入序列）。
 */
export declare function actualSpendOf(entry: ActualProviderLedger, dayKey: string, monthKey: string, nowMs: number): ActualSpend;
/** `/api/billing/actual` 的一行：一个来源的实际消耗汇总。 */
export interface ActualSpendRow extends ActualSpend {
    provider: string;
    displayName: string;
    currency: string;
}
/** `/api/billing/actual` 的响应。 */
export interface ActualResponse {
    providers: readonly ActualSpendRow[];
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
export declare function actualRowsOf(ledger: ActualLedger, dayKey: string, monthKey: string, nowMs: number): readonly ActualSpendRow[];
//# sourceMappingURL=actual.d.ts.map