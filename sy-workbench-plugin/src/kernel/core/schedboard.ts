// timeblock 期 1：班表条目 ↔ 日记列表块 的纯函数映射层。
// 契约（09-18 收拢定案）+ dataview □2（契约 §8 修订 4）：锚点时刻入行文本（同款双写——
// custom-remind-at/end 属性照写：RemindInjector/日历/提醒三链白捡）；条目文本=`HH:mm 摘要`
// （锚点）/`HH:mm-HH:mm 摘要`（带迄）/纯 summary（托盘）；读面文本优先、属性兜底（老条目
// 零迁移）。hard/flash 留属性（契约 §3）。列表容器块挂 custom-role=sched-board 作识别锚
// （「## 班表」标题=纯装饰不挂属性）。
// key=块 id 双写主键：petal SchedStore 的 items key 即日记列表项块 id。
// 期 2 ①：attrs 确定性全键输出+remap/normalize——统一写链（前端 schedEdit/adopt/冻结）共用。
import { shiftDay } from "./behavior";
import { isValidDay, isValidHM, SCHEDULE_KEEP_DAYS } from "./schedule";
import { buildFlashAttr, normFlashMeta } from "./flashwave";
import type { SchedItem } from "./schedule";

/** 块文本归一（零宽空格剔不掉须显式替换——内核空块 content=\u200b） */
function stripZeroWidth(s: string | null | undefined): string {
    return (s ?? "").replace(/\u200b/g, "").trim();
}

/** 列表容器识别属性值（挂 custom-role） */
export const SCHED_BOARD_ROLE_VALUE = "sched-board";

/** 班表条目标记属性名（挂此属性的块=班表条目——期②读面/remind 链的分流旗标：
 *  remind 镜像链跳过班表块（sched 镜像管辖，双推修复）、月历 remind 源去重、notify 块真身优先） */
export const ATTR_SCHED_ORIGIN = "custom-sched-origin";

/** 日窗闸（期② P2-3）：prune 剪 petal 不剪块——读面按同则滤旧日块（today-(KEEP-1) 含内保留），
 *  否则 60 天前的日记班表块会把已剪条目复活进日历。adopt 豁免=pruneSchedule 同则（外部承诺不剪）。 */
export function boardItemInWindow(date: string, origin: string, today: string): boolean {
    if (origin === "adopt") return true;
    return date >= shiftDay(today, -(SCHEDULE_KEEP_DAYS - 1));
}

/** 条目→列表项文本（□2 锚点时刻入文本）：`09:30 摘要`（锚点）/`09:30-11:00 摘要`（带迄）/
 *  纯 summary（托盘）。空白压成单行空格——多行 summary 走 insertBlock/updateBlock 会炸成
 *  多块（多块 data 只落首块坑在案，review P2-2）。
 *  已知限制：行内 markdown（**加粗** 等）落 li 后 content 被内核剥标记，比对恒失配=每轮重写
 *  （summary 罕见行内标记，接受；真需要再上转义层）。 */
export function schedItemText(item: SchedItem): string {
    const summary = item.summary.replace(/\s+/g, " ").trim();
    const time = item.start ? `${item.start}${item.end ? `-${item.end}` : ""}` : "";
    return time && summary ? `${time} ${summary}` : time || summary;
}

/** 行文本时刻头解析产物（end=null=单锚点形；summary 剥时刻头后的纯摘要） */
export interface SchedTextParse {
    start: string;
    end: string | null;
    summary: string;
}

/** 列表项文本→锚点时刻+纯摘要（读面文本优先的纯半边）：`09:30 摘要`/`09:30-11:00 摘要`/
 *  `09:30- 摘要`（容忍）/裸 `09:30`（空摘要锚点）。非时刻头（托盘纯 summary/老条目文本/
 *  用户散文）→null（属性兜底或托盘化）。严格 HH:mm+时刻后须空格或行尾（`09:30摘要`不认
 *  ——宁可少认，坏形进 □8 收集）。 */
const SCHED_TEXT_RE = /^((?:[01]\d|2[0-3]):[0-5]\d)(?:-((?:[01]\d|2[0-3]):[0-5]\d)|-)?(?:\s+(.*))?$/;
export function parseSchedItemText(content: string | null | undefined): SchedTextParse | null {
    const t = stripZeroWidth(content);
    if (!t) return null;
    const m = SCHED_TEXT_RE.exec(t);
    if (!m) return null;
    return { start: m[1], end: m[2] ?? null, summary: (m[3] ?? "").trim() };
}

/** 时刻形嗅探（□8 收集半边）：看着像时刻头但严格解析不认的行（`9:30 站会` 单位数时/
 *  全角冒号）——fail-soft 忽略（读面按托盘/属性兜底）+体检可见。 */
const TIME_SNIFF_RE = /^\d{1,2}[:：]\d/;

/** 班表行批读入参（编排层 IO 收集——读链/□8 体检共用） */
export interface BoardLineInput {
    content: string | null;
    attrs?: Record<string, string> | null;
}

/** 未认班表行收集（读链与 □8 体检的同一判官）：文本非时刻头+属性无时刻+形似时刻=未认。 */
export function collectUnrecognizedBoardLines(lines: BoardLineInput[]): string[] {
    const out: string[] = [];
    for (const l of lines) {
        const t = stripZeroWidth(l.content);
        if (!t) continue;
        if (parseSchedItemText(t)) continue;
        if (attrsToSchedStart(l.attrs)) continue;
        if (TIME_SNIFF_RE.test(t)) out.push(t);
    }
    return out;
}

/** 条目→块属性：remind-at/end（进日历+提醒+块面渲染三链白捡）+ sched-* 机器态。
 *  确定性全键输出（期 2 ①）：缺省键=空串——setBlockAttrs 是合并写，条目去掉时间/番茄布局时
 *  须显式空串删键（writeback 生产同款语义），否则旧属性残留=块继续进日历（期 1 潜伏 bug）。 */
export function schedItemToAttrs(item: SchedItem): Record<string, string> {
    return {
        "custom-remind-at": item.start ? `${item.date}T${item.start}` : "",
        "custom-remind-end": item.end ? `${item.date}T${item.end}` : "",
        "custom-sched-hard": item.hard ? "1" : "0",
        [ATTR_SCHED_ORIGIN]: item.origin,
        "custom-sched-rolled-from": item.rolledFrom ?? "",
        "custom-sched-allday": item.allDay ? "1" : "",
        "custom-sched-flash": item.flash ? buildFlashAttr(item.flash) : "",
    };
}

/** keyRemap 迁移（统一写链三端共用：routineTools/晨滚/前端 schedEdit/adopt）：旧 key→块 id，
 *  items 键与 item.key 同步换；无命中=原引用返回（零拷贝）。
 *  前提（review P2-5）：drags/recon 记录里的旧键不随迁——消费面全是 day 维度清理+summary/时间
 *  展示字段、无按 key 回联，勿在下游加按 DragRecord.key 联查。 */
export function remapSchedItems(items: Record<string, SchedItem>, remap: ReadonlyMap<string, string>): Record<string, SchedItem> {
    let out = items;
    for (const [oldKey, blockId] of remap) {
        const it = out[oldKey];
        if (!it || oldKey === blockId) continue;
        if (out === items) out = { ...items };
        delete out[oldKey];
        out[blockId] = { ...it, key: blockId };
    }
    return out;
}

/** sched-board-sync rpc 入参归一（前端脏数据防线）：每条须有非空 key/summary+合法 date；
 *  start/end 非 HH:mm→null（坏值不进日历链）；origin 白名单外→user。历史块 attrs 里的
 *  custom-sched-pomos 读面零消费（退役不清洗，宽容忽略）。 */
export function normalizeBoardItems(raw: unknown): SchedItem[] {
    if (!Array.isArray(raw)) return [];
    const out: SchedItem[] = [];
    for (const r of raw) {
        if (!r || typeof r !== "object") continue;
        const key = typeof r.key === "string" ? r.key : "";
        const summary = typeof r.summary === "string" ? r.summary.trim().slice(0, 100) : "";
        const date = typeof r.date === "string" && isValidDay(r.date) ? r.date : "";
        // 空 summary 存活（期 2 ⑤ 右键创建空条目=草稿态；镜像面草稿闸另守）
        if (!key || !date) continue;
        const flash = normFlashMeta(r.flash);
        out.push({
            key,
            summary,
            date,
            start: isValidHM(r.start) ? r.start : null,
            end: isValidHM(r.end) ? r.end : null,
            hard: r.hard === true,
            origin: r.origin === "ai" || r.origin === "roll" || r.origin === "report" || r.origin === "adopt" ? r.origin : "user",
            ...(r.origin === "roll" && typeof r.rolledFrom === "string" ? { rolledFrom: r.rolledFrom } : {}),
            ...(r.allDay === true ? { allDay: true } : {}),
            ...(flash ? { flash } : {}),
            createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
            updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
        });
    }
    return out;
}

/** 块属性→HH:mm（custom-remind-at 的 T 后半）；无/坏值=null（托盘或脏行，宽容不炸） */
export function attrsToSchedStart(attrs: Record<string, string> | null | undefined): string | null {
    const v = attrs?.["custom-remind-at"];
    if (typeof v !== "string") return null;
    const hm = v.split("T")[1] ?? "";
    return /^\d{2}:\d{2}$/.test(hm) ? hm : null;
}

/** 块属性→迄点 HH:mm（custom-remind-end 的 T 后半；schedBoardReadRpc 内联读面同款口径——
 *  dataview □8 起抽导出，读链/体检比对共用单一事实源）；无/坏值=null */
export function attrsToSchedEnd(attrs: Record<string, string> | null | undefined): string | null {
    const v = attrs?.["custom-remind-end"];
    if (typeof v !== "string") return null;
    const hm = v.split("T")[1] ?? "";
    return /^\d{2}:\d{2}$/.test(hm) ? hm : null;
}

/** 容器识别：attrs.custom-role === sched-board */
export function isSchedBoardAttrs(attrs: Record<string, string> | null | undefined): boolean {
    return attrs?.["custom-role"] === SCHED_BOARD_ROLE_VALUE;
}

/** clear_from 块侧重放分区（与 petal 侧 clearDayFromItems 同语义）：start≥刀线清（等值含在清）、
 *  已过保留=对账证据、托盘（start=null）不动。
 *  注（review P2-4）：schedule_set 已改整日重放，生产面暂无调用——期 2 读面切块时若需
 *  「只清不整替」语义可复用；届时无消费再删。 */
export function partitionForClear(rows: Array<{ id: string; start: string | null }>, cf: string): { toDelete: string[]; toKeep: string[] } {
    const toDelete: string[] = [];
    const toKeep: string[] = [];
    for (const r of rows) {
        if (r.start !== null && r.start >= cf) toDelete.push(r.id);
        else toKeep.push(r.id);
    }
    return { toDelete, toKeep };
}

/** insertBlock 响应 HTML→NodeListItem id（6808 探针实测：node-id 在 data-type 前）；
 *  无 NodeListItem（非列表响应/形态漂移）→null。容器( NodeList )与 li 都在 HTML 里，只抓 li。 */
export function parseListItemId(html: string): string | null {
    const m = /data-node-id="([^"]+)"[^>]*data-type="NodeListItem"/.exec(html);
    return m ? m[1] : null;
}

/** 中序插入锚：新条目 previousID=最后一个 start≤新 start 的既有块（时间序保持，托盘沉底）。
 *  null=无锚（早于全部/空容器）——编排层走 nextID=容器内首 li 路径（nextID=li 并容器，探针 d 实测）。 */
export function insertAnchorAfter(newStart: string | null, existing: Array<{ id: string; start: string | null }>): string | null {
    let anchor: string | null = null;
    for (const e of existing) {
        if (e.start === null) break; // 托盘沉底：遇首个托盘即停（新条目无论定时与否都插托盘前？——托盘锚=null 语义见测试）
        if (newStart !== null && e.start <= newStart) anchor = e.id;
        else break;
    }
    if (newStart === null) {
        // 托盘新条目沉底：锚=最后一个既有块（含托盘区）
        return existing.length ? existing[existing.length - 1].id : null;
    }
    return anchor;
}
