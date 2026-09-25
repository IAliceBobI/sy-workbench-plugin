// dataview □5②：拖卡到时间线=建锚点+出发——前端纯逻辑层（零 siyuan/DOM 依赖）。
// 拖源=四象限面板任务行（AmmoQuadrantPanel ondragstart 写 dataTransfer）；落点=时间线页签
// 24h 轴（TimelineTab .pj-cal__axis ondrop）。链路三段（IO 全在组件，本层只做可测纯半边）：
//  ① 卡片载荷编解码（自定义 MIME 探测+取值；text/plain 镜像兜底——非思源环境拖文本进来
//     MIME 恒缺=dragover 不认不误触发）；
//  ② 落点分钟（clientY→轴内分钟，snapToStep 15min 吸附同款）+建锚点 op（schedEdit add 通道
//     稳定键——重试幂等；index.schedEdit 软回退按 summary 收口=同卡再拖他处挪既有锚点）；
//  ③ 出发决策：viewDay=今天才出发（出发=当下真实动作，账本只记真实发生的事；非今日轴
//     =只建锚点，到点走 □3 提醒弹窗/横幅「出发下一发」链）。
// 出发本体=ammo-depart rpc（□3 同链——task=锚点条目块 id；start=点击当下非锚点计划时刻）。
// ⚠️红线（checkpoint □5）：拖拽落点只有「池（换池调档）」与「时间线（建锚点+出发）」两类——
// 中央不想做圈永不接 drop（不想做是承诺不是垃圾桶，转不想做走 AI 见证——syncAversions 面）。

import { isPoolSlug, type AmmoPoolSlug } from "@/kernel/core/ammoQuadrant";
import { isValidDay, minToHM, type SchedAddKeyOp } from "@/kernel/core/schedule";
import { snapToStep } from "./dayaxis";

/** 拖卡载荷 MIME（dataTransfer 探测+取值同一键；跨组件 HTML5 DnD 通道） */
export const AMMO_CARD_MIME = "application/x-pj-ammo-card";

/** 拖卡载荷（面板任务行的最小可寻址面——出发/挂池不需要更多） */
export interface AmmoCardData {
    /** 树任务块 id（空串=无主行） */
    task: string;
    name: string;
    pool: AmmoPoolSlug;
    quota: number | null;
}

/** 载荷编码（ondragstart 写入 MIME+text/plain 双份） */
export function encodeAmmoCard(card: AmmoCardData): string {
    return JSON.stringify(card);
}

/** 载荷解码（drop 侧）：坏 JSON/缺名/池白名单外/配额非正整数=null 不认（fail-soft 静默） */
export function decodeAmmoCard(raw: string | null | undefined): AmmoCardData | null {
    if (!raw) return null;
    let v: any;
    try {
        v = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!v || typeof v !== "object") return null;
    const name = typeof v.name === "string" ? v.name.replace(/\u200b/g, "").trim() : "";
    if (!name) return null; // 无名行不可落锚点（引擎 summary 非空校验同因）
    if (!isPoolSlug(v.pool)) return null;
    const quota = v.quota == null ? null : typeof v.quota === "number" && Number.isInteger(v.quota) && v.quota > 0 ? v.quota : null;
    return { task: typeof v.task === "string" ? v.task : "", name, pool: v.pool, quota };
}

/** dataTransfer.types 是否带拖卡载荷（dragover 守门——只认自定义 MIME：任意文本拖拽
 *  （选区/外部）不 preventDefault 不抢事件不亮落点态） */
export function hasAmmoCard(types: ArrayLike<string> | readonly string[] | null | undefined): boolean {
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
        if (types[i] === AMMO_CARD_MIME) return true;
    }
    return false;
}

/** dataTransfer 取卡（drop 侧）：MIME 优先、text/plain 镜像兜底（Chromium 自定义 MIME
 *  getData 稳定，镜像只防奇形宿主——两边都解不出=null） */
export function cardDataOf(dt: { getData: (type: string) => string } | null | undefined): AmmoCardData | null {
    if (!dt) return null;
    return decodeAmmoCard(dt.getData(AMMO_CARD_MIME)) ?? decodeAmmoCard(dt.getData("text/plain"));
}

/** 落点分钟（clientY→轴内分钟+15min 吸附；轴外/坏坐标（NaN clientY 的合成事件）=null 弃） */
export function dropMinuteOf(input: { clientY: number; axisTop: number; scrollTop: number; pxPerMin: number }): number | null {
    if (!(input.pxPerMin > 0) || !Number.isFinite(input.clientY)) return null;
    const pointerMin = (input.clientY - input.axisTop + input.scrollTop) / input.pxPerMin;
    if (pointerMin < 0 || pointerMin >= 24 * 60) return null;
    return snapToStep(pointerMin);
}

/** 建锚点 op（schedEdit add 稳定键版——重试幂等；同卡同刻重拖=软回退复用既有行） */
export function anchorAddOp(day: string, minute: number, card: AmmoCardData): SchedAddKeyOp {
    return {
        type: "add",
        day,
        key: `ammo-${day}-${card.task || card.name}-${minute}`,
        item: { summary: card.name, start: minToHM(minute), end: null, hard: false },
    };
}

/** 锚点块 id 回读（schedEdit 后 board 读面 key=块 id；start+summary 定位——引擎出发 task 指针） */
export function anchorBlockIdOf(items: Array<{ key: string; summary: string; start: string | null }>, minute: number, summary: string): string | null {
    const start = minToHM(minute);
    const hit = items.find((it) => it && it.key && it.start === start && (it.summary ?? "").trim() === summary.trim());
    return hit?.key ?? null;
}

/** 出发决策：落点日=今天才出发（非今日=只建锚点，□3 提醒链到点接力） */
export function shouldDepartOnDrop(viewDay: string, today: string): boolean {
    return isValidDay(viewDay) && viewDay === today;
}

/** 本窗 app id（owner 门牌——ws url 的 app 参数；AmmoPanelHost/schedNotify 同款语义的纯半边） */
export function wsAppId(wsUrl: string | null | undefined): string {
    try {
        return new URL(wsUrl ?? "").searchParams.get("app") ?? "";
    } catch {
        return "";
    }
}
