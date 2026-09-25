// ammo □8：格式体检汇总纯函数层（fail-soft 的可见面——契约 §2「不认的行/条目忽略+体检提示，
// 永不报错、永不拦人」）。三类来源→清单（只做汇总呈现，判官全复用 □1/□2 既有解析器——
// 不新造校验）：
//  ① sections 分区结构异常：不想做文档非恰好三段 H2（□1 resolveAversionAnchors 的 healthNote）；
//  ② unrecognized 未认行：配置/日账/班表行文本+属性双通道都不认（□2 parseConfigRows/
//     parseLedgerEntries/collectUnrecognizedBoardLines 同一判官逐行调用）；
//  ③ conflict 文本与属性冲突：同一行两通道都认且值不同（契约 §2 文本赢——属性是机器缓存，
//     不一致=手改文本后缓存过期/半边写入；读面照常按文本走，体检只出示不拦截）。
// 零 siyuan/网络/DOM 依赖（channels 纪律：kernel bundle 与前端 bundle 共用同一份源）。

import { POOL_LABEL, isPoolSlug, normCount, parseConfigRows, parsePoolRowText, parseTaskRowText, type AmmoPoolSlug } from "./ammoQuadrant";
import { attrsToLedgerEntry, parseLedgerEntries, parseLedgerText } from "./ammoLedger";
import { attrsToSchedEnd, attrsToSchedStart, collectUnrecognizedBoardLines, parseSchedItemText } from "./schedboard";

/** 体检发现三分类（分类序=呈现序：结构问题影响面最大排最先） */
export type AmmoHealthCategory = "sections" | "unrecognized" | "conflict";

/** 发现所属域（面板域标签+定位语义用） */
export type AmmoHealthDomain = "aversion" | "config" | "ledger" | "board";

export interface AmmoHealthItem {
    category: AmmoHealthCategory;
    domain: AmmoHealthDomain;
    /** 行原文（未认/冲突）；sections=分区提示全文 */
    text: string;
    /** 冲突差异摘要（`文本 09:30 / 属性 10:00` 形）；其余分类缺省 */
    detail?: string;
    /** 跳转目标块/文档 id（null=无可跳目标——面板出纯文本行） */
    blockId: string | null;
}

/** 体检行入参（编排层 IO 收集——三域共用：行块 id+文本+属性随行；id=体检跳转定位用） */
export interface HealthLineInput {
    id: string;
    content: string | null;
    attrs?: Record<string, string> | null;
}

/** 块文本归一（零宽空格剔不掉须显式替换——内核空块 content=\u200b） */
function stripZeroWidth(s: string | null | undefined): string {
    return (s ?? "").replace(/\u200b/g, "").trim();
}

/** 配置域体检：未认（parseConfigRows 同判官）+冲突（文本/属性两通道逐字段比对——
 *  池 slug/ratio（池行）、任务指针/quota（任务行）；freq 无文本形态无冲突面。
 *  比对口径=两通道各有主张且值不同（属性空串/坏值=无主张；引擎双写在同步态零出项）。 */
export function configHealthLines(lines: readonly HealthLineInput[]): AmmoHealthItem[] {
    const out: AmmoHealthItem[] = [];
    for (const l of lines) {
        const read = parseConfigRows([l]); // 同一判官（读链/体检共用）
        if (read.unrecognized.length) {
            out.push({ category: "unrecognized", domain: "config", text: read.unrecognized[0], blockId: l.id });
            continue;
        }
        if (!read.pools.length && !read.tasks.length) continue; // 空行静默跳过
        const t = stripZeroWidth(l.content);
        const poolText = parsePoolRowText(t);
        if (poolText) {
            const diffs: string[] = [];
            const attrsPoolRaw = l.attrs?.["custom-ammo-pool"];
            if (isPoolSlug(attrsPoolRaw) && attrsPoolRaw !== poolText.pool) {
                diffs.push(`文本 ${POOL_LABEL[poolText.pool]} / 属性 ${POOL_LABEL[attrsPoolRaw as AmmoPoolSlug]}`);
            }
            const attrRatio = normCount(l.attrs?.["custom-ammo-ratio"]);
            if (attrRatio != null && poolText.ratio != null && attrRatio !== poolText.ratio) {
                diffs.push(`文本 ${poolText.ratio}min / 属性 ${attrRatio}min`);
            }
            if (diffs.length) out.push({ category: "conflict", domain: "config", text: t, detail: diffs.join("；"), blockId: l.id });
            continue;
        }
        const taskText = parseTaskRowText(t);
        if (!taskText) continue; // 属性兜底认出（老条目纯文本）——文本无主张零冲突
        const diffs: string[] = [];
        const attrTask = (l.attrs?.["custom-ammo-task"] ?? "").trim();
        if (attrTask && attrTask !== taskText.task) diffs.push(`文本 ((${taskText.task})) / 属性 ${attrTask}`);
        const attrQuota = normCount(l.attrs?.["custom-ammo-quota"]);
        if (attrQuota != null && taskText.quota != null && attrQuota !== taskText.quota) {
            diffs.push(`文本 ${taskText.quota}min / 属性 ${attrQuota}min`);
        }
        if (diffs.length) out.push({ category: "conflict", domain: "config", text: t, detail: diffs.join("；"), blockId: l.id });
    }
    return out;
}

/** 日账域体检：未认（parseLedgerEntries 同判官）+冲突（时刻头文本 vs custom-ammo-start/end；
 *  属性通道单读=attrsToLedgerEntry(content=null)——无合法 start 属性=无主张零冲突（手写条目）。 */
export function ledgerHealthLines(lines: readonly HealthLineInput[]): AmmoHealthItem[] {
    const out: AmmoHealthItem[] = [];
    for (const l of lines) {
        const read = parseLedgerEntries([l]); // 同一判官（读链/体检共用）
        if (!read.entries.length) {
            if (read.unrecognized.length) out.push({ category: "unrecognized", domain: "ledger", text: read.unrecognized[0], blockId: l.id });
            continue;
        }
        const text = parseLedgerText(l.content);
        if (!text) continue; // 属性兜底认出（老条目纯 summary）——文本无时刻主张零冲突
        const byAttrs = attrsToLedgerEntry(l.id, null, l.attrs);
        if (!byAttrs) continue; // 属性无主张（手写条目无属性）零冲突
        const diffs: string[] = [];
        if (byAttrs.start !== text.start) diffs.push(`文本 ${text.start} / 属性 ${byAttrs.start}`);
        if ((byAttrs.end ?? null) !== (text.end ?? null)) diffs.push(`文本 ${text.end ?? "进行中"} / 属性 ${byAttrs.end ?? "进行中"}`);
        if (diffs.length) out.push({ category: "conflict", domain: "ledger", text: stripZeroWidth(l.content), detail: diffs.join("；"), blockId: l.id });
    }
    return out;
}

/** 班表域体检：未认（collectUnrecognizedBoardLines 同判官——形似时刻头但双通道都不认）+
 *  冲突（时刻头文本 vs custom-remind-at/end；托盘行/属性兜底认出=文本无主张零冲突）。 */
export function boardHealthLines(lines: readonly HealthLineInput[]): AmmoHealthItem[] {
    const out: AmmoHealthItem[] = [];
    for (const l of lines) {
        const unrecognized = collectUnrecognizedBoardLines([{ content: l.content, attrs: l.attrs }]);
        if (unrecognized.length) {
            out.push({ category: "unrecognized", domain: "board", text: unrecognized[0], blockId: l.id });
            continue;
        }
        const parsed = parseSchedItemText(l.content);
        if (!parsed) continue; // 托盘纯 summary/属性兜底——文本无时刻主张零冲突
        const diffs: string[] = [];
        const attrStart = attrsToSchedStart(l.attrs);
        if (attrStart && attrStart !== parsed.start) diffs.push(`文本 ${parsed.start} / 属性 ${attrStart}`);
        const attrEnd = attrsToSchedEnd(l.attrs);
        if (attrEnd && attrEnd !== (parsed.end ?? null)) diffs.push(`文本 ${parsed.end ?? "单点"} / 属性 ${attrEnd}`);
        if (diffs.length) out.push({ category: "conflict", domain: "board", text: stripZeroWidth(l.content), detail: diffs.join("；"), blockId: l.id });
    }
    return out;
}

/** 分区结构体检项（□1 healthNote 非空=非恰好三段 H2 已转属性兜底；docId=不想做文档跳转目标） */
export function aversionHealthItem(input: { healthNote?: string | null; docId?: string | null }): AmmoHealthItem | null {
    if (!input.healthNote) return null;
    return { category: "sections", domain: "aversion", text: input.healthNote, blockId: input.docId ?? null };
}

export interface AmmoHealthInput {
    /** 每日配置容器行（null/缺省=容器不在——不算异常） */
    config?: readonly HealthLineInput[] | null;
    /** 日账容器行 */
    ledger?: readonly HealthLineInput[] | null;
    /** 班表容器行 */
    board?: readonly HealthLineInput[] | null;
    /** 不想做域（healthNote=□1 分区体检提示；docId=跳转目标） */
    aversions?: { healthNote?: string | null; docId?: string | null } | null;
}

/** 三类来源→体检清单（①分区②未认③冲突——分类序即呈现序，域内保容器行序）。 */
export function buildAmmoHealth(input: AmmoHealthInput): AmmoHealthItem[] {
    const items: AmmoHealthItem[] = [];
    const sections = aversionHealthItem(input.aversions ?? {});
    if (sections) items.push(sections);
    const domainItems: AmmoHealthItem[] = [
        ...configHealthLines(input.config ?? []),
        ...ledgerHealthLines(input.ledger ?? []),
        ...boardHealthLines(input.board ?? []),
    ];
    items.push(...domainItems.filter((x) => x.category === "unrecognized"));
    items.push(...domainItems.filter((x) => x.category === "conflict"));
    return items;
}
