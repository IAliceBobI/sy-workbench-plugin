// dataview □7：任务块池/日期徽标注入器（reminder/render.ts 同通道同骨架）。
// - 徽标=只读属性的可视化，不新增存储：池/配额=custom-ammo-pool/quota（降级缓存——真相=
//   每日配置文档结构，契约 §3）；日期=custom-task-due-date（参数留属性=真相即属性）；
// - 生命周期同 RemindInjector：switch/loaded-protyle-* → attach（SQL 初扫+DOM 补位，同 rootId
//   幂等只补不重建）；destroy-protyle → detach；无 tick（徽标无红态推进需求）；
// - 点击徽标弹快捷菜单（independent Menu 第三参——单例菜单被同一次 click 冒泡清空坑在案；
//   open 包 setTimeout 防边缘）；动作链：换池=kernel ammo-move-pool（□5 同一写链：行归属
//   +块缓存双写）/配额步进=kernel ammo-set-quota（行在改行文本+块缓存恒写）/日期=前端直写
//   setBlockAttrs（属性写不走 kernel rpc——index.ts writeBlockAttrsDirect 同约）；
//   「更多…」=属性面板 popover（taskPropsPanel——截止日期/时刻+开始日期+标签平铺，
//   保存直写 custom-task-* 键族=serializeTaskDates 单一事实源）；rpc 不可用或
//   拒=前端兜底写块缓存（quickAdd 同语义：缓存先行，行由引擎收口）；
// - svg use 必须 innerHTML 注入（setAttribute 字面冒号名不进命名空间——坑在案）；
// - textContent 写前值比较（observer 回调路径写同值=childList mutation 无限乒乓——render.ts
//   applyState 同铁律）；
// - 池色（dataview □7 外观三件）：徽标按池配色——色值映射 poolColorOf（taskBadgeMenu 纯层，
//   AmmoQuadrantPanel 色单对齐），经元素 CSS 变量桥（--pj-badge-pool / --pj-badge-pool-dark
//   双值同写）供 remind.css 圆点/文字消费，暗色自动切由 CSS 分支换变量引用承担，渲染期不读
//   主题；每日配置行（custom-ammo-task 在=kernel taskRowAttrs 挂的判型键）出只读色点——
//   不接换池菜单（行内 upsert 会按行 id 错插——拖拽语义只在四象限面板）。
import { Menu, showMessage } from "siyuan";
import { feCall, feQuery } from "../gui/fe";
import { taskBadgeSql } from "../gui/queries";
import { stripTaskMark } from "../kernel/core/remind";
import { parseTaskAttrs } from "../kernel/core/schema";
import { getLogicalDay } from "@/kernel/core/dates";
import { debugLog } from "../libs/debugLog";
import { AMMO_MOVE_POOL_METHOD, AMMO_SET_QUOTA_METHOD } from "../shared/channels";
import { badgeViewFromAttrs, buildTaskBadgeMenu, dueBadgeText, poolBadgeText, poolColorOf, taskPropsSaveAttrs, type BadgeAction, type BadgeMenuItem, type BadgeView, type TaskBadgeTexts, type TaskPropsFields } from "../gui/taskBadgeMenu";
import { closeTaskPropsPanel, openTaskPropsPanel } from "./taskPropsPanel";

const POOL_CLASS = "protyle-attr--pjpool";
const DUE_CLASS = "protyle-attr--pjdue";
const TEXT_CLASS = "pj-taskbadge-text";

/** SQL 行（taskBadgeSql 直出——JOIN 天然只取挂了三属性任一的任务块；pool_task 非空=
 *  每日配置行〔kernel taskRowAttrs 判型键 custom-ammo-task，树任务块不挂〕→只读色点） */
interface BadgeRow {
    id: string;
    content?: string | null;
    pool?: string | null;
    quota?: string | null;
    due_date?: string | null;
    pool_task?: string | null;
}

interface Attached {
    rootId: string;
    map: Map<string, { view: BadgeView; name: string; dotOnly: boolean }>;
    observer: MutationObserver;
}

// ── 写链（依赖注入可测：rpc 面+直写面） ──

export interface BadgeActionDeps {
    /** kernel rpc call 面（缺/null=纯前端兜底链）；返回 {ok:false} 或 throw 都走兜底 */
    rpcCall: ((method: string, params: Record<string, unknown>) => Promise<any>) | null;
    /** 前端直写块属性（feCall setBlockAttrs 封装；空串值=删键） */
    writeAttrs: (blockId: string, attrs: Record<string, string>) => Promise<void>;
}

/** rpc 单发守卫：ok=true=kernel 半边已落（块缓存已被 kernel 双写，前端不再补写）；
 *  其余（ok:false/reject/无 rpc 面）=false 走前端兜底 */
async function rpcOk(deps: BadgeActionDeps, method: string, params: Record<string, unknown>): Promise<boolean> {
    if (!deps.rpcCall) return false;
    try {
        const r = await deps.rpcCall(method, params);
        return Boolean(r?.ok);
    } catch {
        return false;
    }
}

/**
 * 徽标菜单动作落盘（纯写链，注入器与单测共用）。返回动作后的徽标视图（refreshBlock 直刷用）。
 * fail-soft 语义：kernel 面（真相半边）能落则落；落不了（今日未配弹药/kernel rpc 不可用）
 * =前端兜底写块缓存（quickAdd 同款「缓存先行」），不 throw 不拦人；兜底也炸才上抛
 * （调用方 toast）。
 */
export async function applyBadgeAction(
    deps: BadgeActionDeps,
    blockId: string,
    name: string,
    cur: BadgeView,
    action: BadgeAction,
    now: Date,
): Promise<BadgeView> {
    const day = getLogicalDay(now);
    if (action.type === "pool") {
        // 换池：kernel moveTaskPool（行寻址 task 优先；行不在=容器尾插 upsert；树块缓存同步）
        const ok = await rpcOk(deps, AMMO_MOVE_POOL_METHOD, { day, task: blockId, name, pool: action.pool });
        if (!ok) await deps.writeAttrs(blockId, { "custom-ammo-pool": action.pool });
        return { ...cur, pool: action.pool };
    }
    if (action.type === "quota") {
        const ok = await rpcOk(deps, AMMO_SET_QUOTA_METHOD, { day, task: blockId, name, quota: action.quota });
        if (!ok) await deps.writeAttrs(blockId, { "custom-ammo-quota": action.quota != null ? String(action.quota) : "" });
        return { ...cur, quota: action.quota };
    }
    // more=纯 UI 面动作（开属性面板——注入器 click 接线处理，不走写链）：纯函数面 no-op
    if (action.type === "more") return cur;
    // 日期：真相即属性，前端直写（无 kernel 半边）；null=清（空串删键）
    await deps.writeAttrs(blockId, { "custom-task-due-date": action.day ?? "" });
    return { ...cur, due: action.day };
}

// ── DOM 渲染（模块级导出=单测 DOM 断言入口） ──

/**
 * 在块属性行渲染/更新/移除两枚徽标（幂等：在则只 applyState，不在则建；null 半边=移除）。
 * 池徽标在日期徽标前（阅读序）；两者都插 refcount 前（官方序：refcount 殿后——render.ts 同款）。
 * click 走 trampoline（listener 创建时绑一次，每次渲染刷新 __pjOpen）——existing 复用路径
 * 的 onOpen 闭包不陈旧；onOpen=null=只读色点（每日配置行：不接换池菜单，data-pj-readonly
 * 挂 CSS 关手型/hover）。
 * 池色经 CSS 变量桥上屏（亮/暗双值同写——remind.css ::before 与 .pj-taskbadge-text 消费，
 * 暗色自动切由 html[data-theme-mode=dark] 分支换变量引用，渲染期不读主题）。
 */
export function renderBadgeInAttr(
    attr: HTMLElement,
    blockId: string,
    view: BadgeView,
    onOpen: ((blockId: string, anchor: HTMLElement) => void) | null,
    now: Date = new Date(),
): void {
    const ensure = (className: string, inner: string): HTMLElement => {
        let el = attr.querySelector(`:scope > .${className}`) as HTMLElement | null;
        if (!el) {
            el = document.createElement("div");
            el.className = className;
            el.innerHTML = inner; // innerHTML 建节点（svg use 命名空间坑——文本徽标无 svg 同通道）
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                (el as any).__pjOpen?.(blockId, el);
            });
            const refcount = attr.querySelector(":scope > .protyle-attr--refcount");
            attr.insertBefore(el, refcount ?? null);
        }
        (el as any).__pjOpen = onOpen;
        return el;
    };
    // 池徽标
    const poolEl = attr.querySelector(`:scope > .${POOL_CLASS}`) as HTMLElement | null;
    if (view.pool) {
        const el = ensure(POOL_CLASS, `<span class="${TEXT_CLASS}"></span>`);
        el.dataset.badgePool = view.pool;
        // 池色变量桥：亮/暗双值同写（poolColorOf=色单映射纯层；非法 pool=badgeViewFromAttrs
        // 已拦，此处兜底删变量回退灰态）
        const light = poolColorOf(view.pool, false);
        const dark = poolColorOf(view.pool, true);
        if (light) el.style.setProperty("--pj-badge-pool", light);
        else el.style.removeProperty("--pj-badge-pool");
        if (dark) el.style.setProperty("--pj-badge-pool-dark", dark);
        else el.style.removeProperty("--pj-badge-pool-dark");
        if (onOpen) delete el.dataset.pjReadonly;
        else el.dataset.pjReadonly = "1";
        if (view.quota != null) el.dataset.badgeQuota = String(view.quota);
        else delete el.dataset.badgeQuota;
        const span = el.querySelector(`.${TEXT_CLASS}`);
        const text = poolBadgeText(view);
        if (span && span.textContent !== text) span.textContent = text; // 写前比较铁律
    } else {
        poolEl?.remove();
    }
    // 日期徽标（iconCalendar——AmmoFloat 同款在用=活内核 sprite 实有）
    const dueEl = attr.querySelector(`:scope > .${DUE_CLASS}`) as HTMLElement | null;
    if (view.due) {
        const el = ensure(DUE_CLASS, `<svg><use xlink:href="#iconCalendar"></use></svg><span class="${TEXT_CLASS}"></span>`);
        el.dataset.badgeDue = view.due;
        const span = el.querySelector(`.${TEXT_CLASS}`);
        const text = dueBadgeText(view.due, now);
        if (span && span.textContent !== text) span.textContent = text;
    } else {
        dueEl?.remove();
    }
}

// ── 注入器 ──

/** i18n 子集取值（缺键回退 zh 母版——composeRepeatShort 同模式） */
function textsOf(i18n: Record<string, string>): TaskBadgeTexts {
    return {
        taskBadgePool: i18n.taskBadgePool ?? "换池",
        taskBadgeQuotaMinus: i18n.taskBadgeQuotaMinus ?? "配额 −15min（→ {to}）",
        taskBadgeQuotaPlus: i18n.taskBadgeQuotaPlus ?? "配额 +15min（→ {to}）",
        taskBadgeQuotaClear: i18n.taskBadgeQuotaClear ?? "清配额",
        taskBadgeDate: i18n.taskBadgeDate ?? "设日期",
        taskBadgeDateToday: i18n.taskBadgeDateToday ?? "今天 {day}",
        taskBadgeDateTomorrow: i18n.taskBadgeDateTomorrow ?? "明天 {day}",
        taskBadgeDateDayAfter: i18n.taskBadgeDateDayAfter ?? "后天 {day}",
        taskBadgeDatePlus7: i18n.taskBadgeDatePlus7 ?? "+7 天 {day}",
        taskBadgeDateClear: i18n.taskBadgeDateClear ?? "清日期",
        taskBadgeMore: i18n.taskBadgeMore ?? "更多…",
    };
}

export class TaskBadgeInjector {
    private readonly plugin: { i18n: Record<string, string>; kernel?: unknown };
    private attached = new Map<string, Attached>();

    constructor(plugin: { i18n: Record<string, string>; kernel?: unknown }) {
        this.plugin = plugin;
    }

    /** 文档切换/加载：初扫+DOM 补位（同 rootId 幂等——只补不重建） */
    attach(protyle: { block?: { rootID?: string }; wysiwyg?: { element?: HTMLElement } }): void {
        const rootId = protyle.block?.rootID;
        const wysiwygEl = protyle.wysiwyg?.element;
        if (!rootId || !wysiwygEl) return;
        let at = this.attached.get(rootId);
        if (at) {
            this.fillMissing(at, wysiwygEl);
            return;
        }
        at = { rootId, map: new Map(), observer: new MutationObserver(() => this.fillMissing(at!, wysiwygEl)) };
        this.attached.set(rootId, at);
        at.observer.observe(wysiwygEl, { childList: true, subtree: true });
        void this.scan(at, wysiwygEl);
    }

    /** 文档关闭/销毁：断观察器清记录（DOM 随 protyle 消亡） */
    detach(rootId: string): void {
        const at = this.attached.get(rootId);
        if (!at) return;
        at.observer.disconnect();
        this.attached.delete(rootId);
    }

    destroy(): void {
        closeTaskPropsPanel();
        for (const at of this.attached.values()) at.observer.disconnect();
        this.attached.clear();
    }

    /** 菜单动作后的直刷：改 map+改 DOM（不经 SQL 立读窗口——render.ts refreshBlock 同款）。
     *  遍历所有宿主（面包屑行同 data-node-id 在文档序前面，querySelector 首个命中未必是
     *  编辑器真块——render.ts 同防） */
    refreshBlock(blockId: string, view: BadgeView): void {
        for (const rec of this.attached.values()) {
            const cur = rec.map.get(blockId);
            if (cur) rec.map.set(blockId, { view, name: cur.name, dotOnly: cur.dotOnly });
        }
        for (const host of document.querySelectorAll(`[data-node-id="${blockId}"]`)) {
            const attr = (host as HTMLElement).querySelector(":scope > .protyle-attr");
            if (attr) renderBadgeInAttr(attr as HTMLElement, blockId, view, this.onOpenOf(blockId));
        }
    }

    /** 徽标点击通道（dotOnly=每日配置行只读色点→null 不接菜单） */
    private onOpenOf(blockId: string): ((id: string, anchor: HTMLElement) => void) | null {
        return this.lookup(blockId)?.dotOnly ? null : (id, anchor) => this.openMenuForBlock(id, anchor);
    }

    /** 点徽标弹快捷菜单（徽标元素必在场——anchor 必有；map 缺记=空视图起步，菜单动作照写） */
    openMenuForBlock(blockId: string, anchor: HTMLElement): void {
        const view = this.lookup(blockId)?.view ?? { pool: null, quota: null, due: null };
        const items = buildTaskBadgeMenu(view, textsOf(this.plugin.i18n), new Date());
        // independent 第三参：非独立菜单挂 window.siyuan.menus.menu 单例，本次 click 冒泡到
        // window 时被全局监听 remove() 清空（d.ts 只声明两参，运行时 3.8 已支持——as any 惯例）
        const menu = new (Menu as any)("pj-task-badge", undefined, true);
        const land = (m: { addItem: (item: Record<string, unknown>) => void }, list: BadgeMenuItem[]): void => {
            for (const it of list) {
                m.addItem({
                    label: it.label,
                    ...(it.current ? { icon: "iconSelect" } : {}),
                    ...(it.submenu
                        ? {
                              submenu: it.submenu.map((sub) => ({
                                  label: sub.label,
                                  ...(sub.current ? { icon: "iconSelect" } : {}),
                                  ...(sub.action ? { click: () => void this.runAction(blockId, sub.action!) } : {}),
                              })),
                          }
                        : {}),
                    // more=UI 面动作开属性面板（非写链）；其余走 runAction 写链
                    ...(it.action
                        ? { click: () => (it.action!.type === "more" ? void this.openPropsForBlock(blockId) : void this.runAction(blockId, it.action!)) }
                        : {}),
                });
            }
        };
        land(menu, items);
        const r = anchor.getBoundingClientRect();
        setTimeout(() => menu.open({ x: Math.max(8, Math.round(r.right)), y: Math.round(r.bottom + 4) }), 0);
    }

    // ── 内部 ──

    private async scan(at: Attached, wysiwygEl: HTMLElement): Promise<void> {
        try {
            const rows = await feQuery<BadgeRow>(taskBadgeSql(at.rootId));
            for (const row of rows) {
                if (!row.id || at.map.has(row.id)) continue;
                const view = badgeViewFromAttrs({
                    "custom-ammo-pool": row.pool ?? "",
                    "custom-ammo-quota": row.quota ?? "",
                    "custom-task-due-date": row.due_date ?? "",
                });
                if (!view) continue; // 挂了属性但值全不过白名单=不渲染（fail-soft，□8 体检面）
                at.map.set(row.id, { view, name: stripTaskMark(row.content ?? ""), dotOnly: Boolean(row.pool_task) });
            }
            debugLog("taskbadge", `scan doc=${at.rootId} found=${rows.length}`);
            this.fillMissing(at, wysiwygEl);
        } catch (e) {
            debugLog("taskbadge", `!! scan failed doc=${at.rootId}: ${String(e)}`);
        }
    }

    /** 把 map 中尚无 DOM 的块补上（attach 复访/扫描完成/懒加载块刚出现共用）；幂等 */
    private fillMissing(at: Attached, wysiwygEl: HTMLElement): void {
        for (const [blockId, rec] of at.map) {
            const host = wysiwygEl.querySelector(`[data-node-id="${blockId}"]`);
            if (!host) continue;
            const attr = (host as HTMLElement).querySelector(":scope > .protyle-attr");
            if (attr) renderBadgeInAttr(attr as HTMLElement, blockId, rec.view, this.onOpenOf(blockId));
        }
    }

    private lookup(blockId: string): { view: BadgeView; name: string; dotOnly: boolean } | null {
        for (const rec of this.attached.values()) {
            const v = rec.map.get(blockId);
            if (v !== undefined) return v;
        }
        return null;
    }

    private deps(): BadgeActionDeps {
        const call = (this.plugin as any).kernel?.rpc?.call;
        return {
            rpcCall: call
                ? (method: string, params: Record<string, unknown>) => Promise.resolve(call[method](params))
                : null,
            writeAttrs: async (id: string, attrs: Record<string, string>) => {
                await feCall("/api/attr/setBlockAttrs", { id, attrs });
            },
        };
    }

    /** 菜单动作执行：写链→直刷 DOM→debugLog；兜底也炸=toast（fail-soft 的可见失败面） */
    private async runAction(blockId: string, action: BadgeAction): Promise<void> {
        const cur = this.lookup(blockId)?.view ?? { pool: null, quota: null, due: null };
        const name = this.lookup(blockId)?.name ?? "";
        try {
            const next = await applyBadgeAction(this.deps(), blockId, name, cur, action, new Date());
            this.refreshBlock(blockId, next);
            debugLog("taskbadge", `action ${JSON.stringify(action)} block=${blockId.slice(-6)} → ${JSON.stringify(next)}`);
        } catch (e) {
            debugLog("taskbadge", `!! action failed block=${blockId}: ${String(e)}`);
            showMessage(String(this.plugin.i18n.taskBadgeWriteFail ?? "参数写入失败"), 3000, "error");
        }
    }

    /** 「更多…」属性面板：读现值（getBlockAttrs IAL 直读——不经 SQL 立读窗口，render.ts
     *  readRemind 同通道）→ 开 popover（预填现值）。读失败=空初值照开（保存全量覆写）。 */
    async openPropsForBlock(blockId: string): Promise<void> {
        let raw: Record<string, string> = {};
        try {
            raw = (await feCall<Record<string, string>>("/api/attr/getBlockAttrs", { id: blockId })) ?? {};
        } catch (e) {
            debugLog("taskbadge", `!! read props failed block=${blockId}: ${String(e)}`);
        }
        const td = parseTaskAttrs(raw);
        openTaskPropsPanel({
            blockId,
            initial: {
                dueDate: td.dueDate ?? "",
                dueTime: td.dueTime ?? "",
                startDate: td.startDate ?? "",
                tagsRaw: (td.tags ?? []).join(","),
            },
            t: this.plugin.i18n,
            onSaved: (fields) => void this.saveProps(blockId, fields),
        });
    }

    /** 面板保存：直写块属性（taskPropsSaveAttrs 键族=serializeTaskDates 单一事实源；date
     *  动作同款前端直写通道）→直刷徽标（面板可改 due=日期徽标显隐/换值；池/配额不经此面） */
    private async saveProps(blockId: string, fields: TaskPropsFields): Promise<void> {
        const cur = this.lookup(blockId)?.view ?? { pool: null, quota: null, due: null };
        try {
            const attrs = taskPropsSaveAttrs(fields);
            if (!attrs) return; // 纯函数拒坏值（面板已就地报错拦截）——防御分支不写盘
            await feCall("/api/attr/setBlockAttrs", { id: blockId, attrs });
            this.refreshBlock(blockId, { ...cur, due: fields.dueDate || null });
            debugLog("taskbadge", `props saved block=${blockId.slice(-6)} → ${JSON.stringify(attrs)}`);
        } catch (e) {
            debugLog("taskbadge", `!! props save failed block=${blockId}: ${String(e)}`);
            showMessage(String(this.plugin.i18n.taskBadgeWriteFail ?? "参数写入失败"), 3000, "error");
        }
    }
}
