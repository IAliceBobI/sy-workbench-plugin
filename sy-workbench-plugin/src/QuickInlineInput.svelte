<script lang="ts">
    // dataview □6：速记行内输入组件（可复用——全局速记小窗与 □4 看板列尾"+"挂同一件）。
    // 语法=quickParse 纯函数（速记=输入法不是存储——解析完即弃，契约 §6）；本组件零落盘：
    // submit prop=宿主提供的写通道（全局入口=index.ts 落任务章节；看板列尾=□4 挂池写链）。
    // 键盘契约：Enter=提交（isComposing 守卫——IME 组字确认键不算 Enter，sloop □10 坑）；
    // Esc=cancel（宿主语义：小窗=关窗，看板行=收行）；成功=清框留焦（连续录入）。
    // warning 通道（R1）：ok=true 也可带警示（如看板速记「任务已建、挂载未成」——清框
    // 不引导重试=防重复建块，警示就地展示；与 error 分色——非失败是部分达成）。
    import { quickParse, type QuickParseResult } from "./gui/quickParse";
    import { POOL_LABEL } from "./kernel/core/ammoQuadrant";

    let {
        t,
        submit,
        cancel,
        placeholder,
    }: {
        t: Record<string, string>;
        /** 写通道（宿主提供）：回车时喂解析产物；ok=清框（warning=就地警示文案），
         *  error 文本就地展示 */
        submit: (parsed: QuickParseResult) => Promise<{ ok: boolean; error?: string; warning?: string }>;
        /** Esc 行为（缺省=清空输入框不动焦点） */
        cancel?: () => void;
        placeholder?: string;
    } = $props();

    let text = $state("");
    let busy = $state(false);
    let err = $state("");
    let warn = $state("");

    // 每次输入重解析（now 逐次取新——「今天」跟手）；纯函数无副作用
    const parsed: QuickParseResult = $derived(quickParse(text));

    async function go(): Promise<void> {
        if (busy) return;
        if (!parsed.name.trim()) {
            err = text.trim() ? t.quickEntryNoName : "";
            return;
        }
        busy = true;
        err = "";
        warn = "";
        try {
            const r = await submit(parsed);
            if (r?.ok) {
                text = "";
                warn = r?.warning ?? "";
            } else {
                err = r?.error || t.quickEntryFail;
            }
        } catch (e: any) {
            err = `${t.quickEntryFail}：${String(e?.message ?? e)}`;
        } finally {
            busy = false;
        }
    }

    function onKey(e: KeyboardEvent): void {
        if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            void go();
        } else if (e.key === "Escape") {
            if (cancel) cancel();
            else {
                text = "";
                err = "";
                warn = "";
            }
        }
    }
</script>

<div class="pj-qi">
    <input
        class="b3-text-field pj-qi__input"
        type="text"
        placeholder={placeholder ?? t.quickEntryPlaceholder}
        bind:value={text}
        oninput={() => {
            err = "";
            warn = "";
        }}
        onkeydown={onKey}
        disabled={busy}
    />
    {#if err}
        <div class="pj-qi__err">{err}</div>
    {:else if warn}
        <div class="pj-qi__warn">{warn}</div>
    {:else if text.trim()}
        <div class="pj-qi__preview">
            <span class="pj-qi__name">{parsed.name || t.quickEntryNoName}</span>
            {#if parsed.pool}<span class="pj-qi__chip pj-qi__chip--pool" data-pool={parsed.pool}>{POOL_LABEL[parsed.pool]}</span>{/if}
            {#if parsed.quota != null}<span class="pj-qi__chip">{parsed.quota}min</span>{/if}
            {#if parsed.date}<span class="pj-qi__chip">{parsed.date}</span>{/if}
            {#if parsed.dueTime}<span class="pj-qi__chip">{parsed.dueTime}</span>{/if}
        </div>
    {/if}
</div>

<style>
    .pj-qi {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
    }
    .pj-qi__input {
        width: 100%;
    }
    .pj-qi__err {
        color: var(--b3-card-error-color);
        font-size: 12px;
        line-height: 1.5;
    }
    .pj-qi__warn {
        /* warning 系用 --b3-card-warning-color 带 fallback（--b3-theme-warning 思源无此变量——
           treemap □4 坑；fallback 值与 BoardView pooldot 警示同款） */
        color: var(--b3-card-warning-color, #f59e0b);
        font-size: 12px;
        line-height: 1.5;
    }
    .pj-qi__preview {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px 6px;
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        min-width: 0;
    }
    .pj-qi__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
    }
    .pj-qi__chip {
        flex: none;
        padding: 1px 6px;
        border-radius: var(--b3-border-radius-b);
        background: color-mix(in srgb, var(--b3-theme-primary) 12%, transparent);
        color: var(--b3-theme-primary);
    }
    /* R7 池 chip 单独用池色（视觉 P2）：文字=四池族色值（与 BoardView pooldot 同源——四池
       性格色单事实源对齐），底=同色 color-mix 12% 透明（currentColor 跟随文字色，一处声明
       四池共用、亮暗分支自动跟）；配额/日期 chip 维持主色 pill 不动 */
    .pj-qi__chip--pool {
        color: var(--b3-theme-primary); /* slug 未命中兜底=回主色（pooldot 基态同款） */
        background: color-mix(in srgb, currentColor 12%, transparent);
    }
    .pj-qi__chip--pool[data-pool="gold"] { color: #b8860b; }
    .pj-qi__chip--pool[data-pool="deadline"] { color: #dc2626; }
    .pj-qi__chip--pool[data-pool="hearth"] { color: #ea580c; }
    .pj-qi__chip--pool[data-pool="crumbs"] { color: #16a34a; }

    /* ── 暗色（3.8.3 判据=html[data-theme-mode=dark]，scoped 分支 :global——仓纪律） ── */
    :global(html[data-theme-mode="dark"]) .pj-qi__chip--pool[data-pool="gold"] { color: #e3b341; }
    :global(html[data-theme-mode="dark"]) .pj-qi__chip--pool[data-pool="deadline"] { color: #f87171; }
    :global(html[data-theme-mode="dark"]) .pj-qi__chip--pool[data-pool="hearth"] { color: #fb923c; }
    :global(html[data-theme-mode="dark"]) .pj-qi__chip--pool[data-pool="crumbs"] { color: #86efac; }
</style>
