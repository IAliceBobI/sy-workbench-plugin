// 日历同步状态·纯逻辑层（按钮化 b/d）：kernel 每轮同步完把轻量状态落 petal calendar-status.json
// + rpc broadcast 前端直刷。零 siyuan/网络依赖（kernel bundle 与前端 bundle 共用同一份源——channels 纪律）。
// skipped 用 reason code 不产文案（i18n 归前端）；lastAuthFailDay 保留史供面板显示，红态判据只看 authErrorCode。
import { getLogicalDay } from "./dates";

export interface CalendarSyncSummary {
    created: number;
    updated: number;
    deleted: number;
    unchanged: number;
    writtenBack: number;
    conflicts: number;
    invalid: number;
}

/** 跳过原因（前端翻译显示）：未配置 / 总开关停 / 提醒源停 */
export type CalendarSkipReason = "not_configured" | "disabled" | "source_disabled";

export interface CalendarStatus {
    version: 1;
    /** 本轮时点（ISO） */
    at: string;
    /** 有=本轮完整跑完的摘要 */
    summary?: CalendarSyncSummary;
    skipped?: CalendarSkipReason;
    /** 本轮撞到的授权类错误码（20064/token 失效族）——驾驶舱红态+通知判据；健康轮清除 */
    authErrorCode?: number;
    /** 最近一次授权失败逻辑日（YYYY-MM-DD）——授权恢复后保留史 */
    lastAuthFailDay?: string;
    /** runRemindSyncGuarded 顶层异常（网络断/内核错）——技术性消息，面板 tooltip 用 */
    error?: string;
}

/** RemindSyncResult（结构兼容即可，零 import 防 kernel/remind 副作用链进前端 bundle）→ 面板摘要 */
export function summaryFromResult(r: {
    created: number;
    updated: number;
    deleted: number;
    unchanged: number;
    writtenBack: number;
    conflicts: number;
    invalid: unknown[];
}): CalendarSyncSummary {
    return {
        created: r.created,
        updated: r.updated,
        deleted: r.deleted,
        unchanged: r.unchanged,
        writtenBack: r.writtenBack,
        conflicts: r.conflicts,
        invalid: r.invalid.length,
    };
}

export function buildCalendarStatus(input: {
    now: Date;
    summary?: CalendarSyncSummary;
    skipped?: CalendarSkipReason;
    authErrorCode?: number;
    error?: string;
    prev?: CalendarStatus | null;
}): CalendarStatus {
    const failedToday = input.authErrorCode !== undefined ? getLogicalDay(input.now) : undefined;
    return {
        version: 1,
        at: input.now.toISOString(),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.skipped ? { skipped: input.skipped } : {}),
        ...(input.authErrorCode !== undefined ? { authErrorCode: input.authErrorCode } : {}),
        ...(failedToday ? { lastAuthFailDay: failedToday } : input.prev?.lastAuthFailDay ? { lastAuthFailDay: input.prev.lastAuthFailDay } : {}),
        ...(input.error ? { error: input.error } : {}),
    };
}
