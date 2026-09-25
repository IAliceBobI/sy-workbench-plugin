<script lang="ts">
    // gantt-lanes：甘特泳道视图（替换旧森林图画布，spec 2026-09-24）。数据链承旧画布
    // （前端直 fetch 四锚→子文档平铺直出→layoutGantt——folder-model 起无分拣层）；渲染=普通 DOM+CSS sticky
    // （去 SvelteFlow——甘特规则网格，缩放交互随架构淘汰；固定 40px/天单档）。
    // 左 sticky 线名列+右滚动区；顶部 sticky 天级刻度（含法定假日标注，holidaySpans 数据源
    // 沿用）+now 红线+断轴竖带（「断 N 天」诚实标记）；打开定位 now 于视口 ~30%（右侧留
    // 未来），「回到现在」一键复锚。点横条/菱形/果点/行名=cb-get-hl 跳块（禁聚焦政策）。
    // 压缩开关偏好存 petal gantt.json（默认开）；切项目跟手（pj-project-switched）。
    import { onMount } from "svelte";
    import { feQuery } from "./gui/fe";
    import { forestLinesSql, forestRefsSql, forestTasksSql, projectDocSql } from "./gui/queries";
    import {
        layoutGantt, MILESTONE_W, MIN_BAR_W, NAME_COL_W, ROW_H_BASE, SHORT_BAR_W, TRACK_H, TRACK_MAX,
        type ForestFruitRow, type ForestTaskRow, type GanttBar, type GanttModel,
    } from "./ganttLayout";
    import { normalizeGanttPrefs } from "./ganttPrefs";
    import { getLogicalDay } from "@/kernel/core/dates";
    import { holidaySpans } from "./lunarInfo";
    import { debugLog } from "./libs/debugLog";

    const AXIS_H = 32; // 顶部刻度条高

    let {
        projectId,
        t,
        openBlock,
        onOpenBoard,
        onOpenTimeline,
        onOpenDiary,
        loadGanttPrefs,
        saveGanttPrefs,
    }: {
        projectId: string;
        t: Record<string, string>;
        openBlock: (blockId: string) => void;
        /** 顶栏「看板」互切钮（openTab 去重聚焦通道由宿主注入） */
        onOpenBoard: () => void;
        /** 顶栏「时间线」互切钮（宿主注入——驾驶舱 onOpenTimeline 同款通道；缺省不渲染） */
        onOpenTimeline?: () => void;
        /** 顶栏「日账」钮（打开当月日志文档=日账月文档，禁聚焦；无月文档=宿主 toast fail-soft；
         *  01 跳转件：甘特=纯计划投影，实况可达靠跳转不靠塞数据） */
        onOpenDiary?: () => void;
        loadGanttPrefs?: () => Promise<unknown>;
        saveGanttPrefs?: (compress: boolean) => Promise<void>;
    } = $props();

    // 组件常驻：切项目跟手（pj-project-switched，驾驶舱同款），就地 load 不 {#key} 重建
    // svelte-ignore state_referenced_locally
    let liveProjectId = $state(projectId);

    function onSwitched(e: Event): void {
        const id = (e as CustomEvent).detail?.projectId;
        if (typeof id === "string" && id && id !== liveProjectId) {
            liveProjectId = id;
            void load(id);
        }
    }

    let phase = $state<"loading" | "empty" | "error" | "ready">("loading");
    let errorText = $state("");
    let model = $state<GanttModel | null>(null);
    let nowTs = $state(0);
    let compress = $state(true);
    let lastRaw: Omit<Parameters<typeof layoutGantt>[0], "compress"> | null = null; // 开关切换重排原料缓存
    let scrollEl = $state<HTMLDivElement | null>(null);
    let backVisible = $state(false);

    /** 行高=基础 28+每轨 22，封顶 4 轨；条在轨内垂直居中 */
    function rowH(trackCount: number): number {
        return ROW_H_BASE + (Math.min(trackCount, TRACK_MAX) - 1) * TRACK_H;
    }
    function trackOffset(trackCount: number): number {
        return Math.round((rowH(trackCount) - Math.min(trackCount, TRACK_MAX) * TRACK_H) / 2);
    }
    function itemTop(trackCount: number, stackRow: number, h: number): number {
        return trackOffset(trackCount) + stackRow * TRACK_H + Math.round((TRACK_H - h) / 2);
    }
    function barLeft(b: GanttBar): number {
        return b.tsStart !== undefined ? model!.map.xOf(b.tsStart)
            : model!.map.xOf(b.anchorTs) - (b.milestone ? MILESTONE_W : SHORT_BAR_W) / 2;
    }
    function barW(b: GanttBar): number {
        return b.tsStart !== undefined
            ? Math.max(MIN_BAR_W, model!.map.xOf(b.tsEnd!) - model!.map.xOf(b.tsStart))
            : b.milestone ? MILESTONE_W : SHORT_BAR_W;
    }
    function barTitle(b: GanttBar): string {
        const overdue = b.overdueDays !== undefined
            ? ` · ${(t.subOverdue ?? "逾期 {d} 天").replace("{d}", String(b.overdueDays))}` : "";
        return `${b.label}${overdue} · ${fmtTime(b.anchorTs)}`;
    }

    /** 码位截断防代理对劈裂（[...s] 码位迭代） */
    function cut(s: string, max: number): string {
        const chars = [...s];
        return chars.length > max ? chars.slice(0, max).join("") + "…" : s;
    }

    function fmtTime(ts: number): string {
        const d = new Date(ts);
        const p = (x: number) => String(x).padStart(2, "0");
        return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** 顶部天级刻度（含节假日标注；断带内日格被压缩到极窄=自然弃标签） */
    interface DayCell { ts: number; x: number; w: number; label: string; weekend: boolean; holiday?: string }
    const dayCells = $derived.by(() => {
        const m = model;
        if (!m) return [] as DayCell[];
        const cells: DayCell[] = [];
        const holStart = new Map(holidaySpans(m.timeDomain.min, m.timeDomain.max).map((s) => [s.start, s.name]));
        const d = new Date(m.timeDomain.min);
        d.setHours(0, 0, 0, 0);
        if (d.getTime() < m.timeDomain.min) d.setDate(d.getDate() + 1); // 首个完整日零点
        for (; d.getTime() <= m.timeDomain.max; d.setDate(d.getDate() + 1)) {
            const ts = d.getTime();
            const d2 = new Date(ts);
            d2.setDate(d2.getDate() + 1);
            const x = m.map.xOf(ts);
            const w = m.map.xOf(d2.getTime()) - x;
            const p = (n: number) => String(n).padStart(2, "0");
            cells.push({
                ts, x, w,
                label: `${p(d.getMonth() + 1)}-${p(d.getDate())}`,
                weekend: d.getDay() === 0 || d.getDay() === 6,
                holiday: holStart.get(ts),
            });
        }
        return cells;
    });

    function relayout(): void {
        if (!lastRaw) return;
        model = layoutGantt({ ...lastRaw, compress });
        layoutEpoch++;
        scheduleScrollToNow();
    }

    /** 断轴压缩开关：本地重排+落盘串行化（连点乱序防线，串行落盘链） */
    let saveChain: Promise<void> = Promise.resolve();
    function onCompressChange(next: boolean): void {
        compress = next;
        saveChain = saveChain.then(() => saveGanttPrefs?.(next)).catch(() => undefined);
        debugLog("fe", `gantt compress -> ${next}`);
        relayout();
    }

    /** 打开定位 now 于视口 ~30%（右侧留未来） */
    function scrollToNow(): void {
        if (!scrollEl || !model) return;
        scrollEl.scrollLeft = Math.max(0, NAME_COL_W + model.nowX - 0.3 * scrollEl.clientWidth);
        backVisible = false;
    }

    function onScroll(): void {
        if (!scrollEl || !model) return;
        const s = NAME_COL_W + model.nowX;
        backVisible = s < scrollEl.scrollLeft - 20 || s > scrollEl.scrollLeft + scrollEl.clientWidth + 20;
    }

    // 初始定位（数据链直接驱动，勿用 $effect——bind:this 赋值晚于 effect 的竞态在真实
    // 浏览器必现：scrollEl 恒 null 错过唯一次触发，scrollLeft 恒 0，09-24 gantt e2e 实锤；
    // 容器 0 尺寸=隐藏/动画期，120ms 轮询退避 ~3s 上界防脏定位）
    let layoutEpoch = 0;
    function scheduleScrollToNow(): void {
        const ep = layoutEpoch;
        let tries = 0;
        setTimeout(function attempt(): void {
            if (ep !== layoutEpoch || disposed) return;
            if (scrollEl && scrollEl.clientWidth > 0) {
                scrollToNow();
                return;
            }
            if (++tries < 25) setTimeout(attempt, 120);
        }, 0);
    }

    /** load 代际令牌：切项目时旧代在飞查询完成后不得覆写新代 */
    let loadGen = 0;
    let disposed = false;

    async function load(id: string, retriesLeft = 2): Promise<void> {
        const gen = ++loadGen;
        phase = "loading";
        errorText = "";
        try {
            const docs = await feQuery<{ id: string; content: string; box: string; hpath: string; path: string; created: string; updated: string; status: string | null }>(
                projectDocSql(id),
            );
            if (disposed || gen !== loadGen) return;
            if (!docs[0]) {
                // 索引窗兜底：刚建项目 type='d' 行 0.5~2s 才可见（驾驶舱同款有界重试）
                if (retriesLeft > 0) {
                    setTimeout(() => {
                        if (!disposed && id === liveProjectId) void load(id, retriesLeft - 1);
                    }, 1_500);
                    return;
                }
                phase = "empty";
                debugLog("fe", `gantt empty: project doc not indexed id=${id}`);
                return;
            }
            const [linesRaw, tasks, fruits] = await Promise.all([
                feQuery<{ id: string; content: string; hpath?: string | null; created: string; updated: string }>(forestLinesSql(id, docs[0].path)),
                feQuery<ForestTaskRow>(forestTasksSql(id, docs[0].path)),
                feQuery<ForestFruitRow>(forestRefsSql(id, docs[0].path)),
            ]);
            if (disposed || gen !== loadGen) return;
            // folder-model：项目内子文档全平铺直出（日记/注册分拣退役——结构即唯一真源）
            const workLines = linesRaw;
            const now = Date.now();
            lastRaw = {
                now,
                today: getLogicalDay(new Date(now)),
                project: { ...docs[0], name: docs[0].content || (t.untitled ?? ""), status: docs[0].status ?? "active" },
                lines: workLines,
                tasks,
                fruits,
            };
            // spec 空态语义：项目无任务/无线→主文档行照常渲染（空跨度带，行仍显示）；
            // 整图 empty 文案只留给「项目文档不可见」（上方 docs[0] 分支）——不照抄旧
            // 旧画布的 lines/tasks 双空重试回退
            nowTs = now;
            relayout();
            phase = "ready";
            debugLog("fe", `gantt ready project=${id} compress=${compress} rows=${model!.rows.length} lines=${workLines.length} tasks=${tasks.length} fruits=${fruits.length} lenPx=${Math.round(model!.map.lenPx)}`);
        } catch (e: any) {
            if (!disposed && gen === loadGen) {
                errorText = String(e?.message ?? e);
                phase = "error";
                debugLog("fe", `!! gantt load failed: ${errorText}`);
            }
        }
    }

    function keyOpen(blockId: string): (e: KeyboardEvent) => void {
        return (e) => {
            if ((e.key === "Enter" || e.key === " ") && !e.isComposing) {
                e.preventDefault();
                openBlock(blockId);
            }
        };
    }

    onMount(() => {
        // 压缩偏好先读后画（缺档=默认开）；读档失败不阻断
        void (async () => {
            try {
                compress = normalizeGanttPrefs(await loadGanttPrefs?.()).compress;
            } catch {
                compress = normalizeGanttPrefs(null).compress;
            }
            void load(liveProjectId);
        })();
        window.addEventListener("pj-project-switched", onSwitched as EventListener);
        return () => {
            disposed = true;
            window.removeEventListener("pj-project-switched", onSwitched as EventListener);
        };
    });
</script>

<div class="pj-gantt fn__flex-column">
    <div class="pj-gantt__toolbar">
        <button
            type="button"
            class="b3-button b3-button--small pj-gantt__toboard"
            title={t.ganttToBoardTitle ?? ""}
            onclick={onOpenBoard}
        >{t.ganttToBoard ?? "看板"}</button>
        {#if onOpenTimeline}
            <button
                type="button"
                class="b3-button b3-button--small pj-gantt__toboard"
                title={t.ganttToTimelineTitle ?? ""}
                onclick={onOpenTimeline}
            >{t.ganttToTimeline ?? "时间线"}</button>
        {/if}
        {#if onOpenDiary}
            <button
                type="button"
                class="b3-button b3-button--small pj-gantt__toboard"
                title={t.ganttToLedgerTitle ?? ""}
                onclick={onOpenDiary}
            >{t.ganttToLedger ?? "日账"}</button>
        {/if}
        <label class="pj-gantt__compress" title={t.ganttCompressTitle ?? ""}>
            <input type="checkbox" bind:checked={compress} onchange={(e) => onCompressChange(e.currentTarget.checked)} />
            {t.ganttCompress ?? "压缩空白"}
        </label>
        {#if backVisible}
            <button type="button" class="b3-button b3-button--small" onclick={() => void scrollToNow()}>{t.forestBackToNow ?? "回到现在"}</button>
        {/if}
    </div>
    {#if phase === "loading"}
        <div class="pj-gantt__hint">{t.dashboardLoading}</div>
    {:else if phase === "empty"}
        <div class="pj-gantt__hint">{t.ganttEmpty ?? ""}</div>
    {:else if phase === "error"}
        <div class="pj-gantt__hint">{errorText}</div>
    {:else if model}
        <div
            class="pj-gantt__scroll"
            bind:this={scrollEl}
            onscroll={onScroll}
            data-nowpx={NAME_COL_W + model.nowX}
            data-lenpx={NAME_COL_W + model.map.lenPx}
        >
            <div class="pj-gantt__inner" style="width:{NAME_COL_W + model.map.lenPx}px">
                <!-- 顶部 sticky 天级刻度 -->
                <div class="pj-gantt__axis" style="height:{AXIS_H}px">
                    <div class="pj-gantt__corner" style="width:{NAME_COL_W}px">
                        <span class="pj-gantt__nowtag">{t.forestNow ?? "现在"}{nowTs ? ` ${fmtTime(nowTs)}` : ""}</span>
                    </div>
                    {#each dayCells as c (c.ts)}
                        <div
                            class="pj-gantt__day"
                            class:pj-gantt__day--wk={c.weekend}
                            class:pj-gantt__day--hol={!!c.holiday}
                            style="left:{NAME_COL_W + c.x}px;width:{Math.max(0, c.w)}px"
                        >
                            {#if c.w >= 36}<span class="pj-gantt__daylabel">{c.label}</span>
                            {:else if c.w >= 18}<span class="pj-gantt__daylabel pj-gantt__daylabel--sm">{c.label.slice(3)}</span>{/if}
                            {#if c.holiday && c.w >= 12}<span class="pj-gantt__holbadge">{cut(c.holiday, 4)}</span>{/if}
                        </div>
                    {/each}
                </div>
                <!-- 行区：左 sticky 名列+右时间泳道 -->
                {#each model.rows as row (row.id)}
                    <div class="pj-gantt__row" class:pj-gantt__row--dorm={row.dormant} style="height:{rowH(row.trackCount)}px">
                        <div
                            class="pj-gantt__name"
                            style="width:{NAME_COL_W}px"
                            role="button" tabindex="0" title={row.name}
                            onclick={() => openBlock(row.id)}
                            onkeydown={keyOpen(row.id)}
                        >{cut(row.name, 12)}</div>
                        <div class="pj-gantt__lane" style="left:{NAME_COL_W}px;width:{model.map.lenPx}px">
                            <div
                                class="pj-gantt__span"
                                style="left:{model.map.xOf(row.spanTs.start)}px;width:{Math.max(0, model.map.xOf(row.spanTs.end) - model.map.xOf(row.spanTs.start))}px"
                            ></div>
                            {#each row.fruitDots as fd (fd.blockId)}
                                <span
                                    class="pj-gantt__dot"
                                    title={fd.label}
                                    style="left:{model.map.xOf(fd.ts)}px"
                                    role="button" tabindex="0"
                                    onclick={() => openBlock(fd.blockId)}
                                    onkeydown={keyOpen(fd.blockId)}
                                ></span>
                            {/each}
                            {#each row.bars as b (b.id)}
                                <div
                                    class="pj-gantt__bar pj-gantt__bar--{b.kind}"
                                    class:pj-gantt__bar--ms={b.milestone}
                                    style="left:{barLeft(b)}px;width:{barW(b)}px;top:{itemTop(row.trackCount, b.stackRow, b.milestone ? MILESTONE_W : 16)}px"
                                    title={barTitle(b)}
                                    role="button" tabindex="0"
                                    onclick={() => openBlock(b.blockId)}
                                    onkeydown={keyOpen(b.blockId)}
                                >{#if !b.milestone && barW(b) >= 36}{cut(b.label, Math.max(1, Math.floor(barW(b) / 13)))}{/if}</div>
                            {/each}
                            {#each row.futureBars as fb (fb.id)}
                                <div
                                    class="pj-gantt__fbar"
                                    style="left:{model.map.xOf(fb.ts) - SHORT_BAR_W / 2}px;width:{SHORT_BAR_W}px;top:{itemTop(row.trackCount, fb.stackRow, 8)}px"
                                    title={fb.label}
                                    role="button" tabindex="0"
                                    onclick={() => openBlock(fb.blockId)}
                                    onkeydown={keyOpen(fb.blockId)}
                                ></div>
                            {/each}
                        </div>
                    </div>
                {/each}
                <!-- now 红线（横贯行区）+断轴竖带 -->
                <div class="pj-gantt__nowline" style="left:{NAME_COL_W + model.nowX}px"></div>
                {#each model.map.breaks as bk (bk.t0)}
                    <div class="pj-gantt__breakband" style="left:{NAME_COL_W + bk.px}px;width:90px">
                        <span class="pj-gantt__breaklabel" style="top:{AXIS_H + 4}px">{(t.ganttBreakGap ?? "断 {d} 天").replace("{d}", String(bk.days))}</span>
                    </div>
                {/each}
            </div>
        </div>
    {/if}
</div>

<style>
    .pj-gantt {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }
    .pj-gantt__toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--b3-border-color);
    }
    .pj-gantt__compress {
        display: flex;
        gap: 5px;
        align-items: center;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        cursor: pointer;
    }
    .pj-gantt__hint {
        padding: 32px 20px;
        color: var(--b3-theme-on-surface-light);
        font-size: 13px;
    }
    .pj-gantt__scroll {
        flex: 1;
        min-height: 0;
        overflow: auto;
        position: relative;
    }
    .pj-gantt__inner {
        position: relative;
    }
    /* 顶部 sticky 刻度：z6；角落格 sticky 双向 z7 */
    .pj-gantt__axis {
        position: sticky;
        top: 0;
        z-index: 6;
        background: var(--b3-theme-surface);
        border-bottom: 1px solid var(--b3-border-color);
    }
    .pj-gantt__corner {
        position: sticky;
        left: 0;
        z-index: 7;
        display: flex;
        align-items: center;
        padding: 0 8px;
        background: var(--b3-theme-surface);
        border-right: 1px solid var(--b3-border-color);
        overflow: hidden;
    }
    .pj-gantt__nowtag {
        font-size: 11px;
        color: var(--b3-theme-error);
        white-space: nowrap;
    }
    .pj-gantt__day {
        position: absolute;
        top: 0;
        bottom: 0;
        border-left: 1px solid var(--b3-border-color);
    }
    .pj-gantt__day--wk {
        background: color-mix(in srgb, var(--b3-theme-on-surface) 4%, transparent);
    }
    .pj-gantt__day--hol {
        background: color-mix(in srgb, var(--b3-theme-primary) 8%, transparent);
    }
    .pj-gantt__daylabel {
        position: absolute;
        top: 3px;
        left: 3px;
        font-size: 10px;
        color: var(--b3-theme-on-surface-light);
        white-space: nowrap;
    }
    .pj-gantt__daylabel--sm {
        color: color-mix(in srgb, var(--b3-theme-on-surface-light) 70%, transparent);
    }
    .pj-gantt__holbadge {
        position: absolute;
        bottom: 2px;
        left: 3px;
        font-size: 10px;
        color: var(--b3-theme-primary);
        white-space: nowrap;
    }
    /* 行：名列 sticky 左 z5（surface 底防时间区透字） */
    .pj-gantt__row {
        position: relative;
        border-bottom: 1px solid var(--b3-border-color);
    }
    .pj-gantt__row--dorm {
        opacity: 0.45;
    }
    .pj-gantt__name {
        position: sticky;
        left: 0;
        z-index: 5;
        height: 100%;
        display: flex;
        align-items: center;
        padding: 0 8px;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        background: var(--b3-theme-surface);
        border-right: 1px solid var(--b3-border-color);
        overflow: hidden;
        white-space: nowrap;
        cursor: pointer;
    }
    .pj-gantt__lane {
        position: absolute;
        top: 0;
        bottom: 0;
    }
    .pj-gantt__span {
        position: absolute;
        top: 3px;
        bottom: 3px;
        border-radius: 3px;
        background: color-mix(in srgb, var(--b3-theme-on-surface) 13%, transparent); /* 6% 暗底不可感→两轮提档（vision 实测） */
    }
    /* 四态横条（box-sizing 统一，含边框总高 16） */
    .pj-gantt__bar {
        box-sizing: border-box;
        position: absolute;
        height: 16px;
        border-radius: 3px;
        font-size: 10px;
        line-height: 14px;
        padding: 0 4px;
        overflow: hidden;
        white-space: nowrap;
        cursor: pointer;
        color: var(--b3-theme-on-surface);
        z-index: 2;
    }
    .pj-gantt__bar--done {
        background: color-mix(in srgb, var(--b3-theme-success) 40%, var(--b3-theme-surface));
        color: color-mix(in srgb, var(--b3-theme-on-surface) 80%, var(--b3-theme-success));
    }
    .pj-gantt__bar--active {
        background: color-mix(in srgb, var(--b3-theme-primary) 45%, transparent);
        border: 1px solid var(--b3-theme-primary);
    }
    .pj-gantt__bar--overdue {
        background: color-mix(in srgb, var(--b3-theme-error) 12%, var(--b3-theme-surface));
        border: 1px solid var(--b3-theme-error);
        color: var(--b3-theme-error);
    }
    .pj-gantt__bar--future {
        background: color-mix(in srgb, var(--b3-theme-on-surface) 10%, var(--b3-theme-surface));
    }
    .pj-gantt__bar--ms {
        height: 12px;
        border-radius: 2px;
        transform: rotate(45deg);
        line-height: 12px;
    }
    /* 无日期排队条：灰虚短条 */
    .pj-gantt__fbar {
        box-sizing: border-box;
        position: absolute;
        height: 8px;
        border: 1px dashed var(--b3-theme-on-surface-light);
        border-radius: 3px;
        opacity: 0.7;
        cursor: pointer;
        z-index: 2;
    }
    .pj-gantt__dot {
        position: absolute;
        width: 8px;
        height: 8px;
        margin-left: -4px;
        bottom: 3px;
        border-radius: 50%;
        background: var(--b3-theme-success);
        cursor: pointer;
        z-index: 4; /* now 线(3)之上：果点被红线劈半不可感（vision P2） */
    }
    .pj-gantt__nowline {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        margin-left: -1px;
        background: var(--b3-theme-error);
        z-index: 3;
        pointer-events: none;
    }
    .pj-gantt__breakband {
        position: absolute;
        top: 0;
        bottom: 0;
        z-index: 1;
        background: color-mix(in srgb, var(--b3-theme-on-surface) 7%, transparent);
        border-inline: 1px dashed var(--b3-border-color);
        pointer-events: none;
    }
    .pj-gantt__breaklabel {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        font-size: 10px;
        color: var(--b3-theme-on-surface-light);
        background: var(--b3-theme-surface);
        padding: 0 4px;
        border: 1px dashed var(--b3-border-color);
        border-radius: 4px;
        white-space: nowrap;
    }
</style>
