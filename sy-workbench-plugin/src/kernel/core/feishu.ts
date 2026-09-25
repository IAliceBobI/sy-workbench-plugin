// 飞书日历同步·纯逻辑层（提案=docs/checkpoints/2026-09-10-feishu-calendar-auth-proposal.md 09-11 节）。
// 零 siyuan/网络依赖：配置校验/脱敏、事件载荷、同步决策、时间换算、错误解析。
// 网络与存储副作用在 kernel/feishu.ts 客户端层；core 只做可单测的决策。

export const FEISHU_BASE = "https://open.feishu.cn/open-apis";
export const DEFAULT_CALENDAR_NAME = "思源任务";

/** 观测指纹（calauth 09-16）：FNV-1a 32bit → 8 hex。只进 Loki 打点行区分「哪一版 token/哪个
 *  code」，绝不推本体——port=unknown 掩掉实例分流键后，指纹=双实例分吃同一条 refresh 链的判别器 */
export function fp8(s: string | undefined | null): string {
    if (!s) return "-";
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}
/** 全天日程提醒值——⚠️dev 实测（09-11）：应用身份建全天日程时 reminders 被飞书整体静默丢弃（正负值同弃），
 *  仅 timed 日程落盘；且 reminders=按调用身份生效字段（A′=bot 自己的提醒，用户收到的走其客户端默认日程提醒，
 *  B/OAuth 通道才真正以用户身份生效）。保留发送=无害且 B 通道直接受益。 */
export const ALL_DAY_REMINDER_MINUTES = -540;
/** 提醒 minutes 合法域（官方文档：-20160~20160） */
export const REMINDER_MINUTES_MAX = 20160;
/** timed 事件时长：截止语义=提醒锚点，非会议时长 */
export const EVENT_DURATION_MINUTES = 30;
/** Asia/Shanghai 常年 UTC+8 无夏令时（1991 后）——时间换算显式锚死，禁依赖宿主时区 */
const TZ_OFFSET = "+08:00";
const SUMMARY_MAX = 100;

export interface FeishuOAuthState {
    accessToken: string;
    refreshToken: string;
    /** epoch ms，过期前刷新 */
    expiresAt: number;
}

export interface FeishuConfig {
    channel: "bot" | "oauth";
    appId: string;
    /** bot 通道=应用凭证；oauth 通道=换取 code 用（app 层凭证仍要） */
    appSecret: string;
    /** bot 通道必填：ACL writer 成员+参会人（open_id 以插件所用应用视角为准，跨应用不通用） */
    userOpenId?: string;
    calendarName: string;
    /** 懒解析回填：首用/建日历时写入 */
    calendarId?: string;
    /** timed 事件提前 N 分钟提醒 */
    reminderMinutes: number;
    enabled: boolean;
    oauth?: FeishuOAuthState;
    lastProbe?: { at: string; ok: boolean; step?: string; detail?: string };
}

export function normalizeConfig(input: any): FeishuConfig {
    const channel = input?.channel ?? "bot";
    if (channel !== "bot" && channel !== "oauth") throw new Error(`channel 只能是 bot/oauth: ${channel}`);
    const appId = typeof input?.appId === "string" ? input.appId.trim() : "";
    if (!appId) throw new Error("appId 必填（飞书开放平台应用的 App ID）");
    const appSecret = typeof input?.appSecret === "string" ? input.appSecret.trim() : "";
    if (!appSecret) throw new Error("appSecret 必填");
    const userOpenId = typeof input?.userOpenId === "string" && input.userOpenId.trim() ? input.userOpenId.trim() : undefined;
    if (channel === "bot" && !userOpenId) {
        throw new Error("bot 通道必填 userOpenId（你的飞书 open_id——共享日历靠它挂到你名下，缺了日历建了你永远看不到）");
    }
    let reminderMinutes = typeof input?.reminderMinutes === "number" ? input.reminderMinutes : 0;
    if (!Number.isInteger(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > REMINDER_MINUTES_MAX) {
        throw new Error(`reminderMinutes 须为 0~${REMINDER_MINUTES_MAX} 整数（0=到点提醒）: ${reminderMinutes}`);
    }
    let oauth: FeishuOAuthState | undefined;
    if (channel === "oauth") {
        const o = input?.oauth;
        if (!o?.accessToken || !o?.refreshToken || typeof o?.expiresAt !== "number") {
            throw new Error("oauth 通道须带完整 token 状态（accessToken/refreshToken/expiresAt）——先走 calendar.oauth_start 拿授权");
        }
        oauth = { accessToken: o.accessToken, refreshToken: o.refreshToken, expiresAt: o.expiresAt };
    }
    return {
        channel,
        appId,
        appSecret,
        userOpenId,
        calendarName: typeof input?.calendarName === "string" && input.calendarName.trim() ? input.calendarName.trim() : DEFAULT_CALENDAR_NAME,
        ...(typeof input?.calendarId === "string" && input.calendarId ? { calendarId: input.calendarId } : {}),
        reminderMinutes,
        enabled: input?.enabled === undefined ? true : Boolean(input.enabled),
        ...(oauth ? { oauth } : {}),
        ...(input?.lastProbe ? { lastProbe: input.lastProbe } : {}),
    };
}

export function maskConfig(cfg: FeishuConfig) {
    return {
        channel: cfg.channel,
        appId: cfg.appId,
        userOpenId: cfg.userOpenId,
        calendarName: cfg.calendarName,
        calendarId: cfg.calendarId,
        reminderMinutes: cfg.reminderMinutes,
        enabled: cfg.enabled,
        hasSecret: cfg.appSecret.length > 0,
        ...(cfg.oauth ? { oauth: { expiresAt: cfg.oauth.expiresAt } } : {}),
        ...(cfg.lastProbe ? { lastProbe: cfg.lastProbe } : {}),
    };
}

export interface SyncTaskInput {
    blockId: string;
    /** 任务标题（容忍带任务标记前缀，入 summary 前剥离）；缺省=时间-only PATCH（update 专用） */
    content?: string;
    dueDate?: string;
    dueTime?: string;
    /** □16 任务时间段：startDate/startTime 齐且早于 due → 事件起止齐（start~due）；
     *  否则镜像仍=due 锚点+默认 30min（旧数据/只填一侧语义不变） */
    startDate?: string;
    startTime?: string;
    done?: boolean;
}

export interface EventPayload {
    summary?: string;
    description?: string;
    start_time: { timestamp?: string; timezone?: string; date?: string };
    end_time: { timestamp?: string; timezone?: string; date?: string };
    reminders: { minutes: number }[];
    vchat: { vc_type: string };
    attendee_ability: string;
    /** □2 重复事件：RFC5545 RRULE 纯串（""=单次；PATCH 带空串清除旧规则——spike 09-14） */
    recurrence?: string;
}

/** 秒级时间戳换算：本地日期+时刻（Asia/Shanghai）→ epoch 秒字符串 */
export function dueToTimeRange(dueDate: string, dueTime: string, durationMinutes = EVENT_DURATION_MINUTES) {
    const start = Math.floor(Date.parse(`${dueDate}T${dueTime}:00${TZ_OFFSET}`) / 1000);
    return { start: String(start), end: String(start + durationMinutes * 60) };
}

/** □16 区间任务判定（单一事实源）：start 侧齐+timed due+start 严格早于 due。
 *  全天 due（无 dueTime）与 start≥due 的脏值均=非区间（镜像走 due 锚点/全天，回写走锚点分支） */
export function isIntervalTask(task: SyncTaskInput): boolean {
    if (!task.startDate || !task.startTime || !task.dueDate || !task.dueTime) return false;
    const startMs = Date.parse(`${task.startDate}T${task.startTime}:00${TZ_OFFSET}`);
    const dueMs = Date.parse(`${task.dueDate}T${task.dueTime}:00${TZ_OFFSET}`);
    return Number.isFinite(startMs) && Number.isFinite(dueMs) && startMs < dueMs;
}

/** timed 事件提醒双发（09-18 拍板）：到点(0)+提前 N——飞书同事件多提醒天然实现强提醒；
 *  N=0（到点提醒配置）→单发不重复。 */
export function dualReminders(n: number): Array<{ minutes: number }> {
    return n > 0 ? [{ minutes: 0 }, { minutes: n }] : [{ minutes: 0 }];
}

/** 事件载荷；无 due/已完成→null。content 为空→省略 summary/description（时间-only PATCH 语义） */
export function buildEventPayload(task: SyncTaskInput, opts: { reminderMinutes?: number }): EventPayload | null {
    if (!task.dueDate || task.done) return null;
    const bare = (task.content ?? "").replace(/^\s*[-*+]\s*\[[ xX]\]\s*/, "").trim();
    const summary = bare.slice(0, SUMMARY_MAX) + (bare.length > SUMMARY_MAX ? "…" : "");
    const hasContent = summary.length > 0;
    const description = `任务: ${summary}\n在思源中打开: siyuan://blocks/${task.blockId}`;
    if (task.dueTime) {
        const t = dueToTimeRange(task.dueDate, task.dueTime);
        // □16 区间：isIntervalTask 同源判定（start 侧齐备且早于 due）→ 事件=任务起止区间
        // （start_time=开始、end_time=截止）；否则维持 due 锚点+默认 30min（旧数据/只填一侧/start≥due/
        // 全天 due 语义不变）。判定提为导出纯函数——writeback 回写分支必须共用同一口径，否则
        // 「有 start 属性但事件非区间」的行会走错回写分支碾掉用户属性（reasoning P0-1）
        let startTs = t.start;
        let endTs = t.end;
        if (isIntervalTask(task)) {
            const startMs = Date.parse(`${task.startDate}T${task.startTime}:00${TZ_OFFSET}`);
            const dueMs = Date.parse(`${task.dueDate}T${task.dueTime}:00${TZ_OFFSET}`);
            startTs = String(Math.floor(startMs / 1000));
            endTs = String(Math.floor(dueMs / 1000));
        }
        return {
            ...(hasContent ? { summary, description } : {}),
            start_time: { timestamp: startTs, timezone: "Asia/Shanghai" },
            end_time: { timestamp: endTs, timezone: "Asia/Shanghai" },
            reminders: dualReminders(opts.reminderMinutes ?? 0),
            vchat: { vc_type: "no_meeting" },
            attendee_ability: "can_see_others",
        };
    }
    return {
        ...(hasContent ? { summary, description } : {}),
        start_time: { date: task.dueDate },
        end_time: { date: task.dueDate },
        reminders: [{ minutes: ALL_DAY_REMINDER_MINUTES }],
        vchat: { vc_type: "no_meeting" },
        attendee_ability: "can_see_others",
    };
}

export type SyncAction = "create" | "update" | "delete" | "none";

export interface SyncMapping {
    eventId: string;
    calendarId?: string;
    syncedAt?: string;
}

/** 同步决策：有 due 未完→create/update（恒 patch 幂等，不 diff 载荷）；无 due/已完→有映射才 delete */
export function decideSyncAction(task: SyncTaskInput, mapping: SyncMapping | undefined): SyncAction {
    const shouldHave = Boolean(task.dueDate) && !task.done;
    if (shouldHave) return mapping ? "update" : "create";
    return mapping ? "delete" : "none";
}

export interface CalendarMap {
    version: 1;
    entries: Record<string, SyncMapping>;
}

export function emptyMap(): CalendarMap {
    return { version: 1, entries: {} };
}

// ── □11 keyed 全天事件（闪卡今日负担 / calendar.upsert 通用原语） ──

/** keyed 全天事件载荷；summary 空=无标题事件拒建（与 syncTask create 守卫同口径）。
 *  recurrence：undefined=不写字段（PATCH 不动旧规则）；""=显式单次（PATCH 清除旧规则）；
 *  非空=FREQ= 开头纯串（无 RRULE: 前缀，带前缀/数组形态飞书 9499 拒——spike 实锤） */
export function buildAllDayEventPayload(summary: string, date: string, description?: string, recurrence?: string): EventPayload {
    const s = summary.trim();
    if (!s) throw new Error("summary 必填（无标题事件拒建）");
    return {
        summary: s.slice(0, SUMMARY_MAX) + (s.length > SUMMARY_MAX ? "…" : ""),
        ...(description && description.trim() ? { description: description.trim() } : {}),
        start_time: { date },
        end_time: { date },
        reminders: [{ minutes: ALL_DAY_REMINDER_MINUTES }],
        vchat: { vc_type: "no_meeting" },
        attendee_ability: "can_see_others",
        ...(recurrence !== undefined ? { recurrence } : {}),
    };
}

export interface UpsertMap {
    version: 1;
    entries: Record<string, SyncMapping>;
}

export function emptyUpsertMap(): UpsertMap {
    return { version: 1, entries: {} };
}

export interface FeishuCallError {
    code: number;
    msg: string;
}

/** 授权类错误码（token 失效族）——重授权可修复，其余错误重授权救不了。
 *  20026=refresh_token 无效（09-14 dev 实测：假 refresh 撞此码）；20064=oauth 授权失效（09-14 主实例实锤）；
 *  9999166x=open platform user access token 失效族。
 *  ⚠️ 99991672=日历权限未开通（自带一键开通深链）不在此列——那是应用配置问题 */
export const AUTH_ERROR_CODES: readonly number[] = [20026, 20064, 99991661, 99991663, 99991668];

export function isAuthErrorCode(code: number): boolean {
    return AUTH_ERROR_CODES.includes(code);
}

/** 授权链接（B 通道）：redirect_uri 须与开放平台「安全设置」登记一致；state 防串话。
 *  纯函数下沉 core（前端 gui/oauth 与 kernel 客户端层共用——前端禁 import kernel/feishu 全链） */
export function buildAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
    const q = `app_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}`
        + `&state=${encodeURIComponent(state)}&scope=${encodeURIComponent("offline_access calendar:calendar")}`;
    return `https://open.feishu.cn/open-apis/authen/v1/authorize?${q}`;
}

/** 飞书错误解析：业务错（HTTP 200 + code!=0）原样透传 msg——99991672 自带一键开通深链，翻译即误导 */
export function parseFeishuError(status: number, body: string): FeishuCallError {
    try {
        const json = JSON.parse(body);
        if (typeof json?.code === "number" && json.code !== 0) {
            return { code: json.code, msg: String(json.msg ?? body) };
        }
    } catch {
        // 非 JSON 落到 HTTP 兜底
    }
    const head = body.slice(0, 200);
    return { code: status, msg: `HTTP ${status}${head ? `: ${head}` : "（空响应体）"}` };
}
