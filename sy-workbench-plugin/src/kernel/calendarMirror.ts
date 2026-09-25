// □17 飞书日历回流读链·编排层：轮询全部勾选日历（anchor/page_token→sync_token 增量+墓碑）
// →镜像/元数据内容防抖落盘+实例按需 RPC（instance_view ≤39 天分块+1h 内存缓存）。
// 副作用全走 api/feishu 客户端层（单测 mock 边界）；纯决策在 core/calendarMirror。
// 触发源=kernel onrunning + rpc calendar-mirror-poll（前端 hourlyTimer/设置页勾选保存）。
import { storageGetJson, storagePutJson, petalGetJsonFresh } from "./api";
import { storagePutJsonVerified } from "./storageVerify";
import { kernelLog } from "./loki";
import { callFeishu, FeishuApiError, loadConfig, loadLedger } from "./feishu";
import {
    CALENDAR_MIRROR_CONF_FILE,
    CALENDAR_MIRROR_FILE,
    CALENDAR_MIRROR_META_FILE,
} from "../shared/channels";
import {
    canonicalMirror,
    eventToMirror,
    instanceToRow,
    mergeMirrorBatch,
    mirrorEquals,
    mirrorKey,
    normalizeMeta,
    normalizeMirror,
    resolveChecked,
    windowBounds,
    type CalendarMirror,
    type InstanceRow,
    type MirrorEvent,
} from "./core/calendarMirror";

export interface MirrorLogger {
    info: (msg: string, ...rest: unknown[]) => unknown;
    error: (msg: string, ...rest: unknown[]) => unknown;
}

/** 最近一次成功轮询时刻（epoch ms；null=本会话未跑过）。□7 回流信号新鲜度守卫：
 *  syncedAt 晚于它的账本条目不判漂移——刚推的事件镜像还没见到，判删必假阳。
 *  内存态（petal 不落时间戳=广播承载纪律）；推进条件=全历拉取成功+镜像写验真过
 *  （任一历失败/截断不推进——部分失败的镜像是不完整视图，推进=把自己推的被报成用户改的，review P1-2）。 */
let lastMirrorAt: number | null = null;

export function lastMirrorSuccessAt(): number | null {
    return lastMirrorAt;
}

export interface MirrorPollResult {
    skipped: boolean;
    calendars: number;
    events: number;
    changed: boolean;
    error?: string;
}

/** 单历增量上限页数（250×20=5000 事件/历；超限=数据异常，止损走全量重建语义） */
const MAX_PAGES = 20;

async function listCatalogPage(config: any): Promise<{ id: string; summary: string; description: string; type: string }[]> {
    const out: { id: string; summary: string; description: string; type: string }[] = [];
    // list 端点=已授权应用的日历（user token 实测可为空——授权面≠可见面）
    const data = await callFeishu(config, "GET", "/calendar/v4/calendars?page_size=200");
    for (const it of data?.items ?? []) {
        const c = it?.calendar ?? it;
        const id = typeof c?.calendar_id === "string" ? c.calendar_id : "";
        if (!id) continue;
        out.push({
            id,
            summary: typeof c?.summary === "string" ? c.summary : "",
            description: typeof c?.description === "string" ? c.description : "",
            type: typeof c?.type === "string" ? c.type : "",
        });
    }
    // primary 恒在目录（「以主日历为主」拍板主战场；primary 别名恒可达——烟测实锤 list 可空）
    if (!out.some((c) => c.type === "primary")) {
        const p = await callFeishu(config, "GET", "/calendar/v4/calendars/primary");
        const c = p?.calendar ?? p;
        const id = typeof c?.calendar_id === "string" ? c.calendar_id : "";
        if (id) out.push({
            id,
            summary: typeof c?.summary === "string" ? c.summary : "",
            description: typeof c?.description === "string" ? c.description : "",
            type: "primary",
        });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1)); // 序稳定：与 normalizeMeta 同则，目录比较免序抖动假变化
    return out;
}

/** 单历事件拉取：有游标走 sync_token 增量；无游标首拉 anchor=窗起（now-365d——anchor=now 会
 *  漏掉全部过去事件，今天上午的手建日程都进不了镜像）；游标失效（业务码族——传输错包装的
 *  HTTP 状态码 <1000 重抛，防网络抖动双倍全量）降级 anchor 全量重拉一次。
 *  fullPulled=本轮为 anchor 全量（调用方须按历重建——现存清单无墓碑，删除事件靠重建消除）。 */
async function fetchCalendarEvents(
    config: any, cal: string, syncToken: string, anchorSec: number,
): Promise<{ batch: MirrorEvent[]; tombstones: string[]; token: string; fullPulled: boolean }> {
    const walk = async (tok: string): Promise<{ batch: MirrorEvent[]; tombstones: string[]; token: string; fullPulled: boolean }> => {
        const batch: MirrorEvent[] = [];
        const tombstones: string[] = [];
        let pageToken = "";
        let token = "";
        for (let i = 0; i < MAX_PAGES; i++) {
            // goja 无 URLSearchParams（WHATWG API）——查询串手工拼
            const parts: string[] = ["page_size=250"];
            if (tok && !pageToken) parts.push(`sync_token=${encodeURIComponent(tok)}`);
            else if (!tok && !pageToken) parts.push(`anchor_time=${anchorSec}`);
            if (pageToken) parts.push(`page_token=${encodeURIComponent(pageToken)}`);
            const data = await callFeishu(config, "GET", `/calendar/v4/calendars/${cal}/events?${parts.join("&")}`);
            for (const ev of data?.items ?? []) {
                const id = typeof ev?.event_id === "string" ? ev.event_id : "";
                if (!id) continue;
                if (ev?.status === "cancelled") tombstones.push(mirrorKey(cal, id));
                else {
                    const m = eventToMirror(cal, ev);
                    if (m) batch.push(m);
                }
            }
            token = typeof data?.sync_token === "string" ? data.sync_token : token;
            pageToken = data?.has_more && typeof data?.page_token === "string" ? data.page_token : "";
            if (!pageToken) break;
        }
        if (pageToken) {
            // MAX_PAGES 截断：token 不采纳（中间页 token 采纳=跳过未拉页的数据丢失；旧 token 保留=
            // 下轮照旧截断无进展）——置空让调用方按历重建、下轮全量重拉（止损自愈）
            kernelLog("calmirror", `!! ${cal.slice(0, 12)} 拉取截断于 ${MAX_PAGES} 页（事件量异常？）→下轮全量重建`);
            token = "";
        }
        return { batch, tombstones, token: token || tok, fullPulled: !tok };
    };
    try {
        return await walk(syncToken);
    } catch (e) {
        // 增量游标失效=飞书业务码族（>=1000；HTTP 4xx/5xx 传输错包装的状态码重抛，防网络抖动双倍全量）
        if (syncToken && e instanceof FeishuApiError && e.code >= 1000) {
            kernelLog("calmirror", `sync_token 失效(cal=${cal.slice(0, 12)}) code=${e.code}→全量重拉`);
            return await walk("");
        }
        throw e;
    }
}

export async function runMirrorPoll(logger: MirrorLogger, now: Date = new Date()): Promise<MirrorPollResult> {
    const cfg = await loadConfig();
    if (!cfg || !cfg.enabled || cfg.channel !== "oauth") {
        // 只读回流=oauth 用户 token 能见的全部日历；bot 通道（tenant）只见共享日历，无回流语义
        logger.info(`[calmirror] 跳过（${!cfg ? "未配置" : !cfg.enabled ? "已停用" : "非 oauth 通道"}）`);
        return { skipped: true, calendars: 0, events: 0, changed: false };
    }
    // 勾选清单=前端设置页 saveData 直写（□6 读缓存家族）——fresh 直读，防「勾回主日历但内核
    // 恒用旧清单」→ sched 事件整缺席镜像 → 全条目假报 deleted（review P1-4）
    const conf = await petalGetJsonFresh<{ checked: Record<string, boolean> | null }>(CALENDAR_MIRROR_CONF_FILE);
    const meta = normalizeMeta(await storageGetJson<any>(CALENDAR_MIRROR_META_FILE).catch(() => null));
    const prevMirror = normalizeMirror(await storageGetJson<any>(CALENDAR_MIRROR_FILE).catch(() => null));

    const catalog = await listCatalogPage(cfg);
    const checked = resolveChecked(catalog, conf?.checked ?? null).filter((c) => c.on);
    logger.info(`[calmirror] 目录 ${catalog.length} 历，勾选 ${checked.length}，开始增量拉取`);

    const bounds = windowBounds(now);
    // 首拉 anchor=窗起秒（滚动窗随每轮前移=历史自然滚出；日粒度下与 bounds.start 等价）
    const anchorSec = Math.floor((now.getTime() - 365 * 86_400_000) / 1000);
    // 拷贝+恒盖当日窗（勿复用 prevMirror 对象：清场删除会原地改 prev 判等失效=脏事件永不落盘）；
    // evicted 随镜像对象携带（P1-2：清场记录与镜像同档 verified 写=原子落盘，挂 meta 则裸写
    // 失败后不可再生——下轮清场循环对已清空的镜像无物可记）
    let mirror: CalendarMirror = {
        events: { ...(prevMirror?.events ?? {}) },
        winStart: bounds.start,
        winEnd: bounds.end,
        ...(prevMirror?.evicted ? { evicted: prevMirror.evicted } : {}),
    };
    const nextTokens: Record<string, string> = { ...meta.tokens };
    const checkedIds = new Set(checked.map((c) => c.id));
    let anyCalFailed = false; // review P1-2：任一历失败/截断=本轮镜像不完整，lastMirrorAt 不推进
    for (const c of checked) {
        try {
            const r = await fetchCalendarEvents(cfg, c.id, meta.tokens[c.id] ?? "", anchorSec);
            // anchor 全量=按历重建（现存清单无墓碑——不清旧账则删除事件滞留假在显，review P1-2）
            mirror = r.fullPulled
                ? mergeMirrorBatch(mirror, r.batch, r.tombstones, bounds, [c.id])
                : mergeMirrorBatch(mirror, r.batch, r.tombstones, bounds);
            if (r.token) nextTokens[c.id] = r.token;
            else if (r.fullPulled) {
                delete nextTokens[c.id]; // 截断/无 token=游标不前进，下轮全量重拉
                anyCalFailed = true; // 截断轮数据不全（review P1-2）
            }
        } catch (e: any) {
            anyCalFailed = true;
            logger.error(`[calmirror] ${c.summary || c.id.slice(0, 12)} 拉取失败跳过: ${String(e?.message ?? e).slice(0, 160)}`);
        }
    }
    // 取消勾选的日历清场（合并只增量不清理——不删=事件滞留镜像假在显）；
    // 其游标也弃（下次重新勾选=全量重拉）。
    // 清场事件 id 记入镜像档 evicted（□25 P0-1）：清场不算 anyCalFailed、lastMirrorAt 照推进
    // ——不记则下轮 writeback 把「镜像范围收缩」当「用户删事件」全量误删班表
    let evictedChanged = false;
    const evicted = { ...(mirror.evicted ?? {}) };
    // 镜像档缺失/损坏→全量重建轮（□25 复验 P2-1 残留）：evicted 随档丢失不可重建——把全部
    // sched 账本条目注入 evicted（状态未知一律不判删：域外条目恢复守卫、真删条目走 drift
    // 信号可见由用户在思源侧收敛）。域内条目重拉后 idx hit，注入记录不干扰正常比对。
    if (!prevMirror) {
        try {
            const ledger = await loadLedger();
            for (const [k, e] of Object.entries(ledger.entries)) {
                if (k.startsWith("sched:") && e.eventId && !evicted[e.eventId]) { evicted[e.eventId] = true; evictedChanged = true; }
            }
        } catch {
            // 账本读失败=维持现状（无守卫），兜底③仍在
        }
    }
    for (const key of Object.keys(mirror.events)) {
        const ev = mirror.events[key];
        if (!checkedIds.has(ev.cal)) {
            if (!evicted[ev.id]) { evicted[ev.id] = true; evictedChanged = true; }
            delete mirror.events[key];
        }
    }
    if (evictedChanged) mirror = { ...mirror, evicted };
    for (const id of Object.keys(nextTokens)) {
        if (!checkedIds.has(id)) delete nextTokens[id];
    }

    // 内容防抖落盘（petal 写=前端插件整重载——无变化零写，remind status 同款纪律）。
    // 镜像=verified 写（storage.put 静默失败家族——镜像写丢而 meta 写成=游标越过未合并 delta，
    // 事件静默永久缺席，自愈链断点）；镜像验真失败则 meta 也不写（token 不前进，下轮幂等重拉）
    let changed = false;
    const nextCanonical = canonicalMirror(mirror);
    if (!mirrorEquals(prevMirror, nextCanonical)) {
        try {
            await storagePutJsonVerified(CALENDAR_MIRROR_FILE, nextCanonical);
            changed = true;
        } catch (e: any) {
            logger.error(`[calmirror] 镜像落盘验真失败，本轮游标不前进: ${String(e?.message ?? e).slice(0, 160)}`);
            bustInstanceCache();
            return { skipped: false, calendars: checked.length, events: Object.keys(nextCanonical.events).length, changed: false, error: "mirror write failed" };
        }
    }
    const metaChanged = JSON.stringify(catalog) !== JSON.stringify(meta.catalog)
        || JSON.stringify(nextTokens) !== JSON.stringify(meta.tokens);
    if (metaChanged) {
        await storagePutJson(CALENDAR_MIRROR_META_FILE, { catalog: [...catalog].sort((a, b) => (a.id < b.id ? -1 : 1)), tokens: nextTokens });
    }
    bustInstanceCache();
    // 推进门禁（review P1-2）：验真失败已提前 return；这里再挡部分失败轮（任一历失败/截断）——
    // 不完整镜像若推进时刻，schedDriftSignals 会把自己刚推的态判成「用户改的」假阳
    if (!anyCalFailed) lastMirrorAt = Date.now();
    else logger.info(`[calmirror] 本轮有历失败/截断——回流新鲜度时刻不推进（宁缺勿假）`);
    logger.info(`[calmirror] 完成: 事件 ${Object.keys(nextCanonical.events).length}（${changed ? "镜像已更新" : "无变化"}，${metaChanged ? "元数据已更新" : "元数据无变化"}）`);
    return { skipped: false, calendars: checked.length, events: Object.keys(nextCanonical.events).length, changed };
}

// ── 串行守卫（remind 同款）：goja 无 setTimeout、client.fetch 无超时——hang 死锁强制放行 ──

let inFlight = false;
let inFlightSince = 0;
let pending = false;
const INFLIGHT_DEADLOCK_MS = 10 * 60_000;

export async function runMirrorPollGuarded(logger: MirrorLogger, now: Date = new Date()): Promise<MirrorPollResult | null> {
    if (inFlight && Date.now() - inFlightSince < INFLIGHT_DEADLOCK_MS) {
        pending = true;
        return null;
    }
    inFlight = true;
    inFlightSince = Date.now();
    try {
        let last: MirrorPollResult | null = null;
        do {
            pending = false;
            last = await runMirrorPoll(logger, now);
        } while (pending);
        return last;
    } finally {
        inFlight = false;
    }
}

// ── 实例按需 RPC（instance_view ≤39 天分块+1h 内存缓存；纯读零 petal 写） ──

const INSTANCE_CHUNK_MS = 39 * 86_400_000;
const INSTANCE_TTL_MS = 60 * 60_000;
const instanceCache = new Map<string, { at: number; rows: InstanceRow[] }>();

/** 轮询完成=世界可能变了，实例缓存全弃（窗内旧实例最多残留 1h TTL 双保险） */
export function bustInstanceCache(): void {
    instanceCache.clear();
}

export interface InstancesReply {
    ok: boolean;
    rows?: InstanceRow[];
    error?: string;
}

/** 前端 CALENDAR_INSTANCES_METHOD 入口：[startTs,endTs] 秒 → 勾选日历实例行合集
 *  （跨 >39 天自动分块；cancelled 例外实例原样带回由前端过滤——信息完整优先） */
export async function fetchInstancesRpc(logger: MirrorLogger, startTs: number, endTs: number): Promise<InstancesReply> {
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs || endTs - startTs > 120 * 86_400) {
        return { ok: false, error: "时间窗非法（120 天内）" };
    }
    const cfg = await loadConfig();
    if (!cfg || !cfg.enabled || cfg.channel !== "oauth") return { ok: false, error: "未配置 oauth 通道" };
    const conf = await petalGetJsonFresh<{ checked: Record<string, boolean> | null }>(CALENDAR_MIRROR_CONF_FILE); // 前端 saveData 写（fresh 读同族，review P1-4）
    const meta = normalizeMeta(await storageGetJson<any>(CALENDAR_MIRROR_META_FILE).catch(() => null));
    const checked = resolveChecked(meta.catalog, conf?.checked ?? null).filter((c) => c.on);
    if (!checked.length) return { ok: true, rows: [] };

    const chunks: Array<[number, number]> = [];
    for (let s = startTs * 1000; s < endTs * 1000; s += INSTANCE_CHUNK_MS) {
        chunks.push([Math.floor(s / 1000), Math.floor(Math.min(s + INSTANCE_CHUNK_MS, endTs * 1000) / 1000)]);
    }
    const rows: InstanceRow[] = [];
    const now = Date.now();
    for (const c of checked) {
        for (const [cs, ce] of chunks) {
            const key = `${c.id}#${cs}#${ce}`;
            const hit = instanceCache.get(key);
            if (hit && now - hit.at < INSTANCE_TTL_MS) {
                rows.push(...hit.rows);
                continue;
            }
            try {
                const data = await callFeishu(
                    cfg, "GET",
                    `/calendar/v4/calendars/${c.id}/events/instance_view?start_time=${cs}&end_time=${ce}&page_size=500`,
                );
                const chunkRows = (data?.items ?? []).map(instanceToRow).filter((r: InstanceRow | null): r is InstanceRow => r !== null);
                instanceCache.set(key, { at: now, rows: chunkRows });
                rows.push(...chunkRows);
            } catch (e: any) {
                logger.error(`[calmirror] instance_view ${c.summary || c.id.slice(0, 12)} ${cs}~${ce} 失败: ${String(e?.message ?? e).slice(0, 160)}`);
            }
        }
    }
    return { ok: true, rows };
}
