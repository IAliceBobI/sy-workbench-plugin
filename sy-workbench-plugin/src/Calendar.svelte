<script lang="ts">
    import { Menu, confirm } from "siyuan";
    // 独立日历页签（calnav □3·bear 拍板只读月历）：42 格月历（周一起）+三源事件条
    // （remind 蓝/task 橙/burden 灰绿全天）+□17 feishu 回流（紫：镜像一次性+instance_view
    // 循环实例，账本分流去重只显飞书原创）。
    // caltab 期：纯月历瘦身——当日详情区整块迁 TimelineTab.svelte（独立「时间线」页签），
    // 本组件只剩月历面：42 格铺满页签高度；单击=仅选中高亮；双击/右键日期格=打开该天
    // 时间线（onOpenTimeline 桥）；右键事件条=三动作（monthEventMenuActions：删除/跳源块/
    // 在时间线中打开）。数据进页签拉一次（通道 Promise.all），翻月=buildMonthModel 纯函数
    // 本地重算不重查（唯实例行=翻月按需 kernel rpc 拉该网格窗，静默到位不阻塞）；now 钉在
    // 加载时点。顶栏保留：翻月/今天/交接会/手动同步/图例/onboarding 状态条。
    import { buildMonthModel, dayConfigCounts, dayConfigRowsSql, type MonthCell, type MonthDuoLive, type MonthDuoPlan, type MonthEvent, type RemindScanRow, type TaskDueRow } from "./gui/queries";
    import { monthEventMenuActions, type MonthMenuAction } from "./gui/dayaxis";
    import { dayAlmanac } from "./lunarInfo";
    import type { InstanceRow } from "./kernel/core/calendarMirror";
    import { handoffDue, type SchedEditOp, type SchedItem, type SchedStore } from "./kernel/core/schedule";
    import { observeDayNum, OBSERVE_TARGET_DAYS, type OnboardStore } from "./kernel/core/onboard";
    import { fmtDuration } from "./kernel/core/ammoPanel";
    import { feQuery } from "./gui/fe";

    let {
        t,
        openBlock,
        openBlockFocused,
        openTimeline,
        deleteForeignEvent,
        deleteBlockEntry,
        schedEdit,
        loadRemindRows,
        loadTaskRows,
        loadLedger,
        loadMirror,
        fetchInstances,
        loadSchedule,
        loadBoardItems,
        onOpenHandoff,
        loadOnboard,
        onOpenOnboard,
        onManualSync,
        loadLedgerEntries,
    }: {
        t: Record<string, string>;
        openBlock: (blockId: string) => void;
        /** 期 2 ⑤+月历右键「跳到源块」（聚焦落块——bear 拍板通道） */
        openBlockFocused?: (blockId: string) => void;
        /** caltab：双击/右键日期格+事件条「在时间线中打开」→ 独立时间线页签（index.ts openTimeline） */
        openTimeline: (day?: string, focusKey?: string) => void;
        /** 月历右键删除：feishu 虚显=删飞书事件 */
        deleteForeignEvent?: (eventId: string) => Promise<{ ok: boolean; error?: string } | null>;
        /** 月历右键删除：remind/task 真块=连块删 */
        deleteBlockEntry?: (blockId: string) => Promise<boolean>;
        /** 月历右键删除：sched 源=移除班表行（remove 通道） */
        schedEdit?: (op: SchedEditOp) => Promise<SchedStore | null>;
        loadRemindRows: () => Promise<RemindScanRow[]>;
        loadTaskRows: () => Promise<TaskDueRow[]>;
        loadLedger: () => Promise<unknown>;
        /** □17 镜像 JSON（petal calendar-mirror.json 只读；null=未轮询/未配置=空态） */
        loadMirror?: () => Promise<unknown>;
        /** □17 循环系列实例（kernel rpc calendar-instances；缺通道=跳过循环显示） */
        fetchInstances?: (startTs: number, endTs: number) => Promise<{ ok: boolean; rows?: InstanceRow[] } | null>;
        // sloop □4 本地班表：sched 档（交接会角标数据源）
        loadSchedule?: () => Promise<SchedStore | null>;
        // timeblock 期 2 ② 读面切块：月历 sched 源=班表块扫描（SQL）
        loadBoardItems?: () => Promise<SchedItem[]>;
        /** 交接会入口（反 push：可见按钮，非弹窗非定时打扰） */
        onOpenHandoff?: () => void;
        // sloop □5 onboarding：档只读+入口（写者=OnboardDialog 用户动作）
        loadOnboard?: () => Promise<OnboardStore | null>;
        onOpenOnboard?: () => void;
        // 期 2 ④ 手动刷新：踢 kernel 真同步一轮（mirror-poll+remind-sync；广播回来防抖自刷）
        onManualSync?: () => void;
        /** ammo □7：日账日窗读面（月历实况回填=日历双类第二类；kernel rpc ammo-ledger-read days 窗） */
        loadLedgerEntries?: (days: string[]) => Promise<Array<{ day: string; items: import("./kernel/core/ammoLedger").AmmoLedgerEntry[] }> | null>;
    } = $props();

    type Raw = { remindRows: RemindScanRow[]; taskRows: TaskDueRow[]; ledger: unknown; mirror: unknown };

    let raw = $state<Raw | null>(null);
    let loading = $state(true);
    let loadError = $state(false);
    let reloadTick = $state(0);
    /** 当前网格窗的循环实例行（翻月按需拉、静默到位；失败/无通道=保持上一窗） */
    let instanceRows = $state<InstanceRow[]>([]);
    // sloop □4 班表：整档（交接会角标源）；kernel 侧写后广播→只刷这一路
    let sched = $state<SchedStore | null>(null);
    // sloop □5 onboarding 档（状态条源；写者=OnboardDialog→pj-onboard-updated 事件刷新）
    let onboard = $state<OnboardStore | null>(null);
    let nowHM = $state("");
    /** 月历 sched 源（班表块 SQL 扫描+日窗闸；加载时点与三源同批） */
    let monthSched = $state<SchedItem[]>([]);
    /** ammo □7：实况回填（日账打点按日窗；翻月重拉——当月+前后补格窗） */
    let ledgerDays = $state<Array<{ day: string; items: import("./kernel/core/ammoLedger").AmmoLedgerEntry[] }>>([]);
    /** B1 双层计划层：每日配置逐日任务行计数（day→count；翻月按窗月集重拉） */
    let configCounts = $state<Map<string, import("./gui/queries").DayConfigCount>>(new Map());

    /** 加载时点锚：翻月重算共用（红态基准稳定） */
    let nowAnchor = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const todayIso = `${nowAnchor.getFullYear()}-${pad2(nowAnchor.getMonth() + 1)}-${pad2(nowAnchor.getDate())}`;

    let viewYear = $state(nowAnchor.getFullYear());
    let viewMonth = $state(nowAnchor.getMonth() + 1);
    let selectedDate = $state<string | null>(todayIso);

    const WEEKDAYS = $derived([t.calWd1, t.calWd2, t.calWd3, t.calWd4, t.calWd5, t.calWd6, t.calWd7]);
    /** 每格事件条密度上限（超出折叠「还有 N 项」；完整列表=双击进时间线）。
     *  caltab：详情区退役后 42 格铺满页签高度（行高 84px→1fr 分摊），放宽 3→4；
     *  B1 双层行进格再收紧 4→3（计划/实况两行让位 ~28px——数字全量已在双层行+时间线，
     *  「还有 N 项」显式折叠非隐藏） */
    const CELL_MAX_EVENTS = 3;

    /** 交接会待开角标（入夜或当日班表全跑完、且未对账） */
    const handoffDot = $derived(sched && nowHM ? handoffDue(sched, monthSched.filter((i) => i.date === todayIso), todayIso, nowHM) : false);
    /** sloop □5 观察期进度（picked 态才有意义；baselined=状态条退场） */
    const onboardDayNum = $derived(onboard && onboard.state === "picked" ? observeDayNum(onboard, todayIso) : 0);

    let model = $derived(
        raw ? buildMonthModel({ now: nowAnchor, remindRows: raw.remindRows, taskRows: raw.taskRows, ledger: raw.ledger, mirror: raw.mirror, instances: instanceRows, sched: monthSched, ledgerDays, configCounts }, viewYear, viewMonth) : null,
    );

    const SRC_LABEL = $derived<Record<string, string>>({
        remind: t.calSrcRemind,
        task: t.calSrcTask,
        burden: t.calSrcBurden,
        feishu: t.calSrcFeishu,
        sched: t.calSrcSched,
        live: t.calSrcLive ?? "实况",
    });

    async function load(): Promise<void> {
        loading = true;
        loadError = false;
        try {
            const [remindRows, taskRows, ledger, mirror, schedRaw, onboardRaw, boardRaw] = await Promise.all([
                loadRemindRows(),
                loadTaskRows(),
                loadLedger(),
                loadMirror ? loadMirror() : Promise.resolve(null),
                loadSchedule ? loadSchedule() : Promise.resolve(null),
                loadOnboard ? loadOnboard() : Promise.resolve(null),
                loadBoardItems ? loadBoardItems() : Promise.resolve([]),
            ]);
            raw = { remindRows, taskRows, ledger, mirror };
            monthSched = boardRaw;
            sched = schedRaw;
            onboard = onboardRaw;
            const n = new Date();
            nowAnchor = n;
            nowHM = `${pad2(n.getHours())}:${pad2(n.getMinutes())}`;
        } catch {
            loadError = true; // SQL 通道错误=空态+重试（账本/镜像缺文件=内部 null 空态不算错）
            raw = null;
        } finally {
            loading = false;
        }
    }

    $effect(() => {
        reloadTick; // 首跑=挂载加载；重试钮 tick++
        void load();
    });

    // □17 循环实例：翻月按需拉该 42 天网格窗（kernel 分块+1h 缓存），静默到位不阻塞翻月；
    // 翻走后回包作废（key 对不上即弃）
    $effect(() => {
        const y = viewYear, m = viewMonth;
        if (!fetchInstances) return;
        const first = new Date(y, m - 1, 1);
        const lead = (first.getDay() + 6) % 7;
        const start = new Date(y, m - 1, 1 - lead);
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42);
        void (async () => {
            const r = await fetchInstances(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)).catch(() => null);
            if (r?.ok && Array.isArray(r.rows) && `${viewYear}-${viewMonth}` === `${y}-${m}`) instanceRows = r.rows;
        })();
    });

    // ammo □7 实况回填：翻月按需拉 42 格日窗（kernel rpc 块树直读无索引窗；翻走回包作废同则）——
    // 月历侧实况段=回望形态（无提醒纯展示，append-only 不动历史）
    $effect(() => {
        const y = viewYear, m = viewMonth;
        if (!loadLedgerEntries) return;
        const first = new Date(y, m - 1, 1);
        const lead = (first.getDay() + 6) % 7;
        const start = new Date(y, m - 1, 1 - lead);
        const pad = (x: number) => String(x).padStart(2, "0");
        const days: string[] = [];
        for (let i = 0; i < 42; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            days.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
        }
        void (async () => {
            const r = await loadLedgerEntries(days).catch(() => null);
            if (r && `${viewYear}-${viewMonth}` === `${y}-${m}`) ledgerDays = r;
        })();
    });

    // B1 双层计划层：翻月按需拉窗内月集的每日配置行（SQL 一发扫 1~3 个月文档容器——判型在
    // dayConfigCounts 纯函数；翻走回包作废同则；失败=保持上一窗，计划行退化为只显锚点）。
    // ⚠通道=feQuery 直连非 props 注入：本组件「解构 props 含 ≥3 个仅被 $effect 引用的函数
    // 键」时 svelte 5.30 编译器会静默吞掉其一的绑定（产物零声明=运行期 ReferenceError——
    // HEAD 两键〔fetchInstances/loadLedgerEntries〕安全、加第三键必死其一，换名/换标注/
    // 合并 effect/普通函数援引均救不回，根因未深挖）；模块函数调用面零 props 分析恒稳
    // （BoardView feQuery 直连同款先例，测试 vi.mock("@/gui/fe") 同门）
    $effect(() => {
        const y = viewYear, m = viewMonth;
        const first = new Date(y, m - 1, 1);
        const lead = (first.getDay() + 6) % 7;
        const start = new Date(y, m - 1, 1 - lead);
        const pad = (x: number) => String(x).padStart(2, "0");
        const months = new Set<string>();
        for (let i = 0; i < 42; i++) { // 逐日取样（一周可跨月——按周取样会漏月）
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            months.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
        }
        void (async () => {
            const r = await feQuery(dayConfigRowsSql([...months])).catch(() => null);
            if (r && `${viewYear}-${viewMonth}` === `${y}-${m}`) configCounts = dayConfigCounts(r);
        })();
    });

    // ── 期 2 ④/H3 同步：事件驱动防抖重扫+手动同步钮（H3 由「刷新」改名） ──
    // 写链广播两源：pj-schedule-updated=班表写面每条一发（schedEdit/onboard 冻结链/kernel 写块
    // 经 saveSchedule）、pj-calendar-status=每轮 remind-sync 完一发（hourly/提醒面板保存/手动同步）
    // ——连改几条=连发全量重拉风暴，600ms 尾沿合并成一次
    let refreshing = $state(false);
    let rescanTimer: ReturnType<typeof setTimeout> | undefined;
    function scheduleRescan(): void {
        clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => {
            rescanTimer = undefined;
            void load();
        }, 600);
    }

    // 手动同步（H3 改名自「刷新」——语义重叠核实：本就做双向同步，勿加同效第二钮）
    // =立即拉本地全量+踢 kernel 真同步一轮（mirror-poll→writeback/adopt 落块+remind-sync；
    // notify 不等回执，落块/写盘广播回来 scheduleRescan 自动再刷=数据真新）
    async function manualSync(): Promise<void> {
        if (refreshing) return;
        refreshing = true;
        try {
            await load();
            onManualSync?.();
        } finally {
            refreshing = false;
        }
    }

    $effect(() => {
        window.addEventListener("pj-schedule-updated", scheduleRescan);
        window.addEventListener("pj-calendar-status", scheduleRescan);
        return () => {
            window.removeEventListener("pj-schedule-updated", scheduleRescan);
            window.removeEventListener("pj-calendar-status", scheduleRescan);
            clearTimeout(rescanTimer); // 卸载后不再触发（防已卸载组件写 $state）
        };
    });

    // tb2 ⑧ 驾驶舱「打开当天时间线」：goToday 的参数化版（月锚+选中日一起落——已开页签
    // 停在别日/别月时被叫回；首开页签本组件默认即今天，错过事件也无害）
    function onGotoDay(e: Event): void {
        const d = (e as CustomEvent).detail?.date;
        if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
            viewYear = Number(d.slice(0, 4));
            viewMonth = Number(d.slice(5, 7));
            selectedDate = d;
        }
    }
    $effect(() => {
        window.addEventListener("pj-cal-goto-day", onGotoDay);
        return () => window.removeEventListener("pj-cal-goto-day", onGotoDay);
    });

    // sloop □5：Onboarding 对话框写档（挑身份/冻结基线）→ 只刷 onboard 状态条路
    $effect(() => {
        const refresh = () => {
            if (!loadOnboard) return;
            void loadOnboard().then((s) => {
                onboard = s;
            });
        };
        window.addEventListener("pj-onboard-updated", refresh);
        return () => window.removeEventListener("pj-onboard-updated", refresh);
    });

    function shiftMonth(delta: number): void {
        let m = viewMonth + delta;
        let y = viewYear;
        if (m < 1) { m = 12; y -= 1; }
        else if (m > 12) { m = 1; y += 1; }
        viewMonth = m;
        viewYear = y;
        // selectedDate 不清理：新视图无该日时高亮自然消失，翻回原月选中态自然恢复（零状态丢失）
    }

    function goToday(): void {
        viewYear = nowAnchor.getFullYear();
        viewMonth = nowAnchor.getMonth() + 1;
        selectedDate = todayIso;
    }

    /** 单击=仅选中高亮（bear 拍板——不展开任何东西；详情区已迁时间线页签） */
    function selectCell(cell: MonthCell): void {
        selectedDate = cell.date;
    }

    /** 双击日期格=打开该天时间线（月外灰字格照常——事件按格属日进时间线） */
    function openCellTimeline(cell: MonthCell): void {
        openTimeline(cell.date);
    }

    /** 右键日期格=菜单「打开这天的时间线」。事件条上的右键已被条目菜单吞+守卫
     *  （closest 探测——Svelte 事件委托晚于祖先监听，stopPropagation 非充分，红线） */
    function cellContextMenu(e: MouseEvent, cell: MonthCell): void {
        if ((e.target instanceof Element) && e.target.closest(".pj-cal__evt")) return; // 条目右键自理
        e.preventDefault();
        const menu = new Menu("pj-cal-day-ctx");
        menu.addItem({ label: t.tlOpenDay ?? "打开这天的时间线", click: () => openTimeline(cell.date) });
        menu.open({ x: e.clientX, y: e.clientY });
    }

    // ── caltab 月历事件条右键三动作（monthEventMenuActions 纯函数定动作集——删除/跳源块/在时间线中打开） ──

    /** 删除：feishu 虚显=删飞书事件；sched=移除班表行；remind/task=连块删（先确认——
     *  API 事务不进 undo 栈，恢复只能靠文档历史；TimelineTab runEntryDelete 同款语义） */
    async function runMonthDelete(ev: MonthEvent): Promise<void> {
        if (ev.source === "feishu") {
            if (!ev.eventId || !deleteForeignEvent) return;
            await deleteForeignEvent(ev.eventId); // rpc 内已触发镜像轮询→广播回来防抖自刷
            return;
        }
        if (!ev.blockId) return;
        if (ev.source === "sched") {
            const st = await schedEdit?.({ type: "remove", key: ev.blockId });
            if (st) sched = st; // 交接会角标源同步
            patchLocalGone(ev.blockId); // 乐观剔除（SQL 索引窗内重查会拿旧值——广播重拉以真值替换）
            return;
        }
        const yes = await new Promise<boolean>((res) => {
            confirm("⚠️", t.calDeleteBlockConfirm ?? "将删除整个内容块（不可撤销，恢复只能靠文档历史）", () => res(true), () => res(false));
        });
        if (!yes) return;
        if (!deleteBlockEntry || !(await deleteBlockEntry(ev.blockId))) return;
        patchLocalGone(ev.blockId);
    }

    /** 删块后本地剔除行（SQL 索引窗内重查拿旧值——乐观 patch 保即时反馈） */
    function patchLocalGone(blockId: string): void {
        if (!raw) return;
        raw = {
            ...raw,
            remindRows: raw.remindRows.filter((r) => r.id !== blockId),
            taskRows: raw.taskRows.filter((r) => r.id !== blockId),
        };
        monthSched = monthSched.filter((i) => i.key !== blockId);
    }

    function evtContextMenu(e: MouseEvent, ev: MonthEvent): void {
        e.preventDefault();
        e.stopPropagation(); // 同委托层内截住（cellContextMenu 另有 closest 守卫双保险）
        const acts: MonthMenuAction[] = monthEventMenuActions({ source: ev.source, blockId: ev.blockId, repeat: ev.repeat, adoptable: ev.adoptable, adoptBlock: ev.adoptBlock });
        if (!acts.length) return; // 循环 remind/循环实例/burden 派生行=无动作，不出菜单
        const menu = new Menu("pj-cal-evt-ctx");
        for (const a of acts) {
            if (a === "delete") {
                menu.addItem({ label: t.calMenuDelete ?? "删除", click: () => void runMonthDelete(ev) });
            } else if (a === "jump") {
                menu.addItem({ label: t.tlMenuJump ?? "跳到源块", click: () => { if (ev.blockId) (openBlockFocused ?? openBlock)(ev.blockId); } });
            } else {
                menu.addItem({ label: t.tlMenuOpenTimeline ?? "在时间线中打开", click: () => openTimeline(ev.date, ev.blockId ?? ev.eventId) });
            }
        }
        menu.open({ x: e.clientX, y: e.clientY });
    }

    function dayNum(date: string): number {
        return Number(date.slice(8, 10));
    }

    // ── B1 日历双层：格内计划/实况两行紧凑呈现（数字平铺不藏 hover；点击走禁聚焦跳源链） ──

    /** 计划行数字段：`3锚·2硬·5弹`（零硬/零弹段省略——有内容才占位） */
    function duoPlanText(p: MonthDuoPlan): string {
        const segs = [`${p.anchors}${t.calDuoUnitAnchor ?? "锚"}`];
        if (p.hardAnchors > 0) segs.push(`${p.hardAnchors}${t.calDuoUnitHard ?? "硬"}`);
        if (p.ammoTasks > 0) segs.push(`${p.ammoTasks}${t.calDuoUnitAmmo ?? "弹"}`);
        return segs.join("·");
    }

    /** 实况行数字段：`4笔 2h 55m·进行中`（时长=fmtDuration 四象限同口径；全未闭合=时长段省略） */
    function duoLiveText(l: MonthDuoLive): string {
        const segs = [`${l.count}${t.calDuoUnitEntry ?? "笔"}`];
        const dur = fmtDuration(l.totalMin);
        if (dur) segs.push(l.unclosed > 0 ? `${dur}·${t.ammoLiveOpenTag ?? "进行中"}` : dur);
        else if (l.unclosed > 0) segs.push(t.ammoLiveOpenTag ?? "进行中");
        return segs.join(" ");
    }

    /** 双层行点击=开对应文档禁聚焦（openBlock=cb-get-hl 链；无锚目标=静默不响应） */
    function duoOpen(e: MouseEvent, blockId: string | undefined): void {
        e.stopPropagation(); // 格单击=仅选中，双层行点击自理（事件条同款纪律）
        if (blockId) openBlock(blockId);
    }

    function monthTitle(): string {
        return `${viewYear} · ${String(viewMonth).padStart(2, "0")}`;
    }
</script>

<div class="pj-cal fn__flex-column">
    <div class="pj-cal__topbar fn__flex">
        <div class="pj-cal__nav fn__flex">
            <button class="b3-button b3-button--small b3-button--outline pj-cal__navbtn" onclick={() => shiftMonth(-1)} aria-label={t.calPrevMonth} title={t.calPrevMonth}>‹</button>
            <span class="pj-cal__title">{monthTitle()}</span>
            <button class="b3-button b3-button--small b3-button--outline pj-cal__navbtn" onclick={() => shiftMonth(1)} aria-label={t.calNextMonth} title={t.calNextMonth}>›</button>
        </div>
        <button class="b3-button b3-button--small b3-button--outline pj-cal__today" onclick={goToday}>{t.calToday}</button>
        {#if onOpenHandoff}
            <button class="b3-button b3-button--small pj-cal__handoff" class:pj-cal__handoff--due={handoffDot} onclick={() => onOpenHandoff()}>{t.handoffBtn}</button>
        {/if}
        <!-- 期 2 ④+H3：手动同步钮（面板内·bear 拍板不放顶栏；H3 核实语义重叠后由「刷新」改名，
             勿另加同效第二钮）——立即全量重拉+踢 kernel 真同步一轮（双向） -->
        <button
            class="b3-button b3-button--small b3-button--outline pj-cal__sync"
            onclick={() => void manualSync()}
            disabled={refreshing}
            aria-label={t.calSyncBtnTitle}
            title={t.calSyncBtnTitle}
        >{t.calSync}</button>
        <span class="fn__flex-1"></span>
        <div class="pj-cal__legend fn__flex" aria-hidden="true">
            {#each ["remind", "task", "burden", "feishu", "sched", "live"] as src (src)}
                <span class="pj-cal__legend-item"><i class="pj-cal__dot pj-cal__dot--{src}"></i>{SRC_LABEL[src]}</span>
            {/each}
        </div>
    </div>

    <!-- sloop □5 onboarding 状态条：未开始=不显示（09-18 bear 拍板删冷启动横幅——真实使用即冷启动）；
         观察期=进度（点开详情）；baselined=弱化回看条（首份报告/基线的人类可读副本入口——期 4 周报对照物） -->
    {#if onOpenOnboard && !loading && !loadError && onboard}
        {#if onboard.state === "picked"}
            <button class="pj-cal__onboard pj-cal__onboard--live" onclick={() => onOpenOnboard()}>
                <span class="pj-cal__onboard-dot" class:pj-cal__onboard-dot--ready={onboardDayNum >= OBSERVE_TARGET_DAYS}></span>
                <span class="pj-cal__onboard-text" class:pj-cal__onboard-text--ready={onboardDayNum >= OBSERVE_TARGET_DAYS}>
                    {#if onboardDayNum >= OBSERVE_TARGET_DAYS}
                        {t.onboardBarReady.replaceAll("{t}", String(OBSERVE_TARGET_DAYS))}
                    {:else}
                        {t.onboardBarDay.replaceAll("{n}", String(onboardDayNum)).replaceAll("{t}", String(OBSERVE_TARGET_DAYS))}
                    {/if}
                </span>
                {#if onboardDayNum >= OBSERVE_TARGET_DAYS}
                    <span class="pj-cal__onboard-go-tag">{t.onboardReportBtn}</span>
                {/if}
            </button>
        {:else}
            <button class="pj-cal__onboard pj-cal__onboard--frozen" onclick={() => onOpenOnboard()}>
                <span class="pj-cal__onboard-text pj-cal__onboard-text--frozen">{t.onboardBarFrozen.replaceAll("{day}", onboard.baseline?.observedDays?.[onboard.baseline.observedDays.length - 1] ?? onboard.observeStart)}</span>
            </button>
        {/if}
    {/if}

    {#if loading}
        <div class="pj-cal__state">{t.dashboardLoading}</div>
    {:else if loadError}
        <div class="pj-cal__state">
            <div>{t.calLoadFailed}</div>
            <button class="b3-button b3-button--small b3-button--outline" onclick={() => (reloadTick += 1)}>{t.calRetry}</button>
        </div>
    {:else if model}
        <div class="pj-cal__grid-head">
            {#each WEEKDAYS as wd (wd)}
                <span class="pj-cal__grid-headcell">{wd}</span>
            {/each}
        </div>
        <!-- caltab：42 格铺满页签剩余高度（flex:1+1fr 行分摊），单击=仅高亮、双击/右键=开该天时间线 -->
        <div class="pj-cal__grid">
            {#each model as cell (cell.date)}
                {@const alm = dayAlmanac(cell.date)}
                <div
                    class="pj-cal__cell"
                    data-date={cell.date}
                    class:pj-cal__cell--out={!cell.inMonth}
                    class:pj-cal__cell--today={cell.date === todayIso}
                    class:pj-cal__cell--selected={cell.date === selectedDate}
                    role="button"
                    tabindex="0"
                    title={t.tlOpenDay ?? "打开这天的时间线"}
                    onclick={() => selectCell(cell)}
                    ondblclick={() => openCellTimeline(cell)}
                    oncontextmenu={(e) => cellContextMenu(e, cell)}
                    onkeydown={(e) => {
                        if ((e.target instanceof Element) && e.target.closest(".pj-cal__evt, .pj-cal__duo")) return; // 条目/双层行键击自理（防双动作）
                        if (e.key === "Enter") { e.preventDefault(); openCellTimeline(cell); }
                        else if (e.key === " ") { e.preventDefault(); selectCell(cell); }
                    }}
                >
                    <!-- □16 历法层日头行：公历日+农历文案（节日/节气主色）+休/班角标 -->
                    <div class="pj-cal__cellhead">
                        <span class="pj-cal__daynum">{dayNum(cell.date)}</span>
                        <span class="pj-cal__lunar" class:pj-cal__lunar--hi={alm.highlight}>{alm.lunarText}</span>
                        {#if alm.off}<span class="pj-cal__badge pj-cal__badge--off">{t.calHolidayOff}</span>{/if}
                        {#if alm.work}<span class="pj-cal__badge pj-cal__badge--work">{t.calHolidayWork}</span>{/if}
                    </div>
                    <!-- B1 日历双层：计划层（锚点/配置）与实况层（日账）两行紧凑呈现——数字平铺、
                         点击=禁聚焦跳源（配置容器/首打点块）；零内容层不显行 -->
                    {#if cell.duo.plan}
                        <button
                            class="pj-cal__duo pj-cal__duo--plan"
                            title={(t.calDuoPlanTip ?? "计划：{a} 锚（{h} 硬）· {m} 弹").replace("{a}", String(cell.duo.plan.anchors)).replace("{h}", String(cell.duo.plan.hardAnchors)).replace("{m}", String(cell.duo.plan.ammoTasks))}
                            onclick={(e) => duoOpen(e, cell.duo.planBlockId)}
                            ondblclick={(e) => e.stopPropagation()}
                        ><i class="pj-cal__duo-tag">{t.calDuoPlanLabel ?? "计划"}</i><span class="pj-cal__duo-text">{duoPlanText(cell.duo.plan)}</span></button>
                    {/if}
                    {#if cell.duo.live}
                        <button
                            class="pj-cal__duo pj-cal__duo--live"
                            title={(t.calDuoLiveTip ?? "实况：{n} 笔 · {d}").replace("{n}", String(cell.duo.live.count)).replace("{d}", fmtDuration(cell.duo.live.totalMin) || "—")}
                            onclick={(e) => duoOpen(e, cell.duo.liveBlockId)}
                            ondblclick={(e) => e.stopPropagation()}
                        ><i class="pj-cal__duo-tag">{t.calDuoLiveLabel ?? "实况"}</i><span class="pj-cal__duo-text">{duoLiveText(cell.duo.live)}</span></button>
                    {/if}
                    {#each cell.events.slice(0, CELL_MAX_EVENTS) as ev, i (ev.date + "#" + i + "#" + ev.summary + "#" + ev.time)}
                        <button
                            class="pj-cal__evt"
                            class:pj-cal__evt--due={ev.isDue}
                            title={ev.summary}
                            onclick={(e) => { e.stopPropagation(); if (ev.blockId) openBlock(ev.blockId); }}
                            ondblclick={(e) => e.stopPropagation()}
                            oncontextmenu={(e) => evtContextMenu(e, ev)}
                        ><i class="pj-cal__dot pj-cal__dot--{ev.source}"></i><span class="pj-cal__evt-text" class:pj-cal__evt-text--empty={!ev.summary}>{ev.summary || (t.schedEmptySummary ?? "（空条目）")}</span></button>
                    {/each}
                    {#if cell.events.length > CELL_MAX_EVENTS}
                        <span class="pj-cal__more">{t.calMore.replace("{n}", String(cell.events.length - CELL_MAX_EVENTS))}</span>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>

<style lang="scss">
    .pj-cal {
        height: 100%;
        overflow-y: auto;
        padding: 8px 16px 16px;
        gap: 8px;
        box-sizing: border-box;
    }

    /* 顶栏：翻月组+今天+右图例；sticky 贴滚动容器顶（vision P2：矮视口滚到底看当日列表后
       翻月不必滚回顶部；不透明底防内容透过） */
    .pj-cal__topbar {
        position: sticky;
        top: 0;
        z-index: 4;
        background-color: var(--b3-theme-surface);
        gap: 8px;
        align-items: center;
        padding: 4px 0;
    }

    .pj-cal__nav {
        gap: 4px;
        align-items: center;
    }

    .pj-cal__navbtn {
        padding: 2px 10px;
        font-size: 15px;
        line-height: 1.4;
    }

    .pj-cal__title {
        min-width: 88px;
        text-align: center;
        font-size: 15px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
        font-variant-numeric: tabular-nums;
    }

    /* 视觉终审 P1：图例项窄视口竖排换行（「快提醒」折三行）——项 nowrap+放不下横向滚动
     * （信息平铺不折叠进 hover）；gap 12→8 收窄让常见宽度一排放下 */
    .pj-cal__legend {
        gap: 8px;
        align-items: center;
        min-width: 0;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: thin;
    }

    .pj-cal__legend-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        white-space: nowrap;
        flex-shrink: 0;
    }

    /* 同步钮窄视口不折行（④ P2：两字钮换行=按钮形散架；纯 e2e 钩子类补这一条样式） */
    .pj-cal__sync {
        white-space: nowrap;
    }

    /* 源色点（remind 蓝/task 橙/burden 灰绿——全走主题变量明暗各自成立） */
    .pj-cal__dot {
        flex-shrink: 0;
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--b3-theme-on-surface-light);
    }

    .pj-cal__dot--remind {
        background-color: var(--b3-theme-primary);
    }

    .pj-cal__dot--task {
        background-color: var(--b3-card-warning-color, #9d7e00);
    }

    .pj-cal__dot--burden {
        background-color: var(--b3-card-success-color, #2a9d42);
    }

    /* □17 feishu 回流（紫；色点非文本 6px——主题变量无紫档，钉双主题色值） */
    .pj-cal__dot--feishu {
        background-color: #7c5cd6;
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__dot--feishu {
        background-color: #a78bfa;
    }

    /* ammo □7 live 实况回填（绿=发生的世界；与 burden 灰绿同变量档但图例+事件条形态可分） */
    .pj-cal__dot--live {
        background-color: var(--b3-card-success-color, #2a9d42);
    }

    /* 加载/失败空态 */
    .pj-cal__state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 48px 0;
        font-size: 13px;
        color: var(--b3-theme-on-surface);
    }

    /* 表头行（周一起） */
    .pj-cal__grid-head {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 4px;
        padding: 4px 2px 2px;
    }

    .pj-cal__grid-headcell {
        text-align: center;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    /* 月历网格：caltab 详情区退役——42 格铺满页签剩余高度（flex:1 吃满+1fr 行分摊；
     * 行下限 84px 保矮视口可读，超下限总高时外层 .pj-cal 滚动兜底） */
    .pj-cal__grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        grid-auto-rows: minmax(84px, 1fr);
        gap: 4px;
        flex: 1;
    }

    .pj-cal__cell {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px 6px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-surface);
        cursor: pointer;
        min-width: 0;
    }

    .pj-cal__cell:hover {
        background-color: var(--b3-list-hover, var(--b3-theme-surface-lighter));
    }

    .pj-cal__cell--out {
        background-color: transparent;
        border-color: var(--b3-border-color-trans, var(--b3-border-color));

        .pj-cal__daynum {
            color: var(--b3-theme-on-surface-light);
        }

        .pj-cal__lunar,
        .pj-cal__lunar--hi {
            color: var(--b3-theme-on-surface-light);
        }

        /* B1 双层行月外格弱化（事件条不弱化=既有形态不动，双层行跟随日头行语言） */
        .pj-cal__duo {
            color: var(--b3-theme-on-surface-light);
        }
    }

    .pj-cal__cell--today .pj-cal__daynum {
        color: var(--b3-theme-primary);
        font-weight: 600;
    }

    .pj-cal__cell--selected {
        border-color: var(--b3-theme-primary);
    }

    /* □16 历法层日头行：公历日+农历文案+角标一行（daynum 原 padding-bottom 移交本行） */
    .pj-cal__cellhead {
        display: flex;
        align-items: baseline;
        gap: 4px;
        padding-bottom: 2px;
        min-width: 0;
    }

    .pj-cal__lunar {
        margin-left: auto;
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* 节日/节气命中=主色（与今日同色系小字，视觉层级=日>节日>普通农历日） */
    .pj-cal__lunar--hi {
        color: var(--b3-theme-primary);
    }

    .pj-cal__badge {
        flex-shrink: 0;
        font-size: 10px;
        line-height: 1.5;
        padding: 0 3px;
        border-radius: 3px;
        font-style: normal;
    }

    .pj-cal__badge--off {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 12%, transparent);
    }

    .pj-cal__badge--work {
        color: var(--b3-theme-warning, #d25f00);
        background-color: color-mix(in srgb, var(--b3-theme-warning, #d25f00) 14%, transparent);
    }

    .pj-cal__daynum {
        font-size: 13px;
        color: var(--b3-theme-on-background);
        font-variant-numeric: tabular-nums;
    }

    /* B1 日历双层行：计划层/实况层各一行紧凑小字（事件条同款透明按钮语言；label 色系
       与图例呼应——计划=班表 teal、实况=live 绿；数字段=正文字色） */
    .pj-cal__duo {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        padding: 0 2px;
        border: none;
        border-radius: 3px;
        background: transparent;
        font-family: inherit;
        font-size: 11px;
        line-height: 1.5;
        color: var(--b3-theme-on-surface);
        text-align: left;
        cursor: pointer;
    }

    .pj-cal__duo:hover {
        background-color: var(--b3-list-hover, var(--b3-theme-surface-lighter));
    }

    .pj-cal__duo-tag {
        font-style: normal;
        flex-shrink: 0;
        padding: 0 3px;
        border-radius: 3px;
        line-height: 1.5;
    }

    .pj-cal__duo-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
    }

    /* 计划层 label=班表 teal（主题变量无 teal 档——钉双主题色值，dot--sched 同款先例） */
    .pj-cal__duo--plan .pj-cal__duo-tag {
        color: #0d9488;
        background-color: color-mix(in srgb, #0d9488 12%, transparent);
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__duo--plan .pj-cal__duo-tag {
        color: #2dd4bf;
    }

    /* 实况层 label=live 绿（dot--live 同变量档） */
    .pj-cal__duo--live .pj-cal__duo-tag {
        color: var(--b3-card-success-color, #2a9d42);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 12%, transparent);
    }

    /* 事件条：色点+截断摘要（完整列表在下方当日区） */
    .pj-cal__evt {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        padding: 1px 2px;
        border: none;
        border-radius: 3px;
        background: transparent;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.4;
        color: var(--b3-theme-on-surface);
        text-align: left;
        cursor: pointer;
    }

    .pj-cal__evt:hover {
        background-color: var(--b3-list-hover, var(--b3-theme-surface-lighter));
    }

    .pj-cal__evt-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* 空草稿占位弱化（vision ⑧：正文字色呈现告警感——降为辅助灰） */
    .pj-cal__evt-text--empty {
        color: var(--b3-theme-on-surface-light);
    }

    /* 红态：今日已到/已过（时间+摘要一起红，与色点并存） */
    .pj-cal__evt--due {
        color: var(--b3-card-error-color, #d23f31);
    }

    .pj-cal__more {
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    /* sloop □4 班表源（teal——主题变量无 teal 档，钉双主题色值；feishu 紫同款先例） */
    .pj-cal__dot--sched {
        background-color: #0d9488;
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__dot--sched {
        background-color: #2dd4bf;
    }

    /* 交接会按钮（反 push：常驻可见；--due=今晚待开角标点） */
    .pj-cal__handoff {
        position: relative;
    }

    .pj-cal__handoff--due::after {
        content: "";
        position: absolute;
        top: -3px;
        right: -3px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background-color: var(--b3-theme-primary);
        border: 1px solid var(--b3-theme-surface);
    }

    /* sloop □5 onboarding 状态条：未开始=浅底入口；观察期=可点进度条（圆点=进行中/达成换色） */
    .pj-cal__onboard {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 5%, var(--b3-theme-surface));
    }

    .pj-cal__onboard--live {
        width: fit-content;
        border-style: dashed;
        cursor: pointer;
    }

    .pj-cal__onboard--live:hover {
        border-color: var(--b3-theme-primary);
    }

    .pj-cal__onboard-text {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    /* 就绪=整句同绿（与对话框 progress--ready 同语义；vision 一致性 P2） */
    .pj-cal__onboard-text--ready {
        color: var(--b3-card-success-color, #2a9d42);
    }

    .pj-cal__onboard-text--frozen {
        color: var(--b3-theme-on-surface); /* 弱化=去边框底色，字色保持正文级（vision P2：1.7:1 太浅） */
    }

    .pj-cal__onboard--frozen {
        background-color: transparent;
        border-style: dashed;
        cursor: pointer;
        opacity: 0.85;
    }

    .pj-cal__onboard-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background-color: var(--b3-theme-primary);
        flex-shrink: 0;
    }

    .pj-cal__onboard-dot--ready {
        background-color: var(--b3-card-success-color, #2a9d42);
    }

    /* 开步入口=tonal（vision 复审 P0 回归：实心 b3-button 默认蓝底，仅改字色 primary=蓝on蓝
        1:1 不可见——改对话框主 CTA 同款浅底语言） */
    .pj-cal__onboard-go {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 12%, var(--b3-theme-surface));
    }

    .pj-cal__onboard-go-tag {
        font-size: 12px;
        padding: 0 6px;
        border-radius: 3px;
        color: var(--b3-card-success-color, #2a9d42);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 12%, transparent);
    }

</style>
