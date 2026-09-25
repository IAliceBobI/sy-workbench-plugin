<script lang="ts">
    // dataview □6：全局速记小窗内容（宿主=index.ts openQuickEntry——Dialog 壳由宿主建，
    // 本组件=输入件 QuickInlineInput + 语法速查行）。速记语法事实源=src/gui/quickParse.ts。
    import QuickInlineInput from "./QuickInlineInput.svelte";
    import type { QuickParseResult } from "./gui/quickParse";

    let {
        t,
        submit,
        close,
    }: {
        t: Record<string, string>;
        submit: (parsed: QuickParseResult) => Promise<{ ok: boolean; error?: string }>;
        close: () => void;
    } = $props();
</script>

<div class="pj-qe">
    <QuickInlineInput {t} {submit} cancel={close} />
    <div class="pj-qe__hint">{t.quickEntryHint}</div>
</div>

<style>
    .pj-qe {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .pj-qe__hint {
        font-size: 12px;
        line-height: 1.6;
        color: var(--b3-theme-on-surface-light);
    }
</style>
