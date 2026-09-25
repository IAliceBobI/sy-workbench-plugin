// remind 块提醒图标注入器（纯 DOM 注入三件套=只读载体+幂等清残留+不碰块内正文）。
// □2 起 map/数据流携带 {at, repeat} 二元组：循环短文字（频次+时刻）+红态触发日口径+任务勾选红态抑制。
// 形态照官方 protyle-attr--name 同构（Title.ts/keydown.ts 先例）；svg use 必须 innerHTML 注入
// （setAttribute 字面冒号名不进命名空间——图标占位不画，坑在案）。
// 生命周期：switch-protyle/loaded-protyle-* → attach（SQL 初扫+DOM 补位，同 protyle 幂等）；
// destroy-protyle → detach；60s tick 重算红态（跨天/跨时刻推进）；面板写属性后 refreshBlock 直刷
// （setBlockAttrs 不广播在案——外部改动等下次 attach 自愈）。
import { ATTR_REMIND_AT, ATTR_REMIND_END, ATTR_REMIND_REPEAT, docRemindSql, formatShortRemind, isDueRemind, repeatParts, type RepeatParts } from "../kernel/core/remind";
import { syncedBlockIdsFromLedger } from "../kernel/core/ledger";
import { feQuery } from "../gui/fe";
import { debugLog } from "../libs/debugLog";
import { closeRemindPanel, openRemindPanel, triggerRemindSync } from "./panel";

const REMIND_CLASS = "protyle-attr--remind";
const DUE_CLASS = "protyle-attr--remind--due";
const SYNC_CLASS = "pj-remind-sync";
const TICK_MS = 60_000;

/** 循环短文字（i18n 在前端拼——core 零依赖只出部件）；缺键回退 zh 母版 */
function composeRepeatShort(parts: RepeatParts | null, t: Record<string, string>): string | null {
    if (!parts) return null;
    const fill = (s: string, k: string, v: string | number) => s.split(`{${k}}`).join(String(v));
    let head: string;
    if (parts.kind === "daily") head = t.remindShortDaily ?? "每天";
    else if (parts.kind === "weekly") {
        const names = (parts.weekdays ?? []).map((d) => t[`remindWd${d}`] ?? "").filter(Boolean);
        head = `${t.remindShortWeekly ?? "每周"}${names.join(t.remindShortWdSep ?? "、")}`;
    } else if (parts.kind === "monthly") head = fill(t.remindShortMonthlyDay ?? "每月{d}日", "d", parts.monthDay ?? 1);
    else head = fill(t.remindShortEveryN ?? "每隔{n}天", "n", parts.interval ?? 1);
    return `${head} ${parts.time}`;
}

/** □16 循环短文字的 end 同日后缀（每天 09:00~10:00；跨零点不拼——锚点可读性优先） */
function endSuffix(end: string | null | undefined, at: string): string {
    if (!end || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end)) return "";
    const [ad] = at.split("T");
    const [ed, et] = end.split("T");
    return ad === ed ? `~${et}` : "";
}

interface Attached {
    rootId: string;
    /** 本文档内带提醒的块：blockId → {at, repeat, end}（repeat ""=单次、end ""=开放时长） */
    map: Map<string, { at: string; repeat: string; end: string }>;
    observer: MutationObserver;
}

/** setBlockAttrs 写属性（data 恒 null 非 failure；写后不广播——调用方自刷 DOM；空串=删键） */
async function writeRemindAttr(blockId: string, at: string | null, repeat: string | null, end: string | null): Promise<void> {
    const token = (window as any).siyuan?.config?.api?.token ?? "";
    const r = await fetch("/api/attr/setBlockAttrs", {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: JSON.stringify({ id: blockId, attrs: { [ATTR_REMIND_AT]: at ?? "", [ATTR_REMIND_REPEAT]: repeat ?? "", [ATTR_REMIND_END]: end ?? "" } }),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(d.msg ?? `setBlockAttrs failed: ${r.status}`);
}

export class RemindInjector {
    private readonly plugin: { i18n: Record<string, string>; kernel?: unknown };
    /** tb2 H2 同步徽标数据通道：账本只读（readPetalJsonViaHttp 绕缓存恒新鲜） */
    private readonly readLedger?: () => Promise<unknown>;
    /** tb2 H2：已同步飞书的块 id 集（账本 remind:/sched: 有 entry）；null=未拉到/坏档=徽标隐藏 */
    private syncedIds: Set<string> | null = null;
    /** protyle.block.rootId → 附件（同文档多 protyle 共享一份 map？不——各自持有，扫描结果相同幂等） */
    private attached = new Map<string, Attached>();
    private tickTimer: ReturnType<typeof setInterval> | null = null;

    constructor(plugin: { i18n: Record<string, string>; kernel?: unknown }, readLedger?: () => Promise<unknown>) {
        this.plugin = plugin;
        this.readLedger = readLedger;
    }

    /** 文档切换/加载/动态补载：初扫+DOM 补位（同 rootId 幂等——只补不重建） */
    attach(protyle: { block?: { rootID?: string }; wysiwyg?: { element?: HTMLElement }; title?: { element?: HTMLElement } }): void {
        const rootId = protyle.block?.rootID;
        const wysiwygEl = protyle.wysiwyg?.element;
        if (!rootId || !wysiwygEl) return;
        let at = this.attached.get(rootId);
        if (at) {
            this.fillMissing(at, wysiwygEl, protyle.title?.element ?? null);
            return;
        }
        at = { rootId, map: new Map(), observer: new MutationObserver(() => this.onDomChange(at!, wysiwygEl, titleEl)) };
        const titleEl = protyle.title?.element ?? null;
        this.attached.set(rootId, at);
        at.observer.observe(wysiwygEl, { childList: true, subtree: true });
        if (titleEl) at.observer.observe(titleEl, { childList: true, subtree: true });
        this.startTick();
        void this.scan(at, wysiwygEl, titleEl);
        void this.refreshSyncState(); // tb2 H2：首挂拉一次账本（后续每轮同步广播驱动）
    }

    /** 文档关闭/销毁：断观察器清记录（DOM 随 protyle 消亡） */
    detach(rootId: string): void {
        const at = this.attached.get(rootId);
        if (!at) return;
        at.observer.disconnect();
        this.attached.delete(rootId);
        if (this.attached.size === 0) this.stopTick();
    }

    destroy(): void {
        closeRemindPanel();
        for (const at of this.attached.values()) at.observer.disconnect();
        this.attached.clear();
        this.stopTick();
    }

    /** 面板保存/删除后的直刷路径：改 map + 改 DOM + 触发 kernel 同步（不经 SQL 立读窗口）。
     *  ⚠全量遍历：面包屑行同 data-node-id 在文档序前面，querySelector 首个命中的可能不是
     *  编辑器真块（AGENTS 在案）——遍历所有宿主，renderOne 对无 attr 行的容器 no-op。
     *  attached 尚空（attach 事件晚于保存——boot 尾段竞态）也要直刷 DOM：写都写了图标该出，
     *  map 缺记由后续 attach 的 scan 补（scan 采 DOM 值防旧值回退） */
    refreshBlock(blockId: string, at: string | null, repeat: string | null, end: string | null = null): void {
        let touched = false;
        for (const rec of this.attached.values()) {
            if (!rec.map.has(blockId) && at === null) continue;
            if (at) rec.map.set(blockId, { at, repeat: repeat ?? "", end: end ?? "" });
            else rec.map.delete(blockId);
            touched = true;
            if (blockId === rec.rootId) {
                const titleAttr = document.querySelector(".protyle-title .protyle-attr");
                if (titleAttr) this.renderInAttr(titleAttr as HTMLElement, blockId, at, repeat, end);
            }
        }
        if (touched || at !== null) {
            for (const host of document.querySelectorAll(`[data-node-id="${blockId}"]`)) {
                this.renderOne(host as HTMLElement, blockId, at, repeat, end);
            }
        }
        triggerRemindSync(this.plugin);
    }

    /** 面板回调：写属性→直刷 DOM→推 kernel。刷 DOM/推同步失败不回滚属性（盘上已是真相，
     *  前端等下次 attach 自愈）——打点留痕防静默吞异常 */
    async saveRemind(blockId: string, at: string, repeat: string | null, end: string | null): Promise<void> {
        await writeRemindAttr(blockId, at, repeat, end);
        try {
            this.refreshBlock(blockId, at, repeat, end);
        } catch (e) {
            debugLog("remind", `!! refreshBlock after save failed: ${String(e)}`);
        }
        debugLog("remind", `saved block=${blockId} at=${at} end=${end ?? "-"} repeat=${repeat ?? "-"}`);
    }

    async deleteRemind(blockId: string): Promise<void> {
        await writeRemindAttr(blockId, null, null, null);
        this.refreshBlock(blockId, null, null, null);
        debugLog("remind", `deleted block=${blockId}`);
    }

    /** 读当前值（入口开面板用；getBlockAttrs 直读不过 SQL——立读窗口坑） */
    async readRemind(blockId: string): Promise<{ at: string; repeat: string }> {
        const token = (window as any).siyuan?.config?.api?.token ?? "";
        const r = await fetch("/api/attr/getBlockAttrs", {
            method: "POST",
            headers: { Authorization: `Token ${token}` },
            body: JSON.stringify({ id: blockId }),
        });
        const d = await r.json();
        if (d.code !== 0) {
            debugLog("remind", `!! readRemind block=${blockId} code=${d.code} msg=${d.msg}`);
            return { at: "", repeat: "" };
        }
        const v = { at: d.data?.[ATTR_REMIND_AT] ?? "", repeat: d.data?.[ATTR_REMIND_REPEAT] ?? "", end: d.data?.[ATTR_REMIND_END] ?? "" };
        debugLog("remind", `readRemind block=${blockId} → ${JSON.stringify(v)}`);
        return v;
    }

    /** 内存 map 查当前值（面板保存/scan 维护的真相；跨所有已 attach 文档） */
    private lookupMap(blockId: string): { at: string; repeat: string; end: string } | null {
        for (const rec of this.attached.values()) {
            const v = rec.map.get(blockId);
            if (v !== undefined) return v;
        }
        return null;
    }

    /** 供入口（图标点击/右键/命令/slash/块柄菜单）打开面板。初值优先内存 map（保存直刷的真相），
     *  兜底 getBlockAttrs——⚠内核 IAL 缓存/BlockTree 竞态下偶发回空 map（e2e 实锤：click 前
     *  undefined、click 后恢复），主路径必须走 map 防「明明有提醒面板却显示默认值」。
     *  ⑥ 起面板视口居中，不再需要锚定元素 */
    openPanelForBlock(blockId: string): void {
        const open = (initial: { at: string; repeat: string; end: string }) => {
            openRemindPanel({
                blockId,
                initial: initial.at,
                initialRepeat: initial.repeat,
                initialEnd: initial.end,
                t: this.plugin.i18n,
                onSaved: (at, repeat, end) => void this.saveRemind(blockId, at, repeat, end),
                onDeleted: () => void this.deleteRemind(blockId),
            });
        };
        const local = this.lookupMap(blockId);
        if (local !== null) {
            open(local);
            return;
        }
        void this.readRemind(blockId).then(open);
    }

    // ── 内部 ──

    private async scan(at: Attached, wysiwygEl: HTMLElement, titleEl: HTMLElement | null): Promise<void> {
        try {
            const rows = await feQuery<{ id: string; at: string; repeat: string | null; end: string | null }>(docRemindSql(at.rootId));
            // 只填 map 中没有的键，且 DOM 已有图标时采 DOM 值（refreshBlock 写的新值）——
            // 两条防线都防「SQL 立读旧值覆盖用户新写入」（e2e 实锤 10-01 顶掉 09-20 的闪回）
            for (const row of rows) {
                if (at.map.has(row.id)) continue;
                const dom = document.querySelector(`[data-node-id="${row.id}"] .${REMIND_CLASS}`) as HTMLElement | null;
                at.map.set(row.id, {
                    at: dom?.dataset.remindAt ?? row.at,
                    repeat: dom?.dataset.remindRepeat ?? row.repeat ?? "",
                    end: dom?.dataset.remindEnd ?? row.end ?? "",
                });
            }
            debugLog("remind", `scan doc=${at.rootId} found=${rows.length}`);
            this.fillMissing(at, wysiwygEl, titleEl);
        } catch (e) {
            debugLog("remind", `!! scan failed doc=${at.rootId}: ${String(e)}`);
        }
    }

    /** 把 map 中尚无 DOM 的块补上（attach 复访/扫描完成/懒加载块刚出现共用）。
     *  只补位不覆盖：existing 存在=已被 refreshBlock/tick 管理的现值 */
    private fillMissing(at: Attached, wysiwygEl: HTMLElement, titleEl: HTMLElement | null): void {
        for (const [blockId, value] of at.map) {
            if (blockId === at.rootId) {
                const titleAttr = titleEl?.querySelector(".protyle-attr") ?? document.querySelector(".protyle-title .protyle-attr");
                if (titleAttr && !titleAttr.querySelector(`:scope > .${REMIND_CLASS}`)) {
                    debugLog("remind", `fillMissing(title) block=${blockId.slice(-6)} at=${value.at} rep=${value.repeat || "-"}`);
                    this.renderInAttr(titleAttr as HTMLElement, blockId, value.at, value.repeat, value.end);
                }
                continue;
            }
            const host = wysiwygEl.querySelector(`[data-node-id="${blockId}"]`);
            if (host && !host.querySelector(`:scope > .protyle-attr .${REMIND_CLASS}`)) {
                debugLog("remind", `fillMissing render block=${blockId.slice(-6)} at=${value.at} rep=${value.repeat || "-"}`);
                this.renderOne(host as HTMLElement, blockId, value.at, value.repeat, value.end);
            }
        }
    }

    /** DOM 变化：新块出现（懒加载/undo 恢复）补位；title attr 行被内核 innerHTML 重写后重注入 */
    private onDomChange(at: Attached, wysiwygEl: HTMLElement, titleEl: HTMLElement | null): void {
        this.fillMissing(at, wysiwygEl, titleEl);
    }

    /** 在块宿主上渲染/更新/移除图标（attr 行=块的直接子 .protyle-attr） */
    private renderOne(host: HTMLElement, blockId: string, at: string | null, repeat: string | null, end: string | null = null): void {
        const attr = host.querySelector(":scope > .protyle-attr");
        if (!attr) return; // 容器形态差异兜底：无 attr 行的块跳过（下次 DOM 变化重试）
        this.renderInAttr(attr as HTMLElement, blockId, at, repeat, end);
    }

    private renderInAttr(attr: HTMLElement, blockId: string, at: string | null, repeat: string | null, end: string | null = null): void {
        const existing = attr.querySelector(`:scope > .${REMIND_CLASS}`);
        if (!at) {
            existing?.remove();
            return;
        }
        const now = new Date();
        if (existing) {
            this.applyState(existing as HTMLElement, at, repeat ?? "", end ?? "", now);
            return;
        }
        // innerHTML 整体注入（svg use 命名空间坑）；at 已过值域正则=安全字符集，escape 双保险
        const el = document.createElement("div");
        el.className = REMIND_CLASS;
        el.innerHTML = `<svg><use xlink:href="#iconClock"></use></svg><span class="pj-remind-at"></span><span class="${SYNC_CLASS}"></span>`;
        this.applyState(el, at, repeat ?? "", end ?? "", now);
        el.dataset.remindBlock = blockId; // tb2 H2：账本重拉后按 id 刷徽标（applySyncBadge 遍历入口）
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.openPanelForBlock(blockId);
        });
        // 插在 refcount 前（官方序：bookmark/name/alias/memo/av → refcount 殿后）
        const refcount = attr.querySelector(":scope > .protyle-attr--refcount");
        attr.insertBefore(el, refcount ?? null);
        this.applySyncBadge(el, blockId);
    }

    /** tb2 H2 同步徽标（bear 反馈批）：重拉账本→刷新所有已注入徽标。kernel 每轮同步完
     *  广播 onCalendarStatus 搭车触发+attach 首挂一次——saveRemind→triggerRemindSync→
     *  同步→广播→徽标翻绿自动闭环；坏档/无通道=保持现状（隐藏态）不误报 */
    async refreshSyncState(): Promise<void> {
        if (!this.readLedger) return;
        try {
            const raw = await this.readLedger();
            this.syncedIds = syncedBlockIdsFromLedger(raw);
            for (const el of document.querySelectorAll(`.${REMIND_CLASS}`)) {
                const id = (el as HTMLElement).dataset.remindBlock;
                if (id) this.applySyncBadge(el as HTMLElement, id);
            }
            debugLog("remind", `sync-badge refreshed ids=${this.syncedIds?.size ?? "null"}`);
        } catch (e) {
            debugLog("remind", `!! refreshSyncState failed: ${String(e)}`);
        }
    }

    /** 徽标三态：syncedIds null=隐藏（未知勿误报）；在集=「已同步」绿；不在=「未同步」灰。
     *  文案/i18n 与时间轴槽徽标同源（schedSyncedShort 族）。写前比较防 observer 乒乓 */
    private applySyncBadge(el: HTMLElement, blockId: string): void {
        const badge = el.querySelector(`:scope > .${SYNC_CLASS}`) as HTMLElement | null;
        if (!badge) return;
        if (this.syncedIds === null) {
            badge.style.display = "none";
            return;
        }
        badge.style.display = "";
        const on = this.syncedIds.has(blockId);
        const text = on ? (this.plugin.i18n.schedSyncedShort ?? "已同步") : (this.plugin.i18n.schedUnsyncedShort ?? "未同步");
        const tip = on ? (this.plugin.i18n.schedSyncedTip ?? "已同步飞书") : (this.plugin.i18n.schedUnsyncedTip ?? "未同步飞书");
        if (badge.textContent !== text) badge.textContent = text;
        if (badge.title !== tip) badge.title = tip;
        badge.classList.toggle(`${SYNC_CLASS}--on`, on);
    }

    /** 更新已注入元素的数据/短文字/红态类（tick 复用同一入口）。
     *  ⚠写前值比较铁律：textContent 同值赋值也替换子 Text=childList mutation，observer 回调
     *  路径（fillMissing→applyState）里写同值=无限乒乓 100%CPU 死循环（09-11 复习界面同款根因）；
     *  dataset/classList 是 attributes/class 域（observer 只监听 childList）无此患 */
    private applyState(el: HTMLElement, at: string, repeat: string, end: string, now: Date): void {
        el.dataset.remindAt = at;
        el.dataset.remindRepeat = repeat;
        if (end) el.dataset.remindEnd = end;
        else delete el.dataset.remindEnd;
        const span = el.querySelector(".pj-remind-at");
        if (span) {
            // □16 同日 end 平铺后缀（单次与循环同规则）；跨日不拼
            const text = repeat
                ? (composeRepeatShort(repeatParts(repeat, at), this.plugin.i18n) ?? formatShortRemind(at, now)) + endSuffix(end, at)
                : formatShortRemind(at, now, end);
            if (span.textContent !== text) span.textContent = text;
        }
        el.classList.toggle(DUE_CLASS, this.isDueFor(el, at, repeat, now));
    }

    /** 红态判定（含任务勾选抑制）：宿主为已勾选任务块→恒不红（与 kernel DONE_RE 同语义——
     *  DOM 侧判 data-subtype="t" 且 data-task 非空格；勾选翻转最长 60s 后由 tick 追平） */
    private isDueFor(el: HTMLElement, at: string, repeat: string, now: Date): boolean {
        const host = el.closest("[data-node-id]");
        if (host?.getAttribute("data-subtype") === "t") {
            const task = host.getAttribute("data-task") ?? " ";
            if (task.trim()) return false;
        }
        return isDueRemind(at, now, repeat || null);
    }

    private startTick(): void {
        if (this.tickTimer) return;
        this.tickTimer = setInterval(() => {
            const now = new Date();
            for (const el of document.querySelectorAll(`.${REMIND_CLASS}`)) {
                const at = (el as HTMLElement).dataset.remindAt;
                if (at) this.applyState(el as HTMLElement, at, (el as HTMLElement).dataset.remindRepeat ?? "", (el as HTMLElement).dataset.remindEnd ?? "", now);
            }
        }, TICK_MS);
    }

    private stopTick(): void {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = null;
    }
}
