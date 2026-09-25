<script lang="ts">
    // sloop □4 交接会对话框：对账单预填（三态）+待确认拖动+开场包全文（复制给接了思源 MCP
    // 的 AI，或任意大模型）——信息平铺不藏 hover；AI 侧写回走 routine 工具面。
    // manualui：对账单三态 chips 可勾选改态，「落对账」经 kernel rpc recon-record 直落
    // recon_record 同链（recordRecon 单一事实源）——不开 AI 也能走完交接会。
    import { describeDrag, type DragRecord, type ReconItem, type ReconVerdict } from "./kernel/core/schedule";
    import { RECON_RECORD_METHOD } from "./shared/channels";

    let {
        t,
        day,
        packet,
        recon,
        drags,
        rpc,
    }: {
        t: Record<string, string>;
        day: string;
        packet: string;
        recon: ReconItem[];
        drags: DragRecord[];
        /** 插件 kernel rpc 面（Plugin 实例的 this.kernel.rpc——宿主传入；缺=落对账钮报不可用） */
        rpc?: { call: Record<string, (p?: any) => Promise<any>> } | null;
    } = $props();

    let copied = $state(false);

    // 勾选态：初值=预填三态（recon 语义不动——预填即选中，用户只改错的）；快照语义=dialog
    // 一次组装 recon 恒不再变（初值捕获即本意）；整体重赋值驱动重渲（Set 家族坑不适用）
    // svelte-ignore state_referenced_locally
    let verdicts = $state<Record<string, ReconVerdict>>(Object.fromEntries(recon.map((r) => [r.key, r.verdict])));
    let saving = $state(false);
    let saved = $state(false);
    let saveError = $state("");

    const V_LABEL = $derived<Record<ReconItem["verdict"], string>>({
        done: t.reconDone,
        missed: t.reconMissed,
        unknown: t.reconUnknown,
    });
    const V_ORDER: ReconVerdict[] = ["done", "missed", "unknown"];
    /** 有任何勾选（预填也算）才可落；空班表=零勾选恒置灰 */
    const hasAny = $derived(Object.keys(verdicts).length > 0);

    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(packet);
            copied = true;
            setTimeout(() => {
                copied = false;
            }, 1500);
        } catch {
            // 剪贴板不可用（headless/权限）静默
        }
    }

    async function commit(): Promise<void> {
        if (saving || saved) return;
        const call = rpc?.call?.[RECON_RECORD_METHOD];
        if (!call) {
            saveError = t.reconCommitNoKernel;
            return;
        }
        saving = true;
        saveError = "";
        try {
            const res = await call({
                day,
                results: recon.map((r) => ({ key: r.key, summary: r.summary, verdict: verdicts[r.key] ?? r.verdict })),
            });
            if (res?.success) {
                saved = true;
                setTimeout(() => {
                    saved = false;
                }, 2000);
            } else {
                saveError = typeof res?.error === "string" && res.error ? res.error : t.reconCommitFail;
            }
        } catch (e: any) {
            saveError = `${t.reconCommitFail}：${String(e?.message ?? e)}`;
        } finally {
            saving = false;
        }
    }
</script>

<div class="pj-ho fn__flex-column">
    <div class="pj-ho__lead">{t.handoffHint}</div>

    <div class="pj-ho__sec">
        <div class="pj-ho__sec-title">{t.handoffSheetTitle} · {day}</div>
        {#if recon.length === 0}
            <div class="pj-ho__empty">{t.handoffNoItems}</div>
        {:else}
            {#each recon as r (r.key)}
                <div class="pj-ho__row">
                    <span class="pj-ho__chips">
                        {#each V_ORDER as v (v)}
                            <button
                                type="button"
                                class="pj-ho__chip pj-ho__chip--{v}"
                                class:is-on={(verdicts[r.key] ?? r.verdict) === v}
                                aria-pressed={(verdicts[r.key] ?? r.verdict) === v}
                                onclick={() => (verdicts = { ...verdicts, [r.key]: v })}
                            >{V_LABEL[v]}</button>
                        {/each}
                    </span>
                    <span class="pj-ho__slot">{r.start ?? t.schedTrayShort}</span>
                    <span class="pj-ho__summary">{r.summary}{r.hard ? `（${t.schedHardTag}）` : ""}</span>
                    <span class="pj-ho__ev">{r.evidence.join("；")}</span>
                </div>
            {/each}
        {/if}
    </div>

    {#if drags.length > 0}
        <div class="pj-ho__sec">
            <div class="pj-ho__sec-title">{t.handoffDragsTitle}</div>
            {#each drags as d (d.key + "#" + d.at)}
                <div class="pj-ho__row pj-ho__row--drag">{describeDrag(d)}</div>
            {/each}
        </div>
    {/if}

    <div class="pj-ho__sec pj-ho__sec--grow">
        <div class="pj-ho__sec-title fn__flex">
            <span>{t.handoffPromptTitle}</span>
            <span class="fn__flex-1"></span>
            <button class="b3-button b3-button--small" onclick={() => void copy()}>{copied ? t.copied : t.handoffCopy}</button>
        </div>
        <pre class="pj-ho__prompt">{packet}</pre>
    </div>

    <div class="pj-ho__foot">
        {#if saveError}
            <span class="pj-ho__foot-err">{saveError}</span>
        {/if}
        <span class="fn__flex-1"></span>
        <button class="b3-button" disabled={saving || saved || !hasAny} onclick={() => void commit()}>
            {saved ? t.reconCommitted : t.reconCommitBtn}
        </button>
    </div>
</div>

<style lang="scss">
    .pj-ho {
        gap: 10px;
        height: 100%;
        min-height: 0;
        padding: 12px 16px;
        box-sizing: border-box;
        overflow-y: auto;
    }

    .pj-ho__lead {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    .pj-ho__sec {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .pj-ho__sec--grow {
        flex: 1 1 auto;
        min-height: 160px;
    }

    .pj-ho__sec-title {
        font-size: 13px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
        gap: 8px;
        align-items: center;
    }

    .pj-ho__empty {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    .pj-ho__row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        min-width: 0;
        font-size: 12px;
        color: var(--b3-theme-on-background);
        flex-wrap: wrap;
    }

    .pj-ho__row--drag {
        color: var(--b3-theme-on-surface);
    }

    /* 三态语义色（完成=success/未完成=error/待问=中性主色）——选中态沿用原 verdict 徽标
     * 同语言；未选中态显式弱化（b3-button 基类=主色实心，css.md「两态控件」纪律）。
     * 弱化≠裸文本：淡描边 pill+文字比注释深一档（vision P1：纯透明底浅字与行内注释
     * 同色同字号，读不出是三选一控件） */
    .pj-ho__chips {
        display: inline-flex;
        flex-shrink: 0;
        gap: 2px;
    }

    .pj-ho__chip {
        border: 1px solid var(--b3-border-color, rgba(128, 128, 128, 0.35));
        cursor: pointer;
        font-size: 11px;
        line-height: 1.4;
        padding: 0 5px;
        border-radius: 999px;
        color: var(--b3-theme-on-surface);
        background-color: transparent;
    }

    .pj-ho__chip:hover {
        background-color: var(--b3-theme-background);
    }

    .pj-ho__chip--done.is-on {
        color: var(--b3-card-success-color, #2a9d42);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 12%, transparent);
    }

    .pj-ho__chip--missed.is-on {
        color: var(--b3-card-error-color, #d23f31);
        background-color: color-mix(in srgb, var(--b3-card-error-color, #d23f31) 12%, transparent);
    }

    .pj-ho__chip--unknown.is-on {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 12%, transparent);
    }

    .pj-ho__foot {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
    }

    .pj-ho__foot-err {
        font-size: 12px;
        color: var(--b3-card-error-color, #d23f31);
        overflow-wrap: anywhere;
    }

    .pj-ho__slot {
        flex-shrink: 0;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        font-variant-numeric: tabular-nums;
        min-width: 36px;
    }

    .pj-ho__summary {
        font-size: 12px;
    }

    .pj-ho__ev {
        flex: 1 1 120px;
        min-width: 100px;
        font-size: 11px;
        color: var(--b3-theme-on-surface-light);
    }

    .pj-ho__prompt {
        flex: 1;
        min-height: 0;
        margin: 0;
        padding: 8px 10px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-surface);
        color: var(--b3-theme-on-background);
        font-size: 12px;
        line-height: 1.6;
        font-family: inherit;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        overflow-y: auto;
    }
</style>
