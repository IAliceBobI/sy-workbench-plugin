<script lang="ts">
    import { untrack } from "svelte";
    // folder-model 手动建项目对话框（反 push：点菜单才出现）：项目名输入+chips 推荐。
    // 提交走 index.ts → kernel rpc project-create（MCP project create 同一 handler，单一事实源）；
    // 校验前置 UX（空名/含 /），kernel 同款校验终判兜底。建骨架富内容（agentNote/动作段）仍归 AI 通道。
    // notebook 选择已退役（folder-model：项目=目录一级文档，落点=kernel ensureRoot）。
    let {
        t,
        submit,
        close,
    }: {
        t: Record<string, string>;
        submit: (name: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
        close: () => void;
    } = $props();

    let name = $state("");
    let busy = $state(false);
    let errText = $state("");
    // 错误锚定项目名字段（本地校验失败描红边）；rpc 失败是环境问题不描
    let errOnName = $state(false);

    // 推荐名：placeholder 每次 mount 轮换单个+chips 三候选点击即填。
    // 推荐是「给名字灵感」不是「替用户做主」——空提交仍显式报错，不静默采用。
    // （t 传参是 Record<string,string>，数组键运行时本就在——as any 取；untrack 显式声明
    //  非响应式读取绕 state_referenced_locally 告警——对话框生命周期内 t 恒定）
    const suggests: string[] = untrack(() => (t as any).createProjectSuggests ?? []);
    const suggest = untrack(() => suggests[Math.floor(Math.random() * suggests.length)] ?? "");

    async function go(): Promise<void> {
        if (busy) return;
        const n = name.trim();
        if (!n) {
            errOnName = true;
            errText = t.createProjectNameEmpty;
            return;
        }
        if (n.includes("/")) {
            errOnName = true;
            errText = t.createProjectNameSlash;
            return;
        }
        busy = true;
        errText = "";
        errOnName = false;
        try {
            const r = await submit(n);
            if (r?.ok) {
                close();
                return;
            }
            errText = r?.error ? `${t.createProjectFail}：${r.error}` : t.createProjectFail;
        } finally {
            busy = false;
        }
    }
</script>

<div class="pj-cp">
    <label class="pj-cp__field">
        <span class="pj-cp__label">{t.createProjectName}</span>
        <input
            class="b3-text-field pj-cp__input"
            class:pj-cp__input--err={errOnName}
            bind:value={name}
            placeholder={t.createProjectNamePh.replace("{name}", suggest)}
            disabled={busy}
            onkeydown={(e) => {
                // IME 组字期 Enter=确认候选词（isComposing=true）非提交（官方 bindInput 三重防御同款）
                if (e.key === "Enter" && !e.isComposing && !e.repeat) void go();
                if (e.key === "Escape" && !e.isComposing) close();
            }}
        />
    </label>
    {#if suggests.length && !name}
        <div class="pj-cp__suggests">
            {#each suggests as s (s)}
                <button type="button" class="pj-cp__chip" disabled={busy} onclick={() => (name = s)}>{s}</button>
            {/each}
        </div>
    {/if}
    {#if errText}
        <div class="pj-cp__err">{errText}</div>
    {/if}
    <div class="pj-cp__foot">
        <button class="b3-button pj-cp__cancel" disabled={busy} onclick={close}>{t.cancel}</button>
        <button
            class="b3-button pj-cp__go"
            disabled={busy}
            onclick={() => void go()}
        >
            {busy ? t.createProjectBusy : t.createProjectGo}
        </button>
    </div>
</div>

<style>
    .pj-cp {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 4px 2px 2px;
    }

    .pj-cp__field {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .pj-cp__label {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    .pj-cp__input {
        width: 100%;
        font-size: 14px;
        box-sizing: border-box;
    }

    /* b3-text-field 帧线=outline 非 border（AGENTS 坑）——错误态直接覆盖 outline */
    .pj-cp__input--err {
        outline: 1px solid var(--b3-card-error-color, #d23f31);
    }

    .pj-cp__err {
        font-size: 12px;
        line-height: 1.6;
        color: var(--b3-card-error-color, #d23f31);
    }

    /* 推荐名候选 chips（面板既有 chip 惯例：lightest 底+主色字弱化态——remind chips 先例） */
    .pj-cp__suggests {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: -4px;
    }

    .pj-cp__chip {
        font-size: 12px;
        padding: 2px 10px;
        border-radius: 999px;
        cursor: pointer;
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 10%, var(--b3-theme-surface));
    }

    .pj-cp__chip:hover {
        background-color: color-mix(in srgb, var(--b3-theme-primary) 18%, var(--b3-theme-surface));
    }

    .pj-cp__foot {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 4px;
    }

    /* b3-button 基类默认主色实心——次按钮须显式弱化（AGENTS css 坑） */
    .pj-cp__cancel {
        color: var(--b3-theme-on-background);
        background-color: transparent;
    }

    /* 主推进按钮：primary tonal（与 OnboardDialog/日历状态条入口同语言） */
    .pj-cp__go {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 14%, var(--b3-theme-surface));
    }
</style>
