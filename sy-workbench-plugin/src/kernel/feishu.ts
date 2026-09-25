// 飞书客户端层：token 缓存/日历懒初始化/配置体检/任务同步/□3 账本——网络与存储副作用收口于此。
// 决策与载荷在 core/feishu.ts + core/ledger.ts；本模块组合 proxyRequest+storage（单测 mock 边界=api 模块）。
import { proxyRequest, storageGetJson, storagePutJson, storageRemove } from "./api";
import { kernelLog } from "./loki";
import { storagePutJsonVerified } from "./storageVerify";
import {
    FEISHU_BASE,
    buildAuthorizeUrl,
    buildEventPayload,
    decideSyncAction,
    fp8,
    normalizeConfig,
    parseFeishuError,
    type EventPayload,
    type FeishuConfig,
    type SyncMapping,
    type SyncTaskInput,
} from "./core/feishu";
import { isEventGone, migrateLedgerEntries, normalizeLedger, payloadSig, remindersKey, taskKey, type CalendarLedger, type LedgerEntry } from "./core/ledger";

export const FEISHU_CONFIG_KEY = "feishu-config.json";
/** □1/□11 旧映射存储（已废弃）：loadLedger 一次性迁移吸收后删文件 */
const CALENDAR_MAP_KEY = "calendar-map.json";
const UPSERT_MAP_KEY = "calendar-upserts.json";
import { LEDGER_FILE, OAUTH_REDIRECT_URI } from "../shared/channels";
export const LEDGER_KEY = LEDGER_FILE;

const TOKEN_MARGIN_MS = 120_000; // 过期前 2 分钟即判需换
const FEISHU_HEADERS = { "Content-Type": ["application/json; charset=utf-8"] };

export class FeishuApiError extends Error {
    readonly code: number;
    constructor(code: number, msg: string) {
        super(`飞书 ${code}: ${msg}`);
        this.code = code;
    }
}

// ── tenant token（A′ 通道）：模块级缓存，进程生命周期内惰性检查（goja 无 setTimeout） ──

let tenantTokenCache: { appId: string; token: string; expiresAt: number } | null = null;

async function rawPost(path: string, body: any): Promise<any> {
    const resp = await proxyRequest(FEISHU_BASE + path, "POST", body, FEISHU_HEADERS);
    return JSON.parse(resp.body);
}

export async function getTenantToken(appId: string, appSecret: string): Promise<string> {
    if (tenantTokenCache && tenantTokenCache.appId === appId && Date.now() < tenantTokenCache.expiresAt) {
        return tenantTokenCache.token;
    }
    const json = await rawPost("/auth/v3/tenant_access_token/internal", { app_id: appId, app_secret: appSecret });
    if (json.code !== 0 || !json.tenant_access_token) {
        throw new FeishuApiError(json.code ?? -1, String(json.msg ?? "no token in response"));
    }
    tenantTokenCache = {
        appId,
        token: json.tenant_access_token,
        expiresAt: Date.now() + (Number(json.expire) || 7200) * 1000 - TOKEN_MARGIN_MS,
    };
    return json.tenant_access_token;
}

// ── user token（B 通道）：refresh 滚动作废——新 token 对必须先落盘再使用 ──

export interface OAuthTokenPair {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export async function exchangeCode(appId: string, appSecret: string, code: string, redirectUri: string): Promise<OAuthTokenPair> {
    const json = await rawPost("/authen/v2/oauth/token", {
        grant_type: "authorization_code",
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: redirectUri,
    });
    if (json.code !== 0 || !json.access_token || !json.refresh_token) {
        throw new FeishuApiError(json.code ?? -1, String(json.msg ?? "no tokens in response"));
    }
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + (Number(json.expires_in) || 7200) * 1000 - TOKEN_MARGIN_MS,
    };
}

/** 确保 user token 可用；过期则 refresh 并立即持久化新 token 对（旧的已作废，落盘前崩=只能重授）。
 *  □17 起 callers 不再串行（mirror 轮询+翻月 instances rpc 与 remind/writeback 并发）——
 *  refresh_token 单用制：并发双刷必有一方吃 20026 且可能撤销授权。模块级链式互斥+锁内重读
 *  盘上 config（第二个等待者重读后多半已能直接返回，天然覆盖旧「串行方共享内存 cfg」场景）。 */
let refreshChain: Promise<string> | null = null;

export async function ensureUserToken(config: FeishuConfig): Promise<string> {
    if (Date.now() < config.oauth.expiresAt) return config.oauth.accessToken;
    const run = async (): Promise<string> => {
        // 锁内重读：先到者可能已刷新落盘——直接采用，别拿手上的旧 refresh_token 再刷
        const latest = await loadConfig().catch((): FeishuConfig | null => null);
        const oauth = latest?.oauth ?? config.oauth;
        if (Date.now() < oauth.expiresAt) {
            config.oauth = oauth;
            return oauth.accessToken;
        }
        const json = await rawPost("/authen/v2/oauth/token", {
            grant_type: "refresh_token",
            client_id: config.appId,
            client_secret: config.appSecret,
            refresh_token: oauth.refreshToken,
        });
        if (json.code !== 0 || !json.access_token || !json.refresh_token) {
            // calauth □1：refresh 失败是授权链断裂的第一现场（20064/20026 等）——打点留时间线
            kernelLog("calauth", `refresh FAIL code=${json.code ?? -1} msg=${String(json.msg ?? "").slice(0, 120)}`);
            throw new FeishuApiError(json.code ?? -1, String(json.msg ?? "no tokens in response"));
        }
        const next: OAuthTokenPair = {
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            expiresAt: Date.now() + (Number(json.expires_in) || 7200) * 1000 - TOKEN_MARGIN_MS,
        };
        config.oauth = next; // 内存同步：本 cfg 持有者后续调用直接快路径
        await saveConfig({ ...config, oauth: next });
        kernelLog("calauth", `refresh ok expiresAt=${next.expiresAt} rt=${fp8(next.refreshToken)} (was rt=${fp8(oauth.refreshToken)})`);
        return next.accessToken;
    };
    const p = (refreshChain ?? Promise.resolve()).then(run, run);
    refreshChain = p;
    void p.finally(() => {
        if (refreshChain === p) refreshChain = null;
    }).catch(() => { /* 清理链尾吞异常（业务异常已由 p 传播给调用方） */ });
    return p;
}

/** 授权链接（B 通道）：redirect_uri 须与开放平台「安全设置」登记一致；state 防串话。
 *  实现下沉 core/feishu.ts（前端 gui/oauth 共用）；此处 re-export 保旧 import 路径不变 */
export { buildAuthorizeUrl };

// ── 一键重授权（按钮化 c）：code→换证→落盘→体检只报告 ──

export interface OAuthApplyResult {
    ok: boolean;
    error?: string;
    probe?: ProbeResult;
}

/** 前端「重新授权」收 code 后的 kernel 侧处理。换证成功**立即落盘**（与 set_config 的
 *  「体检过才落盘」不同：code 是一次性的，probe 网络抖动失败即浪费一次授权流程——
 *  且新 token 对恒优于已坏的旧 token），runProbe 结果只报告不拦。
 *  仅服务「重新授权」场景（须已有 appId/appSecret 配置）；首次配置仍走 AI 对话 set_config */
export async function applyOAuthCode(code: string, redirectUri: string = OAUTH_REDIRECT_URI): Promise<OAuthApplyResult> {
    const existing = await loadConfig();
    if (!existing?.appId || !existing?.appSecret) {
        return { ok: false, error: "未找到已有飞书配置（appId/appSecret）——首次配置请走设置页「到点提醒」表单" };
    }
    // calauth 09-16：ru+code 指纹+盘上现值——20063（code 无效族）排障三要素（ru 不匹配/
    // code 过期 5min 窗/code 已被消费）与「换证时盘上 token 死活」全在这行可见
    kernelLog("calauth", `apply: ru=${redirectUri} code fp=${fp8(code)} len=${code.length}; disk rt=${fp8(existing.oauth?.refreshToken)} expiresAt=${existing.oauth?.expiresAt ?? "-"}`);
    let oauth: OAuthTokenPair;
    try {
        oauth = await exchangeCode(existing.appId, existing.appSecret, code, redirectUri);
    } catch (e: any) {
        kernelLog("calauth", `apply exchange FAIL (ru=${redirectUri}, code fp=${fp8(code)}): ${String(e?.message ?? e).slice(0, 160)}`);
        return { ok: false, error: `换证失败：${e?.message ?? e}` };
    }
    const candidate = normalizeConfig({ ...existing, channel: "oauth", oauth });
    // calauth □1：落盘失败必须在此拦下（不能带着内存 token 去 probe——probe 过了回 ok
    // 就是 09-14「一点击就通过、盘上纹丝不动」的假绿复发）；saveConfig 内建验真链+兜底
    try {
        await saveConfig(candidate);
    } catch (e: any) {
        return { ok: false, error: `换证成功但落盘失败：${e?.message ?? e}——请重试授权（本次 code 已消耗）` };
    }
    const probe = await runProbe(candidate).catch((e: any): ProbeResult => ({ ok: false, steps: [], failedStep: "probe", detail: String(e?.message ?? e) }));
    if (!probe.ok) {
        kernelLog("calauth", `apply probe FAIL step=${probe.failedStep} detail=${String(probe.detail ?? "").slice(0, 160)}`);
        return { ok: false, error: `授权已保存但体检未过（${probe.failedStep}）：${probe.detail}`, probe };
    }
    // lastProbe 只是展示态遥测，写失败不值得让用户重走授权——best-effort，打点留痕
    try {
        await saveConfig({ ...candidate, lastProbe: { at: new Date().toISOString(), ok: true, step: "all" } });
    } catch (e: any) {
        kernelLog("calauth", `apply lastProbe save FAIL: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    kernelLog("calauth", `apply ok: exchange+save+probe all green (rt=${fp8(oauth.refreshToken)})`);
    return { ok: true, probe };
}

// ── 首次配置纯 UI（calauth □2）：表单攒齐 appId+appSecret+code 一次单写 ──

/** 清除后凭证档案键：token 全弃、appId/appSecret 留档供表单预填（重授权少重填一轮） */
export const FEISHU_CREDS_ARCHIVE_KEY = "feishu-creds-archive.json";

export interface OAuthSetupResult {
    ok: boolean;
    error?: string;
    probe?: ProbeResult;
}

/** 首配表单落点：不要求已有配置（区别于 applyOAuthCode 的重授权场景）；channel 固定 oauth
 *  （用户主日历、提醒真生效——bot 通道留 AI 高级路径不进表单）。攒齐才写：
 *  先 runOAuthFlow 拿 code 再进本函数，中途零 petal 写（防触发前端整重载竞态）。
 *  旧配置的 reminderMinutes 沿用（重配换应用场景），其余回默认。 */
export async function setupOAuthApp(
    appId: string,
    appSecret: string,
    code: string,
    redirectUri: string = OAUTH_REDIRECT_URI,
): Promise<OAuthSetupResult> {
    const aid = appId.trim();
    const sec = appSecret.trim();
    if (!aid || !sec) return { ok: false, error: "App ID 与 App Secret 都要填" };
    if (!code) return { ok: false, error: "缺少授权码（code）——请先完成浏览器授权" };
    let oauth: OAuthTokenPair;
    try {
        oauth = await exchangeCode(aid, sec, code, redirectUri);
    } catch (e: any) {
        kernelLog("calauth", `setup exchange FAIL (ru=${redirectUri}, code fp=${fp8(code)}): ${String(e?.message ?? e).slice(0, 160)}`);
        return { ok: false, error: `换证失败：${e?.message ?? e}` };
    }
    const previous = await loadConfig().catch((): FeishuConfig | null => null);
    const candidate = normalizeConfig({
        appId: aid,
        appSecret: sec,
        channel: "oauth",
        oauth,
        ...(previous?.reminderMinutes ? { reminderMinutes: previous.reminderMinutes } : {}),
    });
    try {
        await saveConfig(candidate);
    } catch (e: any) {
        return { ok: false, error: `换证成功但落盘失败：${e?.message ?? e}——请重试授权（本次 code 已消耗）` };
    }
    const probe = await runProbe(candidate).catch((e: any): ProbeResult => ({ ok: false, steps: [], failedStep: "probe", detail: String(e?.message ?? e) }));
    if (!probe.ok) {
        kernelLog("calauth", `setup probe FAIL step=${probe.failedStep} detail=${String(probe.detail ?? "").slice(0, 160)}`);
        return { ok: false, error: `授权已保存但体检未过（${probe.failedStep}）：${probe.detail}`, probe };
    }
    try {
        await saveConfig({ ...candidate, lastProbe: { at: new Date().toISOString(), ok: true, step: "all" } });
    } catch (e: any) {
        kernelLog("calauth", `setup lastProbe save FAIL: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    kernelLog("calauth", `setup ok: exchange+save+probe all green (rt=${fp8(oauth.refreshToken)})`);
    return { ok: true, probe };
}

/** 清除配置：删整份 feishu-config.json（token/日历绑定全弃）+ 凭证留档（appId/appSecret
 *  供表单预填，回执带回供就地预填）。raw 读不走 normalize——损坏/残档配置（恰恰是
 *  最需要清除的态）也能清。账本不动（事件映射是历史记录，重配后继续沿用）。 */
export async function clearFeishuConfig(): Promise<{ ok: boolean; error?: string; creds?: { appId: string; appSecret: string } }> {
    const raw = await storageGetJson<any>(FEISHU_CONFIG_KEY).catch((): any => null);
    if (!raw) return { ok: true }; // 已是未配置态=目标态达成
    let creds: { appId: string; appSecret: string } | undefined;
    try {
        const aid = typeof raw?.appId === "string" ? raw.appId.trim() : "";
        const sec = typeof raw?.appSecret === "string" ? raw.appSecret.trim() : "";
        if (aid && sec) {
            creds = { appId: aid, appSecret: sec };
            await storagePutJson(FEISHU_CREDS_ARCHIVE_KEY, creds);
        }
        await storageRemove(FEISHU_CONFIG_KEY);
    } catch (e: any) {
        kernelLog("calauth", `clear FAIL: ${String(e?.message ?? e).slice(0, 160)}`);
        return { ok: false, error: `清除失败：${e?.message ?? e}` };
    }
    // 清除后复核读：文件真没了才算成（同 □1 验真纪律——storageRemove 同属静默失败家族）
    const after = await storageGetJson<any>(FEISHU_CONFIG_KEY).catch(() => null);
    if (after) {
        kernelLog("calauth", "clear VERIFY FAIL: config still readable after remove");
        return { ok: false, error: "清除后配置仍在（写入通道异常）——请重启思源后再试或反馈" };
    }
    kernelLog("calauth", "clear ok: config removed");
    return { ok: true, ...(creds ? { creds } : {}) };
}

// ── 通用调用 ──

async function getTokenFor(config: FeishuConfig): Promise<string> {
    return config.channel === "oauth" ? ensureUserToken(config) : getTenantToken(config.appId, config.appSecret);
}

/** 飞书 API 调用：Bearer 头 + 业务 code!=0/HTTP 非 2xx → FeishuApiError（msg 原样透传） */
export async function callFeishu(config: FeishuConfig, method: string, path: string, body?: any): Promise<any> {
    const token = await getTokenFor(config);
    return callFeishuWithToken(token, method, path, body);
}

/** 应用（bot）身份调用——H4 测试消息面：发消息/加急须同一 bot 身份（加急只能加急自己发的
 *  消息），与 oauth 用户身份的日历通道并存；鉴权/错误语义与 callFeishu 完全一致 */
export async function callFeishuAsApp(config: FeishuConfig, method: string, path: string, body?: any): Promise<any> {
    const token = await getTenantToken(config.appId, config.appSecret);
    return callFeishuWithToken(token, method, path, body);
}

async function callFeishuWithToken(token: string, method: string, path: string, body?: any): Promise<any> {
    const resp = await proxyRequest(FEISHU_BASE + path, method, body, {
        ...FEISHU_HEADERS,
        Authorization: [`Bearer ${token}`],
    });
    let json: any;
    try {
        json = JSON.parse(resp.body);
    } catch {
        throw new FeishuApiError(resp.status, `HTTP ${resp.status} 非 JSON 响应: ${resp.body.slice(0, 120)}`);
    }
    if (!resp.ok) {
        const e = parseFeishuError(resp.status, resp.body);
        throw new FeishuApiError(e.code, e.msg);
    }
    if (json.code !== 0) {
        throw new FeishuApiError(json.code, String(json.msg ?? resp.body.slice(0, 200)));
    }
    return json.data;
}

// ── 存取 ──

export async function loadConfig(): Promise<FeishuConfig | null> {
    const raw = await storageGetJson<any>(FEISHU_CONFIG_KEY);
    if (!raw) return null;
    try {
        return normalizeConfig(raw);
    } catch (e: any) {
        throw new Error(`feishu-config.json 损坏（${e.message}）——用 calendar.set_config 重写即可`);
    }
}

/** 关键配置写（calauth □1 验真链：读回比对+重试+putFile 兜底，全败 throw）。
 *  仅 oauth 配置走此通道——token 对丢了不可再生；账本/状态自愈型写入仍走裸 put。 */
export async function saveConfig(config: FeishuConfig): Promise<void> {
    await storagePutJsonVerified(FEISHU_CONFIG_KEY, config);
}

// ── □3 账本（三源统一映射存储：remind:<id> / task:<id> / flashcard-burden:…） ──

export async function loadLedger(): Promise<CalendarLedger> {
    const raw = await storageGetJson<any>(LEDGER_KEY);
    if (raw?.entries) return normalizeLedger(raw);
    // 一次性迁移：旧双 map（upsert 键原样+calendar-map 裸 blockId 加 task: 前缀）吸收进账本后删旧文件
    const oldUpsert = await storageGetJson<{ entries?: Record<string, SyncMapping> }>(UPSERT_MAP_KEY);
    const oldMap = await storageGetJson<{ entries?: Record<string, SyncMapping> }>(CALENDAR_MAP_KEY);
    const entries = migrateLedgerEntries(oldUpsert?.entries, oldMap?.entries);
    if (!Object.keys(entries).length) return normalizeLedger(null);
    const ledger = normalizeLedger({ entries });
    await storagePutJson(LEDGER_KEY, ledger);
    try {
        await storageRemove(UPSERT_MAP_KEY);
        await storageRemove(CALENDAR_MAP_KEY);
    } catch {
        // 删旧文件失败无害（下次 loadLedger 已有 entries 短路，不再读旧文件）
    }
    return ledger;
}

export async function saveLedger(ledger: CalendarLedger): Promise<void> {
    await storagePutJson(LEDGER_KEY, ledger);
}

// ── □6a 账本写串行队列：并发交错丢键根治 ──
// 前端 hourlyTimer 并行触发 remind-sync / mirror-poll(+adopt+writeback) / weather-sync 三链，
// 各写点「loadLedger→(网络往返)→saveLedger 整文件」在 goja await 交错下互相覆盖——后写者
// 旧快照抹掉前写者的键变更（09-19 主实例实锤：weather: 键丢→00:36~03:37 四连 create 事件；
// adopt: 绑定丢→每小时重落 3~4 天气块，09-19/09-20 日记各积 22/18 块）。所有改账本的
// 读-改-写序列进同一条模块级队列串行执行，交错窗口归零。
// ⚠队列内禁止再调进队函数（嵌套=死锁）；纯读 loadLedger 不进队列（读到旧值无害，写时收敛）。
let ledgerWriteQueue: Promise<unknown> = Promise.resolve();

export function enqueueLedgerWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = ledgerWriteQueue.then(op, op); // 前序失败不连坐
    ledgerWriteQueue = run.then(() => undefined, () => undefined);
    return run;
}

/** 键级合并写（□6a）：队列内 load→只动目标键→save。供剪枝/绑定/快照刷新等不走事件
 *  API 的账本维护——任何写者不再覆盖他人键变更 */
export async function mutateLedgerKeys<T>(fn: (entries: Record<string, LedgerEntry>) => T | Promise<T>): Promise<T> {
    return enqueueLedgerWrite(async () => {
        const ledger = await loadLedger();
        const r = await fn(ledger.entries);
        await saveLedger(ledger);
        return r;
    });
}

// ── 日历懒初始化（A′：共享日历+ACL writer；B：primary 短路） ──

export interface CalendarRef {
    calendarId: string;
    created: boolean;
}

/** calendarId 已配→直信（省一次往返；失效会在首次写事件时报错，unlink+重配即恢复） */
export async function ensureCalendar(config: FeishuConfig): Promise<CalendarRef> {
    if (config.channel === "oauth") return { calendarId: "primary", created: false };
    if (config.calendarId) return { calendarId: config.calendarId, created: false };
    const data = await callFeishu(config, "GET", "/calendar/v4/calendars?page_size=200");
    const items: any[] = data?.items ?? [];
    const hit = items.find((it) => it?.calendar?.summary === config.calendarName);
    if (hit) return { calendarId: hit.calendar.calendar_id, created: false };
    // create 请求体扁平（嵌套 {calendar:{…}} 会被静默忽略——建出空名日历，09-11 实测）；响应才嵌套 data.calendar
    const created = await callFeishu(config, "POST", "/calendar/v4/calendars", {
        summary: config.calendarName,
        description: "思源任务截止提醒（sy-workbench-plugin 自动维护，可整日历删除即停）",
    });
    const calendarId = created?.calendar?.calendar_id;
    if (!calendarId) throw new FeishuApiError(-1, "创建日历成功但响应无 calendar_id");
    if (config.userOpenId) {
        await callFeishu(config, "POST", `/calendar/v4/calendars/${calendarId}/acls?user_id_type=open_id`, {
            role: "writer",
            scope: { type: "user", user_id: config.userOpenId },
        });
    }
    return { calendarId, created: true };
}

// ── 配置即体检（三步：token→list→建删测试事件） ──

export interface ProbeResult {
    ok: boolean;
    steps: { name: string; ok: boolean; detail?: string }[];
    failedStep?: string;
    detail?: string;
    resolvedCalendarId?: string;
    createdCalendar?: boolean;
}

export async function runProbe(config: FeishuConfig): Promise<ProbeResult> {
    const steps: ProbeResult["steps"] = [];
    const step = async (name: string, fn: () => Promise<unknown>) => {
        try {
            await fn();
            steps.push({ name, ok: true });
            return true;
        } catch (e: any) {
            steps.push({ name, ok: false, detail: e?.message ?? String(e) });
            return false;
        }
    };

    if (!(await step("token", () => getTokenFor(config)))) {
        return { ok: false, steps, failedStep: "token", detail: steps[steps.length - 1].detail };
    }
    if (!(await step("list", () => callFeishu(config, "GET", "/calendar/v4/calendars?page_size=200")))) {
        return { ok: false, steps, failedStep: "list", detail: steps[steps.length - 1].detail };
    }
    let ref: CalendarRef | undefined;
    let eventId: string | undefined;
    if (!(await step("event", async () => {
        ref = await ensureCalendar(config);
        const ev = await callFeishu(config, "POST", `/calendar/v4/calendars/${ref!.calendarId}/events`, {
            summary: "【体检】sy-project 连通性测试（稍后自动删除）",
            start_time: { date: "2099-01-01" },
            end_time: { date: "2099-01-01" },
            vchat: { vc_type: "no_meeting" },
        });
        eventId = ev?.event?.event_id;
        if (!eventId) throw new FeishuApiError(-1, "建测试日程成功但响应无 event_id");
        await callFeishu(config, "DELETE", `/calendar/v4/calendars/${ref!.calendarId}/events/${eventId}`);
    }))) {
        return { ok: false, steps, failedStep: "event", detail: steps[steps.length - 1].detail };
    }
    return { ok: true, steps, resolvedCalendarId: ref!.calendarId, createdCalendar: ref!.created };
}

// ── 任务同步（建/改/删事件+参会人+账本维护） ──

export interface SyncResult {
    action: "create" | "update" | "delete" | "none";
    eventId?: string;
    calendarId?: string;
    warning?: string;
}

export async function syncTask(task: SyncTaskInput, config: FeishuConfig): Promise<SyncResult> {
    const ledger = await loadLedger();
    const mapping: LedgerEntry | undefined = ledger.entries[taskKey(task.blockId)];
    const action = decideSyncAction(task, mapping);
    if (action === "none") return { action };

    if (!config.enabled) return { action: "none", warning: "日历同步已停用（enabled=false）" };

    if (action === "delete") {
        try {
            await deleteLedgerEvent(taskKey(task.blockId), config);
            return { action };
        } catch (e: any) {
            // 映射保留（deleteLedgerEvent 严格语义），下轮重试——比旧版「失败也清映射」防复制事件
            return { action, warning: `删事件失败（${e?.message ?? e}）——映射保留，下次同步重试` };
        }
    }

    const payload = buildEventPayload(task, { reminderMinutes: config.reminderMinutes })!;
    if (action === "update") {
        try {
            const r = await patchLedgerEvent(taskKey(task.blockId), payload, config);
            return { action, eventId: r.eventId, calendarId: r.calendarId };
        } catch (e: any) {
            // 资源不在族=条目已清下轮重挂；瞬时失败=条目保留下轮 PATCH 重试（非摘钩，□18 review 后语义收窄）
            return { action, eventId: mapping!.eventId, calendarId: mapping!.calendarId, warning: `改事件失败已跳过（${e?.message ?? e}）——下轮自动重试` };
        }
    }

    // create：无内容=裸标题事件，拒建（索引未就绪的 schedule 补挂走 calendar.sync）
    if (!payload.summary) {
        throw new Error("create 需要任务内容（刚建的块 SQL 索引 3~10s 未就绪？稍后 calendar.sync 补挂）");
    }
    const r = await createLedgerEvent(taskKey(task.blockId), payload, config);
    return { action, eventId: r.eventId, calendarId: r.calendarId, ...(r.warning ? { warning: r.warning } : {}) };
}

// ── □3 账本原语（无脑读写面：决策在调用方 remind/writeback 编排层） ──

/** GET 单事件（回写判据通道）。事件不在→{gone:true}（spike 09-14：飞书已删事件 GET 回
 *  code 0 + status:"cancelled" 墓碑，字段形状完整——先判 gone 再进签名）；
 *  其他错（网络/权限）上抛——调用方跳过该键本轮，防把「拿不到」误判「不在」而重建复制事件 */
export interface FeishuEventRef {
    gone: boolean;
    event?: any;
}

export async function getEvent(config: FeishuConfig, calendarId: string, eventId: string): Promise<FeishuEventRef> {
    const data = await callFeishu(config, "GET", `/calendar/v4/calendars/${calendarId}/events/${eventId}`);
    const ev = data?.event;
    if (isEventGone(ev)) return { gone: true };
    return { gone: false, event: ev ?? {} };
}

export interface LedgerEventResult {
    eventId: string;
    calendarId: string;
    warning?: string;
}

/** 建事件+账本记双向快照（fsSnap=所推载荷签名：spike 实测回显同形态，漂移由下轮 writeback-ack 收敛）。
 *  □6a：整段进账本写队列（POST 前重读条目检查由 upsert 承担；此处只负责建+记键不覆盖他键） */
export function createLedgerEvent(key: string, payload: EventPayload, config: FeishuConfig): Promise<LedgerEventResult> {
    return enqueueLedgerWrite(() => createLedgerEventInner(key, payload, config));
}

async function createLedgerEventInner(key: string, payload: EventPayload, config: FeishuConfig): Promise<LedgerEventResult> {
    const ref = await ensureCalendar(config);
    const ev = await callFeishu(config, "POST", `/calendar/v4/calendars/${ref.calendarId}/events`, payload);
    const eventId = ev?.event?.event_id;
    if (!eventId) throw new FeishuApiError(-1, "建日程成功但响应无 event_id");
    let warning: string | undefined;
    if (config.channel === "bot" && config.userOpenId) {
        try {
            await callFeishu(config, "POST", `/calendar/v4/calendars/${ref.calendarId}/events/${eventId}/attendees?user_id_type=open_id`, {
                attendees: [{ type: "user", is_optional: false, user_id: config.userOpenId }],
            });
        } catch (e: any) {
            warning = `日程已建但参会人邀请失败（${e?.message ?? e}）——检查 userOpenId 是否为该应用视角的 open_id`;
        }
    }
    const sig = payloadSig(payload);
    const ledger = await loadLedger();
    ledger.entries[key] = { eventId, calendarId: ref.calendarId, syncedAt: new Date().toISOString(), sySnap: sig, fsSnap: sig, remindersAt: remindersKey(payload.reminders) };
    await saveLedger(ledger);
    return { eventId, calendarId: ref.calendarId, ...(warning ? { warning } : {}) };
}

/** PATCH 事件+账本快照刷新；countConflict=三态双变裁决（思源赢）时冲突计数++。
 *  PATCH 失败=清条目上抛（自愈：下轮无条目走 create 重建；网络错同代价无数据风险） */
/** 飞书「资源不在」错误码族（官方日历 v4 码表）：事件/日历已不可达=清条目走重建自愈；
 *  限流/网络/鉴权族不在此列=瞬时失败，条目保留下轮重试（□18 review：单 193003 扩五码族） */
export const EVENT_GONE_CODES = new Set([191000, 191003, 193000, 193001, 193003]);

/** □6a：整段进账本写队列（条目检查→PATCH→记键原子化——TOCTOU 收口） */
export function patchLedgerEvent(
    key: string,
    payload: EventPayload,
    config: FeishuConfig,
    opts?: { countConflict?: boolean },
): Promise<LedgerEventResult> {
    return enqueueLedgerWrite(() => patchLedgerEventInner(key, payload, config, opts));
}

async function patchLedgerEventInner(
    key: string,
    payload: EventPayload,
    config: FeishuConfig,
    opts?: { countConflict?: boolean },
): Promise<LedgerEventResult> {
    const ledger = await loadLedger();
    const entry = ledger.entries[key];
    if (!entry) throw new Error(`账本无条目 ${key}（先 create）`);
    const ref = await ensureCalendar(config);
    // 日历指向=账本条目优先（sloop □17：落地外来事件 calendarId=镜像真实历 id——副历事件
    // 须对准所属历 PATCH，恒用 ref（oauth=primary 别名）会跨历 404→清条目→重复建事件；
    // 存量条目 create 时即写 ref.calendarId，行为等价；deleteLedgerEvent 同款口径）
    const calId = entry.calendarId ?? ref.calendarId;
    try {
        await callFeishu(config, "PATCH", `/calendar/v4/calendars/${calId}/events/${entry.eventId}`, payload);
    } catch (e: any) {
        // 资源不在族=清条目下轮重建；瞬时失败（限流/网络/5xx）保留条目下轮重试 PATCH——
        // 无差别清会在事件仍存活时造孤儿+下轮 create 复制（deleteLedgerEvent 同款严格语义，□18 review P1-1）
        if (e instanceof FeishuApiError && EVENT_GONE_CODES.has(e.code)) {
            delete ledger.entries[key];
            await saveLedger(ledger);
        }
        throw e;
    }
    const sig = payloadSig(payload);
    const conflicts = opts?.countConflict ? (entry.conflicts ?? 0) + 1 : entry.conflicts;
    ledger.entries[key] = {
        ...entry,
        syncedAt: new Date().toISOString(),
        sySnap: sig,
        fsSnap: sig,
        remindersAt: remindersKey(payload.reminders),
        ...(conflicts ? { conflicts } : {}),
    };
    await saveLedger(ledger);
    return { eventId: entry.eventId, calendarId: calId };
}

/** 删事件+清条目。严格语义：193003（已删）=目标态达成照清；其他错上抛且**条目保留**
 *  （旧版失败也清映射→事件还在+映射没了→下轮 create 复制事件；剪枝侧须能重试）。
 *  □6a：整段进账本写队列 */
export function deleteLedgerEvent(key: string, config: FeishuConfig): Promise<void> {
    return enqueueLedgerWrite(() => deleteLedgerEventInner(key, config));
}

async function deleteLedgerEventInner(key: string, config: FeishuConfig): Promise<void> {
    const ledger = await loadLedger();
    const entry = ledger.entries[key];
    if (!entry) return;
    try {
        await callFeishu(config, "DELETE", `/calendar/v4/calendars/${entry.calendarId ?? config.calendarId}/events/${entry.eventId}`);
    } catch (e: any) {
        if (e instanceof FeishuApiError && EVENT_GONE_CODES.has(e.code)) {
            // 事件已删/日历已不在（用户手删/日历重建）=目标态已达成（□18 review：单 193003 扩五码族）
        } else {
            throw e;
        }
    }
    delete ledger.entries[key];
    await saveLedger(ledger);
}

// ── □11 keyed 事件 upsert（每日闪卡负担 hook + calendar.upsert 通用原语；□3 起账本背书） ──

/** payload 在→有映射 PATCH（幂等改）/无映射 POST 建（bot 通道+参会人邀请当喊声）；
 *  payload=null→有映射删事件清映射（事件已不在=目标态达成；真失败 warning 容忍、条目留下轮重试）。
 *  □6a：整段进账本写队列（映射检查→分派原子化，同 key 双触发只 create 一个事件） */
export function upsertEventByKey(
    key: string,
    payload: EventPayload | null,
    config: FeishuConfig,
): Promise<{ action: "create" | "update" | "delete" | "none"; eventId?: string; calendarId?: string; warning?: string }> {
    return enqueueLedgerWrite(() => upsertEventByKeyInner(key, payload, config));
}

async function upsertEventByKeyInner(
    key: string,
    payload: EventPayload | null,
    config: FeishuConfig,
): Promise<{ action: "create" | "update" | "delete" | "none"; eventId?: string; calendarId?: string; warning?: string }> {
    const ledger = await loadLedger();
    const mapping = ledger.entries[key];
    if (!mapping && !payload) return { action: "none" };
    if (!config.enabled) return { action: "none", warning: "日历同步已停用（enabled=false）" };

    if (!payload) {
        try {
            await deleteLedgerEventInner(key, config);
            return { action: "delete" };
        } catch (e: any) {
            return { action: "delete", warning: `删事件失败（${e?.message ?? e}）——条目保留，下轮重试` };
        }
    }

    if (mapping) {
        try {
            const r = await patchLedgerEventInner(key, payload, config);
            return { action: "update", eventId: r.eventId, calendarId: r.calendarId };
        } catch (e: any) {
            // 资源不在族=条目已清（patchLedgerEvent 内建），下轮无映射走 create 重建；
            // 瞬时失败=条目保留，下轮 PATCH 重试（□18 review 后语义收窄）
            throw e;
        }
    }

    const r = await createLedgerEventInner(key, payload, config);
    return { action: "create", eventId: r.eventId, calendarId: r.calendarId, ...(r.warning ? { warning: r.warning } : {}) };
}
