<script lang="ts">
    // sloop □21 当天时间线（右下 dock 常驻面板）：五源压平一条线（bear 二轮拍板：多项目全局
    // 压平、重叠允许）+分钟级走动的时间指针+三态（进行中/下一项/已过）。「提醒是瞬时信号，
    // 常驻时间线=随时一眼看到现在到哪了」。数据口径全部复用 gui/timeline 纯函数层（与月历
    // 同源）；反 push 合规：dock 可见入口、零弹窗零推送、指针=纯渲染。
    // 刷新：挂载全量拉；pj-schedule-updated 广播刷；30s 走针；5min 数据轮询；跨天自动重拉
    // （now 驱动一切，无服务端推送依赖）。
    import {
        buildTimeline,
        fmtMin,
        tlNextItem,
        tlNowIndex,
        tlStateOf,
        type TimelineItem,
        type TimelineModel,
    } from "./gui/timeline";
    // ammo □7：实况同步钮（三宿主复用同一组件=同一引擎同一状态源）
    import AmmoLiveSyncButton from "./AmmoLiveSyncButton.svelte";
    import { addFeedback, fbTargetKey, feedbackOf, normalizeFeedback, removeFeedback, type FeedbackEntry, type FeedbackStore } from "./kernel/core/feedback";
    // 09-23 笔改道：live 行笔记走 kernel rpc ammo-reflect 直写日账打点条目下（思源文档有痕迹——
    // 原路只写插件私有 feedback 档，用户「以为不起作用」）；sched/due 等计划行维持 feedback 档原路
    import { AMMO_REFLECT_METHOD } from "./shared/channels";
    import { showMessage } from "siyuan";
    // 番茄桥（bear 09-20「去自建钟用番茄工具箱」）：自建钟退役，只读 tomato 计时档出 chip
    // 三态+低频轮询 stats diff 回流账本（POMODORO_LOG_FILE 续写——behavior 训练链口径不变）
    import {
        appendPomoLog,
        applyTomatoStatsDiff,
        fmtRemaining,
        normalizePomoBridgeState,
        normalizePomoLog,
        parseTomatoStats,
        parseTomatoTime,
        pomoLocalDay,
        tomatoExpired,
        tomatoRemaining,
        type PomoLogStore,
        type PomoTarget,
        type TomatoStatsSeen,
        type TomatoView,
    } from "./gui/pomoBridge";
    type SrcLabel = Record<string, string>;

    let {
        t,
        openBlock,
        onOpenCalendar,
        onOpenTimeline,
        loadRemindRows,
        loadTaskRows,
        loadLedger,
        loadMirror,
        fetchInstances,
        loadBoardItems,
        loadFeedback,
        saveFeedback,
        loadPomoLog,
        savePomoLog,
        fetchTomatoText,
        loadPomoBridgeState,
        savePomoBridgeState,
        loadLedgerEntries,
        ammoRpc,
        onOpenDiary,
    }: {
        t: Record<string, string>;
        openBlock: (blockId: string) => void;
        /** 空态/头部「打开日历」入口（可见按钮，非弹窗） */
        onOpenCalendar?: () => void;
        /** caltab：头部「打开时间线」入口（独立时间线页签——「打开日历」旁第二入口） */
        onOpenTimeline?: () => void;
        /** 头部跳当日日记（mainfix0923 □5——外层接 openTodayDiary：定位不到=toast 不懒建；
         *  缺=钮不出） */
        onOpenDiary?: () => void;
        loadRemindRows: () => Promise<import("./gui/queries").RemindScanRow[]>;
        loadTaskRows: () => Promise<import("./gui/queries").TaskDueRow[]>;
        loadLedger: () => Promise<unknown>;
        loadMirror?: () => Promise<unknown>;
        fetchInstances?: (startTs: number, endTs: number) => Promise<{ ok: boolean; rows?: import("./kernel/core/calendarMirror").InstanceRow[] } | null>;
        /** 期 4 块化：班表行=块读面（全库班表块扫描，含托盘行） */
        loadBoardItems?: () => Promise<import("./kernel/core/schedule").SchedItem[]>;
        loadFeedback: () => Promise<{ ok: boolean; data: unknown } | null>;
        saveFeedback: (store: FeedbackStore) => Promise<boolean>;
        /** 番茄账本读写（桥续写 POMODORO_LOG_FILE；读=Ex 版写路径守卫防旧档回灌丢历史） */
        loadPomoLog?: () => Promise<{ ok: boolean; data: unknown } | null>;
        savePomoLog?: (store: PomoLogStore) => Promise<boolean>;
        /** tomato petal 档读（file="tomato-time.json"|"tomato-stats.json"；返回裸文本，null=未装/读失败/{code} 壳） */
        fetchTomatoText?: (file: string) => Promise<string | null>;
        /** 桥状态档（当前任务标记+回流锚一档两键；petal pomo-bridge.json） */
        loadPomoBridgeState?: () => Promise<unknown>;
        savePomoBridgeState?: (state: { focus?: PomoTarget | null; seen?: TomatoStatsSeen }) => Promise<boolean>;
        /** ammo □7：当日日账打点（实况轴本体；kernel rpc ammo-ledger-read 单日通道；缺=实况段缺席降级五源） */
        loadLedgerEntries?: () => Promise<import("./kernel/core/ammoLedger").AmmoLedgerEntry[] | null>;
        /** ammo □7：kernel rpc 面（头部实况同步钮引擎通道——与页签/□9 悬浮窗同一状态源；缺=钮隐藏） */
        ammoRpc?: { call: Record<string, (p?: any) => Promise<any>> } | null;
    } = $props();

    let model = $state<TimelineModel | null>(null);
    let loading = $state(true);
    let loadError = $state(false);
    let nowMin = $state(0);
    /** 「今天」锚（跨天检测：变化→重拉+滚动重置） */
    let dateKey = $state("");
    /** 用户手动滚动后不再抢滚动（只在挂载/跨天各对齐一次） */
    let autoScrolled = false;

    // ── □23 随手反馈：独立档（不挂 SchedItem key——行匹配=source#summary#startMin 三元组，
    //    条目消失 chip 不显但档内可读，交接会开场包直读全量）──
    let fbStore = $state<FeedbackStore>({});
    /** feedback 档读失败闩（pomoLogLoadOk 同款）：失败期间 persistFb 拒写——防「读失败→内存空→
     *  下一笔写=整档覆盖丢 30 天历史」；5min 数据轮询重读成功即自愈（load() 内置 true/false） */
    let fbLoadOk = true;
    /** 正在记的行（三元组 key；null=无） */
    let noteOpenKey = $state<string | null>(null);
    let noteDraft = $state("");
    let noteInputEl = $state<HTMLInputElement | null>(null);

    // ── 番茄桥（bear 09-20 拍板「直接用番茄工具箱的番茄钟」）：自建钟整体退役，本组件只做
    //    ① chip 三态展示（读 tomato tomato-time.json，倒计时=本地钟算——低频读档校准，禁 1s 轮询
    //    文件）；② 回流记账（低频轮询 tomato-stats.json diff 完成段数→追加 POMODORO_LOG_FILE，
    //    behavior 训练链口径不变）；③「当前任务」轻状态（点行设/取消，petal 桥状态档，不涉计时）。
    //    探不通（未装 tomato）=提示 chip+回流暂缺——容量退化=排班参照变保守，过渡可接受。 ──
    /** tomato 在场/计时视图：unknown=首读前；absent=未装/读失败；idle=装了未跑 */
    let tomatoState = $state<"unknown" | "absent" | "idle" | TomatoView>("unknown");
    /** 当前任务行快照（null=未设；行匹配=fbTargetKey 三元组口径） */
    let pomoFocus = $state<PomoTarget | null>(null);
    /** 回流锚（桥状态档持久化——重载/重挂不丢完成段；非渲染态） */
    let tomatoSeen: TomatoStatsSeen = {};
    /** 账本内存态（桥唯一写者追加） */
    let pomoLog = $state<PomoLogStore>({});
    /** log 档读失败标志（失败期间只更内存不落盘——防首笔整档覆盖丢 90 天历史） */
    let pomoLogLoadOk = true;
    /** 本地秒针（chip 倒计时显示——纯显示驱动，不触发读档） */
    let clockMs = $state(0);

    const pad2 = (n: number) => String(n).padStart(2, "0");

    const WEEKDAYS = $derived([t.calWd1, t.calWd2, t.calWd3, t.calWd4, t.calWd5, t.calWd6, t.calWd7]);
    const SRC_LABEL = $derived<SrcLabel>({
        remind: t.calSrcRemind,
        task: t.calSrcTask,
        burden: t.calSrcBurden,
        feishu: t.calSrcFeishu,
        sched: t.calSrcSched,
        live: t.calSrcLive ?? "实况",
    });
    /** live 行池名（i18n 键 ammoPool_<slug>——□6 池名同源；未知 slug 退 slug 原串） */
    const poolLabel = (pool: string): string => (t as Record<string, string>)[`ammoPool_${pool}`] ?? pool;

    const nowIndex = $derived(model ? tlNowIndex(model.items, nowMin) : 0);
    const nextItem = $derived(model ? tlNextItem(model.items, nowMin) : null);
    const headItems = $derived(model ? model.items.slice(0, nowIndex) : []);
    const tailItems = $derived(model ? model.items.slice(nowIndex) : []);
    /** 头部日期串（今天锚随 dateKey 变） */
    const headDate = $derived.by(() => {
        const [y, m, d] = (dateKey || "").split("-").map(Number);
        if (!y) return "";
        const wd = new Date(y, m - 1, d).getDay();
        return `${m}月${d}日 周${WEEKDAYS[wd === 0 ? 6 : wd - 1]}`;
    });
    const nowLabel = $derived(fmtMin(nowMin));

    /** load 代际守卫（reasoning P1）：轮询/广播/跨天/重试四路并发，后发起者胜——
        旧请求后到覆盖新数据会把「写完立看」的班表刷新静默打回（最长 5min） */
    let loadSeq = 0;

    async function load(): Promise<void> {
        const seq = ++loadSeq;
        const fbSeq0 = fbWriteSeq; // 本地写在途/在先检测锚（review P1-3 回打守卫）
        loading = true;
        loadError = false;
        try {
            const n = new Date();
            const d0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
            const dayStart = Math.floor(d0.getTime() / 1000);
            const [remindRows, taskRows, ledger, mirror, boardItems, instances, fbR, ledgerEntries] = await Promise.all([
                loadRemindRows(),
                loadTaskRows(),
                loadLedger(),
                loadMirror ? loadMirror() : Promise.resolve(null),
                loadBoardItems ? loadBoardItems() : Promise.resolve([] as import("./kernel/core/schedule").SchedItem[]),
                fetchInstances ? fetchInstances(dayStart, dayStart + 24 * 3600).catch(() => null) : Promise.resolve(null),
                loadFeedback().catch(() => null),
                loadLedgerEntries ? loadLedgerEntries().catch(() => null) : Promise.resolve(null),
            ]);
            if (seq !== loadSeq) return; // 已有更新一轮在途/完成，本轮回包作废
            // fb 只在「读成功且读发起后本地零新写」才覆盖（读失败保留内存态防下一笔整档覆盖丢 30 天
            // 历史——review P1-2；本地写过则旧档回包作废，下一轮轮询自补）
            if (fbR?.ok) {
                if (fbSeq0 === fbWriteSeq) fbStore = normalizeFeedback(fbR.data);
                fbLoadOk = true;
            } else {
                fbLoadOk = false; // 读失败闩（{ok:false} 或 reject→null）：persistFb 拒写防覆盖，轮询重读自愈
            }
            model = buildTimeline({
                now: n,
                remindRows,
                taskRows,
                ledger,
                mirror,
                instances: instances?.rows ?? [],
                sched: boardItems ?? [],
                ledgerEntries: ledgerEntries ?? [],
            });
        } catch {
            if (seq !== loadSeq) return;
            loadError = true; // SQL 通道错误=空态+重试（档缺文件=内部 null 空态不算错，月历同则）
            model = null;
        } finally {
            if (seq === loadSeq) loading = false;
        }
    }

    /** 走针（30s）+数据轮询（5min）+跨天重拉。全 $state 驱动，无 DOM 旁路。 */
    $effect(() => {
        const tick = () => {
            const n = new Date();
            const key = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
            const crossed = dateKey !== "" && dateKey !== key;
            nowMin = n.getHours() * 60 + n.getMinutes();
            if (dateKey !== key) dateKey = key;
            return crossed;
        };
        let polls = 0;
        tick();
        const id = setInterval(() => {
            const crossed = tick();
            if (crossed) autoScrolled = false; // 跨天重拉后重新对齐指针
            polls++;
            if (crossed || polls >= 10) {
                polls = 0;
                void load();
            }
        }, 30 * 1000);
        return () => clearInterval(id);
    });

    // 挂载加载；班表/周报写入广播（kernel rpc→window 事件）→ 全量刷（事件低频，五源一起新鲜）；
    // ammo □7：pj-ammo-state（引擎开始/停止落账广播）→ 实况段重拉——投影刷新走内存事件链勿 SQL 轮询
    $effect(() => {
        void load();
        void pomoBridgeInit();
        const refresh = () => void load();
        window.addEventListener("pj-schedule-updated", refresh);
        window.addEventListener("pj-ammo-state", refresh);
        return () => {
            window.removeEventListener("pj-schedule-updated", refresh);
            window.removeEventListener("pj-ammo-state", refresh);
        };
    });

    // 指针对齐：model 首次到位/跨天后滚到指针行（≈居中）；此后用户滚动自由。
    // 手动 scrollTop（reasoning P2）：scrollIntoView 按需滚全部可滚祖先，会劫持 dock 列滚动
    let listEl = $state<HTMLElement | null>(null);
    $effect(() => {
        model;
        dateKey;
        const el = listEl;
        if (!el || loading || !model) return;
        if (autoScrolled) return;
        const nowRow = el.querySelector(".pj-tl__now");
        if (nowRow instanceof HTMLElement) el.scrollTop = Math.max(0, nowRow.offsetTop - el.clientHeight / 2);
        autoScrolled = true;
    });

    /** 行 key：绝对位+index 保底防同时刻同摘要重复 key 打死兄弟（keyed each 坑）。
     *  tail 用绝对位（nowIndex+i）——指针推进时同一 item 的 key 不变，避免整段销毁重建 */
    const keyOf = (it: TimelineItem, i: number, offset = 0) => `${offset + i}#${it.source}#${it.startMin}`;
    const stateCls = (it: TimelineItem) => {
        const st = tlStateOf(it, nowMin);
        const focus = focusRowKey !== null && focusRowKey === fbKeyOf(it) ? " pj-tl__row--focus" : "";
        return (st === "past" ? "pj-tl__row--past" : st === "active" ? "pj-tl__row--active" : "") + focus;
    };

    // ── □23 随手反馈（行匹配键=fbTargetKey 三元组单源——写入即归一，行侧 101 字符 trunc 产物同口径截断）──
    const dayNotes = $derived(model ? feedbackOf(fbStore, model.date) : []);
    const fbByRow = $derived.by(() => {
        const m = new Map<string, FeedbackEntry[]>();
        for (const e of dayNotes) {
            if (!e.target) continue;
            const k = fbTargetKey(e.target);
            const list = m.get(k);
            if (list) list.push(e);
            else m.set(k, [e]);
        }
        return m;
    });
    const fbKeyOf = (it: TimelineItem) => fbTargetKey({ source: it.source, summary: it.summary, startMin: it.startMin });

    /** 本地写代际+串行落盘链（review P1-3）：串行链消除亚秒连写乱序（每笔写全量快照，盘终态恒=
     *  最新全量）；代际供 load 回包丢弃「读发起后本地又写过」的旧档回打（读发起于写在途、回包晚于
     *  写完成会把新写的笔从内存打回旧档→链式丢失） */
    let fbWriteSeq = 0;
    let fbSaveChain: Promise<void> = Promise.resolve();
    function persistFb(next: FeedbackStore): void {
        if (!fbLoadOk) {
            // 读失败闩（persistPomoLog 同款）：拒写——此时内存 fbStore 非盘上真相，落盘=整档覆盖丢历史
            showMessage(t.tlFbLoadPaused ?? "随手记档读取失败，已暂停记录以防覆盖历史；稍后自动恢复", 3000, "error");
            return;
        }
        fbStore = next;
        fbWriteSeq++;
        const snap = next;
        fbSaveChain = fbSaveChain
            .then(() => saveFeedback(snap))
            .then((ok) => {
                // 写失败可见化（09-23：静默曾是「以为不起作用」根源之一）——saveFeedbackStore 失败
                // 走 return false 不 reject，两路都提示；内存态保真不回滚（既有拍板）
                if (ok === false) showMessage(t.tlFbSaveFail ?? "随手记保存失败，稍后重试", 3000, "error");
            })
            .catch(() => showMessage(t.tlFbSaveFail ?? "随手记保存失败，稍后重试", 3000, "error")); // reject 路（index.ts 侧 debugLog 留痕）
    }

    function openNote(key: string): void {
        noteOpenKey = noteOpenKey === key ? null : key; // 再点同钮=收（轻交互）
        noteDraft = "";
    }

    /** Enter 存：live 行=改道 kernel rpc ammo-reflect 带 blockId 直写日账打点条目下（09-23 拍板：
     *  思源文档有痕迹——原 feedback 档私有，用户「以为不起作用」）；rpc 面不在/调用失败=回退
     *  feedback 档原路（保底不丢输入）；sched/due 等计划行维持原路不动。成功 toast「已记入日记」；
     *  行下 chip 不回显 live 笔（拍板行为——日账就是它的家）。空文本=纯收起不写 */
    async function commitNote(it: TimelineItem): Promise<void> {
        const text = noteDraft.trim();
        const day = model?.date;
        if (text && day && it.source === "live" && it.blockId && ammoRpc?.call?.[AMMO_REFLECT_METHOD]) {
            let ok = false;
            try {
                const r = await ammoRpc.call[AMMO_REFLECT_METHOD]({ text, day, blockId: it.blockId });
                ok = Boolean(r?.ok);
            } catch {
                ok = false; // rpc 通道异常=按失败回退（kernel 侧自身不 throw，此路为防御）
            }
            if (ok) {
                showMessage(t.tlReflectDone ?? "已记入日记", 2000, "info");
            } else {
                fallbackNote(it, day, text); // kernel 侧拒绝（块没了/非打点条目等）——回退保底落档
            }
        } else if (text && day) {
            fallbackNote(it, day, text);
        }
        noteOpenKey = null;
        noteDraft = "";
    }

    /** 原路：追加进 feedback 档（at=记的时刻）+落盘 */
    function fallbackNote(it: TimelineItem, day: string, text: string): void {
        const next = addFeedback(fbStore, day, fmtMin(nowMin), text, { source: it.source, summary: it.summary, startMin: it.startMin });
        if (next !== fbStore) persistFb(next);
    }

    function removeOne(e: FeedbackEntry): void {
        const day = model?.date;
        if (!day) return;
        const next = removeFeedback(fbStore, day, e.at, e.text);
        if (next !== fbStore) persistFb(next);
    }

    // 记输入框自动聚焦（key 变化→DOM 挂载后 effect 时机，Svelte 5 保证在渲染后）
    $effect(() => {
        noteOpenKey;
        noteInputEl?.focus();
    });

    // ── 番茄桥接线（纯层 pomoBridge + 三档读写：账本/桥状态/tomato petal 只读） ──

    /** log 落盘（串行链——persistFb 同款纪律；读失败期间只更内存防旧档覆盖） */
    let pomoLogChain: Promise<void> = Promise.resolve();
    function persistPomoLog(next: PomoLogStore): void {
        if (!pomoLogLoadOk) return; // 读失败期间只更内存（下一轮重读成功后恢复落盘——防旧档/空档覆盖）
        const snap = next;
        pomoLogChain = pomoLogChain.then(() => savePomoLog?.(snap).then(() => {})).catch(() => {});
    }

    /** 轮询内低频重试读 log 档（自愈=盘档为基+挂起期内存条目按 at#type#index 补回——
     *  直接覆盖会蒸发挂起期未落盘条目；raw 非空但 normalize 全空=可疑坏档不覆盖不置 ok） */
    async function retryPomoLogLoad(): Promise<void> {
        const r = await loadPomoLog?.().catch(() => null);
        if (!r?.ok) return;
        const disk = normalizePomoLog(r.data);
        const rawHasPayload = r.data !== null && (typeof r.data !== "object" ? String(r.data).length > 0 : Object.keys(r.data).length > 0);
        if (rawHasPayload && Object.keys(disk).length === 0) return;
        const seenKey = (e: { at: string; type: string; index?: number; completed?: number }) => `${e.at}#${e.type}#${e.index ?? e.completed ?? ""}`;
        const diskKeys = new Set<string>();
        for (const list of Object.values(disk)) for (const e of list) diskKeys.add(seenKey(e));
        if (Object.values(pomoLog).some((list) => list.some((e) => !diskKeys.has(seenKey(e))))) {
            let next = disk;
            for (const [day, list] of Object.entries(pomoLog)) {
                for (const e of list) {
                    if (diskKeys.has(seenKey(e))) continue;
                    next = appendPomoLog(next, day, e, model?.date ?? day);
                }
            }
            pomoLog = next;
            const snap = next;
            pomoLogChain = pomoLogChain.then(() => savePomoLog?.(snap).then(() => {})).catch(() => {});
        } else {
            pomoLog = disk;
        }
        pomoLogLoadOk = true;
    }

    /** 桥状态档落盘（当前任务+回流锚一档两键；写失败=内存态照常，下一轮自愈） */
    function persistBridgeState(): void {
        void savePomoBridgeState?.({ focus: pomoFocus, seen: tomatoSeen }).catch(() => {});
    }

    const safeJson = (text: string | null | undefined): unknown => {
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    };

    /** 挂载恢复：账本+桥状态档读齐→首轮 tomato 探测（回包晚于用户操作=以内存为准） */
    async function pomoBridgeInit(): Promise<void> {
        const [logR, bridgeR] = await Promise.all([
            loadPomoLog?.().catch(() => null) ?? Promise.resolve(null),
            loadPomoBridgeState?.().catch(() => null) ?? Promise.resolve(null),
        ]);
        if (logR?.ok) {
            pomoLog = normalizePomoLog(logR.data);
            pomoLogLoadOk = true;
        } else if (loadPomoLog) {
            pomoLogLoadOk = false;
        }
        const bs = normalizePomoBridgeState(bridgeR);
        if (bs.focus || pomoFocus === null) pomoFocus = bs.focus ?? null; // 回包前用户已设=内存为准
        tomatoSeen = bs.seen ?? {};
        await pollTomato();
    }

    /** tomato 探测一轮：计时档→chip 三态；stats 档→diff 回流入账（页面隐藏由调用方停）。
     *  absent 判定=连续失败≥2（批四复审 low）：单次读失败可能是瞬态（装着 tomato 的
     *  fetch 抖动）——保持上一态不闪「未装」引导文案一轮；真未装=第二轮（8s 后）落 absent */
    let tomatoMissStreak = 0;
    async function pollTomato(): Promise<void> {
        const timeText = await fetchTomatoText?.("tomato-time.json").catch(() => null);
        if (timeText == null) {
            if (++tomatoMissStreak >= 2) tomatoState = "absent"; // 未装/持续读失败——统一提示态（原 checkTomatoRunning 同拍板）
        } else {
            tomatoMissStreak = 0;
            const v = parseTomatoTime(safeJson(timeText));
            tomatoState = v === null ? "idle" : v; // 过期 running 段=展示层钳 idle（chip 派生判，tomato 前端在场 1s 自清）
        }
        // 回流：stats 读失败=本轮暂缺（锚原地不动，下轮自愈——探不通勿硬造）
        const statsText = await fetchTomatoText?.("tomato-stats.json").catch(() => null);
        if (statsText != null) {
            const stats = parseTomatoStats(safeJson(statsText));
            const before = JSON.stringify(tomatoSeen);
            const r = applyTomatoStatsDiff(pomoLog, stats, tomatoSeen, Date.now(), model?.date ?? pomoLocalDay(Date.now()), pomoFocus ?? undefined);
            if (r.store !== pomoLog) {
                pomoLog = r.store;
                persistPomoLog(r.store);
            }
            if (JSON.stringify(r.seen) !== before) {
                tomatoSeen = r.seen;
                persistBridgeState();
            }
        }
    }

    /** 秒针本地走（纯显示）；8s 低频校准+回流（页面隐藏停轮询——禁 1s 轮询文件）；
     *  log 档读失败期间约每分钟自愈重读。批四复审 low：秒针 tick 同步挂 hidden 守卫
     *  （后台 tab 停走对齐 8s 轮询语义；回场 visibilitychange 立刻校准防陈旧秒针）。 */
    $effect(() => {
        clockMs = Date.now();
        const onVisible = () => {
            if (!document.hidden) clockMs = Date.now();
        };
        const tickId = setInterval(() => {
            if (document.hidden) return;
            clockMs = Date.now();
        }, 1000);
        document.addEventListener("visibilitychange", onVisible);
        let polls = 0;
        const pollId = setInterval(() => {
            if (document.hidden) return;
            polls++;
            void pollTomato().then(() => {
                if (!pomoLogLoadOk && polls % 8 === 0) void retryPomoLogLoad();
            });
        }, 8_000);
        return () => {
            clearInterval(tickId);
            clearInterval(pollId);
            document.removeEventListener("visibilitychange", onVisible);
        };
    });

    /** 点行设/取消当前任务（纯 project 侧轻状态，petal 桥状态档，不涉计时——计时归番茄
     *  工具箱）。已设该行=取消；设他行=切换；行消失不清理（chip 兜底空名，档内可读）。 */
    function toggleFocus(it: TimelineItem): void {
        const key = fbKeyOf(it);
        pomoFocus = pomoFocus && fbTargetKey(pomoFocus) === key ? null : { source: it.source, summary: it.summary, startMin: it.startMin };
        persistBridgeState();
    }

    /** 当前任务行匹配（fbTargetKey 三元组口径——行消失 chip 仍可显示任务名） */
    const focusRowKey = $derived(pomoFocus ? fbTargetKey(pomoFocus) : null);

    /** chip 视图（三态：absent 提示/idle 就绪/run 任务名·剩余；unknown=首读前不渲染） */
    const pomoChip = $derived.by(() => {
        if (tomatoState === "unknown") return null;
        if (tomatoState === "absent") return { kind: "absent" as const };
        if (tomatoState === "idle" || tomatoExpired(tomatoState, clockMs)) return { kind: "idle" as const };
        return {
            kind: "run" as const,
            paused: tomatoState.state === "paused",
            label: pomoFocus?.summary || t.tlPomoBridgeNoFocus,
            rem: fmtRemaining(tomatoRemaining(tomatoState, clockMs)),
        };
    });
</script>

<div class="pj-tl fn__flex-column">
    <div class="pj-tl__head">
        <span class="pj-tl__date">{headDate}</span>
        <span class="pj-tl__clock">{t.calToday} {nowLabel}</span>
        {#if pomoChip}
            {#if pomoChip.kind === "absent"}
                <span class="pj-tl__pomo-chip" title={t.tlPomoBridgeAbsent}><span class="pj-tl__pomo-chip-text">{t.tlPomoBridgeAbsent}</span></span>
            {:else if pomoChip.kind === "idle"}
                <span class="pj-tl__pomo-chip" title={t.tlPomoBridgeIdle}><span class="pj-tl__pomo-chip-text">{t.tlPomoBridgeIdle}</span></span>
            {:else}
                <span class="pj-tl__pomo-chip pj-tl__pomo-chip--run" title={pomoChip.paused ? t.tlPomoBridgePaused : undefined}><span class="pj-tl__pomo-chip-text">{pomoChip.paused ? "⏸ " : ""}{pomoChip.label} · {pomoChip.rem}</span></span>
            {/if}
        {/if}
        {#if onOpenCalendar}
            <button class="b3-button b3-button--small b3-button--outline" onclick={onOpenCalendar}>{t.calOpenCalendar}</button>
        {/if}
        {#if onOpenTimeline}
            <button class="b3-button b3-button--small b3-button--outline" onclick={onOpenTimeline} title={t.calOpenTimelineTitle} aria-label={t.calOpenTimelineTitle}>{t.calOpenTimeline}</button>
        {/if}
        <!-- ammo □7：实况手动同步钮（与时间线页签/□9 悬浮窗同一引擎同一状态源） -->
        {#if ammoRpc}
            <AmmoLiveSyncButton {t} rpc={ammoRpc} />
        {/if}
        <!-- mainfix0923 □5：跳当日日记钮（外层接 openTodayDiary——定位不到=toast 不懒建；
             iconFile=litheness 真表核过；与刷新钮同形态：图标钮+title） -->
        {#if onOpenDiary}
            <button class="pj-tl__refresh-btn pj-tl__diary-btn" onclick={onOpenDiary} title={t.tlOpenDiary} aria-label={t.tlOpenDiary}>
                <svg><use xlink:href="#iconFile"></use></svg>
            </button>
        {/if}
        <!-- 手动刷新钮（09-23 拍板：只做手动刷新，不做文档手改/AI 改的自动监听）：
             点击强制全量重拉（load 代际守卫兜并发）；loading 期禁用=进行中反馈 -->
        <button class="pj-tl__refresh-btn" onclick={() => void load()} disabled={loading} title={t.tlRefresh} aria-label={t.tlRefresh}>
            <svg><use xlink:href="#iconRefresh"></use></svg>
        </button>
    </div>

    {#if loading}
        <div class="pj-tl__state">{t.tlLoading}</div>
    {:else if loadError}
        <div class="pj-tl__state pj-tl__state--col">
            <span>{t.calLoadFailed}</span>
            <button class="b3-button b3-button--small" onclick={() => void load()}>{t.tlRetry}</button>
        </div>
    {:else if model && (model.items.length > 0 || model.tray.length > 0)}
        <div class="pj-tl__list" bind:this={listEl}>
            {#if model.items.length === 0}
                <div class="pj-tl__none">{t.tlEmptyTimed}</div>
            {:else}
                {#snippet rowLine(it: TimelineItem, showNext: boolean)}
                    {@const rk = fbKeyOf(it)}
                    {@const chips = fbByRow.get(rk) ?? []}
                    <div class="pj-tl__row {stateCls(it)}">
                        <div class="pj-tl__row-line">
                            <button
                                class="pj-tl__row-main"
                                onclick={() => it.blockId && openBlock(it.blockId)}
                                disabled={!it.blockId}
                                title={it.summary}
                            >
                                <span class="pj-tl__time">{fmtMin(it.startMin)}{it.endMin !== null ? `–${fmtMin(it.endMin)}` : ""}</span>
                                <i class="pj-tl__dot pj-tl__dot--{it.source}"></i>
                                <span class="pj-tl__summary">{it.summary || (it.source === "live" ? (t.ammoLiveEmptySummary ?? "（未命名打点）") : it.summary)}</span>
                                {#if showNext && nextItem === it}<i class="pj-tl__tag pj-tl__tag--next">{t.tlNextBadge}</i>{/if}
                                {#if it.source === "live" && it.unclosed}<i class="pj-tl__tag pj-tl__tag--live-open">{t.ammoLiveOpenTag ?? "进行中"}</i>{/if}
                                {#if it.source === "live" && it.pool}<i class="pj-tl__tag pj-tl__tag--pool">{poolLabel(it.pool)}</i>{/if}
                                {#if it.source === "live" && it.anchor}<i class="pj-tl__tag">{t.ammoAnchorTag ?? "锚点"}</i>{/if}
                                {#if it.hard}<i class="pj-tl__tag">{t.schedHardTag}</i>{/if}
                                {#if it.fromYesterday}<i class="pj-tl__tag">{t.tlFromYesterday}</i>{/if}
                                {#if it.overnight}<i class="pj-tl__tag">{t.tlOvernight}</i>{/if}
                            </button>
                            {#if focusRowKey === rk}
                                <!-- 当前任务标记（原番茄列位）：点击取消；番茄计时归番茄工具箱（桥 chip 展示） -->
                                <button class="pj-tl__focus-mark" onclick={() => toggleFocus(it)} title={t.tlFocusUnset} aria-label={t.tlFocusUnset}>
                                    <svg><use xlink:href="#iconFocus"></use></svg>
                                </button>
                            {:else}
                                <button
                                    class="pj-tl__focus-btn"
                                    onclick={() => toggleFocus(it)}
                                    title={t.tlFocusSet}
                                    aria-label={t.tlFocusSet}
                                >
                                    <svg><use xlink:href="#iconFocus"></use></svg>
                                </button>
                            {/if}
                            <button class="pj-tl__note-btn" onclick={() => openNote(rk)} title={t.tlNoteBtn} aria-label={t.tlNoteBtn}>
                                <svg><use xlink:href="#iconEdit"></use></svg>
                            </button>
                        </div>
                        {#if noteOpenKey === rk}
                            <div class="pj-tl__note-input">
                                <input
                                    bind:this={noteInputEl}
                                    class="b3-text-field"
                                    type="text"
                                    maxlength="500"
                                    placeholder={t.tlNotePlaceholder}
                                    bind:value={noteDraft}
                                    onkeydown={(e: KeyboardEvent) => {
                                        if (e.isComposing) return; // IME 组字确认键不误触发（□10 坑）
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            void commitNote(it);
                                        } else if (e.key === "Escape") {
                                            e.preventDefault();
                                            noteOpenKey = null;
                                            noteDraft = "";
                                        }
                                    }}
                                />
                            </div>
                        {/if}
                        {#if chips.length}
                            <div class="pj-tl__note-chips">
                                {#each chips as e, ci (`${e.at}#${e.text}#${ci}`)}
                                    <span class="pj-tl__note-chip">
                                        <span class="pj-tl__note-chip-text">{e.at} {e.text}</span>
                                        <button class="pj-tl__note-del" onclick={() => removeOne(e)} aria-label={t.tlNoteDel} title={t.tlNoteDel}>×</button>
                                    </span>
                                {/each}
                            </div>
                        {/if}
                    </div>
                {/snippet}
                {#each headItems as it, i (keyOf(it, i))}
                    {@render rowLine(it, false)}
                {/each}
                <div class="pj-tl__now" role="timer" aria-label={t.tlNow}>
                    <span class="pj-tl__now-time">{nowLabel}</span>
                    <i class="pj-tl__now-dot"></i>
                    <i class="pj-tl__now-line"></i>
                </div>
                {#each tailItems as it, i (keyOf(it, i, nowIndex))}
                    {@render rowLine(it, true)}
                {/each}
            {/if}
        </div>

        {#if model.tray.length > 0}
            <div class="pj-tl__tray">
                <span class="pj-tl__tray-label">{t.tlTrayTitle}（{model.tray.length}）</span>
                <div class="pj-tl__tray-items">
                    {#each model.tray as it, i (`${i}#${it.source}#${it.summary}`)}
                        <span class="pj-tl__tray-item" title="{it.summary} · {SRC_LABEL[it.source]}">
                            <i class="pj-tl__dot pj-tl__dot--{it.source}"></i>{it.summary}
                        </span>
                    {/each}
                </div>
            </div>
        {/if}
    {:else}
        <div class="pj-tl__state pj-tl__state--col">
            <span>{t.tlEmpty}</span>
            {#if onOpenCalendar}
                <button class="b3-button b3-button--small" onclick={onOpenCalendar}>{t.calOpenCalendar}</button>
            {/if}
            {#if onOpenTimeline}
                <button class="b3-button b3-button--small" onclick={onOpenTimeline}>{t.calOpenTimeline}</button>
            {/if}
        </div>
    {/if}
</div>

<style lang="scss">
    .pj-tl {
        height: 100%;
        min-width: 0; // dock 窄栏 flex 溢出防御
        box-sizing: border-box;
        gap: 6px;
        padding: 8px 10px 10px;
    }

    .pj-tl__head {
        flex-shrink: 0;
        display: flex;
        flex-wrap: wrap; /* 窄 dock 面板（实测 317px）单行装不下全量头栏件（自然宽 ~338px）——
                             nowrap 会把时钟/胶囊/番茄 chip 三个弹性件压成 0~18px 残条（vision 两轮
                             实锤：胶囊塌成圆点+刷新钮贴缘被裁）；wrap 两行降级=信息全可见 */
        align-items: center;
        gap: 4px 8px;
        padding: 2px 2px 6px;
        border-bottom: 1px solid var(--b3-border-color);
    }

    .pj-tl__date {
        font-size: 13px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
        /* 二审 P1：运行态长 chip 挤标题三行竖排——标题钉单行不缩（chip 侧让位省略） */
        white-space: nowrap;
        flex-shrink: 0;
    }

    .pj-tl__clock {
        flex: 1;
        min-width: 0; // 胶囊在场可收缩（vision P2：防挤「打开日历」出画）
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        color: var(--b3-theme-primary);
        font-variant-numeric: tabular-nums;
    }

    .pj-tl__list {
        flex: 1;
        min-height: 0; // flex 链滚动区
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    /* 行=column 容器（主行+记输入+chips；hover/三态挂容器=从属信息同亮同暗） */
    .pj-tl__row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
        box-sizing: border-box;
        padding: 3px 6px 3px 4px;
        border-left: 2px solid transparent;
        border-radius: 4px;
        background: transparent;
        color: var(--b3-theme-on-background);
        font-size: 12px;
        line-height: 1.45;
    }

    .pj-tl__row-line {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
    }

    /* 主区=行内按钮（可点跳块；不可点行 disabled）；记钮在兄弟层不嵌套 */
    .pj-tl__row-main {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        border: 0;
        padding: 1px 0;
        background: transparent;
        text-align: left;
        cursor: pointer;
        color: inherit;
        font: inherit;
        line-height: inherit;
    }

    .pj-tl__row-main:disabled {
        cursor: default;
    }

    .pj-tl__row:has(.pj-tl__row-main:not(:disabled)):hover {
        background-color: var(--b3-list-hover);
    }

    /* □23 记钮：常驻可见（反 push 非弹窗）、低饱和不抢行注意力，hover 提亮
       （P2②：on-surface-light×0.6 双重淡化近乎不可见——提 on-surface+0.85 保可发现性） */
    .pj-tl__note-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--b3-theme-on-surface);
        opacity: 0.85;
        cursor: pointer;
    }

    .pj-tl__note-btn svg {
        width: 13px;
        height: 13px;
    }

    .pj-tl__note-btn:hover {
        opacity: 1;
        color: var(--b3-theme-primary);
        background-color: var(--b3-list-hover);
    }

    /* ── 当前任务钮（原番茄开始钮位，同记钮形态——常驻可见反 push、低饱和不抢行注意力；
       P2② 同记钮提对比度） ── */
    .pj-tl__focus-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--b3-theme-on-surface);
        opacity: 0.85;
        cursor: pointer;
    }

    .pj-tl__focus-btn svg {
        width: 13px;
        height: 13px;
    }

    .pj-tl__focus-btn:hover {
        opacity: 1;
        color: var(--b3-theme-primary);
        background-color: var(--b3-list-hover);
    }

    .pj-tl__row--past .pj-tl__focus-btn {
        opacity: 1; // 同记钮：past 行不连乘透明（已过条目照样可标当前收尾）
    }

    /* 已设标记（钉记钮同位）：主色实心=当前任务在身；点击取消 */
    .pj-tl__focus-mark {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--b3-theme-primary);
        cursor: pointer;
    }

    .pj-tl__focus-mark svg {
        width: 13px;
        height: 13px;
    }

    .pj-tl__focus-mark:hover {
        background-color: var(--b3-list-hover);
    }

    /* 头部番茄桥 chip（原胶囊位）：三态——absent 提示（灰）/idle 就绪（灰）/run 主色；
       tabular-nums 防秒跳抖动；信息平铺 title 承载全文非 hover 藏。
       二审 P1（方案 A）：ellipsis 移到内层 .pj-tl__pomo-chip-text 完整链——本仓已知坑：
       inline-flex 容器自身 text-overflow 对匿名 flex 文本静默失效；chip 由 flex-shrink:0
       （不让位=挤标题三行竖排）改为可缩 min-width:0，长任务名在 chip 内省略、标题恒单行 */
    .pj-tl__pomo-chip {
        flex-shrink: 1;
        min-width: 0;
        max-width: 40%; /* 长任务名不挤「打开日历」（原胶囊可收缩同防） */
        overflow: hidden;
        display: inline-flex;
        align-items: center;
        height: 22px;
        padding: 0 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: 11px;
        background-color: var(--b3-theme-surface);
        color: var(--b3-theme-on-surface-light);
        font-size: 11.5px;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    .pj-tl__pomo-chip-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* 入口钮不让位（chip/clock 两弹性位吸收全部挤压——按钮文案不可缩） */
    .pj-tl__head :global(.b3-button) {
        flex-shrink: 0;
    }

    /* 头栏手动刷新钮（图标钮同记钮形态——常驻可见、低饱和 hover 提亮；loading 期禁用置灰） */
    .pj-tl__refresh-btn {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--b3-theme-on-surface);
        opacity: 0.85;
        cursor: pointer;
    }

    .pj-tl__refresh-btn svg {
        width: 13px;
        height: 13px;
    }

    .pj-tl__refresh-btn:hover:not(:disabled) {
        opacity: 1;
        color: var(--b3-theme-primary);
        background-color: var(--b3-list-hover);
    }

    .pj-tl__refresh-btn:disabled {
        cursor: default;
        opacity: 0.5;
    }

    .pj-tl__pomo-chip--run {
        border-color: color-mix(in srgb, var(--b3-theme-primary) 45%, transparent);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
        color: var(--b3-theme-primary);
    }

    :global(html[data-theme-mode="dark"]) .pj-tl__pomo-chip--run {
        color: color-mix(in srgb, var(--b3-theme-primary) 60%, white); /* 11.5px 小字 AA（vision P2：原 3.36:1） */
    }

    .pj-tl__note-input {
        padding: 1px 0 1px 106px; // 对齐摘要列起点（时间槽 88+dot 6+两 gap 12——行 padding-left 已含在子元素起点内勿再加；vision P1-1）
    }

    .pj-tl__note-input .b3-text-field {
        width: 100%;
        box-sizing: border-box;
        height: 26px;
        font-size: 12px;
    }

    .pj-tl__note-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
        padding: 1px 0 0 106px; // 与记输入同起点（摘要列对齐；vision P1-1）
    }

    .pj-tl__note-chip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        max-width: 100%;
        padding: 1px 3px 1px 7px;
        border-radius: 8px;
        background-color: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
        font-size: 11px;
        color: var(--b3-theme-on-surface);
    }

    .pj-tl__note-chip-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pj-tl__note-del {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px; // 热区扩到 16×16（视觉字形不变大；vision P1-3——WCAG 24×24 的密度内近似）
        height: 16px;
        padding: 0;
        margin-right: -3px; // 抵消扩宽，胶囊右缘不变
        border: 0;
        background: transparent;
        border-radius: 50%;
        font-size: 12px;
        line-height: 1;
        color: var(--b3-theme-on-surface-light);
        cursor: pointer;
    }

    .pj-tl__note-del:hover {
        color: var(--b3-card-error-color, #d23f31);
    }

    .pj-tl__row--past {
        opacity: 0.45;
    }

    /* past 行记钮不随行透明度连乘（0.45×0.6≈0.27 近乎不可见——已过条目补记恰是高频场景；
       提到 1 后与该行文字同档，vision P1-2） */
    .pj-tl__row--past .pj-tl__note-btn {
        opacity: 1;
    }

    .pj-tl__row--active {
        border-left-color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
    }

    /* 当前任务行高亮（置 active 之后：同时命中时在办态可辨——染色提 14%，原番茄行视觉沿用） */
    .pj-tl__row--focus {
        border-left-color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 14%, transparent);
    }

    .pj-tl__time {
        flex-shrink: 0;
        width: 88px; // 固定槽（vision P1：min-width 74px 被「HH:mm–HH:mm」区间 11 字符撑破→色点/摘要列失齐；88px=区间形态容纳值）
        color: var(--b3-theme-on-surface);
        font-variant-numeric: tabular-nums;
        font-size: 11.5px;
    }

    .pj-tl__dot {
        flex-shrink: 0;
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--b3-theme-on-surface-light);
    }

    /* 五源点色与月历同档（feishu 紫钉双主题值、sched teal 同月历） */
    .pj-tl__dot--remind { background-color: var(--b3-theme-primary); }
    .pj-tl__dot--task { background-color: var(--b3-card-warning-color, #9d7e00); }
    .pj-tl__dot--burden { background-color: var(--b3-card-success-color, #2a9d42); }
    .pj-tl__dot--feishu { background-color: #7c5cd6; }
    :global(html[data-theme-mode="dark"]) .pj-tl__dot--feishu { background-color: #a78bfa; }
    .pj-tl__dot--sched { background-color: #0d9488; }
    :global(html[data-theme-mode="dark"]) .pj-tl__dot--sched { background-color: #2dd4bf; }
    /* ammo □7 live 实况段（绿=发生的世界；burden 灰绿已占成功档，live 用主成功色+实心度区分） */
    .pj-tl__dot--live { background-color: var(--b3-card-success-color, #2a9d42); }

    .pj-tl__tag--live-open {
        color: var(--b3-card-success-color, #2a9d42);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 10%, transparent);
    }

    .pj-tl__tag--pool {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
    }

    .pj-tl__summary {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pj-tl__tag {
        flex-shrink: 0;
        font-style: normal;
        font-size: 11px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 3px;
        color: var(--b3-theme-on-surface);
        background-color: var(--b3-theme-surface);
    }

    .pj-tl__tag--next {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 10%, transparent);
    }

    /* 时间指针：时刻（与条目行同 74px 槽宽左对齐）→红点（与来源色点同列）→贯通线（vision P1：
       红线起点须接上摘要列，勿悬在时刻列区域）；分钟级走动=纯渲染 */
    .pj-tl__now {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 6px 3px 4px;
        margin: 1px 0;
        border-left: 2px solid transparent; // 与 .pj-tl__row 同基线（三态竖条占位 2px）——否则点列左移 2px 失齐
    }

    .pj-tl__now-dot {
        flex-shrink: 0;
        width: 6px; // 与来源色点同尺寸严格同列（vision P2-1）；视觉分量用同色光环补
        height: 6px;
        border-radius: 50%;
        background-color: var(--b3-card-error-color, #d23f31);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--b3-card-error-color, #d23f31) 30%, transparent);
    }

    .pj-tl__now-time {
        flex-shrink: 0;
        width: 88px; // 与 .pj-tl__time 同固定槽（vision P1 同源）——红点列=来源点列
        font-size: 11.5px;
        font-weight: 600;
        color: var(--b3-card-error-color, #d23f31);
        font-variant-numeric: tabular-nums;
    }

    .pj-tl__now-line {
        flex: 1;
        height: 2px;
        border-radius: 1px;
        background-color: var(--b3-card-error-color, #d23f31);
        opacity: 0.55;
    }

    .pj-tl__none {
        padding: 10px 6px;
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-tl__tray {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-top: 6px;
        border-top: 1px solid var(--b3-border-color);
    }

    .pj-tl__tray-label {
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-tl__tray-items {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
    }

    .pj-tl__tray-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: 100%;
        padding: 2px 6px;
        border: 1px solid var(--b3-border-color);
        border-radius: 4px;
        background-color: var(--b3-theme-surface);
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    .pj-tl__state {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 1;
        min-height: 0;
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-tl__state--col {
        flex-direction: column;
        gap: 10px;
    }
</style>
