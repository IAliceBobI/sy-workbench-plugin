<script lang="ts">
    // 任务徽标「更多…」属性面板（popover 紧凑形态——RemindPanel 同骨架同视觉）。
    // 平铺四字段：截止日期（文本）+ 截止时刻（TimeSpinner 段式件复用——勿重写）+
    // 开始日期（文本）+ 标签（逗号分隔文本）；保存=直写块属性（taskPropsSaveAttrs 纯函数
    // 校验+组装，键名=serializeTaskDates 单一事实源）。打开即预填现值（panel 工厂喂 initial）。
    // 时刻件吃完整 YYYY-MM-DDTHH:mm 值：面板持 dueWhen 全值态镜像 spinner 的 emit
    // （RemindPanel 同回显契约——父侧加工会破 TimeSpinner lastSynced 防回流）；spinner
    // 发完整值时同步回填日期字段（两控件一份数据，日期字段是时间的基）。
    import TimeSpinner from "./TimeSpinner.svelte";
    import { taskPropsSaveAttrs, initialDueWhen, type TaskPropsFields } from "../gui/taskBadgeMenu";

    let {
        initial,
        t,
        onSaved,
    }: {
        initial: TaskPropsFields;
        t: Record<string, string>;
        onSaved: (fields: TaskPropsFields) => void;
    } = $props();

    // 面板单次挂载单次使用：初值只取 props 快照（RemindPanel 同惯例）
    // svelte-ignore state_referenced_locally
    const initSnap = { ...initial };
    let dueDate = $state(initSnap.dueDate);
    let startDate = $state(initSnap.startDate);
    let tagsRaw = $state(initSnap.tagsRaw);
    let error = $state("");
    // 截止时刻的完整值态（spinner 回显契约）：初值=日期+时刻双全取真值，time-only
    // 任务（有时刻无日期）用今天补日期段让时刻可见——补位日期不落盘（保存时 dueDate
    // 字段仍空=清键语义，time-only 形态保留，时刻不再被静默清掉）
    // svelte-ignore state_referenced_locally
    let dueWhen = $state(initialDueWhen(initSnap.dueDate, initSnap.dueTime, todayStr()));

    /** 空态首次聚焦预填：截止日期（非法/空=今天）+ 当前时刻（RemindPanel defaultAt 同拍板） */
    function duePrefill(): string {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim()) ? dueDate.trim() : todayStr();
        const n = new Date();
        const p = (x: number) => String(x).padStart(2, "0");
        return `${d}T${p(n.getHours())}:${p(n.getMinutes())}`;
    }

    function todayStr(): string {
        const n = new Date();
        const p = (x: number) => String(x).padStart(2, "0");
        return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
    }

    /** spinner emit 回显（含空中间态）+ 完整值时同步日期字段（spinner 改日段=改截止日期）；
     * 日期字段空/非法（time-only 任务）不回灌——spinner 里的日期段是补位显示基非落盘值 */
    function onDueWhen(v: string): void {
        dueWhen = v;
        if (v && /^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim())) dueDate = v.slice(0, 10);
    }

    /** 日期字段手改 → 合法全形时把 spinner 的日期段换基（时刻段不动）；spinner 空态不灌 */
    function syncDueWhenFromField(): void {
        if (!dueWhen) return;
        const d = dueDate.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dueWhen = `${d}T${dueWhen.slice(11)}`;
    }

    function save(): void {
        error = "";
        const fields: TaskPropsFields = {
            dueDate: dueDate.trim(),
            dueTime: dueWhen ? dueWhen.slice(11) : "",
            startDate: startDate.trim(),
            tagsRaw,
        };
        if (!taskPropsSaveAttrs(fields)) {
            error = t.taskBadgePropsInvalid;
            return;
        }
        onSaved(fields);
    }

    function onRootKeydown(e: KeyboardEvent): void {
        if (e.key !== "Enter" || e.isComposing) return; // IME 组字确认键不算 Enter（sloop □10 坑）
        // button 的 Enter=激活钮（保存/聚焦段）——不劫持成保存
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "BUTTON" || tag === "SELECT") return;
        save();
    }
</script>

<div class="pj-taskprops" role="dialog" aria-label={t.taskBadgePropsTitle} tabindex="-1" onkeydown={onRootKeydown}>
    <div class="pj-taskprops__title">{t.taskBadgePropsTitle}</div>
    <div class="pj-taskprops__fieldlabel">{t.taskBadgePropsDueDate}</div>
    <input
        class="b3-text-field pj-taskprops__input"
        type="text"
        placeholder="YYYY-MM-DD"
        bind:value={dueDate}
        oninput={syncDueWhenFromField}
    />
    <div class="pj-taskprops__fieldlabel">{t.taskBadgePropsDueTime}</div>
    <TimeSpinner value={dueWhen} ariaLabel={t.taskBadgePropsDueTime} onInput={onDueWhen} onFirstFocus={duePrefill} />
    <div class="pj-taskprops__fieldlabel">{t.taskBadgePropsStartDate}</div>
    <input
        class="b3-text-field pj-taskprops__input"
        type="text"
        placeholder="YYYY-MM-DD"
        bind:value={startDate}
    />
    <div class="pj-taskprops__fieldlabel">{t.taskBadgePropsTags}</div>
    <input class="b3-text-field pj-taskprops__input" type="text" bind:value={tagsRaw} />
    <div class="pj-taskprops__hint">{t.taskBadgePropsHint}</div>
    {#if error}
        <div class="pj-taskprops__error">{error}</div>
    {/if}
    <div class="pj-taskprops__row">
        <button class="b3-button b3-button--small b3-button--primary" onclick={save}>{t.taskBadgePropsSave}</button>
    </div>
</div>
