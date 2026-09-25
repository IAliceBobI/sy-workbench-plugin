<script lang="ts">
    // dataview □4：看板页签视图（零自有存储纯投影——契约 §4：列=查询分组怎么分就怎么查）。
    // 两分组模式：按池（列=四池固定，卡源=今日配置行+块池缓存双合并）/按线（列=项目树文档，
    // 卡=列下任务块）——分组/过滤/卡片字段全在 gui/boardModel.ts 纯层（单测钉死）。
    // 数据链：任务块/项目/线=组件内 feQuery（旧森林图先例）；每日配置行=kernel rpc
    // ammo-panel（AmmoPanelHost 同通道——rpc 缺=配置源退空，缓存源照常，fail-soft）。
    // 卡点击=openBlock（cb-get-hl 禁聚焦——非编辑跳转不抢焦点是仓政策）；列尾「+」=
    // QuickInlineInput（□6 件）速记：按池列=落块+挂池进配置容器（boardAdd.attachTaskToDayConfig），
    // 按线列=落该线文档任务章节（quickAddTask 同款锚规划）。
    // manualui 翻日：顶栏翻日器（◀ 日期 ▶＋回今天＋date input 直跳——TimelineTab 顶栏同款
    // 形态平移）把「今日」参数化：按池列数据源=视图日的每日配置容器（rpc day 参，kernel 侧
    // 任意日读面本就支持）、列尾速记挂视图日配置。仅作用按池模式（按线=项目树投影与日正交，
    // 翻日器禁用弱化）；过去日只读（B1.3 过去组冻结——列尾建卡入口隐藏，isDayWritable 纯层
    // 判定）；默认今天=现状零变化，视图态不持久化（TimelineTab 同款——关重开回今天）。
    import { onMount } from "svelte";
    import { feQuery } from "./gui/fe";
    import { boardTasksByRootSql, rootSubtreeDocsSql, dedupeById } from "./gui/queries";
    import { fetchProjectSnapshot } from "./gui/projectSource";
    import QuickInlineInput from "./QuickInlineInput.svelte";
    import { addDays, getLogicalDay } from "@/kernel/core/dates";
    import { AMMO_PANEL_METHOD } from "./shared/channels";
    import { POOL_LABEL } from "@/kernel/core/ammoQuadrant";
    import type { AmmoPanelData } from "./kernel/ammoPanel";
    import type { QuickParseResult } from "./gui/quickParse";
    import { quickAddTask } from "./gui/quickAdd";
    import { attachTaskToDayConfig } from "./gui/boardAdd";
    import {
        buildProjectBoard, buildPoolBoard, isDayWritable, resolveEntryPool,
        type BoardColumn, type BoardLineRow, type BoardProjectRow, type BoardTaskRow,
    } from "./gui/boardModel";
    import { debugLog } from "./libs/debugLog";

    let {
        t,
        openBlock,
        rpc,
        getActiveProjectId,
        onOpenGantt,
    }: {
        t: Record<string, string>;
        openBlock: (blockId: string) => void;
        /** kernel rpc 面（Plugin 实例的 this.kernel.rpc——宿主注入；缺=按池模式配置源退空） */
        rpc: { call: Record<string, (p?: any) => Promise<any>> } | null;
        /** 活跃项目 id（按池列尾速记的落点——与全局速记同语义：无活跃项目=提示） */
        getActiveProjectId: () => string;
        /** gantt-lanes：顶栏「甘特图」互切钮（openTab 去重聚焦通道由宿主注入） */
        onOpenGantt: () => void;
    } = $props();

    type Mode = "pool" | "project";
    let mode = $state<Mode>("pool");
    let phase = $state<"loading" | "error" | "ready">("loading");
    let errorText = $state("");

    // 列底「已完成」折叠分区：各列独立展开（foldview 替 showDone 复选框——默认收起计数
    // 可见、翻过去日回放完整）；数组重赋值驱动（$state(new Set()) add 不触发重渲染——仓坑）
    let expandedDoneCols = $state<string[]>([]);

    function toggleDoneCol(key: string): void {
        expandedDoneCols = expandedDoneCols.includes(key)
            ? expandedDoneCols.filter((k) => k !== key)
            : [...expandedDoneCols, key];
    }

    // 「今天」基值（挂载锚定——TimelineTab todayIso 同款：跨午夜不自动翻，刷新/重开复位）
    const todayIso = getLogicalDay(new Date());
    /** 视图日（按池模式数据源日；翻日/回今天/直跳驱动；按线模式与其正交——切模式不清日） */
    let viewDay = $state(todayIso);
    /** 过去日只读（B1.3 冻结：列尾建卡入口隐藏+只读提示；今天/未来可写） */
    const writable = $derived(isDayWritable(viewDay, todayIso));

    // 原料缓存（模式/showDone 切换=纯函数重算零 IO——旧森林图 lastRaw 同思路）
    let poolRaw = $state<{ panel: AmmoPanelData | null; blocks: BoardTaskRow[] } | null>(null);
    let lineRaw = $state<{ projects: BoardProjectRow[]; subdocs: BoardLineRow[]; blocks: BoardTaskRow[] } | null>(null);

    const columns = $derived.by(() => {
        if (mode === "pool" && poolRaw) {
            return buildPoolBoard({
                panelTasks: poolRaw.panel?.tasks ?? [],
                blocks: poolRaw.blocks,
                poolRatios: Object.fromEntries(
                    (poolRaw.panel?.pools ?? []).map((p) => [p.pool, p.ratio]),
                ),
            });
        }
        if (mode === "project" && lineRaw) {
            return buildProjectBoard({ projects: lineRaw.projects, subdocs: lineRaw.subdocs, blocks: lineRaw.blocks });
        }
        return [];
    });

    /** load 代际令牌（旧森林图 loadGen 同款）：模式切换时旧代在飞查询完成后不得覆写新代 */
    let loadGen = 0;
    let disposed = false;

    async function load(): Promise<void> {
        const gen = ++loadGen;
        phase = "loading";
        errorText = "";
        try {
            if (mode === "pool") {
                // 视图日配置行：kernel rpc 聚合读面（day 参=kernel 侧任意日读面；rpc 缺/失败
                // =配置源退空（缓存源照常——fail-soft，不炸整板））
                let panel: AmmoPanelData | null = null;
                if (rpc?.call) {
                    try {
                        panel = (await rpc.call[AMMO_PANEL_METHOD]({ day: viewDay })) as AmmoPanelData;
                    } catch (e) {
                        debugLog("fe", `board ammo-panel rpc failed: ${String(e)}`);
                    }
                }
                // folder-model：任务源=目录子树单前缀（boardTasksByRootSql——三件套子树排除）
                const snapPool = await fetchProjectSnapshot();
                const blocks = dedupeById(await feQuery<BoardTaskRow>(boardTasksByRootSql(snapPool.rootPath, snapPool.triplet)));
                if (disposed || gen !== loadGen) return;
                poolRaw = { panel, blocks };
            } else {
                const snapshot = await fetchProjectSnapshot();
                const subdocs = snapshot.projects.length
                    ? await feQuery<BoardLineRow>(rootSubtreeDocsSql(snapshot.rootPath))
                    : [];
                const blocks = dedupeById(await feQuery<BoardTaskRow>(boardTasksByRootSql(snapshot.rootPath, snapshot.triplet)));
                if (disposed || gen !== loadGen) return;
                lineRaw = { projects: snapshot.projects, subdocs, blocks };
            }
            phase = "ready";
        } catch (e: any) {
            if (disposed || gen !== loadGen) return;
            phase = "error";
            errorText = String(e?.message ?? e);
        }
    }

    function switchMode(next: Mode): void {
        if (mode === next) return;
        mode = next;
        expandedCol = null; // 收列尾展开（模式语义变——残留展开态怪异）
        // 已有原料=纯重算（$derived 跟手）；该模式未拉过才取数
        if ((next === "pool" && !poolRaw) || (next === "project" && !lineRaw)) void load();
    }

    // ── 翻日器（TimelineTab shiftDayNav/goToday 同款；addDays 正午锚免疫时区/夏令时边界） ──

    /** 翻日前置：仅按池模式（按线=项目树投影与日正交）；收列尾展开（数据源换日防残留） */
    function setViewDay(next: string): void {
        if (mode !== "pool" || next === viewDay) return;
        viewDay = next;
        expandedCol = null;
        void load();
    }

    function shiftDayNav(delta: number): void {
        setViewDay(addDays(viewDay, delta));
    }

    function goToday(): void {
        setViewDay(todayIso);
    }

    /** 日期直跳（文本输入 onchange）：ISO 形态+真实历法日才翻；清空/坏值=回显当前日不动作
     *  （正午锚点往返校验——2026-02-30 拒；原生 date input 显示格式随环境 locale 走〔vision P1：
     *  en 环境落 09/24/2026 与项目内 ISO 惯例分裂〕故弃用，文本恒 ISO） */
    function jumpDay(v: string, el: HTMLInputElement): void {
        let ok = /^\d{4}-\d{2}-\d{2}$/.test(v);
        if (ok) {
            const dt = new Date(`${v}T12:00:00`);
            const p = (n: number) => String(n).padStart(2, "0");
            ok = !Number.isNaN(dt.getTime()) && `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}` === v;
        }
        if (ok) setViewDay(v);
        else el.value = viewDay; // 受控回写（清空态复位——viewDay 未变 Svelte 不重设 DOM value）
    }

    /** 列头主名：按池=池展示名（白名单序固定四列）；按线=文档名 */
    function colTitle(col: BoardColumn): string {
        return col.pool ? (POOL_LABEL[col.pool] ?? col.pool) : col.title;
    }

    /** 列尾「+」展开态（单列展开——再看别列自动收） */
    let expandedCol = $state<string | null>(null);

    function toggleExpand(key: string): void {
        expandedCol = expandedCol === key ? null : key;
    }

    /** 挂载跳过文案（fail-soft reason code→i18n；缺/未知 code=通用句兜底） */
    function attachSkipText(reason?: string): string {
        const key = reason === "no-doc" ? "boardAttachSkipNoDoc"
            : reason === "no-container" ? "boardAttachSkipNoContainer"
            : reason === "empty-container" ? "boardAttachSkipEmpty"
            : "boardAttachSkipGeneric";
        return t[key] ?? t.boardAttachSkipGeneric ?? "";
    }

    /** R5：quickAdd 属性段部分失败（块已建成）→ 警示文案（防重试重复建块）；
     *  无警告=null。warnings 非空即示「参数未完全挂上」（今日唯一 code=attrs-failed，
     *  未认 code 也照示——部分达成静默吞比误示更糟） */
    function quickAttrWarnText(r: { warnings?: string[] }, name: string): string | null {
        return (r.warnings?.length ?? 0) > 0 ? (t.quickEntryPartialAttr ?? "").replace("{n}", name) : null;
    }

    /** 列尾速记落盘（QuickInlineInput submit 通道）：成功后重拉（新卡上板）；
     *  warning=任务已建但部分未成的就地警示（ok=true 清框不引导重试——R1 挂载跳过/
     *  R5 属性挂靠失败同通道：重试录入=重复建块）。挂配置日=视图日（翻日=给任意天
     *  配弹药；过去日入口已隐藏，此处恒为今天/未来日） */
    async function submitAt(col: BoardColumn, parsed: QuickParseResult): Promise<{ ok: boolean; error?: string; warning?: string }> {
        const name = parsed.name.trim();
        if (!name) return { ok: false, error: t.quickEntryNoName };
        const warns: string[] = [];
        if (mode === "pool" && col.pool) {
            const projectId = getActiveProjectId();
            if (!projectId) return { ok: false, error: t.quickEntryNoProject };
            // 池决策=速记显式词赢、列池兜底（boardModel.resolveEntryPool——单测钉死）
            const pool = resolveEntryPool(parsed.pool, col.pool);
            const r = await quickAddTask(projectId, { ...parsed, name, pool });
            if (!r.ok) return { ok: false, error: t.quickEntryFail };
            const attrWarn = quickAttrWarnText(r, name);
            if (attrWarn) warns.push(attrWarn);
            if (pool) {
                const a = await attachTaskToDayConfig(viewDay, {
                    id: r.taskId, name, quota: parsed.quota, pool,
                });
                // 挂载未成≠录入失败（R1）：任务块已由 quickAddTask 建成，重试录入=重复
                // 建块——ok:false 文案先讲「任务已建」；fail-soft（attached:false）=ok+
                // warning 通道就地提示跳过原因（块缓存照常上板，行由引擎/交接会收口）。
                if (!a.ok) return { ok: false, error: `${t.boardAttachPartial}：${a.error ?? "?"}` };
                if (!a.attached) warns.push(attachSkipText(a.reason));
            }
        } else if (mode === "project" && col.docId) {
            // 按项目列尾=落该项目文档任务章节（速记池词→块缓存属性，quickAddTask 内置；不挂配置
            // ——列上下文不是池，挂配置只在按池列尾有明确池意图时发生）
            const r = await quickAddTask(col.docId, { ...parsed, name });
            if (!r.ok) return { ok: false, error: t.quickEntryFail };
            const attrWarn = quickAttrWarnText(r, name);
            if (attrWarn) warns.push(attrWarn);
        } else {
            return { ok: false, error: t.boardAddNoTarget ?? "" };
        }
        void load();
        return warns.length ? { ok: true, warning: warns.join("；") } : { ok: true };
    }

    onMount(() => {
        void load();
        return () => {
            disposed = true;
        };
    });
</script>

<div class="pj-board">
    <div class="pj-board__bar">
        <div class="pj-board__modes" role="tablist">
            <button
                type="button"
                class="b3-button pj-board__modebtn"
                class:pj-board__modebtn--on={mode === "pool"}
                onclick={() => switchMode("pool")}
            >{t.boardGroupPool}</button>
            <button
                type="button"
                class="b3-button pj-board__modebtn"
                class:pj-board__modebtn--on={mode === "project"}
                onclick={() => switchMode("project")}
            >{t.boardGroupLine}</button>
        </div>
        <!-- 翻日器（TimelineTab 顶栏同款形态：◀ 日期 ▶＋回今天；date input=显示+直跳两用）。
             仅按池模式可用——按线=项目树投影与日正交，禁用弱化（title 讲原因） -->
        <div class="pj-board__daynav" class:pj-board__daynav--off={mode !== "pool"}>
            <button
                type="button"
                class="b3-button b3-button--small b3-button--outline pj-board__navbtn"
                onclick={() => shiftDayNav(-1)}
                disabled={mode !== "pool"}
                aria-label={t.tlPrevDay ?? "前一天"}
                title={mode !== "pool" ? (t.boardDayNavLineMode ?? "") : (t.tlPrevDay ?? "前一天")}
            >‹</button>
            <input
                type="text"
                class="b3-text-field pj-board__dayinput"
                value={viewDay}
                placeholder="YYYY-MM-DD"
                maxlength="10"
                disabled={mode !== "pool"}
                title={mode !== "pool" ? (t.boardDayNavLineMode ?? "") : (t.boardDay ?? "")}
                aria-label={t.boardDay ?? viewDay}
                onchange={(e) => jumpDay(e.currentTarget.value, e.currentTarget)}
            />
            <button
                type="button"
                class="b3-button b3-button--small b3-button--outline pj-board__navbtn"
                onclick={() => shiftDayNav(1)}
                disabled={mode !== "pool"}
                aria-label={t.tlNextDay ?? "后一天"}
                title={mode !== "pool" ? (t.boardDayNavLineMode ?? "") : (t.tlNextDay ?? "后一天")}
            >›</button>
            <button
                type="button"
                class="b3-button b3-button--small b3-button--outline pj-board__todaybtn"
                onclick={goToday}
                disabled={mode !== "pool"}
                title={mode !== "pool" ? (t.boardDayNavLineMode ?? "") : undefined}
            >{t.tlBackToday ?? "回今天"}</button>
        </div>
        <span class="pj-board__spacer"></span>
        <button type="button" class="b3-button pj-board__refresh" onclick={onOpenGantt} title={t.boardToGanttTitle ?? ""}>{t.boardToGantt ?? "甘特图"}</button>
        {#if phase === "loading"}<span class="pj-board__phase">{t.dashboardLoading ?? ""}</span>{/if}
        <button type="button" class="b3-button pj-board__refresh" onclick={() => void load()}>{t.boardRefresh}</button>
    </div>
    {#if phase === "error"}
        <div class="pj-board__error">
            <div>{t.boardLoadFail ?? ""}: {errorText}</div>
            <button type="button" class="b3-button" onclick={() => void load()}>{t.boardRetry ?? ""}</button>
        </div>
    {:else if columns.length === 0 && phase === "ready"}
        <div class="pj-board__error">{t.boardEmpty ?? ""}</div>
    {:else}
        <div class="pj-board__cols">
            {#each columns as col (col.key)}
                <section class="pj-board__col" data-colkey={col.key}>
                    <header class="pj-board__colhead">
                        {#if col.pool}<span class="pj-board__pooldot" data-pool={col.pool}></span>{/if}
                        <span class="pj-board__coltitle">{colTitle(col)}</span>
                        {#if col.subtitle}<span class="pj-board__colsub">{col.subtitle}</span>{/if}
                        <span class="pj-board__count">{col.cards.length}</span>
                    </header>
                    <div class="pj-board__cards">
                        {#each col.cards as card (card.key)}
                            <div
                                class="pj-board__card"
                                class:pj-board__card--done={card.done}
                                class:pj-board__card--dead={!card.taskId}
                                role="button"
                                tabindex="0"
                                onclick={() => (card.taskId ? openBlock(card.taskId) : undefined)}
                                onkeydown={(e) => {
                                    if ((e.key === "Enter" || e.key === " ") && !e.isComposing && card.taskId) {
                                        e.preventDefault();
                                        openBlock(card.taskId);
                                    }
                                }}
                            >
                                <span class="pj-board__cardname">{card.name}</span>
                                {#if card.pool || card.quota != null || card.due}
                                    <span class="pj-board__cardmeta">
                                        {#if card.pool && mode === "project"}
                                            <span class="pj-board__chip" data-pool={card.pool}>{POOL_LABEL[card.pool]}</span>
                                        {/if}
                                        {#if card.quota != null}<span class="pj-board__chip">{card.quota}min</span>{/if}
                                        {#if card.due}<span class="pj-board__chip pj-board__chip--due">{card.due}</span>{/if}
                                    </span>
                                {/if}
                            </div>
                        {/each}
                        {#if !col.cards.length}<div class="pj-board__colempty">{t.boardEmptyCol ?? ""}</div>{/if}
                    </div>
                    {#if col.doneCards.length}
                        <!-- 列底「已完成」折叠分区（foldview 替旧「显示已完成」复选框）：计数
                             常可见、各列独立展开；过去日回放=分区照常在，不用先找开关 -->
                        <button
                            type="button"
                            class="pj-board__donehead"
                            onclick={() => toggleDoneCol(col.key)}
                            aria-expanded={expandedDoneCols.includes(col.key)}
                        >
                            <span class="pj-board__donetoggle" class:pj-board__donetoggle--open={expandedDoneCols.includes(col.key)}>▸</span>
                            ✓ {t.boardDoneSection ?? "已完成"} · {col.doneCards.length}
                        </button>
                        {#if expandedDoneCols.includes(col.key)}
                            <div class="pj-board__cards pj-board__cards--done">
                                {#each col.doneCards as card (card.key)}
                                    <div
                                        class="pj-board__card pj-board__card--done"
                                        class:pj-board__card--dead={!card.taskId}
                                        role="button"
                                        tabindex="0"
                                        onclick={() => (card.taskId ? openBlock(card.taskId) : undefined)}
                                        onkeydown={(e) => {
                                            if ((e.key === "Enter" || e.key === " ") && !e.isComposing && card.taskId) {
                                                e.preventDefault();
                                                openBlock(card.taskId);
                                            }
                                        }}
                                    >
                                        <span class="pj-board__cardname">{card.name}</span>
                                        {#if card.pool && mode === "project"}
                                            <span class="pj-board__cardmeta">
                                                <span class="pj-board__chip" data-pool={card.pool}>{POOL_LABEL[card.pool]}</span>
                                            </span>
                                        {/if}
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    {/if}
                    <footer class="pj-board__colfoot">
                        {#if !writable}
                            <!-- 过去日只读（B1.3 过去组冻结——对账证据不可改写）：建卡入口隐藏，
                                 原因就地出示（找不到「+」时看得见为什么） -->
                            <div class="pj-board__readonly">{t.boardDayReadonly ?? ""}</div>
                        {:else if expandedCol === col.key}
                            <QuickInlineInput
                                {t}
                                submit={(p) => submitAt(col, p)}
                                cancel={() => (expandedCol = null)}
                                placeholder={t.boardAddPlaceholder ?? undefined}
                            />
                        {:else}
                            <button
                                type="button"
                                class="b3-button pj-board__addbtn"
                                onclick={() => toggleExpand(col.key)}
                                title={t.boardAddCard}
                            >+ {t.boardAddCard}</button>
                        {/if}
                    </footer>
                </section>
            {/each}
        </div>
    {/if}
</div>

<style>
    /* 横滚看板（列固定宽；宿主页签容器=fn__flex-1 高度链——旧森林图同款挂载纪律） */
    .pj-board {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }
    .pj-board__bar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
        flex: none;
    }
    .pj-board__modes {
        display: flex;
        gap: 4px;
    }
    /* 两态控件未选中态必须显式弱化（b3-button 基类默认主色实心——remind chips vision P0 同坑） */
    .pj-board__modebtn {
        background: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
        color: var(--b3-theme-primary);
    }
    .pj-board__modebtn--on {
        background: var(--b3-theme-primary);
        color: var(--b3-theme-on-primary);
    }
    /* ── 列底「已完成」折叠分区（foldview）：计数常可见，展开=完成序卡列 ── */
    .pj-board__donehead {
        display: flex;
        align-items: center;
        gap: 4px;
        width: 100%;
        flex: none;
        padding: 5px 10px;
        border: none;
        border-top: 1px solid var(--b3-border-color);
        background: transparent;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        text-align: left;
        cursor: pointer;
    }
    .pj-board__donehead:hover {
        color: var(--b3-theme-primary);
    }
    .pj-board__donetoggle {
        display: inline-block;
        font-size: 10px;
        transition: transform 0.12s ease;
    }
    .pj-board__donetoggle--open {
        transform: rotate(90deg);
    }
    /* 展开区=收缩自适应（主卡区 flex:1 撑余高；上限防长史压垮活卡区，区内自滚） */
    .pj-board__cards--done {
        flex: 0 1 auto;
        max-height: 40%;
        border-top: 1px dashed var(--b3-border-color);
        padding-top: 0;
    }
    /* ── 翻日器组（TimelineTab pj-tl__nav 同款形态；date input=显示+直跳两用） ── */
    .pj-board__daynav {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .pj-board__navbtn {
        padding: 0 8px;
        flex: none;
    }
    /* b3-text-field 紧凑化（边框=outline 是内核面不动——只收盒尺寸与字级，b3-text-field
       覆盖样式静默失效坑只袭边框覆盖面） */
    .pj-board__dayinput {
        width: 128px;
        height: 26px;
        padding: 0 4px 0 8px;
        font-size: 12px;
        flex: none;
    }
    .pj-board__todaybtn {
        flex: none;
    }
    /* 按线模式禁用弱化（与日正交——非可交互态的视觉信号） */
    .pj-board__daynav--off {
        opacity: 0.45;
    }
    /* 过去日列尾只读提示（建卡入口隐藏的原因出示） */
    .pj-board__readonly {
        font-size: 12px;
        line-height: 1.5;
        color: var(--b3-theme-on-surface);
        opacity: 0.55;
    }
    .pj-board__spacer {
        flex: 1;
    }
    .pj-board__phase {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
    }
    .pj-board__error {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 24px;
        color: var(--b3-theme-on-surface);
        opacity: 0.85;
    }
    .pj-board__cols {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        flex: 1;
        min-height: 0;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 0 12px 12px;
    }
    .pj-board__col {
        display: flex;
        flex-direction: column;
        width: 264px;
        flex: none;
        min-height: 0;
        max-height: 100%;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius-b);
        background: var(--b3-theme-surface);
    }
    .pj-board__colhead {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        flex: none;
        border-bottom: 1px solid var(--b3-border-color);
    }
    .pj-board__pooldot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex: none;
        background: var(--b3-theme-primary);
    }
    /* 池色（AmmoQuadrantPanel 池点同族色值——四池性格色单事实源对齐） */
    .pj-board__pooldot[data-pool="gold"] { background: #b8860b; }
    .pj-board__pooldot[data-pool="deadline"] { background: #dc2626; }
    .pj-board__pooldot[data-pool="hearth"] { background: #ea580c; }
    .pj-board__pooldot[data-pool="crumbs"] { background: #16a34a; }
    .pj-board__coltitle {
        font-weight: 600;
        font-size: 13px;
        color: var(--b3-theme-on-background);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .pj-board__colsub {
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .pj-board__count {
        margin-left: auto;
        flex: none;
        font-size: 11px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
    }
    .pj-board__cards {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        overflow-y: auto;
        min-height: 0;
        flex: 1;
    }
    .pj-board__card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 7px 9px;
        border-radius: var(--b3-border-radius-b);
        border: 1px solid var(--b3-border-color);
        background: var(--b3-theme-background);
        cursor: pointer;
    }
    .pj-board__card:hover {
        border-color: var(--b3-theme-primary);
    }
    /* 无主配置行（taskId 空）：不可点（dead=照实出示但不给手型） */
    .pj-board__card--dead {
        cursor: default;
        opacity: 0.7;
    }
    .pj-board__card--done .pj-board__cardname {
        text-decoration: line-through;
        opacity: 0.6;
    }
    .pj-board__cardname {
        font-size: 13px;
        line-height: 1.45;
        color: var(--b3-theme-on-background);
        word-break: break-word;
    }
    .pj-board__cardmeta {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
    }
    .pj-board__chip {
        flex: none;
        font-size: 11px;
        padding: 0 6px;
        border-radius: var(--b3-border-radius-b);
        background: color-mix(in srgb, var(--b3-theme-primary) 10%, transparent);
        color: var(--b3-theme-on-surface);
    }
    .pj-board__chip--due {
        background: color-mix(in srgb, var(--b3-card-warning-color, #f59e0b) 14%, transparent);
    }
    .pj-board__colempty {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        opacity: 0.55;
        padding: 2px 2px 6px;
    }
    .pj-board__colfoot {
        flex: none;
        padding: 8px 10px;
        border-top: 1px solid var(--b3-border-color);
    }
    .pj-board__addbtn {
        width: 100%;
        background: transparent;
        color: var(--b3-theme-on-surface);
        text-align: left;
    }
    .pj-board__addbtn:hover {
        color: var(--b3-theme-primary);
    }

    /* ── 暗色（3.8.3 判据=html[data-theme-mode=dark]，scoped 分支 :global——仓纪律） ── */
    :global(html[data-theme-mode="dark"]) .pj-board__pooldot[data-pool="gold"] { background: #e3b341; }
    :global(html[data-theme-mode="dark"]) .pj-board__pooldot[data-pool="deadline"] { background: #f87171; }
    :global(html[data-theme-mode="dark"]) .pj-board__pooldot[data-pool="hearth"] { background: #fb923c; }
    :global(html[data-theme-mode="dark"]) .pj-board__pooldot[data-pool="crumbs"] { background: #86efac; }
</style>
