<script lang="ts">
    // sloop □5 Onboarding 对话框（设计档 §5 全流程）：挑身份看基色 → 现实约束口述+投影预览
    // → 静默观察约 3 天 → 首份照镜子报告（冻结基线）+初版粗排落明日班表 → 回看态。
    // 反 push：零弹窗零定时——只在用户点开时出现；信息平铺不藏 hover；失败=行内一句话不弹窗。
    import { ARCHETYPES } from "./kernel/core/formlib-data";
    import { projectDraft, getArchetype, type OnboardConstraints } from "./kernel/core/formlib";
    import { isValidHM } from "./kernel/core/schedule";
    import { observeDayNum, freezeBaseline, OBSERVE_TARGET_DAYS, type OnboardBaseline, type OnboardStore } from "./kernel/core/onboard";

    let {
        t,
        lang,
        onboard,
        today,
        startOnboarding,
        buildReport,
        freeze,
    }: {
        t: Record<string, string>;
        lang: string;
        onboard: OnboardStore | null;
        today: string;
        startOnboarding: (archetypeId: string, constraints: OnboardConstraints) => Promise<OnboardStore | null>;
        buildReport: () => Promise<{ report: string; match: Array<{ id: string; score: number; reason: { zh: string; en: string } }>; draft: Array<{ summary: string; start: string; end: string | null; hard: boolean; lowConf: boolean }>; packet: string; days: string[]; shiftMin: number; writeDay: string } | null>;
        freeze: (baseline: OnboardBaseline) => Promise<{ ok: boolean; written: number } | null>;
    } = $props();

    const zh = $derived(!lang || lang.toLowerCase().startsWith("zh"));

    type Step = "pick" | "constraints" | "observing" | "report" | "frozen";
    // props 初档复制为响应式源（开步/冻结后本地推进——props 只在打开时给一次，一次性捕获是刻意的）
    // svelte-ignore state_referenced_locally
    let ob = $state<OnboardStore | null>(onboard);
    // svelte-ignore state_referenced_locally
    let step = $state<Step>(onboard ? (onboard.state === "baselined" ? "frozen" : "observing") : "pick");
    let pickedId = $state<string | null>(null);
    let wake = $state("");
    let sleep = $state("");
    let noteText = $state("");
    let notes = $state<string[]>([]);
    let reportData = $state<Awaited<ReturnType<typeof buildReport>> | null>(null);
    let loading = $state(false);
    let starting = $state(false);
    let freezing = $state(false);
    let copied = $state(false);
    let errText = $state("");
    let frozenWritten = $state<number | null>(null);

    const arch = $derived(pickedId ? getArchetype(pickedId) : ob ? getArchetype(ob.archetypeId) : null);
    const dayNum = $derived(ob ? observeDayNum(ob, today) : 0);
    const obsReady = $derived(dayNum >= OBSERVE_TARGET_DAYS);

    const CHRONO_KEY: Record<string, string> = { morning: "onboardChronoMorning", night: "onboardChronoNight", flex: "onboardChronoFlex" };

    const constraints = $derived<OnboardConstraints>({
        ...(isValidHM(wake) ? { wake } : {}),
        ...(isValidHM(sleep) ? { sleep } : {}),
        ...(notes.length ? { notes } : {}),
    });

    const projection = $derived(arch ? projectDraft(arch, zh, constraints) : null);

    function pick(id: string): void {
        pickedId = id;
        errText = "";
        step = "constraints";
    }

    function addNote(): void {
        const v = noteText.trim().slice(0, 100);
        if (!v) return;
        notes = [...notes, v].slice(0, 20); // 写侧封顶对齐归一层（review P2-4）
        noteText = "";
    }

    async function startObs(): Promise<void> {
        if (!pickedId) return;
        starting = true;
        errText = "";
        const s = await startOnboarding(pickedId, constraints);
        starting = false;
        if (s) {
            ob = s;
            step = "observing";
        } else {
            errText = t.onboardErrSave;
        }
    }

    async function preview(): Promise<void> {
        loading = true;
        errText = "";
        reportData = await buildReport();
        loading = false;
        if (reportData) step = "report";
        else errText = t.onboardErrSave;
    }

    async function doFreeze(): Promise<void> {
        if (!reportData) return;
        freezing = true;
        errText = "";
        const baseline: OnboardBaseline = {
            at: new Date().toISOString(),
            observedDays: reportData.days,
            report: reportData.report,
            match: reportData.match.slice(0, 3).map((m) => ({ id: m.id, score: m.score, reason: zh ? m.reason.zh : m.reason.en })),
            draft: reportData.draft,
        };
        const r = await freeze(baseline);
        freezing = false;
        if (r?.ok && ob) {
            ob = freezeBaseline(ob, baseline); // 本地镜像推进（props 不回填）
            frozenWritten = r.written;
            step = "frozen";
        } else {
            errText = t.onboardErrSave;
        }
    }

    async function copyPacket(): Promise<void> {
        if (!reportData) return;
        try {
            await navigator.clipboard.writeText(reportData.packet);
            copied = true;
            setTimeout(() => {
                copied = false;
            }, 1500);
        } catch {
            // 剪贴板不可用（headless/权限）静默
        }
    }
</script>

<div class="pj-ob fn__flex-column">
    {#if step === "pick"}
        <div class="pj-ob__lead">{t.onboardPickHint}</div>
        <div class="pj-ob__grid">
            {#each ARCHETYPES as a (a.id)}
                <button class="pj-ob__card" onclick={() => pick(a.id)}>
                    <span class="pj-ob__card-name">{zh ? a.name.zh : a.name.en}</span>
                    <span class="pj-ob__chrono pj-ob__chrono--{a.chrono}">{t[CHRONO_KEY[a.chrono]]}</span>
                    <span class="pj-ob__card-anchors">{a.anchors.slice(0, 3).map((an) => `${zh ? an.label.zh : an.label.en} ${an.start}`).join(" / ")}</span>
                </button>
            {/each}
        </div>
        <div class="pj-ob__note pj-ob__note--tail">{t.onboardPickTail}</div>
    {:else if step === "constraints"}
        <div class="pj-ob__lead">{t.onboardConstraintsTitle}</div>
        {#if arch}
            <div class="pj-ob__arch">
                <div class="pj-ob__arch-head">
                    <span class="pj-ob__card-name">{zh ? arch.name.zh : arch.name.en}</span>
                    <span class="pj-ob__chrono pj-ob__chrono--{arch.chrono}">{t[CHRONO_KEY[arch.chrono]]}</span>
                </div>
                <div class="pj-ob__anchor-list">
                    {#each arch.anchors as an, i (i)}
                        <span class="pj-ob__anchor"><i class="pj-ob__anchor-dot" class:pj-ob__anchor-dot--hard={an.hard}></i>{zh ? an.label.zh : an.label.en} {an.start}{an.end ? `–${an.end}` : ""}{an.hard ? `（${t.schedHardTag}）` : `（${t.schedFlexTag}）`}</span>
                    {/each}
                </div>
                <div class="pj-ob__note">{zh ? arch.stageNote.zh : arch.stageNote.en}</div>
                <div class="pj-ob__note pj-ob__note--conflict">{t.onboardConflictLabel}：{zh ? arch.conflictAnchor.zh : arch.conflictAnchor.en}</div>
            </div>
        {/if}
        <div class="pj-ob__form">
            <label class="pj-ob__field">
                <span class="pj-ob__field-label">{t.onboardLabelWake}</span>
                <input class="b3-text-field pj-ob__hm" placeholder={t.onboardWakePh} maxlength="5" bind:value={wake} />
            </label>
            <label class="pj-ob__field">
                <span class="pj-ob__field-label">{t.onboardLabelSleep}</span>
                <input class="b3-text-field pj-ob__hm" placeholder={t.onboardSleepPh} maxlength="5" bind:value={sleep} />
            </label>
        </div>
        <div class="pj-ob__notes">
            {#each notes as n, i (i)}
                <span class="pj-ob__note-tag">{n}<button class="pj-ob__note-x" onclick={() => (notes = notes.filter((_, j) => j !== i))}>×</button></span>
            {/each}
            <input
                class="b3-text-field fn__flex-1"
                placeholder={t.onboardNotesPh}
                bind:value={noteText}
                onkeydown={(e) => {
                    if (e.key === "Enter") addNote();
                }}
            />
        </div>
        {#if projection}
            <div class="pj-ob__proj">
                <div class="pj-ob__sec-title">
                    {t.onboardProjTitle}
                    {#if isValidHM(wake)}
                        <span class="pj-ob__proj-shift">{t.onboardProjShift.replace("{n}", String(Math.abs(projection.shiftMin)))}</span>
                    {:else}
                        <span class="pj-ob__proj-shift pj-ob__proj-shift--low">{t.onboardProjNoShift}</span>
                    {/if}
                    <span class="pj-ob__legend">
                        <i class="pj-ob__anchor-dot pj-ob__anchor-dot--hard"></i>{t.schedHardTag}
                        <i class="pj-ob__anchor-dot"></i>{t.schedFlexTag}
                    </span>
                </div>
                {#each projection.items as d, i (i)}
                    <span class="pj-ob__draft-row">
                        <i class="pj-ob__anchor-dot" class:pj-ob__anchor-dot--hard={d.hard}></i>
                        <span class="pj-ob__draft-time">{d.start}{d.end ? `–${d.end}` : ""}</span>
                        {d.summary}
                        {#if d.lowConf}<i class="pj-ob__low">{t.onboardLowConf}</i>{/if}
                    </span>
                {/each}
            </div>
        {/if}
        {#if errText}<div class="pj-ob__note pj-ob__note--low">{errText}</div>{/if}
        <div class="pj-ob__foot">
            <button class="b3-button b3-button--small b3-button--outline" onclick={() => (step = "pick")}>{t.onboardBack}</button>
            <button class="b3-button b3-button--small pj-ob__go" disabled={starting} onclick={() => void startObs()}>{starting ? t.onboardStarting : t.onboardStartObs}</button>
        </div>
    {:else if step === "observing"}
        <div class="pj-ob__lead">{t.onboardObsTitle}</div>
        {#if arch}
            <div class="pj-ob__obs-head">
                <span class="pj-ob__card-name">{zh ? arch.name.zh : arch.name.en}</span>
                <span class="pj-ob__chrono pj-ob__chrono--{arch.chrono}">{t[CHRONO_KEY[arch.chrono]]}</span>
            </div>
        {/if}
        <div class="pj-ob__progress" class:pj-ob__progress--ready={obsReady}>
            {#if obsReady}
                {t.onboardObsDone.replaceAll("{n}", String(OBSERVE_TARGET_DAYS))}
            {:else}
                {t.onboardObsDay.replaceAll("{n}", String(dayNum)).replaceAll("{t}", String(OBSERVE_TARGET_DAYS))}
            {/if}
        </div>
        <div class="pj-ob__note">{t.onboardObsHint}</div>
        {#if errText}<div class="pj-ob__note pj-ob__note--low">{errText}</div>{/if}
        <div class="pj-ob__foot">
            <button class="b3-button b3-button--small b3-button--outline" onclick={() => (step = "pick")}>{t.onboardRepick}</button>
            <button class="b3-button b3-button--small pj-ob__go" disabled={!obsReady || loading} onclick={() => void preview()}>{loading ? t.onboardLoading : t.onboardReportBtn}</button>
        </div>
    {:else if step === "report"}
        {#if reportData}
            <div class="pj-ob__lead">{t.onboardReportTitle}</div>
            <pre class="pj-ob__report">{reportData.report}</pre>
            <div class="pj-ob__proj">
                <div class="pj-ob__sec-title">{t.onboardDraftTitle}<span class="pj-ob__proj-shift">{t.onboardDraftDay.replaceAll("{day}", reportData.writeDay)}</span></div>
                {#each reportData.draft as d, i (i)}
                    <span class="pj-ob__draft-row">
                        <i class="pj-ob__anchor-dot" class:pj-ob__anchor-dot--hard={d.hard}></i>
                        <span class="pj-ob__draft-time">{d.start}{d.end ? `–${d.end}` : ""}</span>
                        {d.summary}
                        {#if d.lowConf}<i class="pj-ob__low">{t.onboardLowConf}</i>{/if}
                    </span>
                {/each}
                {#if reportData.draft.some((d) => d.lowConf)}
                    <div class="pj-ob__note pj-ob__note--low">{t.onboardLowConfHint}</div>
                {/if}
            </div>
            {#if errText}<div class="pj-ob__note pj-ob__note--low">{errText}</div>{/if}
            <div class="pj-ob__foot">
                <button class="b3-button b3-button--small b3-button--outline" onclick={() => void copyPacket()}>{copied ? t.copied : t.onboardMirrorCopy}</button>
                <button class="b3-button b3-button--small pj-ob__go" disabled={freezing} onclick={() => void doFreeze()}>{freezing ? t.onboardFreezing : t.onboardFreeze}</button>
            </div>
        {/if}
    {:else if step === "frozen"}
        <div class="pj-ob__okchip">{t.onboardFrozenHint}</div>
        {#if ob?.baseline}
            <pre class="pj-ob__report">{ob.baseline.report}</pre>
            <div class="pj-ob__proj">
                <div class="pj-ob__sec-title">{t.onboardDraftTitle}{#if frozenWritten != null}<span class="pj-ob__proj-shift">{t.onboardWritten.replaceAll("{n}", String(frozenWritten))}</span>{/if}</div>
                {#each ob.baseline.draft as d, i (i)}
                    <span class="pj-ob__draft-row">
                        <i class="pj-ob__anchor-dot" class:pj-ob__anchor-dot--hard={d.hard}></i>
                        <span class="pj-ob__draft-time">{d.start}{d.end ? `–${d.end}` : ""}</span>
                        {d.summary}
                        {#if d.lowConf}<i class="pj-ob__low">{t.onboardLowConf}</i>{/if}
                    </span>
                {/each}
            </div>
        {/if}
    {/if}
</div>

<style lang="scss">
    /* Dialog 高度=auto（vision P1：固定 680 在前两步留 ~215px 死空间）；长内容这里封顶内滚 */
    .pj-ob {
        gap: 10px;
        max-height: min(560px, 88vh);
        padding: 12px 16px;
        box-sizing: border-box;
        overflow-y: auto;
    }

    .pj-ob__lead {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    /* 冻结里程碑句：绿字+12% 绿底 chip、13px（vision P1：裸 12px 绿字对比 3.5:1 不足） */
    .pj-ob__okchip {
        font-size: 13px;
        color: var(--b3-card-success-color, #2a9d42);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 12%, transparent);
        padding: 4px 10px;
        border-radius: var(--b3-border-radius);
        width: fit-content;
        line-height: 1.6;
    }

    .pj-ob__grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
        gap: 8px;
    }

    .pj-ob__card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: flex-start;
        padding: 8px 10px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 4%, var(--b3-theme-surface));
        cursor: pointer;
        text-align: left;
    }

    .pj-ob__card:hover {
        border-color: var(--b3-theme-primary);
    }

    .pj-ob__card-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
    }

    /* chrono 语义色：晨=success / 夜=primary / 弹性=中性 */
    .pj-ob__chrono {
        font-size: 12px;
        padding: 0 6px;
        border-radius: 3px;
    }

    .pj-ob__chrono--morning {
        color: var(--b3-card-success-color, #2a9d42);
        background-color: color-mix(in srgb, var(--b3-card-success-color, #2a9d42) 12%, transparent);
    }

    .pj-ob__chrono--night {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 12%, transparent);
    }

    .pj-ob__chrono--flex {
        color: var(--b3-theme-on-surface);
        background-color: color-mix(in srgb, var(--b3-theme-on-surface) 12%, transparent);
    }

    .pj-ob__card-anchors {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        line-height: 1.5;
    }

    .pj-ob__note--tail {
        margin-top: auto; /* 填 pick 步底部引导（vision P1 死空间→引导行） */
    }

    .pj-ob__arch {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        border: 1px solid var(--b3-border-color);
        border-radius: var(--b3-border-radius);
    }

    .pj-ob__arch-head,
    .pj-ob__obs-head {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .pj-ob__anchor-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 14px;
    }

    .pj-ob__anchor,
    .pj-ob__draft-row {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        color: var(--b3-theme-on-background);
    }

    .pj-ob__anchor-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: var(--b3-theme-on-surface);
        flex-shrink: 0;
    }

    .pj-ob__anchor-dot--hard {
        background-color: var(--b3-theme-primary);
    }

    .pj-ob__note {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
        line-height: 1.6;
    }

    /* 实质规则不藏弱灰（vision P1：on-surface-light 白底可读性差） */
    .pj-ob__note--conflict {
        color: var(--b3-theme-on-surface);
    }

    .pj-ob__note--low {
        color: var(--b3-theme-warning, #d97706);
    }

    .pj-ob__form {
        display: flex;
        gap: 12px;
    }

    .pj-ob__field {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .pj-ob__field-label {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }

    .pj-ob__hm {
        width: 180px;
        font-variant-numeric: tabular-nums;
    }

    .pj-ob__notes {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
    }

    .pj-ob__note-tag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        padding: 2px 6px;
        border-radius: 3px;
        background-color: color-mix(in srgb, var(--b3-theme-primary) 10%, transparent);
        color: var(--b3-theme-on-background);
    }

    .pj-ob__note-x {
        border: 0;
        background: none;
        padding: 0 2px;
        cursor: pointer;
        color: var(--b3-theme-on-surface);
        font-size: 12px;
    }

    .pj-ob__proj {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        border: 1px dashed var(--b3-border-color);
        border-radius: var(--b3-border-radius);
    }

    .pj-ob__sec-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 500;
        color: var(--b3-theme-on-background);
        flex-wrap: wrap;
    }

    /* 硬/弹圆点图例（vision P2：蓝/灰点含义不再回看身份卡） */
    .pj-ob__legend {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: auto;
        font-size: 12px;
        font-weight: 400;
        color: var(--b3-theme-on-surface);
    }

    .pj-ob__proj-shift {
        font-size: 12px;
        font-weight: 400;
        color: var(--b3-theme-on-surface);
    }

    .pj-ob__proj-shift--low,
    .pj-ob__low {
        color: var(--b3-theme-warning, #d97706);
    }

    .pj-ob__low {
        font-size: 12px;
        font-style: normal;
        padding: 0 4px;
        border-radius: 3px;
        background-color: color-mix(in srgb, var(--b3-theme-warning, #d97706) 12%, transparent);
    }

    .pj-ob__draft-time {
        font-variant-numeric: tabular-nums;
        color: var(--b3-theme-on-surface);
    }

    .pj-ob__progress {
        font-size: 14px;
        color: var(--b3-theme-on-background);
        padding: 6px 0;
    }

    .pj-ob__progress--ready {
        color: var(--b3-card-success-color, #2a9d42);
    }

    .pj-ob__report {
        flex: 1;
        min-height: 120px;
        max-height: 300px;
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

    .pj-ob__foot {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
    }

    /* 主推进按钮：primary 字色（与日历状态条入口同语言；vision P1 CTA 一致性） */
    .pj-ob__go {
        color: var(--b3-theme-primary);
        background-color: color-mix(in srgb, var(--b3-theme-primary) 14%, var(--b3-theme-surface));
    }
</style>
