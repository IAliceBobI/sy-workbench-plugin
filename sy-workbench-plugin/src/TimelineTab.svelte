<script lang="ts">
    import { Menu, confirm, showMessage } from "siyuan";
    // caltab 期：独立「时间线」页签（openTab custom，挂载接线在 index.ts addTab——组件名用
    // TimelineTab：Timeline.svelte 已被 sloop □21 dock 常驻面板占用）。本组件=Calendar.svelte
    // 「当日详情区」整块平移（bear 拍板逻辑不改只搬家）：24h 真占位轴+托盘+添加行+拖动 15min
    // 吸附+条目右键三动作+点条目跳源块+右键空轴创建+同步徽标+周报 chip。与月历的差异只有三处：
    // ① 顶栏=翻日组（◀ 前一天/日期·周几·农历·共 N 项/后一天 ▶＋回今天）替代月历翻月组；
    // ② 轴恒展开（0 条目也整轴渲染+nowline——月历侧空态不渲染病灶在此根治）；
    // ③ day/focusKey 外部可控（openTimeline 落参/pj-tl-goto-day 事件；focusKey=切日后高亮
    // 并滚动定位该条目）。打开默认今天、关重开回今天（视图态不持久化）。
    // 类名沿用 pj-cal__*（月历同款 scoped 样式逐条平移，两组件各自 scoped 互不冲突）。
    import { buildDayAxis, DAY_AXIS_MIN_SLOT_MIN, entryMenuActions, slotIsActiveAt, snapToStep, type DayAxisModel, type DayAxisSlot, type DayAxisTrayRow, type DayMenuAction } from "./gui/dayaxis";
    // dataview □5②：拖卡到时间线=建锚点+出发（拖源=四象限面板任务行；纯层=gui/ammoDrop）
    import { anchorAddOp, anchorBlockIdOf, cardDataOf, dropMinuteOf, hasAmmoCard, shouldDepartOnDrop, wsAppId } from "./gui/ammoDrop";
    import { buildDepartParams } from "./ammoDepartWire";
    import { AMMO_DEPART_METHOD } from "./shared/channels";
    import { hmToMin, minToHM } from "./kernel/core/schedule";
    import { dayAlmanac } from "./lunarInfo";
    import type { InstanceRow } from "./kernel/core/calendarMirror";
    import { type SchedEditOp, type SchedItem, type SchedStore } from "./kernel/core/schedule";
    import type { WeeklyStore } from "./kernel/core/report";
    import { addDays } from "./kernel/core/dates";
    import type { RemindScanRow, TaskDueRow } from "./gui/queries";
    // ammo □7：实况段（日账打点=回望形态槽）+实况手动同步钮（三宿主同一引擎同一状态源）
    import AmmoLiveSyncButton from "./AmmoLiveSyncButton.svelte";
    import type { AmmoLedgerEntry } from "./kernel/core/ammoLedger";

    /** readDayBoard rpc 返回形态（kernel/schedboard BoardReadResult 的组件侧视图） */
    interface BoardReadShape {
        ok: boolean;
        docId?: string;
        boardId?: string;
        items?: Array<{ key: string; summary: string; start: string | null; end: string | null; hard: boolean; origin: SchedItem["origin"]; allDay?: boolean }>;
        error?: string;
    }

    let {
        t,
        day,
        focusKey,
        openBlock,
        loadRemindRows,
        loadTaskRows,
        loadLedger,
        loadMirror,
        fetchInstances,
        schedEdit,
        adoptForeign,
        loadWeekly,
        readDayBoard,
        createRemindEntry,
        moveRemindBlock,
        moveTaskDueTime,
        openBlockFocused,
        deleteForeignEvent,
        deleteBlockEntry,
        untimeRemindBlock,
        untimeTaskDueTime,
        loadLedgerEntries,
        ammoRpc,
    }: {
        t: Record<string, string>;
        /** 打开落日（YYYY-MM-DD；非法/缺省=今天） */
        day?: string;
        /** 打开定位条目（块 id/飞书 event id/实例 id——切日后高亮+滚动定位；缺省不定位） */
        focusKey?: string;
        openBlock: (blockId: string) => void;
        loadRemindRows: () => Promise<RemindScanRow[]>;
        loadTaskRows: () => Promise<TaskDueRow[]>;
        loadLedger: () => Promise<unknown>;
        /** □17 镜像 JSON（petal calendar-mirror.json 只读；null=未轮询/未配置=空态） */
        loadMirror?: () => Promise<unknown>;
        /** □17 循环系列实例（kernel rpc calendar-instances；缺通道=跳过循环显示） */
        fetchInstances?: (startTs: number, endTs: number) => Promise<{ ok: boolean; rows?: InstanceRow[] } | null>;
        // 班表三操作（move=拖动改时刻落 DragRecord/add/remove——与 Calendar 日面板同一通道）
        schedEdit?: (op: SchedEditOp) => Promise<SchedStore | null>;
        // □17 飞书先建事件落地（条目右键「重建块」；缺通道=菜单项仍出不落块）
        adoptForeign?: (eventId: string) => Promise<{ ok: boolean; error?: string } | null>;
        // 周报表只读（托盘周报 chip 开文档映射+未读角标数据源）
        loadWeekly?: () => Promise<WeeklyStore | null>;
        // 当日班表块 rpc 读（IAL 直读恒新鲜；拖动/addrow 的板面真值）
        readDayBoard?: (day: string) => Promise<BoardReadShape | null>;
        // 轴右键创建=kernel 插带时间空段落块（remind 链全家桶——bear 段落块拍板）
        createRemindEntry?: (day: string, startHM: string) => Promise<{ ok: boolean; blockId?: string; docId?: string; error?: string } | null>;
        // 拖动改块属性通道（remind/task 直写 setBlockAttrs；board 走 schedEdit 既有通道）
        moveRemindBlock?: (blockId: string, day: string, startHM: string, endHM: string | null) => Promise<boolean>;
        moveTaskDueTime?: (blockId: string, timeHM: string) => Promise<boolean>;
        // 条目右键三动作+右键创建后的聚焦跳源块通道
        openBlockFocused?: (blockId: string) => void;
        deleteForeignEvent?: (eventId: string) => Promise<{ ok: boolean; error?: string } | null>;
        deleteBlockEntry?: (blockId: string) => Promise<boolean>;
        untimeRemindBlock?: (blockId: string) => Promise<boolean>;
        untimeTaskDueTime?: (blockId: string) => Promise<boolean>;
        /** ammo □7：当日日账打点读面（kernel rpc ammo-ledger-read 单日；缺=实况段缺席降级） */
        loadLedgerEntries?: (day: string) => Promise<AmmoLedgerEntry[] | null>;
        /** ammo □7：kernel rpc 面（顶栏实况同步钮引擎通道；缺=钮隐藏） */
        ammoRpc?: { call: Record<string, (p?: any) => Promise<any>> } | null;
    } = $props();

    const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;

    type Raw = { remindRows: RemindScanRow[]; taskRows: TaskDueRow[]; ledger: unknown; mirror: unknown };

    let raw = $state<Raw | null>(null);
    let loading = $state(true);
    let loadError = $state(false);
    let reloadTick = $state(0);
    /** 当前日的循环实例行（切日按需拉、静默到位；失败/无通道=保持上一日） */
    let instanceRows = $state<InstanceRow[]>([]);
    // 周报表（chip 开文档映射+未读角标源；kernel 写→pj-schedule-updated 广播同刷）
    let weekly = $state<WeeklyStore | null>(null);
    /** 已读周集（weekStart→true；点击周报 chip 置位+localStorage 持久——轻 push 角标只消本机） */
    let readWeeks = $state<Record<string, boolean>>({});
    let addSummary = $state("");
    let addTime = $state("");
    let addHard = $state(false);
    let addTimeBad = $state(false);
    /** 当日班表块（rpc 只读；viewDay/写广播/重载时刷新） */
    let boardItems = $state<SchedItem[]>([]);
    /** ammo □7：当日日账打点（实况段；viewDay 变化/引擎广播刷新——内存事件链非轮询） */
    let ledgerEntries = $state<AmmoLedgerEntry[]>([]);
    /** 指针拖动态（真占位轴：curMin=吸附后目标起点；moved<4px=点击不落写） */
    let drag = $state<null | {
        key: string;
        source: DayAxisSlot["source"];
        blockId: string;
        /** 拖起时起点分钟（托盘起拖=null） */
        fromMin: number | null;
        endMin: number | null;
        grabMin: number;
        curMin: number;
        over: "axis" | "tray";
        moved: boolean;
    }>(null);
    // 增补一 □4：独立页签轴撑满高后刻度更疏——48→56（48~64 档内取中；PX_PER_MIN 同源派生，
    // 拖动吸附/落点换算自动跟随；小时刻度行高经 --pj-axis-pxh CSS var 同吃本常量——复审 high：
    // 曾只改 JS 漏 CSS 刻度尺，槽与刻度错位 1.5h/时长线性放大）
    const PX_PER_HOUR = 56;
    const PX_PER_MIN = PX_PER_HOUR / 60;
    /** 拖动收尾吞一拍 click（pointerup 后浏览器照发 click——拖完不开源块） */
    let suppressClick = false;

    /** 加载时点锚：红态基准稳定（Calendar 同款——非 $state，靠 raw 重赋值带动 derived 重算） */
    let nowAnchor = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const todayIso = `${nowAnchor.getFullYear()}-${pad2(nowAnchor.getMonth() + 1)}-${pad2(nowAnchor.getDate())}`;

    /** 视图日（打开落日非法/缺省=今天；翻日/回今天/goto 事件驱动；关重开回今天）。
     *  day/focusKey=打开落参只在挂载时消费一次（后续外部切日走 pj-tl-goto-day 事件）——
     *  初始值捕获是本意，svelte-ignore 压 state_referenced_locally */
    // svelte-ignore state_referenced_locally
    let viewDay = $state(DATE_OK.test(day ?? "") ? (day as string) : todayIso);
    /** focusKey 落位态（key+目标日；axis 到位后高亮滚动并清空；10s 落空兜底放弃） */
    // svelte-ignore state_referenced_locally
    let pendingFocus = $state<{ key: string; day: string } | null>(typeof focusKey === "string" && focusKey ? { key: focusKey, day: viewDay } : null);
    /** 定位高亮槽（key；短暂闪烁后退场） */
    let focusFlash = $state<string | null>(null);

    const WEEKDAYS = $derived([t.calWd1, t.calWd2, t.calWd3, t.calWd4, t.calWd5, t.calWd6, t.calWd7]);

    /** 统一时间轴模型（四源+burden+实况；虚实/徽标/lane 打包全在此——Calendar 同款） */
    const axis = $derived<DayAxisModel | null>(
        raw
            ? buildDayAxis({
                  day: viewDay,
                  today: todayIso,
                  now: nowAnchor,
                  boardItems,
                  remindRows: raw.remindRows,
                  taskRows: raw.taskRows,
                  mirror: raw.mirror,
                  instances: instanceRows,
                  ledger: raw.ledger,
                  ledgerEntries,
              })
            : null,
    );
    /** 今日走针线（分钟；他日不画）。增补一 □1：分钟级走针——独立 $state 节拍驱动
     *  （挂载即算+60s interval），不再用加载锚 nowAnchor（那只喂 axis 的红态基准——
     *  「红态基准稳定」既有设计勿破：节拍不进 axis 依赖集，走针不触发模型重算；
     *  轴滚动 effect 也不依赖节拍——用户手动滚走后不被每分钟拽回 now）。 */
    let tickNow = $state(new Date());
    $effect(() => {
        const tId = setInterval(() => (tickNow = new Date()), 60_000);
        return () => clearInterval(tId);
    });
    const nowLineMin = $derived(viewDay === todayIso ? tickNow.getHours() * 60 + tickNow.getMinutes() : null);

    // ── sloop □17 飞书先建事件落地（纯飞书→完全同步跃迁；与 Calendar 同款） ──
    let adopting = $state(false);
    /** 不可落地原因 → title 文案（i18n 键兜底英文形态，同 i18n 兜底哲学） */
    const ADOPT_BLOCK_TIP = $derived<Record<string, string>>({
        allDay: t.calAdoptBlockAllDay ?? "All-day events can't be saved yet",
        recurring: t.calAdoptBlockRecurring ?? "Recurring events can't be saved yet",
        unrepresentable: t.calAdoptBlockForm ?? "This event can't fit the schedule (overnight/untitled)",
        too_old: t.calAdoptBlockTooOld ?? "Event is too old (beyond the schedule retention window)",
        already: t.calAdoptBlockAlready ?? "This event is already a plugin mirror",
    });
    async function adoptOne(ev: { eventId?: string; adoptable?: boolean }): Promise<void> {
        if (adopting || !ev.eventId || !ev.adoptable || !adoptForeign) return;
        adopting = true;
        try {
            const r = await adoptForeign(ev.eventId);
            if (r?.ok) reloadTick += 1; // 刷新：feishu 行消失→班表区出条目（落地即双向）
        } finally {
            adopting = false;
        }
    }

    const SRC_LABEL = $derived<Record<string, string>>({
        remind: t.calSrcRemind,
        task: t.calSrcTask,
        burden: t.calSrcBurden,
        feishu: t.calSrcFeishu,
        sched: t.calSrcSched,
        live: t.calSrcLive ?? "实况",
    });

    /** live 行池名（i18n 键 ammoPool_<slug>——□6 池名同源；未知 slug 退 slug 原串） */
    function poolLabel(pool: string): string {
        return (t as Record<string, string>)[`ammoPool_${pool}`] ?? pool;
    }

    async function load(): Promise<void> {
        loading = true;
        loadError = false;
        try {
            const [remindRows, taskRows, ledger, mirror, weeklyRaw] = await Promise.all([
                loadRemindRows(),
                loadTaskRows(),
                loadLedger(),
                loadMirror ? loadMirror() : Promise.resolve(null),
                loadWeekly ? loadWeekly() : Promise.resolve(null),
            ]);
            raw = { remindRows, taskRows, ledger, mirror };
            applyWeekly(weeklyRaw);
            nowAnchor = new Date();
        } catch {
            loadError = true; // SQL 通道错误=空态+重试（账本/镜像缺文件=内部 null 空态不算错）
            raw = null;
        } finally {
            loading = false;
        }
    }

    // ── sloop □6 周报 chip：origin=report 的托盘行 ↔ 周报表按日落日映射+未读判定+点击开文档
    //    （期① 落块后 chip key=块 id——wr- 前缀匹配恒不中，改按 origin+day 查周报表） ──
    function applyWeekly(w: WeeklyStore | null): void {
        weekly = w;
        const rw: Record<string, boolean> = {};
        for (const wk of Object.keys(w?.weeks ?? {})) {
            try {
                if (localStorage.getItem(`pj-weekly-read-${wk}`)) rw[wk] = true;
            } catch { /* localStorage 不可用=角标常亮，无碍 */ }
        }
        readWeeks = rw;
    }
    /** 落在该日的周报周键（周报表 weeks[].day=周日落日——班表 chip 的 date 同值） */
    function reportWeekKeyOfDay(day: string): string | null {
        for (const [wk, rec] of Object.entries(weekly?.weeks ?? {})) if (rec.day === day) return wk;
        return null;
    }
    function reportUnreadOfDay(day: string): boolean {
        const wk = reportWeekKeyOfDay(day);
        return Boolean(wk && !readWeeks[wk]);
    }
    function openReportOfDay(day: string): void {
        const wk = reportWeekKeyOfDay(day);
        const rec = wk && weekly?.weeks[wk] ? weekly.weeks[wk] : null;
        if (!rec || !wk) return;
        openBlock(rec.docId);
        try {
            localStorage.setItem(`pj-weekly-read-${wk}`, "1");
        } catch { /* 无碍 */ }
        readWeeks = { ...readWeeks, [wk]: true };
    }

    $effect(() => {
        reloadTick; // 首跑=挂载加载；重试钮 tick++
        void load();
    });

    // □17 循环实例：切日按需拉该日窗（kernel 分块+1h 缓存），静默到位不阻塞；
    // 切走后回包作废（日对不上即弃）
    $effect(() => {
        const d = viewDay;
        if (!fetchInstances || !DATE_OK.test(d)) return;
        const start = new Date(d + "T00:00");
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        void (async () => {
            const r = await fetchInstances(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)).catch(() => null);
            if (r?.ok && Array.isArray(r.rows) && viewDay === d) instanceRows = r.rows;
        })();
    });

    // ── 期 2 ④/H3 同步：事件驱动防抖重扫（写链广播 pj-schedule-updated/pj-calendar-status
    //    两源——连改几条=连发全量重拉风暴，600ms 尾沿合并成一次；全量=load 五路+日轴 rpc） ──
    let rescanTimer: ReturnType<typeof setTimeout> | undefined;
    async function refreshAll(): Promise<void> {
        await load();
        await refreshBoard();
        await refreshLedgerEntries(viewDay); // ammo □7：实况段随写广播一并刷新
    }
    function scheduleRescan(): void {
        clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => {
            rescanTimer = undefined;
            void refreshAll();
        }, 600);
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

    // caltab：已开页签的切日通道（openTimeline 落参——detail={date, focusKey?}；date 非法=仅聚焦）
    function onGotoDay(e: Event): void {
        const detail = (e as CustomEvent).detail;
        const d = detail?.date;
        if (typeof d === "string" && DATE_OK.test(d)) {
            viewDay = d;
            const fk = detail?.focusKey;
            if (typeof fk === "string" && fk) pendingFocus = { key: fk, day: d };
        }
    }
    $effect(() => {
        window.addEventListener("pj-tl-goto-day", onGotoDay);
        return () => window.removeEventListener("pj-tl-goto-day", onGotoDay);
    });

    const HOURS = Array.from({ length: 24 }, (_, h) => h);
    let axisEl = $state<HTMLElement | null>(null);
    let trayEl = $state<HTMLElement | null>(null);

    /** 当日班表块 rpc 拉取（viewDay 变化/写广播/重载触发；树真相=写后立读安全） */
    async function refreshBoard(): Promise<void> {
        if (!readDayBoard) return;
        const r = await readDayBoard(viewDay).catch(() => null);
        // 翻页竞态守卫：回包时视图日已换=弃
        if (r?.ok && r.items && readDayBoard) boardItems = rpcItemsToSched(r.items, viewDay);
    }
    function rpcItemsToSched(items: NonNullable<BoardReadShape["items"]>, day: string): SchedItem[] {
        return items.map((i) => ({ key: i.key, summary: i.summary, date: day, start: i.start, end: i.end, hard: i.hard, origin: i.origin, ...(i.allDay ? { allDay: true } : {}), createdAt: "", updatedAt: "" }));
    }

    $effect(() => {
        viewDay;
        boardItems = []; // 翻日先清空（防上一日条目闪现）
        void refreshBoard();
        void refreshLedgerEntries(viewDay);
    });

    /** ammo □7：当日实况段拉取（块树直读 rpc 无索引窗——但留竞态守卫同款：翻日弃旧回包）。
     *  刷新触发=viewDay 变化/写广播 refreshAll/pj-ammo-state（开始/停止落账——内存事件链） */
    async function refreshLedgerEntries(d: string): Promise<void> {
        if (!loadLedgerEntries) return;
        const r = await loadLedgerEntries(d).catch(() => null);
        if (viewDay === d && r) ledgerEntries = r;
    }

    // ammo □7：引擎广播→实况段重拉（今天才刷——历史日打点不被引擎动作改动）
    $effect(() => {
        if (!loadLedgerEntries) return;
        const onAmmo = () => {
            if (viewDay === todayIso) void refreshLedgerEntries(viewDay);
        };
        window.addEventListener("pj-ammo-state", onAmmo);
        return () => window.removeEventListener("pj-ammo-state", onAmmo);
    });

    // 轴滚动：视图日变化→滚到首条 slot 或 now 线（默认 00 顶会把上午藏在折叠线上——月历同款）
    $effect(() => {
        axis;
        viewDay;
        const el = axisEl;
        if (!el) return;
        const first = el.querySelector(".pj-cal__slot") instanceof HTMLElement ? el.querySelector(".pj-cal__slot") as HTMLElement : null;
        const nowLine = el.querySelector(".pj-cal__nowline") instanceof HTMLElement ? el.querySelector(".pj-cal__nowline") as HTMLElement : null;
        const anchor = first ?? nowLine;
        // P2③：滚动位吸附整点刻度——固定 24px 偏移会把顶行切出半行残影；向下取整到整点行首
        el.scrollTop = anchor ? Math.floor(Math.max(0, anchor.offsetTop - 24) / PX_PER_HOUR) * PX_PER_HOUR : 0;
    });

    // ── focusKey 定位：axis 到位（board rpc/实例窗回包→axis 重算）后匹配槽位→高亮+滚动。
    //    匹配面=key/blockId/eventId 三通道（board/remind/task 槽 key=块 id；feishu 一次性槽
    //    key=event id；循环实例槽 key=实例行 id——月历侧只有 eventId，走 eventId 通道命中）。
    //    未命中不弃（axis 每次重算重进）；10s 落空兜底放弃（条目已删/键形不符）。 ──
    $effect(() => {
        axis;
        pendingFocus;
        viewDay;
        const pf = pendingFocus;
        if (!pf || pf.day !== viewDay || !axis) return;
        const hit = axis.slots.find((s) => s.key === pf.key || s.blockId === pf.key || s.eventId === pf.key);
        if (!hit) return;
        pendingFocus = null;
        focusFlash = hit.key;
        const el = axisEl?.querySelector(`[data-slot-key="${hit.key}"]`);
        if (el instanceof HTMLElement) {
            setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
        }
        setTimeout(() => {
            if (focusFlash === hit.key) focusFlash = null;
        }, 2600);
    });
    $effect(() => {
        if (!pendingFocus) return;
        const tId = setTimeout(() => (pendingFocus = null), 10_000); // 落空兜底（防永挂）
        return () => clearTimeout(tId);
    });

    // ── 指针拖动（15 分钟吸附；有块=实可拖改属性——board 走 schedEdit、remind/task 直写属性） ──

    // ── 期 2 ⑤ 条目右键三动作+轴空白右键创建（bear 二轮拍板：重建块/删除含块/去时间；创建=空条目块+跳日记聚焦+15min 吸附） ──

    /** 右键动作执行上下文（槽/托盘行通用视图） */
    interface EntryCtx {
        source: DayAxisSlot["source"];
        key: string;
        blockId?: string;
        eventId?: string;
        virtual: boolean;
        start: string | null;
        /** 虚显行落地可行性旗标（rebuild 动作可用性——行级真值，恒 true 会对不可落地事件摆空枪） */
        adoptable?: boolean;
    }

    function openEntryMenu(e: MouseEvent, acts: DayMenuAction[], ctx: EntryCtx): void {
        // ⑥（⑤ review 新-2 顺手修）：无动作行也吞 contextmenu——不吞会冒泡到轴容器被创建菜单
        // 截胡（槽在轴内）/出浏览器原生菜单（托盘行）；吞=右键静默，条目上不摆「在 HH:mm 新建」
        e.preventDefault();
        e.stopPropagation();
        if (!acts.length) return; // 循环 remind/burden/循环实例行=无动作，不出菜单
        const menu = new Menu("pj-tl-entry-ctx");
        for (const a of acts) {
            if (a === "rebuild") {
                menu.addItem({ label: t.calMenuRebuild ?? "重建块", click: () => void adoptOne({ eventId: ctx.eventId, adoptable: ctx.adoptable !== false }) });
            } else if (a === "delete") {
                menu.addItem({ label: t.calMenuDelete ?? "删除", click: () => void runEntryDelete(ctx) });
            } else {
                menu.addItem({ label: t.calMenuUntime ?? "去掉时间", click: () => void runEntryUntime(ctx) });
            }
        }
        menu.open({ x: e.clientX, y: e.clientY });
    }

    function slotContextMenu(e: MouseEvent, s: DayAxisSlot): void {
        openEntryMenu(e, entryMenuActions({ source: s.source, virtual: s.virtual, blockId: s.blockId, repeat: s.repeat, timed: true, adoptable: s.adoptable, adoptBlock: s.adoptBlock }), {
            source: s.source, key: s.key, blockId: s.blockId, eventId: s.eventId, virtual: s.virtual, start: s.start, adoptable: s.adoptable,
        });
    }

    function trayContextMenu(e: MouseEvent, r: DayAxisTrayRow): void {
        openEntryMenu(e, entryMenuActions({ source: r.source, virtual: r.virtual, blockId: r.blockId, timed: false, adoptable: r.adoptable, adoptBlock: r.adoptBlock }), {
            source: r.source, key: r.key, blockId: r.blockId, eventId: r.eventId, virtual: r.virtual, start: null, adoptable: r.adoptable,
        });
    }

    /** 删除：虚显=删飞书事件（订阅日历报错可见）；board=连块删（remove 通道）；remind/task=删块（镜像事件下轮同步自清） */
    async function runEntryDelete(ctx: EntryCtx): Promise<void> {
        if (ctx.virtual) {
            if (!ctx.eventId || !deleteForeignEvent) return;
            await deleteForeignEvent(ctx.eventId); // rpc 内已触发镜像轮询→广播回来防抖自刷（虚显行消失）
            return;
        }
        if (!ctx.blockId) return;
        if (ctx.source === "board") {
            await removeItem(ctx.key);
            return;
        }
        // remind/task 删除=连内容块一起删（属性可挂任意大小正文块；API 事务不进 undo 栈）——
        // 先确认（review P1-2）；board li=插件管辖区不设防
        const yes = await new Promise<boolean>((res) => {
            confirm("⚠️", t.calDeleteBlockConfirm ?? "将删除整个内容块（不可撤销，恢复只能靠文档历史）", () => res(true), () => res(false));
        });
        if (!yes) return;
        if (!deleteBlockEntry || !(await deleteBlockEntry(ctx.blockId))) return;
        patchLocalGone(ctx.blockId);
    }

    /** 去时间：块保留、退役出日程——board=清时刻变托盘；remind/task=清时间属性（本地乐观更新即时反馈） */
    async function runEntryUntime(ctx: EntryCtx): Promise<void> {
        if (!ctx.blockId) return;
        if (ctx.source === "board") {
            await untimeBoardItem(ctx);
            return;
        }
        if (ctx.source === "remind") {
            if (untimeRemindBlock && await untimeRemindBlock(ctx.blockId)) patchLocalGone(ctx.blockId);
            return;
        }
        if (untimeTaskDueTime && await untimeTaskDueTime(ctx.blockId)) patchLocalGone(ctx.blockId);
    }

    /** board 条目去时间（=拖回托盘语义：schedEdit move to start:null，heal 载荷保真） */
    async function untimeBoardItem(ctx: EntryCtx): Promise<void> {
        if (!schedEdit) return;
        await schedEdit({ type: "move", key: ctx.key, to: { start: null } });
        void refreshBoard();
    }

    /** 删块/去时间后本地剔除行（SQL 索引窗内重查拿旧值——乐观 patch 保即时反馈） */
    function patchLocalGone(blockId: string): void {
        if (!raw) return;
        raw = {
            ...raw,
            remindRows: raw.remindRows.filter((r) => r.id !== blockId),
            taskRows: raw.taskRows.filter((r) => r.id !== blockId),
        };
    }

    /** 轴空白右键创建：落点分钟 15min 吸附→菜单「在 HH:mm 新建条目」→空段落块+跳日记聚焦（用户主动要写=聚焦正当） */
    function axisContextMenu(e: MouseEvent): void {
        const el = axisEl;
        if (!createRemindEntry || !(e.target instanceof Node) || !el.contains(e.target)) return;
        const rect = el.getBoundingClientRect();
        const pointerMin = (e.clientY - rect.top + el.scrollTop) / PX_PER_MIN;
        if (pointerMin < 0 || pointerMin >= 24 * 60) return;
        const at = snapToStep(pointerMin);
        e.preventDefault();
        const menu = new Menu("pj-tl-create-ctx");
        menu.addItem({ label: (t.calCreateAt ?? "在 {t} 新建条目").replace("{t}", minToHM(at)), click: () => void createBoardEntryAt(at) });
        menu.open({ x: e.clientX, y: e.clientY });
    }

    /** 建带时间空**段落块**（tb2 H1 bear 拍板「先简单只支持段落块」）：kernel rpc 插块+挂
     *  custom-remind-at（无 sched-origin/无 petal 行）→走 remind 链全家桶（同步/块面时间/
     *  日轴 remind 源），绕开班表草稿闸+petal 回流缺口 →跳日记聚焦该块（用户主动要写=聚焦正当）；
     *  空段=草稿，写上内容 remind 链下轮推 */
    async function createBoardEntryAt(min: number): Promise<void> {
        const r = await createRemindEntry?.(viewDay, minToHM(min));
        if (!r?.ok || !r.blockId) {
            showMessage(t.calCreateFail ?? "创建失败", 3000, "error");
            return;
        }
        // 乐观 patch 即时上屏（review P1-2）：loadRemindRows 走 SQL，rpc 落块后索引窗最长 ~17s，
        // refreshAll 大概率查回旧值把新行冲掉——故不重拉（patchLocalGone/Remind 同款先例）；
        // 下次事件驱动/手动刷新以 SQL 真值替换，形态一致
        if (raw) raw = { ...raw, remindRows: [...raw.remindRows, { id: r.blockId, at: `${viewDay}T${minToHM(min)}`, repeat: null, end: null, content: "" }] };
        openBlockFocused?.(r.blockId);
    }

    // ── dataview □5②：弹药卡外拖落轴=建锚点+出发（HTML5 DnD——四象限面板任务行为拖源） ──
    /** 拖卡悬停的吸附分钟（null=不在轴上/非本源拖拽——不亮落点态不抢事件） */
    let ammoDropMin = $state<number | null>(null);

    function axisAmmoDragOver(e: DragEvent): void {
        const el = axisEl;
        if (!el || !hasAmmoCard(e.dataTransfer?.types)) return; // 非拖卡载荷（文本/块拖拽）不拦
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = el.getBoundingClientRect();
        ammoDropMin = dropMinuteOf({ clientY: e.clientY, axisTop: rect.top, scrollTop: el.scrollTop, pxPerMin: PX_PER_MIN });
    }

    function axisAmmoDragLeave(): void {
        ammoDropMin = null;
    }

    /** 落卡链：建锚点（schedEdit add 稳定键）→今日轴再出发（ammo-depart □3 同链——
     *  task=锚点条目块 id、start=落卡当下；非今日=只建锚点，到点走 □3 提醒链） */
    async function axisAmmoDrop(e: DragEvent): Promise<void> {
        const el = axisEl;
        ammoDropMin = null;
        if (!el) return;
        const card = cardDataOf(e.dataTransfer);
        if (!card) return; // MIME 缺（非本源）=静默弃
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const dropMin = dropMinuteOf({ clientY: e.clientY, axisTop: rect.top, scrollTop: el.scrollTop, pxPerMin: PX_PER_MIN });
        if (dropMin == null) return; // 轴外落点（min 兜底重算——dragover 与 drop 间隙坐标以 drop 为准）
        if (!schedEdit) {
            showMessage(t.ammoDropNoChannel ?? "班表写通道不在——锚点未建", 3000, "error");
            return;
        }
        const st = await schedEdit(anchorAddOp(viewDay, dropMin, card));
        if (!st) {
            showMessage(t.ammoDropAnchorFail ?? "锚点未建（班表写入失败）", 3000, "error");
            return;
        }
        if (!shouldDepartOnDrop(viewDay, todayIso) || !ammoRpc) {
            showMessage((t.ammoDropAnchored ?? "已建锚点：{s} {t}").replace("{s}", card.name).replace("{t}", minToHM(dropMin)), 2500, "info");
            return; // 非今日轴/无引擎通道=只建锚点
        }
        // 锚点块 id 回读（schedEdit 返回值不带块 id；board 读面 key=块 id——getChildBlocks
        // 直读通道，写后立读安全）
        const board = await readDayBoard?.(viewDay);
        const anchorId = board?.ok ? anchorBlockIdOf(board.items ?? [], dropMin, card.name) : null;
        if (!anchorId) {
            showMessage((t.ammoDropAnchored ?? "已建锚点：{s} {t}").replace("{s}", card.name).replace("{t}", minToHM(dropMin)), 2500, "info");
            return; // 锚点在（建成功）；出发指针没拿到=不裸出发（引擎 task 指针校验会拒）
        }
        const p = buildDepartParams({
            summary: card.name,
            task: anchorId,
            now: new Date(),
            day: todayIso,
            owner: wsAppId((window as any).siyuan?.ws?.ws?.url),
        });
        const r = await ammoRpc.call[AMMO_DEPART_METHOD]?.(p).catch(() => null);
        if (r?.ok) {
            showMessage((t.ammoDropDeparted ?? "已出发：{s}").replace("{s}", card.name), 2500, "info");
        } else {
            showMessage((t.ammoDropDepartFail ?? "出发失败（锚点已建）：{msg}").replace("{msg}", String(r?.error ?? (t.schedNotifyDepartTimeout ?? "rpc 无响应"))), 3500, "error");
        }
    }

    /** 槽位 tooltip：源标签+时刻+摘要+虚实/循环语义注（信息平铺不藏 hover 的截断兜底） */
    function slotTitle(s: DayAxisSlot): string {
        const base = `${SRC_LABEL[s.source] ?? s.source} ${s.start}${s.end ? `–${s.end}` : ""} ${s.summary}`;
        if (s.virtual) return `${base}（${t.schedVirtualTip ?? "飞书镜像·虚显"}）`;
        if (s.source === "remind" && s.repeat) return `${base}（${t.schedRepeatTip ?? "循环提醒·不可拖"}）`;
        if (s.source === "live") return `${base}（${t.ammoLiveSlotTip ?? "实况回填·只读"}）`;
        return base;
    }

    function slotClick(s: DayAxisSlot): void {
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        if (s.blockId) openBlock(s.blockId);
    }

    function slotDraggable(s: DayAxisSlot): boolean {
        if (s.virtual || !s.blockId) return false; // 虚块（飞书镜像）display-only
        if (s.source === "remind" && s.repeat) return false; // 循环提醒：改基础时刻会挪全部实例
        if (s.source === "live") return false; // ammo □7 实况段：append-only 不动历史（改历史=改日账本体）
        return Boolean(schedEdit || moveRemindBlock || moveTaskDueTime);
    }

    function slotPointerDown(e: PointerEvent, s: DayAxisSlot): void {
        if (e.button !== 0 || !slotDraggable(s)) return;
        e.preventDefault();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        drag = {
            key: s.key,
            source: s.source,
            blockId: s.blockId!,
            fromMin: hmToMin(s.start),
            endMin: s.end ? hmToMin(s.end) : null,
            grabMin: Math.max(0, (e.clientY - rect.top) / PX_PER_MIN),
            curMin: hmToMin(s.start),
            over: "axis",
            moved: false,
        };
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragUp, { once: true });
        window.addEventListener("pointercancel", onDragCancel, { once: true });
    }

    function trayPointerDown(e: PointerEvent, r: DayAxisTrayRow): void {
        // 托盘 board 条目=可拖上轴（remind/task/虚块托盘行 display-only）
        if (e.button !== 0 || r.source !== "board" || !r.blockId || !schedEdit) return;
        e.preventDefault();
        drag = {
            key: r.key,
            source: "board",
            blockId: r.blockId,
            fromMin: null,
            endMin: null,
            grabMin: 0,
            curMin: 0,
            over: "tray",
            moved: false,
        };
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragUp, { once: true });
        window.addEventListener("pointercancel", onDragCancel, { once: true });
    }

    function onDragMove(e: PointerEvent): void {
        const d = drag;
        if (!d) return;
        if (!d.moved) d.moved = true;
        const el = axisEl;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const pointerMin = (e.clientY - rect.top + el.scrollTop) / PX_PER_MIN;
        d.curMin = snapToStep(pointerMin - d.grabMin);
        d.over = "axis";
        if (trayEl && d.source === "board") {
            const tr = trayEl.getBoundingClientRect();
            if (e.clientY >= tr.top && e.clientY <= tr.bottom) d.over = "tray";
        }
    }

    function onDragCancel(): void {
        window.removeEventListener("pointermove", onDragMove);
        drag = null;
    }

    async function onDragUp(): Promise<void> {
        window.removeEventListener("pointermove", onDragMove);
        const d = drag;
        drag = null;
        if (!d) return;
        if (!d.moved) return; // 原地按下抬起=点击（click 通道自理）
        suppressClick = true; // 拖完吞一拍 click
        if (d.over === "tray") {
            if (d.source === "board" && d.fromMin !== null) await commitBoardMove(d, null); // 定时→托盘
            return;
        }
        const toHM = minToHM(d.curMin);
        if (d.fromMin !== null && toHM === minToHM(d.fromMin)) return; // 原位放下=零写零记录
        if (d.source === "board") await commitBoardMove(d, toHM);
        else if (d.source === "remind" && moveRemindBlock) {
            // 保时长平移（无 end=null；越界钳 23:59——minToHM 自带）
            const endHM = d.endMin !== null ? minToHM(Math.min(24 * 60 - 1, d.curMin + (d.endMin - d.fromMin!))) : null;
            if (await moveRemindBlock(d.blockId, viewDay, toHM, endHM)) patchLocalRemind(d.blockId, viewDay, toHM, endHM);
        } else if (d.source === "task" && moveTaskDueTime) {
            if (await moveTaskDueTime(d.blockId, toHM)) patchLocalTask(d.blockId, toHM);
        }
    }

    async function commitBoardMove(d: NonNullable<typeof drag>, toStart: string | null): Promise<void> {
        if (!schedEdit) return;
        // 期 4：行恒从当日块读面组装（schedEdit 内部取数），拖动不再带 heal 载荷
        await schedEdit({ type: "move", key: d.blockId, to: { start: toStart } });
        void refreshBoard(); // rpc 真值替换（树真相，写后立读安全）
    }

    /** remind 拖后本地乐观更新（SQL 索引窗内重查会拿旧值——本地 patch 保拖动即时反馈） */
    function patchLocalRemind(blockId: string, day: string, start: string, end: string | null): void {
        if (!raw) return;
        raw = {
            ...raw,
            remindRows: raw.remindRows.map((r) =>
                r.id === blockId ? { ...r, at: `${day}T${start}`, end: end ? `${day}T${end}` : null } : r,
            ),
        };
    }

    function patchLocalTask(blockId: string, time: string): void {
        if (!raw) return;
        raw = { ...raw, taskRows: raw.taskRows.map((r) => (r.id === blockId ? { ...r, due_time: time } : r)) };
    }

    async function removeItem(key: string): Promise<void> {
        if (!schedEdit) return;
        await schedEdit({ type: "remove", key });
        void refreshBoard();
    }

    async function addItem(): Promise<void> {
        if (!schedEdit) return;
        const summary = addSummary.trim();
        if (!summary) return;
        addTimeBad = Boolean(addTime.trim()) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(addTime.trim());
        if (addTimeBad) return;
        const s = await schedEdit({
            type: "add",
            day: viewDay,
            item: { summary: summary.slice(0, 100), start: addTime.trim() || null, end: null, hard: addHard },
        });
        if (s) {
            addSummary = "";
            addTime = "";
            void refreshBoard();
        }
    }

    /** 翻日（前一天/后一天；addDays 正午锚点免疫时区/夏令时边界） */
    function shiftDayNav(delta: number): void {
        viewDay = addDays(viewDay, delta);
    }

    function goToday(): void {
        viewDay = todayIso;
    }

    function weekdayOf(date: string): string {
        // 周一起的星期序（周一=1..周日=7）——i18n 键 calWd1..7
        const d = new Date(date + "T00:00").getDay();
        return WEEKDAYS[d === 0 ? 6 : d - 1];
    }

    // □16 历法层：顶栏标题带农历/节日+休班（信息平铺不藏 hover）
    function almSuffix(date: string): string {
        const a = dayAlmanac(date);
        const badge = a.off ? t.calHolidayOff : a.work ? t.calHolidayWork : "";
        return a.lunarText ? ` · ${a.lunarText}${badge ? ` ${badge}` : ""}` : "";
    }
</script>

<div class="pj-tl fn__flex-column">
    {#if loading}
        <div class="pj-cal__state">{t.dashboardLoading}</div>
    {:else if loadError}
        <div class="pj-cal__state">
            <div>{t.calLoadFailed}</div>
            <button class="b3-button b3-button--small b3-button--outline" onclick={() => (reloadTick += 1)}>{t.calRetry}</button>
        </div>
    {:else}
        <!-- caltab 顶栏：◀ 前一天 ｜ 日期·周几·农历(含班/休)·共 N 项 ｜ 后一天 ▶ ＋ 回今天（bear 拍板） -->
        <div class="pj-tl__topbar fn__flex">
            <div class="pj-tl__nav fn__flex">
                <button class="b3-button b3-button--small b3-button--outline pj-cal__navbtn" onclick={() => shiftDayNav(-1)} aria-label={t.tlPrevDay ?? "前一天"} title={t.tlPrevDay ?? "前一天"}>‹</button>
                <span class="pj-tl__title">{viewDay} · {weekdayOf(viewDay)}{almSuffix(viewDay)}</span>
                <button class="b3-button b3-button--small b3-button--outline pj-cal__navbtn" onclick={() => shiftDayNav(1)} aria-label={t.tlNextDay ?? "后一天"} title={t.tlNextDay ?? "后一天"}>›</button>
            </div>
            <button class="b3-button b3-button--small b3-button--outline" onclick={goToday}>{t.tlBackToday ?? "回今天"}</button>
            <span class="fn__flex-1"></span>
            <!-- ammo □7：实况手动同步钮（dock 头/悬浮窗同引擎同状态源；day=viewDay 翻日跟手） -->
            {#if ammoRpc}
                <AmmoLiveSyncButton {t} rpc={ammoRpc} day={viewDay} />
            {/if}
            <span class="pj-cal__day-count">{t.calDayCount.replace("{n}", String((axis?.slots.length ?? 0) + (axis?.tray.length ?? 0)))}</span>
            <span class="pj-cal__day-hint">{t.schedDragHint}</span>
        </div>

        <!-- timeblock 期 2 ② 统一时间轴（Calendar 日面板平移）：当天全部带时间的东西都上轴。
             caltab：轴恒展开——0 条目也整轴渲染+nowline（月历侧空态不渲染病灶根治点）。
             虚实：实线边=有块可拖改属性；虚线边半透明=飞书镜像虚显。同步徽标=账本 sched:<块id>
             有 entry（只挂 board 定时槽）。拖动 15 分钟吸附。 -->
        <div class="pj-cal__day">
            <!-- 托盘：未定时 board 条目（可拖上轴）+飞书全天/burden/无时刻任务（display-only） -->
            <div class="pj-cal__tray" bind:this={trayEl} class:pj-cal__tray--hot={drag?.over === "tray" && drag.moved}>
                <span class="pj-cal__tray-label">{t.schedTray}</span>
                {#each axis?.tray ?? [] as r (r.key)}
                    {@render trayChip(r)}
                {/each}
                {#if !axis || axis.tray.length === 0}<span class="pj-cal__tray-empty">—</span>{/if}
            </div>

            <!-- 24h 真占位轴：top=start×px/min、height=时长×px/min、重叠分道并列；空白右键=创建
                 （15min 吸附；键盘流走下方 addrow 输入框，右键=增强通道不承诺键盘等价）。
                 --pj-axis-pxh=刻度行高同源通道：slot/nowline/droplabel 全按 PX_PER_MIN 定位，
                 刻度尺必须同一 PX_PER_HOUR——增补批复审 high 实锤：56px 期刻度行残留 48px，
                 09:30 槽渲染在 11:00 刻度处（视觉时差随时长线性放大）；CSS var 注入=改一处常量
                 两处同动，杜绝再掉队 -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="pj-cal__axis"
                class:pj-cal__axis--ammohot={ammoDropMin !== null}
                style="--pj-axis-pxh:{PX_PER_HOUR}px"
                bind:this={axisEl}
                oncontextmenu={axisContextMenu}
                ondragover={axisAmmoDragOver}
                ondragleave={axisAmmoDragLeave}
                ondrop={(e: DragEvent) => void axisAmmoDrop(e)}
            >
                {#each HOURS as h (h)}
                    <div class="pj-cal__axis-hour"><span>{String(h).padStart(2, "0")}:00</span></div>
                {/each}
                {#if nowLineMin !== null}<div class="pj-cal__nowline" style="top:{nowLineMin * PX_PER_MIN}px"><span class="pj-cal__nowline-hm">{minToHM(nowLineMin)}</span></div>{/if}
                {#each axis?.slots ?? [] as s (s.key)}
                    {@const dragging = drag?.key === s.key}
                    {@const topMin = dragging && drag ? drag.curMin : hmToMin(s.start)}
                    <div
                        class="pj-cal__slot pj-cal__slot--{s.source}"
                        class:pj-cal__slot--virtual={s.virtual}
                        class:pj-cal__slot--hard={s.hard === true}
                        class:pj-cal__slot--due={s.isDue}
                        class:pj-cal__slot--dragging={dragging}
                        class:pj-cal__slot--nodrag={!slotDraggable(s)}
                        class:pj-cal__slot--focus={focusFlash === s.key}
                        class:pj-cal__slot--active={nowLineMin !== null && slotIsActiveAt(s, nowLineMin)}
                        data-slot-key={s.key}
                        style="top:{topMin * PX_PER_MIN}px;height:{Math.max(s.durationMin, DAY_AXIS_MIN_SLOT_MIN) * PX_PER_MIN}px;left:calc(44px + (100% - 44px) * {s.lane / Math.max(s.lanes, 1)} + 2px);width:calc((100% - 44px) / {Math.max(s.lanes, 1)} - 6px);"
                        title={slotTitle(s)}
                        role="button"
                        tabindex="0"
                        onpointerdown={(e) => slotPointerDown(e, s)}
                        oncontextmenu={(e) => slotContextMenu(e, s)}
                        onclick={() => slotClick(s)}
                        onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); slotClick(s); } }}
                    >
                        <span class="pj-cal__slot-time">{s.start}{#if s.end}–{s.end}{/if}</span>
                        <span class="pj-cal__slot-summary">{s.summary || (s.source === "live" ? (t.ammoLiveEmptySummary ?? "（未命名打点）") : (t.schedEmptySummary ?? "（空条目）"))}</span>
                        {#if s.source === "board"}<span class="pj-cal__slot-sync" class:pj-cal__slot-sync--on={s.synced} title={s.synced ? t.schedSyncedTip : t.schedUnsyncedTip}>{s.synced ? t.schedSyncedShort : t.schedUnsyncedShort}</span>{/if}
                        {#if s.source === "live"}
                            <span class="pj-cal__slot-sync pj-cal__slot-sync--live" class:pj-cal__slot-sync--on={s.synced} title={s.synced ? (t.ammoLiveSyncedTip ?? "实况已同步飞书") : (t.ammoLiveUnsyncedTip ?? "实况未同步飞书")}>{s.synced ? t.schedSyncedShort : t.schedUnsyncedShort}</span>
                            {#if s.unclosed}<i class="pj-cal__slot-tag pj-cal__slot-tag--live-open">{t.ammoLiveOpenTag ?? "进行中"}</i>{/if}
                            {#if s.pool}<i class="pj-cal__slot-tag pj-cal__slot-tag--pool">{poolLabel(s.pool)}</i>{/if}
                            {#if s.anchor}<i class="pj-cal__slot-tag">{t.ammoAnchorTag ?? "锚点"}</i>{/if}
                        {/if}
                        {#if false && s.source === "feishu" && s.eventId && adoptForeign}
                            <button
                                class="pj-cal__adopt"
                                disabled={!s.adoptable || adopting}
                                title={s.adoptable ? (t.calAdoptTip ?? "").replace("{s}", () => s.summary) : ADOPT_BLOCK_TIP[s.adoptBlock ?? ""] ?? ""}
                                aria-label={t.calAdoptBtn}
                                onpointerdown={(e) => e.stopPropagation()}
                                onclick={(e) => { e.stopPropagation(); suppressClick = true; void adoptOne({ eventId: s.eventId, adoptable: s.adoptable }); }}
                            >{t.calAdoptBtn}</button>
                        {/if}
                        {#if s.source === "board"}
                            <button class="pj-cal__slot-x" aria-label={t.schedRemove} title={t.schedRemove}
                                onpointerdown={(e) => e.stopPropagation()}
                                onclick={(e) => { e.stopPropagation(); suppressClick = true; void removeItem(s.key); }}
                            >×</button>
                        {/if}
                    </div>
                {/each}
                {#if drag && drag.moved}
                    {@const dragEnd = drag.endMin !== null && drag.fromMin !== null ? minToHM(Math.min(24 * 60 - 1, drag.curMin + (drag.endMin - drag.fromMin))) : null}
                    <div class="pj-cal__droplabel" style="top:{drag.curMin * PX_PER_MIN}px">{drag.over === "tray" ? t.schedTray : minToHM(drag.curMin)}{#if dragEnd}–{dragEnd}{/if}</div>
                {/if}
                {#if ammoDropMin !== null}
                    <!-- □5② 拖卡落点标签（吸附时刻+任务名——建锚点+出发的落点预告） -->
                    <div class="pj-cal__droplabel pj-cal__droplabel--ammo" style="top:{ammoDropMin * PX_PER_MIN}px">{minToHM(ammoDropMin)}</div>
                {/if}
            </div>

            {#if schedEdit}
                <div class="pj-cal__addrow">
                    <input
                        class="b3-text-field fn__flex-1"
                        placeholder={t.schedAddPh}
                        bind:value={addSummary}
                        onkeydown={(e) => { if (e.key === "Enter") void addItem(); }}
                    />
                    <input
                        class="b3-text-field pj-cal__addtime"
                        class:pj-cal__addtime--bad={addTimeBad}
                        placeholder={t.schedAddTimePh}
                        maxlength="5"
                        bind:value={addTime}
                    />
                    <button
                        class="b3-button b3-button--small pj-cal__addhard"
                        class:pj-cal__addhard--on={addHard}
                        onclick={() => (addHard = !addHard)}
                    >{addHard ? t.schedHardTag : t.schedFlexTag}</button>
                    <button class="b3-button b3-button--small" onclick={() => void addItem()}>{t.schedAddBtn}</button>
                </div>
            {/if}
        </div>
    {/if}
</div>

{#snippet trayChip(r: DayAxisTrayRow)}
    {@const isReport = r.source === "board" && r.origin === "report"}
    {#if r.source === "board"}
        <span
            class="pj-cal__chip"
            class:pj-cal__chip--report={isReport}
            class:pj-cal__chip--dragging={drag?.key === r.key}
            title={isReport ? t.weeklyUnreadTip : undefined}
            role="button"
            tabindex="0"
            onpointerdown={(e) => trayPointerDown(e, r)}
            oncontextmenu={(e) => trayContextMenu(e, r)}
            onclick={() => {
                if (suppressClick) { suppressClick = false; return; }
                if (isReport) openReportOfDay(viewDay);
                else if (r.blockId && !drag) openBlock(r.blockId);
            }}
            onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (isReport) openReportOfDay(viewDay);
                    else if (r.blockId) openBlock(r.blockId);
                }
            }}
        >{#if isReport && reportUnreadOfDay(viewDay)}<i class="pj-cal__chip-unread" aria-label={t.weeklyUnreadTip}></i>{/if}{r.source === "board" ? (r.summary || (t.schedEmptySummary ?? "（空条目）")) : r.summary}
            {#if r.allDay}<i class="pj-cal__chip-tag">{t.schedAllDayTag ?? "全天"}</i>{/if}
            {#if r.origin === "roll"}<i class="pj-cal__chip-tag">{t.schedRollTag}</i>{/if}
            <button class="pj-cal__chip-x" aria-label={t.schedRemove} title={t.schedRemove}
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => { e.stopPropagation(); suppressClick = true; void removeItem(r.key); }}
            >×</button>
        </span>
    {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span class="pj-cal__chip pj-cal__chip--virtual" oncontextmenu={(e) => trayContextMenu(e, r)}>
            <i class="pj-cal__dot pj-cal__dot--{r.source}"></i>{r.summary}
            {#if false && r.source === "feishu" && r.eventId && adoptForeign}
                <button
                    class="pj-cal__adopt"
                    disabled={!r.adoptable || adopting}
                    title={r.adoptable ? (t.calAdoptTip ?? "").replace("{s}", () => r.summary) : ADOPT_BLOCK_TIP[r.adoptBlock ?? ""] ?? ""}
                    aria-label={t.calAdoptBtn}
                    onclick={(e) => { e.stopPropagation(); void adoptOne({ eventId: r.eventId, adoptable: r.adoptable }); }}
                >{t.calAdoptBtn}</button>
            {/if}
        </span>
    {/if}
{/snippet}

<style lang="scss">
    .pj-tl {
        height: 100%;
        overflow-y: auto;
        padding: 8px 16px 16px;
        gap: 8px;
        box-sizing: border-box;
    }

    /* 顶栏：翻日组+回今天+计数/提示；sticky 贴滚动容器顶（不透明底防内容透过） */
    .pj-tl__topbar {
        position: sticky;
        top: 0;
        z-index: 4;
        background-color: var(--b3-theme-surface);
        gap: 8px;
        align-items: center;
        padding: 4px 0;
    }

    .pj-tl__nav {
        gap: 4px;
        align-items: center;
    }

    .pj-tl__title {
        min-width: 0;
        text-align: center;
        font-size: 15px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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

    /* 翻日钮（月历翻月钮同款尺寸） */
    .pj-cal__navbtn {
        padding: 2px 10px;
        font-size: 15px;
        line-height: 1.4;
        white-space: nowrap;
    }

    /* ── 以下全部=Calendar.svelte 日面板 scoped 样式逐条平移（类名同款，两组件各自 scoped） ── */

    .pj-cal__day {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 8px;
        padding: 8px 10px;
        flex: 1 1 0; /* 增补一 □4：日面板吃根列余高（min-content 地板天然保住托盘/添加行） */
        /* 视觉终审 P1：月历时代的主色 3px 左饰条在独立页签=左缘通高蓝竖条（亮暗两态均在）
         * ——四边统一 1px 细边；原 color-mix(primary 5%) 底同步退役（无饰条后孤立色块） */
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-surface);
    }

    .pj-cal__day-count {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        flex-shrink: 0;
    }

    /* 视觉终审 P1：原 nowrap+flex-shrink:0 在窄面板把提示顶出右缘硬裁无省略号——
     * 允许自然换行（信息平铺不折叠进 hover；CJK 行内可断） */
    .pj-cal__day-hint {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        min-width: 0;
        text-align: right;
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

    /* □17 feishu 回流（紫；主题变量无紫档，钉双主题色值） */
    .pj-cal__dot--feishu {
        background-color: #7c5cd6;
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__dot--feishu {
        background-color: #a78bfa;
    }

    /* □17 落地钮（随槽平移；当前 {#if false} 关闭态） */
    .pj-cal__adopt {
        flex-shrink: 0;
        margin-left: auto;
        padding: 1px 8px;
        border: 1px solid var(--b3-theme-surface-lighter);
        border-radius: 4px;
        background: transparent;
        font-family: inherit;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
        white-space: nowrap;
    }

    .pj-cal__adopt:hover:not(:disabled) {
        background-color: var(--b3-list-hover, var(--b3-theme-surface-lighter));
        color: var(--b3-theme-on-background);
    }

    .pj-cal__adopt:disabled {
        color: var(--b3-theme-on-surface-light);
        border-color: var(--b3-border-color);
        cursor: not-allowed;
    }

    /* sloop □4 班表源（teal——主题变量无 teal 档，钉双主题色值） */
    .pj-cal__dot--sched {
        background-color: #0d9488;
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__dot--sched {
        background-color: #2dd4bf;
    }

    .pj-cal__tray {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        padding: 4px 6px;
        border: 1px dashed var(--b3-border-color);
        border-radius: 6px;
        min-height: 30px;
    }

    .pj-cal__tray-label {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-cal__tray-empty {
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    /* 24h 真占位轴：左边 44px 刻度沟（padding 化——沟在 padding box 内，刻度 span 负
     * left 不被 overflow 裁）。增补一 □4：独立页签撑满余高（grow 比例非 basis 百分比——
     * 红线；月历下方搬来的 min(560px,70vh) 旧帽退役，极矮视口 120px 保底防轴被挤没） */
    .pj-cal__axis {
        position: relative;
        padding-left: 44px;
        flex: 1 1 0;
        min-height: 120px;
        overflow-y: auto;
        overflow-x: hidden;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius-b, 6px);
        background-color: var(--b3-theme-surface);
        touch-action: none; /* 拖动吃指针（触屏滚动走容器外） */
    }

    /* □5② 拖卡悬停轴（弹药卡拖入=建锚点+出发的落点态；主色描边与指针拖动区分） */
    .pj-cal__axis--ammohot {
        border-color: var(--b3-theme-primary);
        box-shadow: 0 0 0 1px var(--b3-theme-primary) inset;
    }

    /* 刻度行高=轴容器注入的 --pj-axis-pxh（模板 style 带 PX_PER_HOUR 同源值）——与 slot
     * top/height、nowline、droplabel 的 PX_PER_MIN 定位同一常量，改档两处同动（复审 high 修）。
     * ⚠box-sizing:border-box 必须：默认 content-box 下 1px border-bottom 叠在行高之外=行距
     * 57px 而槽按 56 定位（实测 570−513=57）——原 48px 期同病（行距 49）持续漂移 ~2%/时 */
    .pj-cal__axis-hour {
        position: relative;
        box-sizing: border-box;
        height: var(--pj-axis-pxh, 56px);
        border-bottom: 1px solid var(--b3-border-color-trans, var(--b3-border-color));
    }

    .pj-cal__axis-hour:last-child {
        border-bottom: none;
    }

    /* 视觉终审 P1：标签行内垂直居中——原贴行顶（static position），滚动落点不齐行时首个
     * 可见标签上缘被容器顶半裁（只露下半字形）；居中后 ±半行内滚动偏移都完整可见 */
    .pj-cal__axis-hour span {
        position: absolute;
        left: -40px;
        top: 50%;
        transform: translateY(-50%);
        width: 36px;
        text-align: right;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        font-variant-numeric: tabular-nums;
    }

    /* 今日走针线（红——他日不画） */
    .pj-cal__nowline {
        position: absolute;
        left: 44px;
        right: 0;
        height: 0;
        border-top: 1px solid var(--b3-card-error-color, #d23f31);
        z-index: 2;
        pointer-events: none;
    }

    .pj-cal__nowline::before {
        content: "";
        position: absolute;
        left: 0;
        top: -3px;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background-color: var(--b3-card-error-color, #d23f31);
    }

    /* 增补一 □2：走针当前时刻——落左侧刻度沟、与小时刻度同槽右对齐。视觉终审 P1 修：
     * 走针贴近整点时红字与整点刻度同槽叠印（18:22 压 18:00）——改红底白字胶囊（走针
     * 时刻优先于整点刻度读数，覆盖式不叠字）；白字对 #d23f31 底亮暗主题对比恒成立，
     * 不引未验证 b3 变量 */
    .pj-cal__nowline-hm {
        position: absolute;
        left: -44px;
        top: -8px;
        padding: 0 4px;
        border-radius: 3px;
        background-color: var(--b3-card-error-color, #d23f31);
        color: #fff;
        font-size: 11px;
        line-height: 14px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    /* 事件块：源色左边条+浅源色底；实=实线边可拖（grab）；虚=虚线边半透明（飞书镜像）。
     * 二审 P1：行级 flex-shrink:0——点事件下限块（~40px 内容高）装不下三行时默认 shrink
     * 会压缩行高=文字上下叠压+顶缘裁切纹理；禁缩后装不下=整行被 overflow 裁掉不叠字 */
    .pj-cal__slot {
        position: absolute;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 2px 4px 2px 7px;
        border: 1px solid var(--b3-border-color);
        border-left-width: 3px;
        border-radius: var(--b3-border-radius, 4px);
        background-color: var(--b3-theme-surface);
        overflow: hidden;
        cursor: pointer;
        user-select: none;
        font-size: 12px;
        line-height: 1.35;
        z-index: 1;
    }

    .pj-cal__slot-time {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        font-variant-numeric: tabular-nums;
    }

    .pj-cal__slot-summary {
        flex-shrink: 0;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--b3-theme-on-background);
    }

    .pj-cal__slot--due .pj-cal__slot-summary {
        color: var(--b3-card-error-color, #d23f31);
    }

    /* 同步徽标（board 槽）：已同步=绿实底；未同步=灰描边（bear 拍板两态直显）。
     * 二审 P1：退出文档流改右上角绝对定位——占位行让 ~40px 下限块三行必叠；离流后
     * 时间行左/徽标右同线共处（悬停 × 钮同角落盖上=临时让位，点删语义下可接受）；
     * 窄车道防压字=徽标自身 ellipsis 链（min-width:0 整链——flex 容器 ellipsis 静默失效坑） */
    .pj-cal__slot-sync {
        position: absolute;
        top: 1px;
        right: 2px;
        max-width: 45%;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 11px;
        line-height: 1.4;
        padding: 0 3px;
        border-radius: 3px;
        color: var(--b3-theme-on-surface);
        border: 1px solid var(--b3-border-color);
        white-space: nowrap;
    }

    .pj-cal__slot--board {
        border-left-color: #0d9488;
        background-color: color-mix(in srgb, #0d9488 10%, var(--b3-theme-surface));
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__slot--board {
        border-left-color: #2dd4bf;
        background-color: color-mix(in srgb, #2dd4bf 12%, var(--b3-theme-surface));
    }

    .pj-cal__slot--remind {
        border-left-color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 9%, var(--b3-theme-surface));
    }

    .pj-cal__slot--task {
        border-left-color: var(--b3-card-warning-color, #9d7e00);
        background-color: color-mix(in srgb, var(--b3-card-warning-color, #9d7e00) 10%, var(--b3-theme-surface));
    }

    .pj-cal__slot--feishu {
        border-left-color: #7c5cd6;
        background-color: color-mix(in srgb, #7c5cd6 10%, var(--b3-theme-surface));
    }

    /* ammo □7 live 实况段（回望形态=绿系只读；cursor 走默认+pointer 仅点击跳块——不可拖） */
    .pj-cal__slot--live {
        border-left-color: var(--b3-card-success-color, #2a9d42);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 9%, var(--b3-theme-surface));
        border-style: dashed;
        cursor: pointer;
    }

    .pj-cal__slot-tag {
        flex-shrink: 0;
        align-self: flex-start;
        font-style: normal;
        font-size: 10.5px;
        line-height: 1.3;
        padding: 0 3px;
        border-radius: 3px;
        color: var(--b3-theme-on-surface);
        background-color: var(--b3-theme-surface);
    }

    .pj-cal__slot-tag--live-open {
        color: var(--b3-card-success-color, #2a9d42);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 12%, transparent);
    }

    .pj-cal__slot-tag--pool {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
    }

    .pj-cal__slot-sync--live {
        border-style: dashed;
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__slot--feishu {
        border-left-color: #a78bfa;
        background-color: color-mix(in srgb, #a78bfa 12%, var(--b3-theme-surface));
    }

    /* 虚显=虚线边+降不透明度（无块=不可拖——飞书镜像过渡形态） */
    .pj-cal__slot--virtual {
        border-style: dashed;
        opacity: 0.78;
        cursor: default;
    }

    /* 硬性班表=teal 源色边框全周（排进日程）；弹性保持默认灰边 */
    .pj-cal__slot--hard {
        border-color: #0d9488;
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__slot--hard {
        border-color: #2dd4bf;
    }

    /* 循环提醒/不可拖态：grab 换箭头语义退化为可点 */
    .pj-cal__slot--nodrag {
        cursor: pointer;
    }

    .pj-cal__slot--dragging {
        opacity: 0.6;
        z-index: 3;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    }

    /* focusKey 定位高亮（openTimeline(day, focusKey)/goto 事件落地：主色描边+三拍脉冲） */
    .pj-cal__slot--focus {
        border-color: var(--b3-theme-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--b3-theme-primary) 45%, transparent);
        animation: pj-tl-focus-pulse 0.85s ease-in-out 3;
    }

    @keyframes pj-tl-focus-pulse {
        0%, 100% { box-shadow: 0 0 0 2px transparent; }
        50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--b3-theme-primary) 55%, transparent); }
    }

    /* 增补一 □3：当前块（走针分钟落在视觉占位区间）——主色描边+底色加深一档。置于全部
     * 源色变体之后：亮面同特异性 (0,1,0) 靠序压过 board/task/feishu/hard；暗面源色档是
     * :global (0,1,1)，须同特异性双规则压回（变量自适应、值不变只提序） */
    .pj-cal__slot--active {
        border-color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 16%, var(--b3-theme-surface));
    }

    :global(html[data-theme-mode="dark"]) .pj-cal__slot--active {
        border-color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 18%, var(--b3-theme-surface));
    }

    .pj-cal__slot-sync--on {
        color: var(--b3-card-success-color, #1d7a33);
        border-color: color-mix(in srgb, var(--b3-card-success-color, #1d7a33) 40%, transparent);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #1d7a33) 12%, transparent);
    }

    .pj-cal__slot-x {
        position: absolute;
        top: 1px;
        right: 1px;
        border: none;
        background: transparent;
        padding: 0 2px;
        min-width: 16px;
        min-height: 16px;
        font-size: 13px;
        line-height: 1.2;
        color: var(--b3-theme-on-surface-light);
        cursor: pointer;
        font-family: inherit;
        opacity: 0; /* 常驻占位防布局跳；hover 槽位才显（触屏=长按拖动为主通道） */
        transition: opacity 0.1s;
    }

    .pj-cal__slot:hover .pj-cal__slot-x {
        opacity: 1;
    }

    .pj-cal__slot-x:hover {
        color: var(--b3-card-error-color, #d23f31);
    }

    .pj-cal__slot .pj-cal__adopt {
        align-self: flex-start;
        margin-left: 0;
        font-size: 10px;
        padding: 0 4px;
    }

    /* 拖动落点时刻标签（吸附后目标区间——贴轴内容区左缘） */
    .pj-cal__droplabel {
        position: absolute;
        left: 2px;
        transform: translateY(-50%);
        padding: 0 4px;
        border-radius: 3px;
        font-size: 11px;
        white-space: nowrap;
        color: var(--b3-theme-on-background);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 15%, var(--b3-theme-surface));
        border: 1px solid var(--b3-theme-primary);
        z-index: 4;
        pointer-events: none;
        font-variant-numeric: tabular-nums;
    }

    /* □5② 弹药卡外拖落点标签（主色实底——与指针拖动的半透明标签拉开来源） */
    .pj-cal__droplabel--ammo {
        background-color: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }

    /* 托盘热区（拖入未定时落点） */
    .pj-cal__tray--hot {
        background-color: color-mix(in srgb, var(--b3-theme-primary) 12%, transparent);
        outline: 1px dashed var(--b3-theme-primary);
        outline-offset: -2px;
    }

    .pj-cal__chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--b3-theme-on-background);
        background-color: var(--b3-theme-surface);
        border: 1px solid var(--b3-border-color);
        cursor: grab;
        user-select: none;
        max-width: 100%;
    }

    .pj-cal__chip--dragging {
        opacity: 0.45;
    }

    /* 托盘虚行（飞书全天/无时刻任务/burden）：display-only，grab 语义退化 */
    .pj-cal__chip--virtual {
        cursor: default;
        border-style: dashed;
        opacity: 0.85;
    }

    /* sloop □6 周报 chip：与班表锚同源（sched 点色系）但可点击开文档——
       复合选择器提特异性 (0,2,0)：单类会被 .pj-cal__chip:not(--hard) 的 :not 压回 */
    .pj-cal__chip.pj-cal__chip--report {
        border-style: solid;
        border-color: var(--b3-theme-primary);
        background-color: var(--b3-theme-primary-lightest);
        cursor: pointer;
    }

    .pj-cal__chip.pj-cal__chip--report:hover {
        border-color: var(--b3-theme-primary-lighter);
        filter: brightness(0.97);
    }

    .pj-cal__chip-unread {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background-color: var(--b3-theme-primary);
        box-shadow: 0 0 0 2px var(--b3-theme-primary-lightest);
        flex: none;
    }

    .pj-cal__chip-tag {
        font-style: normal;
        font-size: 10px;
        color: var(--b3-theme-on-surface-light);
        border: 1px solid var(--b3-border-color);
        border-radius: 3px;
        padding: 0 2px;
    }

    .pj-cal__chip-x {
        flex-shrink: 0;
        border: none;
        background: transparent;
        padding: 0 2px;
        min-width: 16px;
        min-height: 16px;
        font-size: 13px;
        line-height: 1.2;
        color: var(--b3-theme-on-surface-light);
        cursor: pointer;
        font-family: inherit;
    }

    .pj-cal__chip-x:hover {
        color: var(--b3-card-error-color, #d23f31);
    }

    .pj-cal__addrow {
        display: flex;
        gap: 6px;
        align-items: center;
    }

    .pj-cal__addtime {
        width: 104px;
        flex-shrink: 0;
    }

    /* b3-text-field 帧线=outline 非 border；平拼类名提特异性 */
    .pj-cal__addrow .pj-cal__addtime--bad {
        outline: 1px solid var(--b3-card-error-color, #d23f31);
        outline-offset: -1px;
    }

    .pj-cal__addhard {
        flex-shrink: 0;
        min-width: 40px;
    }

    .pj-cal__addhard--on {
        border-color: var(--b3-theme-primary);
        color: var(--b3-theme-primary);
    }
</style>
