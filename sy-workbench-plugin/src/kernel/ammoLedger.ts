// ammo □2：日账写入编排层（kernel 侧）——「打点落盘」的写入半边。
// 契约=docs/ammo-concept.md B2（日账域）：开始=日账末尾追加未闭合条目 / 停止=补
// custom-ammo-end 单点闭合 / 感想=append 子块挂条目下；append-only 不改写历史。
// dataview □2（契约 §8 修订 3）：行文本升为真相+引擎双写——开始落 `HH:mm- 摘要`（进行中）；
// 停止重写行文本为 `HH:mm-HH:mm 摘要`（闭合）+全键属性补挂（updateBlock 重写不迁移 custom-*
// ——纯内容+setBlockAttrs 两步纪律）。重写目标=li 的文本子块（stopLedgerEntryInner 头注释
// ——li 本体两条路实测皆死：搬走唯一子块=内核回收 li；直接 update=感想内容被毁）。
// B3 日账月账化（契约 §8 修订 6）：日账 30 篇/月→12 篇/年——写链全改月文档
// （/主线数据/日记/YYYY-MM 一篇，schedboard ensureMonthDiaryDoc 定位——每日配置月文档先例
// 同款三层链），月内分日=日组容器（custom-role=ammo-ledger + custom-ammo-day=YYYY-MM-DD
// 双键定位+`## YYYY-MM-DD` 标题，findConfigContainer 同族方案）；读面 fail-soft 兼容读
// 老每日文档（YYYY-MM-DD 形态——文本即真相，老数据零迁移仍可读：月日组行+老容器行合并，
// 老账在前新账在后=时间序）。班表区（sched-board）不迁——B3 范围=日账域。
// 串行链=boardWriteChain 同款模块级单飞链。
// 错误兜底对齐 schedboard：任何失败返回 {ok:false,error} 不 throw（调用方接管 UI 提示）。
import {
    deleteBlock,
    getBlockAttrs,
    getBlockKramdown,
    getChildBlocks,
    insertBlockMarkdown,
    insertListItem,
    setBlockAttrs,
    updateBlockMarkdown,
} from "./api";
import { ensureMonthDiaryDoc, locateDayDoc, locateMonthDiaryDoc } from "./schedboard";
import {
    AMMO_LEDGER_ROLE_VALUE,
    ammoStartAttrs,
    attrsToLedgerEntry,
    isAmmoLedgerAttrs,
    ledgerEntryText,
    ledgerTextFromKramdown,
    parseLedgerEntries,
} from "./core/ammoLedger";
import type { AmmoLedgerEntry } from "./core/ammoLedger";
import type { HealthLineInput } from "./core/ammoHealth";
import { isValidDay, isValidHM } from "./core/schedule";

export interface LedgerWriteResult {
    ok: boolean;
    /** 新条目/感想块 id（ok=true 时在） */
    blockId?: string;
    /** 日记文档 id（ok=true 时在） */
    docId?: string;
    error?: string;
}

/** 顶层找日账容器——老每日文档形态（IAL 直读判 custom-role，不判日键——老容器本就不挂
 *  custom-ammo-day；B3 兼容读专用，写链已改月文档日组）。顺带找既有「## 日账」标题块做查重。 */
async function findLedger(docId: string): Promise<{ ledgerId: string | null; hasTitle: boolean }> {
    const tops = await getChildBlocks(docId);
    let ledgerId: string | null = null;
    let hasTitle = false;
    for (const b of tops) {
        if (isAmmoLedgerAttrs(await getBlockAttrs(b.id))) ledgerId = b.id;
        if (b.type === "h" && (b.content ?? "").trim() === "日账") hasTitle = true;
    }
    return { ledgerId, hasTitle };
}

/** 月文档顶层找该日日组容器（B3——findConfigContainer 同族方案：custom-role=ammo-ledger
 *  +custom-ammo-day===day 双键定位，月内多日组共存逐组扫属性，末个匹配赢；顺带查「## day」
 *  标题做查重——日组标题=日期（老每日文档的「## 日账」装饰标题退役，月文档里标题即分日锚）。 */
async function findLedgerForDay(docId: string, day: string): Promise<{ ledgerId: string | null; hasTitle: boolean }> {
    const tops = await getChildBlocks(docId);
    let ledgerId: string | null = null;
    let hasTitle = false;
    for (const b of tops) {
        const attrs = await getBlockAttrs(b.id);
        if (attrs?.["custom-role"] === AMMO_LEDGER_ROLE_VALUE && attrs?.["custom-ammo-day"] === day) ledgerId = b.id;
        if (b.type === "h" && (b.content ?? "").trim() === day) hasTitle = true;
    }
    return { ledgerId, hasTitle };
}

/** 首建日组容器（首条插入建壳+挂 role+day 双键）；标题缺失才补（nextID=容器，恒在容器前）
 *  ——ensureBoard/writeDayConfigInner 同款。容器插月文档**尾**（多日组时间序 append 姿态
 *  ——writeDayConfigInner 同款；老每日文档的文档顶 nextID 形态随 B3 退役）。
 *  lineText=行文本全形（□2 起含时刻头 `HH:mm- 摘要`——编排层只管落盘不管拼）。 */
async function ensureLedger(
    docId: string,
    tops: Array<{ id: string }>,
    hasTitle: boolean,
    lineText: string,
    day: string,
): Promise<{ ledgerId: string; liId: string }> {
    const tail = tops.length ? { previousID: tops[tops.length - 1].id } : {};
    const r = await insertListItem(docId, `- ${lineText}`, tail);
    await setBlockAttrs(r.containerId, { "custom-role": AMMO_LEDGER_ROLE_VALUE, "custom-ammo-day": day });
    if (!hasTitle) await insertBlockMarkdown(docId, `## ${day}`, r.containerId);
    return { ledgerId: r.containerId, liId: r.liId };
}

export interface StartLedgerParams {
    /** 打点落账日（=开始日；跨零点条目留开始日不迁移——B2.4） */
    day: string;
    start: string;
    summary: string;
    pool?: string;
    task?: string;
    anchor?: boolean;
}

/** 开始打点：月文档该日日组末尾追加未闭合条目（B3 起写链全改月文档；行文本=`HH:mm- 摘要`
 *  进行中形态+custom-ammo-end 空串双写）。
 *  日组空（用户手删光条目）→删壳首建（空容器插 li 不并壳——schedboard 探针同族约束）。
 *  □3 导出=引擎链内直调版（互斥闭合归引擎——外部调用方一律走 public startLedgerEntry 或引擎面）。 */
export async function startLedgerEntryInner(p: StartLedgerParams): Promise<LedgerWriteResult> {
    const summary = p.summary.replace(/\s+/g, " ").trim(); // 多行压单行（insert 多块炸——schedItemText 同款）
    const lineText = ledgerEntryText(p.start, null, summary); // □2：时刻头入文本（进行中形）
    const monthDoc = await ensureMonthDiaryDoc(p.day);
    if ("error" in monthDoc) return { ok: false, error: monthDoc.error }; // strict:false 判别用 in（AGENTS 坑）
    const docId = monthDoc.docId;

    const tops = await getChildBlocks(docId);
    const { ledgerId, hasTitle } = await findLedgerForDay(docId, p.day);
    let liId: string;
    if (ledgerId) {
        const lis = await getChildBlocks(ledgerId);
        if (lis.length) {
            // 尾插：previousID=日组最后一个子块（新条目按时间序天然有序尾插——B2.7 append-only）
            const r = await insertListItem(docId, `- ${lineText}`, { previousID: lis[lis.length - 1].id });
            liId = r.liId;
        } else {
            await deleteBlock(ledgerId);
            const built = await ensureLedger(docId, tops.filter((t) => t.id !== ledgerId), hasTitle, lineText, p.day);
            liId = built.liId;
        }
    } else {
        const built = await ensureLedger(docId, tops, hasTitle, lineText, p.day);
        liId = built.liId;
    }
    await setBlockAttrs(liId, ammoStartAttrs(p));
    return { ok: true, blockId: liId, docId };
}

export function startLedgerEntry(p: StartLedgerParams): Promise<LedgerWriteResult> {
    if (!isValidDay(p?.day)) return Promise.resolve({ ok: false, error: "day 须为合法 YYYY-MM-DD" });
    if (!isValidHM(p?.start)) return Promise.resolve({ ok: false, error: "start 须为合法 HH:mm" });
    return ammoWriteChainRun(() => startLedgerEntryInner(p).catch(toLedgerErr));
}

export interface StopLedgerParams {
    blockId: string;
    end: string;
    /** 落账日（引擎链三调用方全传，保持接口面稳定）：搬移协议随 09-21 修复退役后
     *  闭合链不再消费（重写文本子块零搬移）——留字段防调用方对象字面量 excess 报错。 */
    day?: string;
}

/** 停止打点（□2 起=闭合入文本）：重写行文本为 `HH:mm-HH:mm 摘要` + 全键属性补挂
 *  （updateBlock 重写不迁移 custom-*——纯内容+setBlockAttrs 两步纪律；文本先落=读面
 *  文本优先，属性后补失败也不产生假进行中）。复核读=IAL+kramdown 双直读（文本形态
 *  优先认——手写「14:00-」条目无属性也可闭）。块不在/非打点条目/已闭合异值→拒
 *  （append-only 不改历史；同值幂等）。
 *  ⚠重写目标=li 的**文本子块**（思源 li 结构=li>[文本p, ...感想]），不是 li 本身——
 *  6808 实测（09-21 dataview 收官 e2e 归因，搬移协议两代皆死）：
 *  ① 搬走子块再 updateBlock(li)：文本子块是 li 唯一子块时 move 走=内核即刻回收 li
 *    （update/搬回全 block not found——条目永悬+文本行滞留文档顶层+读面丢条目）；
 *  ② 直接 updateBlock(li)：doUpdate 整节点替换把新文本写进首个子块并删其余（带感想
 *    =感想内容被毁，append-only 红线）。改写文本子块=纯 p 替换（无子树零毁伤），感想
 *    零触碰零搬移；块 id 两侧都保留（markdown 通道 update 同 id 换内容）。文本子块定位
 *    =子块内容与当前行文本等值→时刻头前缀→首子块兜底（手写变体条目）。
 *  □3 导出=引擎链内直调版。 */
export async function stopLedgerEntryInner(p: StopLedgerParams): Promise<LedgerWriteResult> {
    const attrs = await getBlockAttrs(p.blockId);
    if (!attrs) return { ok: false, error: "目标块不是打点条目（不存在或无 custom-ammo-start）" };
    let kram = "";
    try {
        kram = await getBlockKramdown(p.blockId);
    } catch {
        kram = ""; // kramdown 读失败=按空文本走属性兜底（不炸闭合主链）
    }
    const entry = attrsToLedgerEntry(p.blockId, ledgerTextFromKramdown(kram), attrs);
    if (!entry) return { ok: false, error: "目标块不是打点条目（文本非时刻行且无 custom-ammo-start）" };
    if (entry.closed) {
        if (entry.end === p.end) return { ok: true, blockId: p.blockId }; // 幂等：重复 stop 同值
        return { ok: false, error: `条目已闭合（end=${entry.end}）——append-only 纪律不改历史` };
    }
    const closedText = ledgerEntryText(entry.start, p.end, entry.summary);
    const children = await getChildBlocks(p.blockId);
    const curText = ledgerEntryText(entry.start, entry.end, entry.summary); // 未闭合形（end=null）
    const textChild = children.find((c) => normText(c.content) === curText)
        ?? children.find((c) => normText(c.content).startsWith(`${entry.start}-`))
        ?? children[0];
    await updateBlockMarkdown(textChild?.id ?? p.blockId, textChild ? closedText : `- ${closedText}`);
    await setBlockAttrs(p.blockId, {
        "custom-ammo-start": entry.start,
        "custom-ammo-end": p.end,
        "custom-ammo-pool": entry.pool,
        "custom-ammo-task": entry.task,
        "custom-ammo-anchor": entry.anchor ? "1" : "",
    });
    return { ok: true, blockId: p.blockId };
}

export function stopLedgerEntry(p: StopLedgerParams): Promise<LedgerWriteResult> {
    if (!isValidHM(p?.end)) return Promise.resolve({ ok: false, error: "end 须为合法 HH:mm" });
    return ammoWriteChainRun(() => stopLedgerEntryInner(p).catch(toLedgerErr));
}

export interface ReflectionParams {
    blockId: string;
    text: string;
}

/** 感想 append 到条目下（任意 Markdown 子块，append-only 不改写历史）。条目判同款双直读
 *  （□2：手写「14:00-」文本条目无属性也可挂感想）。多行文本=逐行链式插（previousID 接
 *  上一条响应 id——内核多块 data 只落首块坑在案）。 */
async function appendLedgerReflectionInner(p: ReflectionParams): Promise<LedgerWriteResult> {
    const attrs = await getBlockAttrs(p.blockId);
    if (!attrs) return { ok: false, error: "目标块不是打点条目（不存在或无 custom-ammo-start）" };
    let kram = "";
    try {
        kram = await getBlockKramdown(p.blockId);
    } catch {
        kram = "";
    }
    if (!attrsToLedgerEntry(p.blockId, ledgerTextFromKramdown(kram), attrs)) {
        return { ok: false, error: "目标块不是打点条目（文本非时刻行且无 custom-ammo-start）" };
    }
    const lines = p.text.split("\n").map((l) => l.trim()).filter(Boolean);
    let last: string | undefined;
    for (const line of lines) {
        last = await insertBlockMarkdown(p.blockId, line, undefined, last);
    }
    return { ok: true, blockId: last };
}

export function appendLedgerReflection(p: ReflectionParams): Promise<LedgerWriteResult> {
    if (!p?.text?.replace(/\u200b/g, "").trim()) return Promise.resolve({ ok: false, error: "text 不能为空" });
    return ammoWriteChainRun(() => appendLedgerReflectionInner(p).catch(toLedgerErr));
}

/** 任何 IO throw→{ok:false,error}（不 throw——schedboard 错误兜底同款，调用方接管 UI） */
function toLedgerErr(e: any): LedgerWriteResult {
    return { ok: false, error: String(e?.message ?? e) };
}

// ── 读链+恢复链（读通道零副作用：locateDayDoc 读版绝不建档——schedBoardReadRpc 同款） ──

export interface LedgerReadResult {
    ok: boolean;
    /** 日记文档 id（找到日账时在） */
    docId?: string;
    /** 日账容器块 id */
    boardId?: string;
    items: AmmoLedgerEntry[];
    /** 未认行原文（文本/属性双通道都不认的非空行——□8 体检素材；缺省=零未认） */
    unrecognized?: string[];
    error?: string;
}

/** 日账容器行批读（dataview □8：体检的 IO 收集半边——行块 id+文本+属性随行，判官在
 *  core/ammoHealth/parseLedgerEntries。零建档零副作用，readDayLedger 同一容器定位通道）。 */
export interface LedgerLinesResult {
    ok: boolean;
    docId?: string;
    ledgerId?: string;
    /** 容器行（容器不在=null——无打点不算异常） */
    lines?: HealthLineInput[] | null;
    error?: string;
}

/** 感想子块文本归一（零宽空格+trim——内核空块 content=\u200b） */
function normText(s: string | null | undefined): string {
    return (s ?? "").replace(/\u200b/g, "").trim();
}

/** 日账容器行批读（B3 兼容读：两形态都探——月文档该日日组〔新写链落点〕+老每日文档容器
 *  〔YYYY-MM-DD 形态，老数据零迁移仍可读〕，月文档优先探测；合并序=[老容器行, 月日组行]=
 *  时间序〔老账=升级前所打在前、新账在后——classifyUnclosedLedger 并列取数组位靠后=后开始，
 *  合并序保持该语义〕。docId/ledgerId 回填=月文档优先（rpc 面消费 items，二字段仅诊断用）。
 *  两形态都无容器→lines=null（无打点不算异常）。dataview □8：体检的 IO 收集半边——行块
 *  id+文本+属性随行，判官在 core/ammoHealth/parseLedgerEntries。零建档零副作用。 */
export async function readDayLedgerLines(day: string): Promise<LedgerLinesResult> {
    if (!isValidDay(day)) return { ok: false, lines: null, error: "day 须为合法 YYYY-MM-DD" };
    try {
        const monthLines: HealthLineInput[] = [];
        let docId: string | undefined;
        let ledgerId: string | undefined;
        const monthDoc = await locateMonthDiaryDoc(day);
        if (monthDoc) {
            const found = await findLedgerForDay(monthDoc, day);
            if (found.ledgerId) {
                for (const li of await getChildBlocks(found.ledgerId)) {
                    monthLines.push({ id: li.id, content: li.content, attrs: await getBlockAttrs(li.id) });
                }
                docId = monthDoc;
                ledgerId = found.ledgerId;
            }
        }
        const oldLines: HealthLineInput[] = [];
        const oldDoc = await locateDayDoc(day);
        if (oldDoc) {
            const found = await findLedger(oldDoc);
            if (found.ledgerId) {
                for (const li of await getChildBlocks(found.ledgerId)) {
                    oldLines.push({ id: li.id, content: li.content, attrs: await getBlockAttrs(li.id) });
                }
                docId ??= oldDoc;
                ledgerId ??= found.ledgerId;
            }
        }
        if (!monthLines.length && !oldLines.length) return { ok: true, ...(docId ? { docId } : {}), lines: null };
        return { ok: true, ...(docId ? { docId } : {}), ...(ledgerId ? { ledgerId } : {}), lines: [...oldLines, ...monthLines] };
    } catch (e: any) {
        return { ok: false, lines: null, error: String(e?.message ?? e) };
    }
}

/** 读一日日账（B3 兼容读：月文档日组+老每日文档容器合并——readDayLedgerLines 两形态探测）：
 *  行文本（真相）+属性（兜底）→结构化条目（供 UI 渲染与 AI 消费；当日=day 传
 *  今天，按日查询=day 传任意日——两形态同函数）。容器内非打点 li（文本非时刻行且无合法
 *  custom-ammo-start）跳过+进 unrecognized（□8 体检素材）。读不走串行链（零副作用无交错面）。
 *  走查复用 readDayLedgerLines（单容器单走查——体检与读链同源）。 */
export async function readDayLedger(day: string): Promise<LedgerReadResult> {
    const walk = await readDayLedgerLines(day);
    if (!walk.ok) return { ok: false, items: [], error: walk.error };
    if (!walk.lines) return { ok: true, ...(walk.docId ? { docId: walk.docId } : {}), items: [] };
    try {
        const parsed = parseLedgerEntries(walk.lines);
        for (const entry of parsed.entries) {
            const refl = await getChildBlocks(entry.id); // 感想=条目子块（append-only，容器序）
            entry.reflections = refl.map((r) => ({ id: r.id, text: normText(r.content) }));
        }
        return {
            ok: true,
            docId: walk.docId,
            boardId: walk.ledgerId,
            items: parsed.entries,
            ...(parsed.unrecognized.length ? { unrecognized: parsed.unrecognized } : {}),
        };
    } catch (e: any) {
        return { ok: false, items: [], error: String(e?.message ?? e) };
    }
}

/** 恢复链：识别未闭合条目（悬着的=事故现场——B2.5 崩溃恢复依据，返回给上层提示补结；
 *  闭合的不在列表）。启动读当日+近日=调用方按日循环本函数（□3 恢复协议）。 */
export async function findUnclosedLedgerEntries(day: string): Promise<LedgerReadResult> {
    const r = await readDayLedger(day);
    if (!r.ok) return r;
    return { ...r, items: r.items.filter((i) => !i.closed) };
}

/** 按日窗读多日日账（□7 月历实况回填数据源）：顺序循环单日读（goja 单线程天然串行——
 *  块树直读非 SQL，无索引竞态面；无日账的天 locateDayDoc 短路=零成本）。单日失败不炸
 *  整窗（该日 items 空+error 带日）。 */
export async function readLedgerDays(days: string[]): Promise<Array<{ day: string; ok: boolean; items: AmmoLedgerEntry[]; error?: string }>> {
    const out: Array<{ day: string; ok: boolean; items: AmmoLedgerEntry[]; error?: string }> = [];
    for (const day of days) {
        const r = await readDayLedger(day);
        out.push({ day, ok: r.ok, items: r.items, ...(r.ok ? {} : { error: r.error }) });
    }
    return out;
}

/** 日账写串行链（boardWriteChain 同款）：全部日账写经此单飞链严格串行——重叠写排队，
 *  防并发交错（start 与 stop 竞态=stop 复核读读不到 start 刚挂的条目）；失败吞 reject 不堵队列。 */
let ammoWriteChain: Promise<unknown> = Promise.resolve();
function ammoWriteChainRun<T>(task: () => Promise<T>): Promise<T> {
    const run = ammoWriteChain.then(task, task);
    ammoWriteChain = run.then(() => undefined, () => undefined);
    return run;
}

/** □3 引擎共用：把一段复合写（读+闭+开）作为一个单位进串行链（schedboard 复合写同款先例）。
 *  ⚠️链内只能调 *Inner 直调版（调 public 版=链内再排队→死锁）。 */
export function runLedgerUnit<T>(task: () => Promise<T>): Promise<T> {
    return ammoWriteChainRun(task);
}
