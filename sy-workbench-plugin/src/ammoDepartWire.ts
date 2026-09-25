// dataview □3：出发键接线·前端纯逻辑层（零 siyuan/DOM 依赖——弹窗/面板宿主共用）。
// 引擎面（kernel ammo-depart rpc）现成，本层只做三件事：
//  - buildDepartParams：出发参数组装（day=逻辑日兜底可覆写；start=用户点击的当下时刻——
//    「账本只记真实发生的事」，出发时刻≠锚点计划时刻）；summary 须纯文案（引擎写日账行
//    文本时自拼时刻头——班表行文本的时刻头在此剥掉，parseSchedItemText 同一判官）；
//  - pickNextAnchor：当日班表→「下一发」（start 严格晚于当下分钟的最早锚点行——已过点
//    不作下一发；同时刻取容器序首个；无 start 托盘行/非法时刻跳过）；
//  - stripAnchorSummary：班表行文本→纯摘要（时刻头剥除；裸时刻行/非时刻文本回退原文）。
import { getLogicalDay } from "./kernel/core/dates";
import { parseSchedItemText } from "./kernel/core/schedboard";

/** ammo-depart rpc 参数（kernel AmmoDepartParams 的前端镜像——task=班表锚点条目块 id B2.4） */
export interface DepartWireParams {
    day: string;
    start: string;
    summary: string;
    task: string;
    owner?: string;
}

/** 出发参数组装。day 缺省=逻辑日（调用方可传面板口径 day 覆写——口径同源 getLogicalDay）。 */
export function buildDepartParams(input: {
    summary: string;
    task: string;
    now: Date;
    day?: string;
    owner?: string;
}): DepartWireParams {
    const pad = (x: number) => String(x).padStart(2, "0");
    const d = input.now;
    return {
        day: input.day ?? getLogicalDay(d),
        start: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        summary: input.summary,
        task: input.task,
        ...(input.owner ? { owner: input.owner } : {}),
    };
}

/** 班表行文本→纯摘要（出发打点的 summary 不带时刻头——引擎写行文本自拼「HH:mm- 摘要」形）。
 *  时刻头行=剥头纯摘要（裸时刻行 summary 空=无语义文案，返空→调用方不出出发钮）；
 *  非时刻头文本（托盘/普通文案）=原样返回。 */
export function stripAnchorSummary(content: string | null | undefined): string {
    const plain = (content ?? "").replace(/\u200b/g, "").trim();
    if (!plain) return "";
    const parsed = parseSchedItemText(plain);
    return parsed ? parsed.summary.trim() : plain;
}

/** 班表行（sched-board-read 产物形态——key=块 id） */
export interface DepartBoardRow {
    key: string;
    summary: string;
    start: string | null;
}

/** 下一发（pickNextAnchor 产物——start 守卫后恒非空，UI/出发链路不再判空） */
export interface NextAnchor {
    key: string;
    summary: string;
    start: string;
}

/** HH:mm→当日分钟（非法=NaN；core/ammoPanel hmToMinLocal 同义，此处独立防 kernel 图反向依赖） */
function hmToMin(hm: string): number {
    const m = /^(\d{2}):(\d{2})$/.exec(hm ?? "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** 下一发选择：start 严格晚于 nowMin 的最早行；同时刻取首见（容器序=用户排班序）。null=无下一发 */
export function pickNextAnchor(rows: DepartBoardRow[], nowMin: number): NextAnchor | null {
    let best: NextAnchor | null = null;
    let bestMin = Number.POSITIVE_INFINITY;
    for (const r of rows ?? []) {
        if (!r?.key || !r.start) continue; // 无 id 行不可寻址（出发 task 指针落空）
        const min = hmToMin(r.start);
        if (!Number.isFinite(min) || min <= nowMin) continue; // 已过点/进行中锚点不作下一发
        if (min < bestMin) {
            bestMin = min;
            best = { key: r.key, summary: r.summary, start: r.start };
        }
    }
    return best;
}
