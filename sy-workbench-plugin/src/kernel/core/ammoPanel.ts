// ammo □6：四象限面板·视图合成纯层——「本体只有两个（森林域+日账域），UI 全是投影」的
// 合成半边。kernel/ammoPanel.ts（IO 聚合读面）把一日原料（配置行+日账条目+不想做清单+
// 引擎运行态）读齐后喂进本层，产出组件可直接渲染的视图形态：
//  - buildPoolViews：四池视图（配比性格+消耗态合成——已消耗/多用 X 分钟照实显示不拦截，A5）；
//  - buildTaskViews：当日任务行视图（keyed each 去重+key 加序号保底——重复 key=整面板冻结，
//    本战役缘起 bug 之一的防御层；同任务跨行/AI 整组重放残影都在此收敛）；
//  - buildCircleView：中央不想做圈（鞭策墙=用户原话常驻+三类分区——递镜子纪律：只显示
//    用户自己写的原话，AI 从不产生新指责）。
// 零 siyuan/网络/DOM 依赖（channels 纪律）；now 全注入可测（core/pomodoro 退役骨架同款）。
import { AMMO_POOL_SLUGS, DEFAULT_HEARTH_FREQ, AVERSION_SECTION_TITLES, type AmmoDayConfig, type AmmoPoolSlug, type AmmoTaskRow, type AversionKind } from "./ammoQuadrant";
import type { AversionItem } from "../ammoQuadrant";

// ── 四池视图（配比+消耗态合成） ──

/** 消耗态（A5 软配额照实显示，全程不拦截）：
 *  - "idle"：无配额数字且无吃量（沉默不出行——零信号行不占位）；
 *  - "plain"：无配额数字但有吃量（照实显示实吃）；
 *  - "left"：有配额未达（还差 X——gold 保底未达成/纪律提醒面）；
 *  - "done"：恰好达配额数字（已消耗）；
 *  - "over"：超过配额数字（多用 X 分钟——橙标；配额是数字不是闸门） */
export type AmmoPoolBurnState = "idle" | "plain" | "left" | "done" | "over";

export interface AmmoPoolView {
    pool: AmmoPoolSlug;
    /** 配额分钟（gold=保底 / hearth=上限；null=今日未设数字） */
    ratio: number | null;
    /** 仅 hearth 有语义（最小频率天数；无配置/无值=null——组件显示缺省提示用） */
    freq: number | null;
    /** 日账闭合段实吃分钟（未闭合运行段不计——运行态走 running 横幅/行徽标） */
    actualMin: number;
    state: AmmoPoolBurnState;
    /** 差值分钟：left=还差的量 / over=多用的量 / 其余=0 */
    deltaMin: number;
}

/** 四池视图合成（呈现序=池白名单序——goja 键序≠V8 插入序，跨引擎一致靠显式序；
 *  config=null=今日未配弹药：全池零数字空态，照实不吃警。
 *  消耗态按池性格分派（A4/P1-B）：gold=保底（未满=left「还差」纪律提醒面）；
 *  hearth=上限、deadline/crumbs 不保底不设限——未满均无「还差」语义（上限没超不是欠缺），
 *  实吃>0 照实 plain、零吃量 idle 沉默；恰达数字=done（A5 用完显示已消耗）；超出=over 多用照实。 */
export function buildPoolViews(input: { config: AmmoDayConfig | null; actualByPool: Record<string, number> }): AmmoPoolView[] {
    return AMMO_POOL_SLUGS.map((pool) => {
        const ratio = input.config?.pools.find((p) => p.pool === pool)?.ratio ?? null;
        const freq = input.config?.pools.find((p) => p.pool === pool)?.freq ?? null;
        const actualMin = input.actualByPool[pool] ?? 0;
        let state: AmmoPoolBurnState;
        let deltaMin = 0;
        if (ratio == null) {
            state = actualMin > 0 ? "plain" : "idle";
        } else if (actualMin === ratio) {
            state = "done";
        } else if (actualMin > ratio) {
            state = "over";
            deltaMin = actualMin - ratio;
        } else if (pool === "gold") {
            state = "left";
            deltaMin = ratio - actualMin;
        } else {
            state = actualMin > 0 ? "plain" : "idle";
        }
        return { pool, ratio, freq, actualMin, state, deltaMin };
    });
}

// ── 任务行视图（当日挂载清单+运行归属） ──

export interface AmmoTaskView {
    /** 树任务块 id（空串=无主任务行——迁移预告/AI 直排） */
    task: string;
    /** 任务名（配置行文本剥引用后的展示名） */
    name: string;
    pool: AmmoPoolSlug;
    /** 任务级配额分钟（null=只吃池配比） */
    quota: number | null;
    /** 引擎运行中归属此行（running.task 树块精确匹配；无主行回退 running.pool+summary 名匹配） */
    running: boolean;
    /** 悬账（昨日窗未闭合）归属此行——行上挂「悬」徽标（补结走面板悬账条，不在此展开） */
    dangling: boolean;
    /** each key：池#身份#序号——序号保底=重复 key 整面板冻结的最后一道防线（踩坑纪律） */
    key: string;
}

/** 当日任务行视图合成（呈现序=配置行容器序；去重=同身份行收敛——task 非空按 task 身份、
 *  空按 name 身份，池归属取首现行：跨池重复=数据侧违「当天内一任务一池」的残影，从严收敛
 *  防同一任务双行误导消耗态）。
 *  running/dangling 归属判定用真身块 id（打点条目的 custom-ammo-task 指针），匹配不到
 *  （无主行临时任务）回退池+名字匹配——锚点出发型（pool 空）永不匹配池内行。 */
export function buildTaskViews(input: {
    config: AmmoDayConfig | null;
    running: { task: string; pool: string; summary: string; anchor?: boolean } | null;
    danglingTasks: string[];
}): AmmoTaskView[] {
    const seen = new Set<string>();
    const out: AmmoTaskView[] = [];
    const rows: AmmoTaskRow[] = input.config?.tasks ?? [];
    rows.forEach((r, i) => {
        const identity = r.task || r.name;
        if (!identity) return; // 双空行（无 id 无名）：不可渲染不可寻址，防御丢弃
        if (seen.has(identity)) return; // keyed each 冻结防线①：合成层按 id 去重（跨池残影同收敛）
        seen.add(identity);
        const running = Boolean(
            input.running &&
            !input.running.anchor &&
            (r.task ? input.running.task === r.task : (input.running.pool === r.pool && input.running.summary === r.name)),
        );
        out.push({
            task: r.task,
            name: r.name,
            pool: r.pool,
            quota: r.quota,
            running,
            dangling: Boolean(r.task && input.danglingTasks.includes(r.task)),
            key: `${r.pool}#${identity}#${i}`, // 防线②：key 加序号——同批数据重复身份不冻结面板
        });
    });
    return out;
}

// ── 中央不想做圈视图（鞭策墙+三分区） ──

export interface AmmoCircleView {
    /** 鞭策墙：全部不想做原话原文常驻（用户原话唯一素材源——AI 从不产生新指责） */
    whip: string[];
    vows: AversionItem[];
    fears: AversionItem[];
    swallows: AversionItem[];
    /** 三分区显示名（文档标题优先、缺段/空标题→默认词补位——「分区叫什么名文档说了算」；
     *  缺省（结构不对/读取失败）=组件退 i18n 默认词） */
    titles: Record<AversionKind, string>;
}

/** 中央圈视图合成：三分区=机器属性 kind 分拣（未知 kind=不进圈——读面已滤，此处双保险）；
 *  鞭策墙=全部原话按清单容器序（用户写的顺序=权重序，不发明排序）。
 *  titles=分区显示名（sectionTitles 透传——文档三段 H2 实际标题；缺省=全默认词，组件不须判空）。 */
export function buildCircleView(aversions: AversionItem[], sectionTitles?: Record<AversionKind, string> | null): AmmoCircleView {
    const vows: AversionItem[] = [];
    const fears: AversionItem[] = [];
    const swallows: AversionItem[] = [];
    for (const a of aversions) {
        if (a.kind === "vow") vows.push(a);
        else if (a.kind === "fear") fears.push(a);
        else if (a.kind === "swallow") swallows.push(a);
    }
    const titles: Record<AversionKind, string> = { ...AVERSION_SECTION_TITLES, ...sectionTitles };
    return { whip: aversions.map((a) => a.text), vows, fears, swallows, titles };
}

// ── 杂项（组件展示用小工具——注入式纯函数） ──

/** 分钟→「Xh Ym」人话时长（负值/非法=空串；运行横幅与池消耗态共用口径） */
export function fmtDuration(min: number | null | undefined): string {
    if (min == null || !Number.isFinite(min) || min <= 0) return "";
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h <= 0) return m > 0 ? `${m}m` : "";
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** HH:mm→当日分钟（非法=NaN——调用方判空；hmToMinutes 引擎侧同义，此处独立防 kernel 图反向依赖） */
export function hmToMinLocal(hm: string): number {
    const m = /^(\d{2}):(\d{2})$/.exec(hm ?? "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** 运行已走分钟（显示时钟容差版跨零点归一）：start>now 的负差在容差带内（-5~0）钳 0——
 *  显示时钟（宿主 30s 递推 nowMin）对内核落账 start 的分钟截断抖动（09-23 实锤：start 15:41
 *  + nowMin 停 15:40 曾把 -1 分钟放大成 23h 59m）；大幅负值才认昨日跨零点续跑 +24h
 *  （ledgerDurationMin 同语义但入参两侧同为落账时刻无抖动面，不需容差）。
 *  容差带只吞「已跑 ≥1435 分钟」长跑的显示毛刺；已跑 <5 分钟的真跨零点（23:59 开 00:01 看）
 *  diff ≤ -1434 落在跨零点侧不受影响。非法入参=0（显示面保守值）。 */
export function elapsedRunMin(startHm: string | null | undefined, nowMin: number): number {
    if (!/^\d{2}:\d{2}$/.test(startHm ?? "") || !Number.isFinite(nowMin)) return 0;
    const startMin = Number(startHm.slice(0, 2)) * 60 + Number(startHm.slice(3));
    const diff = nowMin - startMin;
    if (diff >= 0) return diff;
    return diff >= -5 ? 0 : diff + 24 * 60;
}

/** hearth 最小频率展示值（freq 缺省链唯一出口——DEFAULT_HEARTH_FREQ 的 UI 面） */
export function hearthFreqDisplay(freq: number | null): number {
    return freq ?? DEFAULT_HEARTH_FREQ;
}
