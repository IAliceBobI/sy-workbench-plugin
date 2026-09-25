// 作息训练·期 1（sloop □3）：今日行为画像·纯逻辑层。
// 八路数据源（概念档 §6 七路+□27 番茄）的聚合 schema 与决策函数——零 siyuan/网络/DOM 依赖
// （kernel bundle 与前端 bundle 共用同一份源——channels 纪律：只允许零依赖纯函数）。
// 红线：明细仅本地不外传；画像内容脱敏（标题/摘要级，不进正文）——本层产出的
// DayProfile 就是交接会提示词（期 4）的直接原料，字段粒度以「标题级」为上限。

import { getLogicalDay } from "./dates";

/** 画像滚动窗（天）：周报（期 4）要周窗，14 天=一周+对照余量 */
export const BEHAVIOR_KEEP_DAYS = 14;

/** ①②⑤ 文档触达记录：今日动过的文档（SQL blocks type='d' 的 created/updated 投影） */
export interface DocTouch {
    id: string;
    title: string;
    box: string;
    hpath: string;
    /** diary=日记 box / fastnote=闪念速记 / project=项目主文档 / doc=普通文档 */
    kind: "diary" | "fastnote" | "project" | "doc";
    /** 今日新建（created >= 日界） */
    created: boolean;
    /** 树内今日 updated 块数（近似编辑量——含级联父链，方向性信号非精确账） */
    edits: number;
    /** 今日最后动过时刻 HH:mm（文档行 updated——级联刷新，非内容编辑时刻） */
    lastAt: string | null;
}

/** ③ 文档停留（前端 tracker 推送的全量快照幂等覆盖） */
export interface DocStay {
    id: string;
    title: string;
    /** 可见停留秒数（visibilitychange 剔除挂机段） */
    seconds: number;
    sessions: number;
}

/** ④⑤ 日历事件（今日窗；外来/自己分流=镜像事件 id 是否在账本 eventId 集） */
export interface CalEventBrief {
    summary: string;
    /** YYYY-MM-DDTHH:mm（墙上时间）或全天 YYYY-MM-DD——镜像 MirrorEvent.start 原样 */
    start: string;
    end: string;
    allDay: boolean;
    /** 日历显示名（meta.catalog 映射；缺=日历 id 前缀） */
    cal: string;
    /** true=咱们插件写的（remind/task/burden/weather 账本内） */
    own: boolean;
}

/** ⑤ 今日应触发提醒（对账原料：单次=at 今日；循环=todayIsOccurrence） */
export interface RemindDue {
    blockId: string;
    title: string;
    /** HH:mm（remind-at 当日时刻） */
    at: string;
    repeat: string | null;
}

/** ⑤ 今日到期任务（对账三态证据）。rootId=内部字段（项目归属聚合用，序列化无碍） */
export interface TaskDue {
    blockId: string;
    title: string;
    done: boolean;
    /** HH:mm | null（无时刻=全天到期） */
    dueTime: string | null;
    rootId: string;
}

/** ⑤ 项目级聚合：今日动过的项目容器 */
export interface ProjectTouch {
    id: string;
    title: string;
    edits: number;
    /** 今日到期任务数（项目树内） */
    tasksTouched: number;
}

/** 一天的行为画像（交接会提示词直接原料；按天聚合项目级粒度） */
export interface DayProfile {
    version: 1;
    day: string;
    /** ①②⑤ 今日动过的文档（标题级；按 lastAt 降序） */
    docs: DocTouch[];
    /** ③ 文档停留 */
    stays: DocStay[];
    /** 作息核心信号：块 updated 按小时分桶（"08"→块数；本地墙上时间） */
    activeHours: Record<string, number>;
    /** 操作日计数（近似：级联父链含水分，方向性信号） */
    ops: { blocksCreated: number; blocksUpdated: number; docsCreated: number };
    /** ④⑤ 今日日历事件（外来+自己，按 start 升序） */
    calendar: CalEventBrief[];
    /** ⑤ 今日应触发提醒 */
    reminders: RemindDue[];
    /** ⑤ 今日到期任务 */
    tasks: TaskDue[];
    /** ⑤ 今日动过的项目 */
    projects: ProjectTouch[];
    /** ⑥ 今日历法（□16 历法层） */
    almanac: { lunarText: string; off: boolean; work: boolean };
    /** ⑧ 今日番茄（□27：work-done 计数+Σ工作分钟——深度块锚点证据；log 档前端写 kernel 读聚合） */
    pomodoros: { count: number; minutes: number };
    /** ⑦ 长期目标画像（期 7 落地，先留位） */
    goalProfile: null;
    /** 采集健康度：路名→"ok"|"empty"|"error:<短消息>"（画像内容外，提示词不进） */
    sources: Record<string, string>;
    /** 本轮时点（ISO）——内容防抖排除字段，不参与变化判定 */
    collectedAt: string;
}

/** 画像存档形态（behavior-profile.json） */
export interface BehaviorArchive {
    version: 1;
    days: Record<string, DayProfile>;
}

// ── SQL 行形态（编排层喂进来的原始行——纯层只做聚合不碰 IO） ──

export interface DocRow {
    id: string;
    box: string;
    path: string;
    hpath: string;
    content: string;
    /** 14 位内核时间戳 */
    created: string;
    updated: string;
}

export interface RootAggRow {
    root_id: string;
    /** 两位小时（本地墙上时间——kernel updated 本地 14 位，substr(9,2)） */
    h: string;
    n: number;
}

/** kernelTime 14 位 → "HH:mm"（防越界：截 4 位数字段） */
export function kernelTimeToHM(t: string): string | null {
    if (!/^\d{14}$/.test(t)) return null;
    return `${t.slice(8, 10)}:${t.slice(10, 12)}`;
}

/** activeHours 小时键域校验："00".."23" 才收（O2①：capacity 92:00/60:00 根治写面）。
 *  根因实锤（主实例 6806 实测）：blocks 表存在 15 位残缺 updated（如 567260119065201），
 *  采集 SQL 的 `updated >= '<day>000000'` 按字典序比较放 '5…' 开头的残值过关，
 *  substr(updated,9,2) 落出 00-99 任意两位（3 日窗实测脏键 31/40/41/51/52/60/61/81/90/92）
 *  ——buildDayProfile 写面在此拒收；读面（routineTools capacity / handoffSeed 活跃段）
 *  同款过滤兜已冻结的旧档（归档直通不重写，写面修不了历史键）。 */
export function isHourKey(h: string): boolean {
    return /^([01]\d|2[0-3])$/.test(h ?? "");
}

/** 文档 kind 判定：fastnote/project 属性集优先（特异性），余下按日记 box 归 diary */
export function docKind(docId: string, box: string, fastnoteIds: Set<string>, projectIds: Set<string>, diaryBox: string | null): DocTouch["kind"] {
    if (fastnoteIds.has(docId)) return "fastnote";
    if (projectIds.has(docId)) return "project";
    if (diaryBox && box === diaryBox) return "diary";
    return "doc";
}

/** 文档归属项目：项目主文档自身，或子文档（物理目录=父文档 id——path 以 /<pid>/ 开头；
 *  嵌套层级任意深，前缀判定成立；非项目树= null） */
export function projectOf(docId: string, path: string, projectIds: Set<string>): string | null {
    if (projectIds.has(docId)) return docId;
    for (const pid of projectIds) {
        if (path?.startsWith(`/${pid}/`)) return pid;
    }
    return null;
}

/** 构建一日画像（编排层各路数据齐后一次成型；stays 原样注入=前端快照为唯一真源） */
export function buildDayProfile(input: {
    day: string;
    collectedAt: string;
    docs: DocRow[];
    /** created >= 日界的文档 id 集（docsCreated+DocTouch.created） */
    createdDocIds: Set<string>;
    rootAggs: RootAggRow[];
    createdCounts: Map<string, number>;
    fastnoteIds: Set<string>;
    projectIds: Set<string>;
    projectTitles: Map<string, string>;
    diaryBox: string | null;
    stays: DocStay[];
    calendar: CalEventBrief[];
    reminders: RemindDue[];
    tasks: TaskDue[];
    almanac: { lunarText: string; off: boolean; work: boolean };
    /** ⑧ 番茄日聚合（编排层读 log 档产出） */
    pomodoros: { count: number; minutes: number };
    sources: Record<string, string>;
}): DayProfile {
    const editsByRoot = new Map<string, number>();
    const activeHours: Record<string, number> = {};
    let blocksUpdated = 0;
    for (const r of input.rootAggs) {
        editsByRoot.set(r.root_id, (editsByRoot.get(r.root_id) ?? 0) + r.n);
        // O2①：脏时刻键拒收（kernelTimeToHM 同款纪律）——编辑量计数照收（次数仍真），
        // 仅小时直方图丢该行（15 位 updated 残值的 substr 产物非可信时刻）
        if (isHourKey(r.h)) activeHours[r.h] = (activeHours[r.h] ?? 0) + r.n;
        blocksUpdated += r.n;
    }
    let blocksCreated = 0;
    for (const n of input.createdCounts.values()) blocksCreated += n;

    // 文档→项目归属（项目自身或子文档树），块编辑按 root 归属累计到项目
    const projectByDoc = new Map<string, string>();
    for (const d of input.docs) {
        const pid = projectOf(d.id, d.path, input.projectIds);
        if (pid) projectByDoc.set(d.id, pid);
    }
    const projEdits = new Map<string, number>();
    for (const [root, n] of editsByRoot) {
        const pid = projectByDoc.get(root);
        if (pid) projEdits.set(pid, (projEdits.get(pid) ?? 0) + n);
    }
    const projTasks = new Map<string, number>();
    for (const t of input.tasks) {
        const pid = projectByDoc.get(t.rootId);
        if (pid) projTasks.set(pid, (projTasks.get(pid) ?? 0) + 1);
    }
    const projects: ProjectTouch[] = [];
    for (const pid of input.projectIds) {
        const edits = projEdits.get(pid) ?? 0;
        const created = input.createdDocIds.has(pid);
        if (edits <= 0 && !created && !(projTasks.get(pid) ?? 0)) continue;
        projects.push({ id: pid, title: input.projectTitles.get(pid) ?? "", edits, tasksTouched: projTasks.get(pid) ?? 0 });
    }

    const docs: DocTouch[] = input.docs
        .map((d) => ({
            id: d.id,
            title: d.content || d.hpath || d.id,
            box: d.box ?? "",
            hpath: d.hpath ?? "",
            kind: docKind(d.id, d.box, input.fastnoteIds, input.projectIds, input.diaryBox),
            created: input.createdDocIds.has(d.id),
            edits: editsByRoot.get(d.id) ?? 0,
            lastAt: kernelTimeToHM(d.updated),
        }))
        .sort((a, b) => (a.lastAt ?? "").localeCompare(b.lastAt ?? "") * -1);

    return {
        version: 1,
        day: input.day,
        docs,
        stays: [...input.stays].sort((a, b) => b.seconds - a.seconds),
        activeHours: Object.fromEntries(Object.entries(activeHours).sort(([a], [b]) => a.localeCompare(b))),
        ops: {
            blocksCreated,
            blocksUpdated,
            docsCreated: input.docs.filter((d) => input.createdDocIds.has(d.id)).length,
        },
        calendar: [...input.calendar].sort((a, b) => a.start.localeCompare(b.start)),
        reminders: input.reminders,
        tasks: input.tasks,
        projects,
        almanac: input.almanac,
        pomodoros: input.pomodoros,
        goalProfile: null,
        sources: input.sources,
        collectedAt: input.collectedAt,
    };
}

/** 内容判等（防抖落盘用）：除 collectedAt 外全等才不写（remind status 同款纪律——
 *  petal 写=前端插件整重载，无变化零写） */
export function profileContentEquals(a: DayProfile, b: DayProfile): boolean {
    return JSON.stringify({ ...a, collectedAt: "" }) === JSON.stringify({ ...b, collectedAt: "" });
}

/** 滚动窗剪枝：保留 keepDays 天（含 today）；返回新对象（无变化返回原引用） */
export function pruneArchive(archive: BehaviorArchive, today: string, keepDays = BEHAVIOR_KEEP_DAYS): BehaviorArchive {
    const limit = new Date(today + "T00:00:00");
    if (Number.isNaN(limit.getTime())) return archive;
    limit.setDate(limit.getDate() - (keepDays - 1));
    const keepFrom = getLogicalDay(limit);
    const days = Object.keys(archive.days).filter((d) => d >= keepFrom);
    if (days.length === Object.keys(archive.days).length) return archive;
    const next: Record<string, DayProfile> = {};
    for (const d of days) next[d] = archive.days[d];
    return { version: 1, days: next };
}

/** 盘档宽容归一（缺文件/坏档→空档；days 直通——日画像字段宽容，消费侧可选读） */
export function normalizeArchive(raw: any): BehaviorArchive {
    if (!raw?.days || typeof raw.days !== "object" || Array.isArray(raw.days)) return { version: 1, days: {} };
    return { version: 1, days: raw.days };
}

/** 逻辑日加减：day±n 天（YYYY-MM-DD 字典序安全） */
export function shiftDay(day: string, deltaDays: number): string {
    const d = new Date(day + "T00:00:00");
    if (Number.isNaN(d.getTime())) return day;
    d.setDate(d.getDate() + deltaDays);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日终冻结裁决：内存中的过去日哪些该本轮落盘。
 *  规则：≤前天的过去日一律本轮冻结；昨日（today-1）跳过本轮——给前端 stay 推送留窗
 *  （翻转后前端 flushAll 推昨日档，下一轮 hourly 采齐冻结；1h 内关机的极端=昨日 stay 丢失可接受） */
export function daysToFreeze(memoryDays: string[], today: string): string[] {
    const yesterday = shiftDay(today, -1);
    return memoryDays.filter((d) => d < yesterday).sort();
}
