<script lang="ts">
    // dataview B2：月度对账页签视图（零存储纯投影——「收据不是考卷」：只呈现事实不评判）。
    // 三块：①配额达成（各池月内配置配额〔池行配比+任务行配额聚合〕vs 日账实际时长）②时段
    // 热力（日账闭合段 日×小时 分钟桶 DOM 网格自绘，色阶=主题色 color-mix 透明度阶梯）③计划
    // 偏差（班表锚点时刻 vs 锚点出发型打点 start——准点/提前/延后/未出发，未出发只计已过去
    // 的日子）。聚合全在 gui/reconModel.ts 纯层（单测钉死）；无 AI 全可用（硬编码聚合）。
    // 数据链：每日配置=组件内 feQuery（Calendar B1 同款直连通道——dayConfigRowsSql 单发月集，
    // 判官 parseConfigRow）；日账=props loadLedgerEntries（kernel rpc ammo-ledger-read days 窗
    // ——B3 月文档读面）；班表=props loadBoardItems（SQL 扫描+日窗闸）。翻月=整窗重拉；条目
    // 点击=openBlock（cb-get-hl 禁聚焦——非编辑跳转不抢焦点是仓政策）。
    import { fmtDuration } from "./kernel/core/ammoPanel";
    import { POOL_LABEL, type AmmoPoolSlug } from "./kernel/core/ammoQuadrant";
    import { feQuery } from "./gui/fe";
    import { dayConfigRowsSql, type DayConfigScanRow } from "./gui/queries";
    import {
        buildReconDeviation, buildReconHeat, buildReconQuota, monthDays, monthPrefix, reconDayConfigs,
        type LedgerDayRow, type ReconDevItem, type ReconDeviation,
    } from "./gui/reconModel";
    import type { SchedItem } from "./kernel/core/schedule";

    let {
        t,
        openBlock,
        loadLedgerEntries,
        loadBoardItems,
    }: {
        t: Record<string, string>;
        openBlock: (blockId: string) => void;
        /** 日账日窗读（kernel rpc days 窗——B3 月文档读面；null/失败=空账 fail-soft） */
        loadLedgerEntries: (days: string[]) => Promise<LedgerDayRow[] | null>;
        /** 班表锚点源（loadBoardItems 同款——SchedItem 形态；失败=空源 fail-soft） */
        loadBoardItems: () => Promise<SchedItem[]>;
    } = $props();

    /** 加载时点锚（今天判定基准稳定——翻月不重算 today） */
    const nowAnchor = new Date();
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const todayIso = `${nowAnchor.getFullYear()}-${pad2(nowAnchor.getMonth() + 1)}-${pad2(nowAnchor.getDate())}`;

    let viewYear = $state(nowAnchor.getFullYear());
    let viewMonth = $state(nowAnchor.getMonth() + 1);
    let reloadTick = $state(0);
    let phase = $state<"loading" | "error" | "ready">("loading");

    /** 三源原料（翻月整窗重拉；配置行直连 feQuery 同 Calendar B1） */
    let configRows = $state<DayConfigScanRow[]>([]);
    let ledgerDays = $state<LedgerDayRow[]>([]);
    let schedItems = $state<SchedItem[]>([]);

    async function load(): Promise<void> {
        const y = viewYear, m = viewMonth; // 发起时窗快照：回包时窗已翻走=整包丢弃（Calendar 同款守卫）
        phase = "loading";
        try {
            const days = monthDays(y, m);
            const [cfgRaw, ledgerRaw, schedRaw] = await Promise.all([
                feQuery<DayConfigScanRow>(dayConfigRowsSql([monthPrefix(y, m)])),
                loadLedgerEntries(days).catch(() => null),
                loadBoardItems().catch(() => [] as SchedItem[]),
            ]);
            if (`${viewYear}-${viewMonth}` !== `${y}-${m}`) return; // 翻走回包作废（新窗 load 管自己的 phase）
            configRows = Array.isArray(cfgRaw) ? cfgRaw : [];
            ledgerDays = ledgerRaw ?? []; // rpc 缺/失败=空账（fail-soft，其余两块照常）
            schedItems = schedRaw;
            phase = "ready";
        } catch {
            if (`${viewYear}-${viewMonth}` === `${y}-${m}`) phase = "error"; // 配置 SQL 通道错误=空态+重试（Calendar loadError 同款判界）
        }
    }

    $effect(() => {
        reloadTick; // 首跑=挂载加载；翻月/重试钮触发同路重拉
        viewYear;
        viewMonth;
        void load();
    });

    function shiftMonth(delta: number): void {
        let m = viewMonth + delta;
        let y = viewYear;
        if (m < 1) { m = 12; y -= 1; }
        else if (m > 12) { m = 1; y += 1; }
        viewMonth = m;
        viewYear = y;
    }

    function goToday(): void {
        viewYear = nowAnchor.getFullYear();
        viewMonth = nowAnchor.getMonth() + 1;
    }

    function monthTitle(): string {
        return `${viewYear} · ${pad2(viewMonth)}`;
    }

    // ── 三块视图模型（纯函数重算零 IO） ──

    const configs = $derived(reconDayConfigs(configRows));
    const quotaRows = $derived(buildReconQuota({ configs, ledgerDays, year: viewYear, month: viewMonth }));
    const heat = $derived(buildReconHeat({ ledgerDays, year: viewYear, month: viewMonth }));
    const dev = $derived(buildReconDeviation({ sched: schedItems, ledgerDays, year: viewYear, month: viewMonth, today: todayIso }));

    /** 池配比性质标签（gold=保底 floor / hearth=上限 cap / 其余=无配比） */
    function poolTag(pool: AmmoPoolSlug): string {
        return pool === "gold" ? (t.reconQuotaFloor ?? "保底") : pool === "hearth" ? (t.reconQuotaCap ?? "上限") : (t.reconQuotaNone ?? "无配比");
    }

    /** 分钟值→展示串（0/空=0m——收据面零也照示不藏） */
    function fmtMin(min: number): string {
        return fmtDuration(min) || "0m";
    }

    /** 带符号分钟（差值口径：算术不是评价——多用/少用都只是数） */
    function fmtSigned(min: number): string {
        if (min > 0) return `+${fmtDuration(min)}`;
        if (min < 0) return `−${fmtDuration(-min)}`;
        return "0m";
    }

    /** 热力格色阶：值/峰值开方阶梯（感知线性）→主题色透明度 6%~75%。经手通道=CSS 自定义
     *  属性 --pj-heat-a（inline style 直挂 color-mix 声明会被部分环境 CSSOM 剥掉——custom
     *  property 恒存活，color-mix 留样式表；主题色单源，亮暗随变量自动成立零双分支） */
    function heatAlpha(v: number, max: number): number {
        if (v <= 0 || max <= 0) return 0;
        return 6 + Math.round(69 * Math.sqrt(v / max));
    }

    function heatCellTip(day: string, hour: number, min: number): string {
        return (t.reconHeatCellTip ?? "{d} {h}:00 · {m}").replace("{d}", day).replace("{h}", String(hour)).replace("{m}", fmtMin(min));
    }

    /** 偏差行文案（devMin null=未出发——只示事实） */
    function devText(item: ReconDevItem): string {
        if (item.devMin == null) return t.reconDevNotDeparted ?? "未出发";
        return `${item.anchorHM} → ${item.actualHM}（${fmtSigned(item.devMin)}）`;
    }

    /** 偏差块汇总 chip 集（data-k 断言钩；平均 chip=有出发样本才在） */
    function devChips(d: ReconDeviation): Array<{ k: string; text: string }> {
        const chips = [
            { k: "ontime", text: `${t.reconDevOnTime ?? "准点"} ${d.onTime}` },
            { k: "early", text: `${t.reconDevEarly ?? "提前"} ${d.early}` },
            { k: "late", text: `${t.reconDevLate ?? "延后"} ${d.late}` },
            { k: "notdeparted", text: `${t.reconDevNotDeparted ?? "未出发"} ${d.notDeparted}` },
        ];
        if (d.avgDevMin != null) chips.push({ k: "avg", text: `${t.reconDevAvg ?? "平均"} ${fmtSigned(d.avgDevMin)}` });
        return chips;
    }
</script>

<div class="pj-recon">
    <div class="pj-recon__topbar">
        <div class="pj-recon__nav">
            <button class="b3-button b3-button--small b3-button--outline pj-recon__navbtn" onclick={() => shiftMonth(-1)} aria-label={t.calPrevMonth ?? "上一月"} title={t.calPrevMonth ?? "上一月"}>‹</button>
            <span class="pj-recon__title">{monthTitle()}</span>
            <button class="b3-button b3-button--small b3-button--outline pj-recon__navbtn" onclick={() => shiftMonth(1)} aria-label={t.calNextMonth ?? "下一月"} title={t.calNextMonth ?? "下一月"}>›</button>
        </div>
        <button class="b3-button b3-button--small b3-button--outline" onclick={goToday}>{t.calToday ?? "今天"}</button>
        <button class="b3-button b3-button--small b3-button--outline pj-recon__refresh" onclick={() => (reloadTick += 1)}>{t.boardRefresh ?? "刷新"}</button>
        <span class="fn__flex-1"></span>
        <span class="pj-recon__tagline">{t.reconTagline ?? "照实记录——收据不是考卷"}</span>
    </div>

    {#if phase === "loading"}
        <div class="pj-recon__state">{t.dashboardLoading ?? "读取中…"}</div>
    {:else if phase === "error"}
        <div class="pj-recon__state">
            <div>{t.reconLoadFail ?? "对账读取失败"}</div>
            <button class="b3-button b3-button--small b3-button--outline" onclick={() => (reloadTick += 1)}>{t.reconRetry ?? "重试"}</button>
        </div>
    {:else}
        <!-- ① 配额达成：各池 配置 vs 实际（池行配比+任务行配额=配置侧；日账闭合段=实际侧） -->
        <section class="pj-recon__block" data-block="quota">
            <h3 class="pj-recon__blocktitle">{t.reconQuotaTitle ?? "配额对账"}</h3>
            <div class="pj-recon__qtable" role="table">
                <div class="pj-recon__qhead" role="row">
                    <span class="pj-recon__qcell pj-recon__qcell--pool">{t.reconQuotaPoolCol ?? "池"}</span>
                    <span class="pj-recon__qcell">{t.reconQuotaCfgCol ?? "配置"}</span>
                    <span class="pj-recon__qcell">{t.reconQuotaActualCol ?? "实际"}</span>
                    <span class="pj-recon__qcell">{t.reconQuotaDeltaCol ?? "差"}</span>
                </div>
                {#each quotaRows as row (row.pool)}
                    <div class="pj-recon__qrow" role="row" data-pool={row.pool}>
                        <span class="pj-recon__qcell pj-recon__qcell--pool">
                            <i class="pj-recon__pooldot" data-pool={row.pool}></i>
                            <span class="pj-recon__poolname">{POOL_LABEL[row.pool]}</span>
                            <span class="pj-recon__pooltag">{poolTag(row.pool)}</span>
                        </span>
                        <span class="pj-recon__qcell">
                            {#if row.days > 0}
                                {row.planMin > 0 ? fmtMin(row.planMin) : (t.reconQuotaNone ?? "无配比")}
                                <span class="pj-recon__qsub">{t.reconQuotaDays?.replace("{n}", String(row.days)) ?? `${row.days} 天`}{row.quotaMin > 0 ? ` · ${t.reconQuotaTaskQuota ?? "任务配额"} ${fmtMin(row.quotaMin)}` : ""}</span>
                            {:else}
                                —
                            {/if}
                        </span>
                        <span class="pj-recon__qcell">
                            {fmtMin(row.actualMin)}
                            {#if row.unclosed > 0}
                                <span class="pj-recon__qsub">{t.reconQuotaUnclosed?.replace("{n}", String(row.unclosed)) ?? `${row.unclosed} 笔未闭合`}</span>
                            {/if}
                        </span>
                        <span class="pj-recon__qcell">{row.days > 0 || row.actualMin > 0 ? fmtSigned(row.actualMin - row.planMin) : "—"}</span>
                    </div>
                {/each}
            </div>
        </section>

        <!-- ② 时段热力：日×24 小时分钟桶（DOM 网格自绘；色阶=主题色 color-mix 透明度） -->
        <section class="pj-recon__block" data-block="heat">
            <h3 class="pj-recon__blocktitle">{t.reconHeatTitle ?? "时段热力"}</h3>
            {#if heat.max <= 0}
                <div class="pj-recon__emptynote">{t.reconHeatEmpty ?? "本月暂无打点"}</div>
            {:else}
                <div class="pj-recon__heatwrap">
                    <div class="pj-recon__heatgrid" role="grid">
                        <span class="pj-recon__heatcorner"></span>
                        {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
                            <span class="pj-recon__heatlabel" data-h={h}>{h % 3 === 0 ? String(h) : ""}</span>
                        {/each}
                        {#each heat.days as day (day)}
                            <span class="pj-recon__daylabel" data-d={day}>{Number(day.slice(8, 10))}</span>
                            {#each heat.buckets.get(day) ?? [] as min, h (day + "#" + h)}
                                <span
                                    class="pj-recon__cell"
                                    class:pj-recon__cell--on={min > 0}
                                    data-d={day}
                                    data-h={h}
                                    data-min={min}
                                    style={min > 0 ? `--pj-heat-a: ${heatAlpha(min, heat.max)}` : ""}
                                    title={min > 0 ? heatCellTip(day, h, min) : ""}
                                ></span>
                            {/each}
                        {/each}
                    </div>
                </div>
                <div class="pj-recon__heatlegend">
                    <span class="pj-recon__heatlegendtext">{t.reconHeatLess ?? "少"}</span>
                    {#each [8, 25, 40, 55, 75] as a (a)}
                        <span class="pj-recon__heatlegendcell" style={`background-color: color-mix(in srgb, var(--b3-theme-primary) ${a}%, transparent)`}></span>
                    {/each}
                    <span class="pj-recon__heatlegendtext">{t.reconHeatMore ?? "多"}</span>
                    <span class="pj-recon__heatlegendnote">{t.reconHeatUnit ?? "分钟/格"}</span>
                </div>
            {/if}
        </section>

        <!-- ③ 计划偏差：班表锚点 vs 锚点出发型打点（未出发只计已过去的日子） -->
        <section class="pj-recon__block" data-block="dev">
            <h3 class="pj-recon__blocktitle">{t.reconDevTitle ?? "锚点偏差"}</h3>
            {#if dev.items.length === 0}
                <div class="pj-recon__emptynote">{t.reconDevNone ?? "本月无带时刻锚点"}</div>
            {:else}
                <div class="pj-recon__devchips">
                    {#each devChips(dev) as chip (chip.k)}
                        <span class="pj-recon__devchip" data-k={chip.k}>{chip.text}</span>
                    {/each}
                </div>
                <div class="pj-recon__devlist">
                    {#each dev.items as item (item.key)}
                        <button
                            class="pj-recon__devrow"
                            class:pj-recon__devrow--miss={item.devMin == null}
                            onclick={() => openBlock(item.key)}
                            title={t.reconDevJump ?? "跳到班表锚点"}
                        >
                            <span class="pj-recon__devday">{item.day.slice(5)}</span>
                            <span class="pj-recon__devsummary">{item.summary || (t.schedEmptySummary ?? "（空条目）")}</span>
                            <span class="pj-recon__devtime">{devText(item)}</span>
                        </button>
                    {/each}
                </div>
            {/if}
        </section>
    {/if}
</div>

<style lang="scss">
    .pj-recon {
        height: 100%;
        overflow-y: auto;
        padding: 8px 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-sizing: border-box;
    }

    /* 顶栏：翻月组+今天+刷新+收据口径标语（sticky 同 pj-cal 顶栏先例） */
    .pj-recon__topbar {
        position: sticky;
        top: 0;
        z-index: 4;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 0;
        background-color: var(--b3-theme-surface);
    }

    .pj-recon__nav {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .pj-recon__navbtn {
        padding: 2px 10px;
        font-size: 15px;
        line-height: 1.4;
    }

    .pj-recon__title {
        min-width: 88px;
        text-align: center;
        font-size: 15px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
        font-variant-numeric: tabular-nums;
    }

    /* 收据口径标语：弱化辅助色（口径声明，不参与层级竞争） */
    .pj-recon__tagline {
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
        white-space: nowrap;
    }

    .pj-recon__state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 48px 0;
        font-size: 13px;
        color: var(--b3-theme-on-surface);
    }

    .pj-recon__block {
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius-b);
        background: var(--b3-theme-surface);
        padding: 10px 12px;
    }

    .pj-recon__blocktitle {
        margin: 0 0 8px;
        font-size: 13px;
        font-weight: 600;
        color: var(--b3-theme-on-background);
    }

    .pj-recon__emptynote {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        opacity: 0.7;
        padding: 6px 0;
    }

    /* ① 配额表：四行固定（列=池/配置/实际/差；子注=天数·任务配额/未闭合笔数） */
    .pj-recon__qtable {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }

    .pj-recon__qhead,
    .pj-recon__qrow {
        display: grid;
        grid-template-columns: minmax(180px, 1.4fr) minmax(150px, 1.2fr) minmax(120px, 1fr) minmax(80px, 0.7fr);
        gap: 8px;
        align-items: baseline;
    }

    .pj-recon__qhead {
        padding: 2px 6px;
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-recon__qrow {
        padding: 6px;
        border-radius: var(--b3-border-radius);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
    }

    .pj-recon__qrow:nth-child(odd) {
        background-color: color-mix(in srgb, var(--b3-theme-surface-light) 45%, transparent);
    }

    .pj-recon__qcell {
        min-width: 0;
        color: var(--b3-theme-on-background);
    }

    .pj-recon__qcell--pool {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    /* 池色圆点（BoardView pooldot 同族四池性格色——单事实源对齐） */
    .pj-recon__pooldot {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--b3-theme-primary);
    }

    .pj-recon__pooldot[data-pool="gold"] { background: #b8860b; }
    .pj-recon__pooldot[data-pool="deadline"] { background: #dc2626; }
    .pj-recon__pooldot[data-pool="hearth"] { background: #ea580c; }
    .pj-recon__pooldot[data-pool="crumbs"] { background: #16a34a; }

    .pj-recon__poolname {
        font-weight: 500;
        white-space: nowrap;
    }

    /* 池性质标签：tonal 浅底（保底/上限/无配比——性质说明非状态） */
    .pj-recon__pooltag {
        flex: none;
        font-size: 10px;
        line-height: 1.5;
        padding: 0 4px;
        border-radius: 3px;
        color: var(--b3-theme-on-surface);
        background-color: color-mix(in srgb, var(--b3-theme-on-surface-light) 18%, transparent);
    }

    .pj-recon__qsub {
        display: block;
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    /* ② 热力网格：日行×24 时列（横向滚动兜底窄视口；格=正方块 aspect-ratio 防挤扁） */
    .pj-recon__heatwrap {
        overflow-x: auto;
        padding-bottom: 4px;
    }

    .pj-recon__heatgrid {
        display: grid;
        grid-template-columns: 26px repeat(24, minmax(12px, 1fr));
        grid-auto-rows: auto;
        gap: 2px;
        min-width: 420px;
    }

    .pj-recon__heatcorner {
        grid-column: 1;
    }

    .pj-recon__heatlabel {
        font-size: 10px;
        line-height: 1.2;
        text-align: left;
        color: var(--b3-theme-on-surface-light);
        font-variant-numeric: tabular-nums;
    }

    .pj-recon__daylabel {
        font-size: 10px;
        line-height: 14px;
        text-align: right;
        color: var(--b3-theme-on-surface-light);
        font-variant-numeric: tabular-nums;
    }

    .pj-recon__cell {
        width: 100%;
        height: 14px;
        border-radius: 2px;
        background-color: color-mix(in srgb, var(--b3-theme-surface-light) 40%, transparent);
    }

    .pj-recon__cell--on {
        /* 色阶=主题色 color-mix，透明度吃格上 --pj-heat-a（0~75，开方感知线性） */
        background-color: color-mix(in srgb, var(--b3-theme-primary) calc(var(--pj-heat-a) * 1%), transparent);
    }

    .pj-recon__heatlegend {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-top: 6px;
    }

    .pj-recon__heatlegendtext {
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-recon__heatlegendcell {
        width: 12px;
        height: 12px;
        border-radius: 2px;
    }

    .pj-recon__heatlegendnote {
        margin-left: 6px;
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    /* ③ 偏差块：汇总 chips+明细行（点击=禁聚焦跳班表锚点） */
    .pj-recon__devchips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
    }

    .pj-recon__devchip {
        font-size: 11px;
        line-height: 1.6;
        padding: 0 8px;
        border-radius: var(--b3-border-radius);
        color: var(--b3-theme-on-surface);
        background-color: color-mix(in srgb, var(--b3-theme-on-surface-light) 16%, transparent);
        font-variant-numeric: tabular-nums;
    }

    .pj-recon__devlist {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 240px;
        overflow-y: auto;
    }

    .pj-recon__devrow {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
        padding: 2px 6px;
        border: none;
        border-radius: 3px;
        background: transparent;
        font-family: inherit;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        text-align: left;
        cursor: pointer;
        font-variant-numeric: tabular-nums;
    }

    .pj-recon__devrow:hover {
        background-color: var(--b3-list-hover, var(--b3-theme-surface-lighter));
    }

    .pj-recon__devday {
        flex: none;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-recon__devsummary {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--b3-theme-on-background);
    }

    .pj-recon__devtime {
        flex: none;
        margin-left: auto;
    }

    /* 未出发行：弱化（事实照示不加重——收据不是考卷） */
    .pj-recon__devrow--miss .pj-recon__devtime {
        color: var(--b3-theme-on-surface-light);
    }

    /* ── 暗色（3.8.3 判据=html[data-theme-mode=dark]，scoped 分支 :global——仓纪律） ──
       热力色阶走主题变量 color-mix 自动成立；池色点四值双分支（BoardView 同源色值） */
    :global(html[data-theme-mode="dark"]) .pj-recon__pooldot[data-pool="gold"] { background: #e3b341; }
    :global(html[data-theme-mode="dark"]) .pj-recon__pooldot[data-pool="deadline"] { background: #f87171; }
    :global(html[data-theme-mode="dark"]) .pj-recon__pooldot[data-pool="hearth"] { background: #fb923c; }
    :global(html[data-theme-mode="dark"]) .pj-recon__pooldot[data-pool="crumbs"] { background: #86efac; }
</style>
