<script lang="ts">
    // remind 面板（popover 紧凑形态）。□24 段式时间控件（TimeSpinner）替代 datetime-local：
    // ▲▼/滚轮/↑↓ 调聚焦段、结束空态聚焦预填=开始、相对时长通道（+N 分钟/小时/天）、时长摘要行。
    // □2 循环位：四枚举 select+条件参数行（周几 chips/月几号/间隔天数）→ custom-remind-repeat；
    // 解析复用 core 纯函数与同步链同源。
    import { parseRemindRepeat } from "../kernel/core/remind";
    import { durationMinutes, formatDuration, shiftMinutes, type DurWords } from "./spinnerLogic";
    import TimeSpinner from "./TimeSpinner.svelte";
    let {
        initial = "",
        initialRepeat = "",
        initialEnd = "",
        t,
        onSaved,
        onDeleted,
    }: {
        initial?: string;
        initialRepeat?: string;
        /** □16 结束时间（可空=开放时长） */
        initialEnd?: string;
        t: Record<string, string>;
        onSaved: (at: string, repeat: string | null, end: string | null) => void;
        onDeleted: () => void;
    } = $props();

    // 面板单次挂载单次使用：初值只取 props 快照（用户编辑不回写 props，无需响应式跟随）
    // svelte-ignore state_referenced_locally
    const initSnap = { at: initial, repeat: initialRepeat, end: initialEnd };
    let value = $state(initSnap.at || defaultAt());
    let endValue = $state(initSnap.end || "");
    let error = $state("");
    let repeatKind = $state<"none" | "daily" | "weekly" | "monthly" | "every">("none");
    let weekdays = $state<number[]>([]); // ISO 星期 1(一)~7(日)，升序
    let monthDay = $state(initSnap.at ? Number(initSnap.at.slice(8, 10)) || 1 : new Date().getDate());
    let everyN = $state(2);
    // □24 相对时长通道：+ N 分钟/小时/天 → end=开始+偏移（写入 spinner 后可继续微调，两通道配合）
    let relNum = $state(30);
    let relUnit = $state("1"); // 分钟数（分钟/小时/天=1/60/1440）

    const initRp = parseRemindRepeat(initSnap.repeat);
    if (initRp?.kind === "daily") repeatKind = "daily";
    else if (initRp?.kind === "weekly") {
        repeatKind = "weekly";
        weekdays = [...initRp.days];
    } else if (initRp?.kind === "monthly") {
        repeatKind = "monthly";
        monthDay = initRp.day;
    } else if (initRp?.kind === "every") {
        repeatKind = "every";
        everyN = initRp.days;
    }

    /** 无既有提醒的初值：当前时间（截到分钟——bear □24 拍板「默认初始化为当前时间」） */
    function defaultAt(): string {
        const p = (n: number) => String(n).padStart(2, "0");
        const now = new Date();
        return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
    }

    /** 时长摘要行：开始+结束都完整且 end>start → 「历时 X 小时 Y 分钟」（跨档同族表达） */
    const durLabel = $derived.by(() => {
        if (!value || !endValue) return "";
        if (durationMinutes(value, endValue) === null) return "";
        const words: DurWords = {
            min: t.remindUnitMin, hour: t.remindUnitHour, day: t.remindUnitDay,
            month: t.remindUnitMonth, year: t.remindUnitYear,
        };
        return `${t.remindDurPrefix} ${formatDuration(value, endValue, words) ?? ""}`;
    });

    function applyRelative(): void {
        // 钳制 [1, 5256000]（max 属性仅咨询性可键入更大）；开始值中间态时 shiftMinutes 返回 null 不动
        const n = Math.min(5256000, Math.max(1, Math.floor(Number(relNum) || 0)));
        const unit = Number(relUnit);
        if (!Number.isFinite(unit) || unit < 1) return;
        const shifted = shiftMinutes(value, n * unit);
        if (shifted) endValue = shifted;
    }

    function toggleDay(d: number): void {
        weekdays = weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort((a, b) => a - b);
    }

    function save(): void {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
            error = t.remindInvalid;
            return;
        }
        // □16 结束时间：空=开放时长；非空须形态合法且严格晚于开始（跨天允许）
        const end = endValue.trim();
        if (end && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end) === false
            || Number.isNaN(Date.parse(end)) || Date.parse(end) <= Date.parse(value))) {
            error = t.remindEndInvalid;
            return;
        }
        let repeat: string | null = null;
        if (repeatKind === "weekly" && weekdays.length === 0) {
            error = t.remindPickWeekday;
            return;
        }
        if (repeatKind === "monthly" && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31)) {
            error = t.remindBadRepeat;
            return;
        }
        if (repeatKind === "every" && (!Number.isInteger(everyN) || everyN < 1 || everyN > 3650)) {
            error = t.remindBadRepeat;
            return;
        }
        if (repeatKind === "daily") repeat = "daily";
        else if (repeatKind === "weekly") repeat = `weekly:${weekdays.join(",")}`;
        else if (repeatKind === "monthly") repeat = `monthly:${monthDay}`;
        else if (repeatKind === "every") repeat = everyN === 1 ? "daily" : `every:${everyN}d`;
        onSaved(value, repeat, end || null);
    }

    function onRootKeydown(e: KeyboardEvent): void {
        if (e.key !== "Enter" || e.isComposing) return; // IME 组字确认键不算 Enter（sloop □10 坑）
        // select 的 Enter=原生展开下拉、button 的 Enter=激活钮——都不劫持成保存（input 上=表单式提交）
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "SELECT" || tag === "BUTTON") return;
        save();
    }
</script>

<div class="pj-remind-panel" role="dialog" aria-label={t.remindTitle} tabindex="-1" onkeydown={onRootKeydown}>
    <div class="pj-remind-panel__title">{t.remindTitle}</div>
    <div class="pj-remind-panel__fieldlabel">{t.remindStartLabel}</div>
    <TimeSpinner value={value} ariaLabel={t.remindStartLabel} onInput={(v) => (value = v)} />
    <div class="pj-remind-panel__endhead">
        <span class="pj-remind-panel__fieldlabel">{t.remindEndLabel}</span>
        {#if endValue}
            <button type="button" class="pj-remind-panel__clear" onclick={() => (endValue = "")}>{t.remindClear}</button>
        {/if}
    </div>
    <TimeSpinner value={endValue} ariaLabel={t.remindEndLabel} onInput={(v) => (endValue = v)} onFirstFocus={() => value} />
    <div class="pj-remind-panel__rel">
        <span class="pj-remind-panel__relplus">+</span>
        <input class="b3-text-field pj-remind-panel__relnum" type="number" min="1" max="5256000" bind:value={relNum} />
        <select class="b3-select pj-remind-panel__relunit" bind:value={relUnit}>
            <option value="1">{t.remindUnitMin}</option>
            <option value="60">{t.remindUnitHour}</option>
            <option value="1440">{t.remindUnitDay}</option>
        </select>
        <button type="button" class="b3-button b3-button--small" onclick={applyRelative}>{t.remindRelSet}</button>
    </div>
    {#if durLabel}
        <div class="pj-remind-panel__dur">{durLabel}</div>
    {:else}
        <div class="pj-remind-panel__endlabel">{t.remindEndHint}</div>
    {/if}
    <select class="b3-select pj-remind-panel__repeat" bind:value={repeatKind}>
        <option value="none">{t.remindRepeatNone}</option>
        <option value="daily">{t.remindRepeatDaily}</option>
        <option value="weekly">{t.remindRepeatWeekly}</option>
        <option value="monthly">{t.remindRepeatMonthly}</option>
        <option value="every">{t.remindRepeatEvery}</option>
    </select>
    {#if repeatKind === "weekly"}
        <div class="pj-remind-panel__chips">
            {#each [1, 2, 3, 4, 5, 6, 7] as d (d)}
                <button
                    type="button"
                    class="b3-button pj-remind-panel__chip"
                    class:pj-remind-panel__chip--on={weekdays.includes(d)}
                    onclick={() => toggleDay(d)}
                >{t[`remindWd${d}`]}</button>
            {/each}
        </div>
    {:else if repeatKind === "monthly"}
        <div class="pj-remind-panel__param">
            <input class="b3-text-field pj-remind-panel__num" type="number" min="1" max="31" bind:value={monthDay} />
            <span class="pj-remind-panel__unit">{t.remindMonthlyUnit}</span>
        </div>
    {:else if repeatKind === "every"}
        <div class="pj-remind-panel__param">
            <input class="b3-text-field pj-remind-panel__num" type="number" min="1" max="3650" bind:value={everyN} />
            <span class="pj-remind-panel__unit">{t.remindEveryUnit}</span>
        </div>
    {/if}
    {#if error}
        <div class="pj-remind-panel__error">{error}</div>
    {/if}
    <div class="pj-remind-panel__row">
        {#if initial}
            <button class="b3-button b3-button--small b3-button--outline pj-remind-panel__danger" onclick={onDeleted}>{t.remindDelete}</button>
        {/if}
        <button class="b3-button b3-button--small b3-button--primary" onclick={save}>{t.remindSave}</button>
    </div>
</div>
