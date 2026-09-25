<script lang="ts">
    // 删除项目确认弹窗（手动维护 UI 批次；形态参照 CreateProjectDialog——t/close/submit props，
    // Dialog 壳由 Dashboard.svelte 自建）。破坏性动作两道防线：
    // ①范围与后果明示（整树 N 篇+外部块引用失效+可从思源「历史」恢复）；
    // ②二次确认=删除按钮需再次点击（armed 态；「再点一次」vs「输入项目名」取前者——简单形态默认值）。
    let {
        t,
        name,
        docCount,
        submit,
        close,
    }: {
        t: Record<string, string>;
        name: string;
        /** 整树文档篇数（主文档+所有线+归档区整树——驾驶舱 model.lines 计数，kernel 终判另有统计） */
        docCount: number;
        submit: () => Promise<{ ok: boolean; totalDocs?: number; error?: string }>;
        close: () => void;
    } = $props();

    let armed = $state(false);
    let busy = $state(false);
    let errText = $state("");

    async function go(): Promise<void> {
        if (busy) return;
        if (!armed) {
            armed = true;
            errText = "";
            return;
        }
        busy = true;
        errText = "";
        try {
            const r = await submit();
            if (r?.ok) {
                close();
                return;
            }
            errText = r?.error ? `${t.deleteProjectFail}：${r.error}` : t.deleteProjectFail;
            armed = false;
        } finally {
            busy = false;
        }
    }
</script>

<div class="pj-dp">
    <div class="pj-dp__scope">{t.deleteProjectScope.replace("{name}", name).replace("{n}", String(docCount))}</div>
    <div class="pj-dp__warn">
        <div>{t.deleteProjectWarnRefs}</div>
        <div>{t.deleteProjectWarnHistory}</div>
    </div>
    {#if errText}
        <div class="pj-dp__err">{errText}</div>
    {/if}
    <div class="pj-dp__foot">
        <button class="b3-button pj-dp__cancel" disabled={busy} onclick={close}>{t.cancel}</button>
        <button
            class="b3-button pj-dp__go"
            class:pj-dp__go--armed={armed}
            disabled={busy}
            title={armed ? t.deleteProjectGoArmed : t.deleteProjectGo}
            aria-label={armed ? t.deleteProjectGoArmed : t.deleteProjectGo}
            onclick={() => void go()}
        >
            {busy ? t.deleteProjectBusy : armed ? t.deleteProjectGoArmed : t.deleteProjectGo}
        </button>
    </div>
</div>

<style>
    .pj-dp {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 4px 2px 2px;
    }

    .pj-dp__scope {
        font-size: 13px;
        line-height: 1.6;
        color: var(--b3-theme-on-background);
    }

    .pj-dp__warn {
        font-size: 12px;
        line-height: 1.6;
        /* 危险色带 fallback——不存在的 b3 变量+var() 无 fallback=整条声明静默失效（AGENTS 坑） */
        color: var(--b3-card-error-color, #d23f31);
    }

    .pj-dp__err {
        font-size: 12px;
        line-height: 1.6;
        color: var(--b3-card-error-color, #d23f31);
    }

    .pj-dp__foot {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 4px;
    }

    /* b3-button 基类默认主色实心——次按钮须显式弱化（AGENTS css 坑） */
    .pj-dp__cancel {
        color: var(--b3-theme-on-background);
        background-color: transparent;
    }

    /* 删除钮：未 armed=危险描边（破坏性第一眼可辨——vision P1：中性灰态读作可随意点的
     * 普通钮；与驾驶舱头部删除钮同语言）；armed=危险色实心（两击式第二击，视觉焦点拉满） */
    .pj-dp__go {
        color: var(--b3-card-error-color, #d23f31);
        background-color: transparent;
        border: 1px solid color-mix(in srgb, var(--b3-card-error-color, #d23f31) 55%, transparent);
    }

    .pj-dp__go:hover:not(:disabled) {
        background-color: color-mix(in srgb, var(--b3-card-error-color, #d23f31) 10%, transparent);
    }

    .pj-dp__go--armed {
        color: #fff;
        background-color: var(--b3-card-error-color, #d23f31);
        border-color: transparent;
    }

    .pj-dp__go:disabled {
        opacity: 0.55;
        cursor: default;
    }
</style>
