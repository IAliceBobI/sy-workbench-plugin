<script lang="ts">
    // □24 段式时间控件（macOS 日期偏好/TradingView 同款）：五段（年/月/日/时/分）独立聚焦，
    // ↑↓/滚轮/▲▼ 调当前聚焦段（wrap 回绕），满位自动跳段，blur clamp（日按当月月末）。
    // 空态（value=""）=开放时长：完全空时首次聚焦经 onFirstFocus 取预填值（结束预填=开始）。
    import { SEG_DEFS, clampSegInput, segsToValue, stepSeg, valueToSegs, type SegKey, type TimeSegs } from "./spinnerLogic";
    import { REMIND_AT_RE } from "../kernel/core/remind";

    let {
        value,
        onInput,
        /** 空态首次聚焦的预填源（返回完整值；结束时间传开始值）；不给=无预填 */
        onFirstFocus,
        ariaLabel,
    }: {
        value: string;
        onInput: (v: string) => void;
        onFirstFocus?: () => string;
        ariaLabel: string;
    } = $props();

    const EMPTY: TimeSegs = { y: "", mo: "", d: "", h: "", mi: "" };
    // svelte-ignore state_referenced_locally
    let segs = $state<TimeSegs>(valueToSegs(value) ?? { ...EMPTY });
    let lastSeg = $state<SegKey>("mi"); // ▲▼ 作用段=最近聚焦段（默认分钟=最常微调）
    // 预填每开一次面板只做一回：初值非空=既有值场景直接消耗标志（清空后再聚焦不灌开始值）；
    // 面板每开即重挂（panel.ts close+mount 新实例），「一回」由此保持
    // svelte-ignore state_referenced_locally
    let prefilled = valueToSegs(value) !== null;
    // svelte-ignore state_referenced_locally
    let lastSynced = value; // 防重置基准=自己最后 emit 的值（含空——中间态也算已同步，P0-1）
    // svelte-ignore state_referenced_locally
    let lastComplete = valueToSegs(value) !== null ? value : ""; // 最近完整值=blur 半态归一的基
    let segEls: HTMLInputElement[] = [];

    // 外部 value 变化（相对通道写入/父清空）→ 重置段+归一基；脏检查模式防 effect 读回写振荡
    $effect(() => {
        if (value !== lastSynced) {
            segs = valueToSegs(value) ?? { ...EMPTY };
            lastSynced = value;
            lastComplete = REMIND_AT_RE.test(value) ? value : ""; // 外部值同刷基（清空=基也清，防 blur 复活旧值）
        }
    });

    function joinSegs(): string {
        return `${segs.y}-${segs.mo}-${segs.d}T${segs.h}:${segs.mi}`;
    }
    function emit(): void {
        const v = segsToValue(segs);
        if (v !== null) {
            const norm = valueToSegs(v);
            if (norm) segs = norm; // clamp 修正回显（2-31→2-28 立即纠正，段与值不脱钩）
            lastComplete = v;
        }
        lastSynced = v ?? ""; // 自己发出的空值（中间态）也算已同步——回流相等即不重置（防打字被清）
        onInput(v ?? "");
    }

    /** 空态预填（onFirstFocus 源值非法则维持空态）；成功=true */
    function prefill(): boolean {
        if (prefilled || !onFirstFocus) return false;
        if (!SEG_DEFS.every((d) => segs[d.key] === "")) return false;
        const pre = valueToSegs(onFirstFocus());
        if (!pre) return false;
        segs = pre;
        prefilled = true;
        lastSynced = lastComplete = joinSegs();
        onInput(lastSynced);
        return true;
    }

    function bump(key: SegKey, delta: 1 | -1): void {
        // 空态点 ▲▼=先预填再步进（macOS stepper 语义；预填失败才 no-op）
        if (!REMIND_AT_RE.test(joinSegs()) && !prefill()) return;
        const next = stepSeg(joinSegs(), key, delta);
        segs = valueToSegs(next) ?? segs;
        lastSynced = lastComplete = next;
        onInput(next);
    }

    function onSegFocus(e: FocusEvent, key: SegKey): void {
        lastSeg = key;
        const input = e.currentTarget as HTMLInputElement;
        prefill(); // 完全空态首次聚焦：预填（结束预填=开始）
        requestAnimationFrame(() => input.select()); // raf：等浏览器落焦后全选
    }

    function onSegInput(e: Event, key: SegKey): void {
        const input = e.currentTarget as HTMLInputElement;
        const def = SEG_DEFS.find((d) => d.key === key)!;
        const digits = input.value.replace(/\D/g, "").slice(0, def.len);
        segs = { ...segs, [key]: digits };
        if (digits.length === def.len) {
            const idx = SEG_DEFS.findIndex((d) => d.key === key);
            const nextEl = segEls[idx + 1];
            if (nextEl) {
                nextEl.focus();
                nextEl.select();
            }
        }
        emit();
    }

    function onSegKeydown(e: KeyboardEvent, key: SegKey): void {
        if (e.key === "ArrowUp") {
            e.preventDefault();
            bump(key, 1);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            bump(key, -1);
        }
    }

    function onSegWheel(e: WheelEvent, key: SegKey): void {
        e.preventDefault();
        bump(key, e.deltaY < 0 ? 1 : -1);
    }

    function onSegBlur(key: SegKey): void {
        const cur = joinSegs();
        const year = new Date().getFullYear();
        if (REMIND_AT_RE.test(cur)) {
            const next = clampSegInput(cur, key, segs[key], year);
            if (next !== cur) {
                segs = valueToSegs(next) ?? segs;
                lastSynced = next;
                onInput(next);
            }
            return;
        }
        // 半编辑态（聚焦段缺位：月敲"3"/删空）→ 以最近完整值为基复原：聚焦段补值（"3"→"03"、
        // 空→段最小值/当年）+其余段还原该基（macOS 单段复原语义）
        // 基用 lastComplete 而非 lastSynced——后者在中间态已被记空（P0-1 防回流语义）
        if (REMIND_AT_RE.test(lastComplete)) {
            const next = clampSegInput(lastComplete, key, segs[key], year);
            segs = valueToSegs(next) ?? segs;
            lastSynced = next;
            lastComplete = next;
            onInput(next);
        }
    }
</script>

<div class="pj-timespinner" role="group" aria-label={ariaLabel}>
    {#each SEG_DEFS as def, i}
        {#if i > 0}<span class="pj-timespinner__sep" aria-hidden="true">{def.key === "h" ? " " : def.key === "mi" ? ":" : "-"}</span>{/if}
        <input
            class="pj-timespinner__seg"
            class:pj-timespinner__seg--y={def.key === "y"}
            type="text"
            inputmode="numeric"
            maxlength={def.len}
            placeholder={def.key === "y" ? "YYYY" : def.key === "mo" ? "MM" : def.key === "d" ? "DD" : def.key === "h" ? "HH" : "mm"}
            value={segs[def.key]}
            bind:this={segEls[i]}
            onfocus={(e) => onSegFocus(e, def.key)}
            oninput={(e) => onSegInput(e, def.key)}
            onkeydown={(e) => onSegKeydown(e, def.key)}
            onwheel={(e) => onSegWheel(e, def.key)}
            onblur={() => onSegBlur(def.key)}
        />
    {/each}
    <span class="pj-timespinner__btns">
        <button type="button" class="pj-timespinner__btn" tabindex="-1" aria-label="▲" onmousedown={(e) => { e.preventDefault(); bump(lastSeg, 1); }}>
            <svg viewBox="0 0 16 16"><path d="M8 5.2 12 10.8H4z" /></svg>
        </button>
        <button type="button" class="pj-timespinner__btn" tabindex="-1" aria-label="▼" onmousedown={(e) => { e.preventDefault(); bump(lastSeg, -1); }}>
            <svg viewBox="0 0 16 16"><path d="M8 10.8 4 5.2h8z" /></svg>
        </button>
    </span>
</div>
