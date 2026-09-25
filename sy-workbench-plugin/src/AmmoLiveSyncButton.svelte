<script lang="ts">
    // ammo □7：实况手动同步钮（颜色标态）——dock 时间线头部/时间线页签顶栏/□9 悬浮窗工具区
    // 三处 mount 本组件=同一引擎同一状态源（□9 契约：勿做第二套引擎）。
    // 四态色标（bear 拍板三色+off 灰）：绿=已同步 / 黄=有未同步新打点 / 灰=无内容或飞书未配置
    // （off 与 empty 同灰，title 区分原因）/ 同步中=进度文案禁点。
    // 数据链：态=kernel rpc ammo-live-state（纯读零网络）；动作=ammo-live-sync（kernel 串行
    // 单飞链+plan 幂等）；刷新=window「pj-ammo-live-synced」（kernel 同步完广播转发）+
    // 「pj-ammo-state」（开始/停止留痕→态变黄）——内存事件链，非 SQL 轮询。
    // type-only import：编排层类型擦除，不拖 feishu IO 面进前端 bundle（CJS 打包图纪律）。
    import { onMount } from "svelte";
    import { AMMO_LIVE_STATE_METHOD, AMMO_LIVE_SYNC_METHOD } from "./shared/channels";
    import type { AmmoLiveState, AmmoLiveSyncResult } from "./kernel/ammoLiveSync";

    let {
        t,
        rpc,
        day,
    }: {
        t: Record<string, string>;
        /** 插件 kernel rpc 面（Plugin 实例 this.kernel.rpc——宿主传入；缺=钮隐藏） */
        rpc: { call: Record<string, (p?: any) => Promise<any>> } | null;
        /** 目标日（缺省=当日；时间线页签翻日跟手） */
        day?: string;
    } = $props();

    let st = $state<AmmoLiveState | null>(null);
    let syncing = $state(false);
    /** 最近一次同步失败的拒因（kernel 配置守卫/网络错——title 透出，下次成功或态变清零） */
    let lastError = $state("");

    async function refresh(): Promise<void> {
        if (!rpc?.call) return;
        try {
            st = (await rpc.call[AMMO_LIVE_STATE_METHOD]({ day })) as AmmoLiveState;
        } catch {
            // 读态失败=保持上一态（下一发广播/动作自愈）；首读失败=钮灰 title 兜底
        }
    }

    async function sync(): Promise<void> {
        if (syncing || !rpc?.call) return;
        syncing = true;
        lastError = "";
        try {
            const r = (await rpc.call[AMMO_LIVE_SYNC_METHOD]({ day })) as AmmoLiveSyncResult;
            if (r && r.ok === false) lastError = r.error ?? ""; // 拒因透出 title（黄钮引导知情再点）
            await refresh();
        } catch {
            // 异常=态面照旧（state 恒 dirty 黄钮引导再点）；错误详情走 kernel 日志
        } finally {
            syncing = false;
        }
    }

    function onLiveSynced(e: Event): void {
        // 广播回包即最新态（payload=AmmoLiveSyncResult）——本窗动作与本链他端触发同通道收敛
        void refresh();
        void (e as CustomEvent).detail;
    }

    onMount(() => {
        window.addEventListener("pj-ammo-live-synced", onLiveSynced);
        window.addEventListener("pj-ammo-state", onLiveSynced);
        return () => {
            window.removeEventListener("pj-ammo-live-synced", onLiveSynced);
            window.removeEventListener("pj-ammo-state", onLiveSynced);
        };
    });

    // day 变化→重拉（页签翻日跟手：旧日态面作废——st 是状态快照不是记忆）
    $effect(() => {
        day;
        void refresh();
    });

    const cls = $derived(
        syncing || !st
            ? "pj-live-sync--busy"
            : st.state === "synced"
                ? "pj-live-sync--green"
                : st.state === "dirty"
                    ? "pj-live-sync--yellow"
                    : "pj-live-sync--grey",
    );
    /** 文字随态走（色弱友好——09-23 bear「成功的红绿分不清」；圆点色标保留、文字不再恒定
     *  四态全区分）：绿=已同步 / 黄=待同步{n} / 灰（off·empty·未知）=默认动作文案。 */
    const label = $derived.by(() => {
        if (syncing) return t.ammoLiveSyncing ?? "同步中…";
        if (st?.state === "synced") return t.ammoLiveStateSyncedShort ?? "已同步";
        if (st?.state === "dirty") return (t.ammoLiveStateDirtyShort ?? "待同步 {n}").replace("{n}", String(st.pending));
        return t.ammoLiveSyncBtn ?? "同步飞书";
    });
    const tip = $derived.by(() => {
        if (!rpc) return "";
        if (syncing) return t.ammoLiveSyncing ?? "同步中…";
        if (!st) return t.ammoLiveStateUnknown ?? "同步态未知";
        const errSuffix = lastError ? `（${lastError}）` : "";
        if (st.state === "off") return (t.ammoLiveStateOff ?? "飞书未配置或已停用") + (st.error ? `（${st.error}）` : "");
        if (st.state === "empty") return t.ammoLiveStateEmpty ?? "当日无实况打点";
        if (st.state === "dirty") return (t.ammoLiveStateDirty ?? "有实况未同步").replace("{n}", String(st.pending)) + errSuffix;
        return t.ammoLiveStateSynced ?? "实况已同步飞书";
    });
    const disabled = $derived(syncing || !rpc || !st || st.state === "off" || st.state === "empty" || st.ok === false);
</script>

{#if rpc}
    <button class="pj-live-sync {cls}" onclick={() => void sync()} disabled={disabled} title={tip} aria-label={tip} data-live-sync-state={!st || !st.ok ? "unknown" : st.state}>
        <i class="pj-live-sync__dot"></i><span class="pj-live-sync__text">{label}</span>
    </button>
{/if}

<style lang="scss">
    /* 胶囊钮：色点+文字；三色走卡片变量（明暗各自成立——feishu 紫钉值的教训，主题变量优先）。
     * 可收缩让位（vision P0 实锤：头栏加图标钮后 flex-shrink:0 恒不让位=末字被面板右缘
     * 硬裁半个字形——pomo chip 同款 min-width:0+max-width 治法；dot 不缩、文字省略、全文 title） */
    .pj-live-sync {
        flex-shrink: 1;
        min-width: 0;
        max-width: 42%;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 22px;
        padding: 0 8px;
        border: 1px solid var(--b3-border-color);
        border-radius: 11px;
        background-color: var(--b3-theme-surface);
        font-size: 11.5px;
        line-height: 1;
        color: var(--b3-theme-on-surface-light);
        cursor: pointer;
        white-space: nowrap;
    }

    .pj-live-sync__dot {
        flex-shrink: 0;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background-color: var(--b3-theme-on-surface-light);
    }

    .pj-live-sync__text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .pj-live-sync--green {
        color: var(--b3-card-success-color, #2a9d42);
        border-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 40%, transparent);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 8%, transparent);
    }

    .pj-live-sync--green .pj-live-sync__dot {
        background-color: var(--b3-card-success-color, #2a9d42);
    }

    .pj-live-sync--yellow {
        color: var(--b3-card-warning-color, #9d7e00);
        border-color: color-mix(in srgb, var(--b3-card-warning-color, #9d7e00) 45%, transparent);
        background-color: color-mix(in srgb, var(--b3-card-warning-color, #9d7e00) 10%, transparent);
    }

    .pj-live-sync--yellow .pj-live-sync__dot {
        background-color: var(--b3-card-warning-color, #9d7e00);
    }

    .pj-live-sync--grey,
    .pj-live-sync--busy {
        cursor: default;
    }

    .pj-live-sync--busy {
        opacity: 0.7;
    }

    .pj-live-sync:hover:not(:disabled) {
        background-color: var(--b3-list-hover);
    }

    .pj-live-sync:disabled {
        opacity: 0.85;
    }
</style>
