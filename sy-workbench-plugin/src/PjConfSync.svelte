<script lang="ts">
    // 设置双栏 □1「同步对账」页（只读）：数据=kernel 同步链的 lastSync 基线，零网络零写入
    // ——自 Conf.svelte 纯搬家，交互文案零变化。
    // refreshTick：日历配置页动作成功经壳转发（原 refreshMirrors 跨区刷新的拆分形态），
    // 挂载首拉+每次 tick 重拉。
    import { ledgerToRows, type LedgerPanelModel } from "./gui/queries";
    type CalendarLedger = import("./kernel/core/ledger").CalendarLedger;

    let {
        t,
        loadLedger,
        refreshTick,
    }: {
        t: Record<string, string>;
        /** 日历区数据源：petal calendar-ledger.json 只读镜像（null=未同步空态） */
        loadLedger: () => Promise<CalendarLedger | null>;
        refreshTick: number;
    } = $props();

    let panel = $state<LedgerPanelModel | null>(null);

    /** 源键→展示（四源固定序；文案 i18n；sched=班表镜像，仅在用户选了飞书后端后有行） */
    let SOURCE_META = $derived<Array<{ key: "remind" | "task" | "burden" | "sched"; label: string }>>([
        { key: "remind", label: t.calSrcRemind },
        { key: "task", label: t.calSrcTask },
        { key: "burden", label: t.calSrcBurden },
        { key: "sched", label: t.calSrcSched },
    ]);

    function stateText(row: { state: string; conflicts: number }): string {
        if (row.state === "conflict") return t.calStateConflict.replace("{n}", String(row.conflicts));
        return row.state === "drift" ? t.calStateDrift : t.calStateOk;
    }

    $effect(() => {
        refreshTick; // 依赖：首跑=挂载加载，tick 变化=日历页动作成功重拉
        void (async () => {
            panel = ledgerToRows(await loadLedger().catch(() => null));
        })();
    });
</script>

<div class="pj-conf__section">
    <div class="pj-conf__title">{t.calSyncTitle}</div>
    <div class="pj-conf__lead">{t.calSyncLead}</div>
    {#if panel && panel.rows.length > 0}
        {#each SOURCE_META as src (src.key)}
            {#if panel.sources[src.key].count > 0}
                <div class="pj-conf__lsrc">
                    <span class="pj-conf__lsrc-name">{src.label}</span>
                    <span class="pj-conf__lsrc-state" class:pj-conf__lsrc-state--off={!panel.sources[src.key].enabled}>
                        {panel.sources[src.key].enabled ? t.calSrcOn : t.calSrcOff}
                    </span>
                    <span class="pj-conf__lsrc-count">{panel.sources[src.key].count}</span>
                </div>
                {#each panel.rows.filter((r) => r.source === src.key) as row (row.eventId)}
                    <div class="pj-conf__lrow">
                        <span class="pj-conf__lrow-summary" title={row.summary}>{row.summary || "—"}</span>
                        <span class="pj-conf__lrow-time">
                            {row.syTime ?? t.calNoTime}{#if row.fsTime && row.fsTime !== row.syTime}<span class="pj-conf__lrow-fs"> ↔ {row.fsTime}</span>{/if}
                        </span>
                        <span
                            class="pj-conf__lrow-state"
                            class:pj-conf__lrow-state--drift={row.state === "drift"}
                            class:pj-conf__lrow-state--conflict={row.state === "conflict"}
                        >{stateText(row)}</span>
                    </div>
                {/each}
            {/if}
        {/each}
    {:else}
        <div class="pj-conf__hint">{t.calSyncEmpty}</div>
    {/if}
    <div class="pj-conf__hint">{t.calSyncNote}</div>
</div>

<style lang="scss">
    .pj-conf__section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .pj-conf__title {
        font-size: 15px;
        font-weight: 400;
        color: var(--b3-theme-on-background);
    }

    .pj-conf__lead {
        font-size: 13px;
        color: var(--b3-theme-on-surface);
    }

    .pj-conf__hint {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    /* 同步区：源头行+条目行（信息平铺——不用 hover 藏） */
    .pj-conf__lsrc {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding-top: 6px;
        font-size: 13px;
    }

    .pj-conf__lsrc-name {
        color: var(--b3-theme-on-background);
        font-weight: 500;
    }

    .pj-conf__lsrc-state {
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-conf__lsrc-state--off {
        color: var(--b3-theme-on-surface);
    }

    .pj-conf__lsrc-count {
        font-size: 12px;
        color: var(--b3-theme-on-surface-light);
        font-variant-numeric: tabular-nums;
    }

    .pj-conf__lrow {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 2px 0 2px 12px;
        font-size: 12px;
        border-bottom: 1px solid var(--b3-border-color);

        &:last-child {
            border-bottom: none;
        }
    }

    .pj-conf__lrow-summary {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--b3-theme-on-background);
        text-align: left;
    }

    .pj-conf__lrow-time {
        flex-shrink: 0;
        color: var(--b3-theme-on-surface);
        font-variant-numeric: tabular-nums;
    }

    .pj-conf__lrow-fs {
        color: var(--b3-theme-on-surface-light);
    }

    .pj-conf__lrow-state {
        flex-shrink: 0;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-conf__lrow-state--drift {
        color: var(--b3-card-warning-color, #9d7e00);
    }

    .pj-conf__lrow-state--conflict {
        color: var(--b3-card-error-color, #d23f31);
    }
</style>
