// timeblock 期 3：闪卡波次纯逻辑层（core/flashwave.ts）。
// 拍板（09-19 bear）：分波=纯均分（块粒度、块不跨波——同块多卡天然同波）；写入者=schedule_set
// 内消化（排班时刻=波次时刻一步对齐）；刷卡界面=官方复习界面（due 规整即生效，零 UI 开发）。
// 零 siyuan/网络依赖（与 core 族同纪律）；副作用在 kernel/flashwave.ts 编排层。
/** 侦察池的块粒度（同块多卡聚一行；顺序=文档聚簇序，分波保持聚簇=刷卡上下文连续） */
export interface FlashPoolBlock {
    id: string;
    cards: number;
}

/** 分波方案：quota=AI 输入意向回显，cards=实分卡数（加权均摊池量，超额/欠额自适应） */
export interface FlashWavePlan {
    wave: number;
    quota: number;
    cards: number;
    blocks: string[];
}

/** 波次条目属性（custom-sched-flash 载荷）：微调联动（改时刻重规整）与对账（完成度）的依据。
 *  due=本波规整时刻 14 位、at=排班动作时刻 14 位——两者合成重规整保护线：
 *  due 被推过 due 线（被番茄推迟）或 lastReview 晚于 at 线（排班后已刷卡——FSRS 新卡首刷
 *  间隔分钟级、due 仍可能≤波次时刻，只看 due 盖不住「先斩后奏」）的卡不覆盖 FSRS 调度。 */
export interface FlashWaveMeta {
    wave: number;
    cards: number;
    blocks: string[];
    due?: string;
    at?: string;
}

/** 加权均摊分波：每波目标=round(池量 × quota_i / Σquota)（quota 全等=纯均分）；
 *  顺序装块到 ≥目标 切波（块不跨波），最后一波吸收剩余，池耗尽后=0 张波（调用方不落空波条目）。
 *  非正 quota 按 1 兜底（0/负数=「随便多少」，不炸不丢波）。 */
export function splitFlashWaves(poolBlocks: FlashPoolBlock[], quotasRaw: number[]): FlashWavePlan[] {
    const quotas = quotasRaw.map((q) => (Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1));
    const totalCards = poolBlocks.reduce((s, b) => s + b.cards, 0);
    const totalQuota = quotas.reduce((s, q) => s + q, 0);
    const plans: FlashWavePlan[] = [];
    let idx = 0;
    for (let i = 0; i < quotas.length; i++) {
        const target = Math.round((totalCards * quotas[i]) / totalQuota);
        const blocks: string[] = [];
        let acc = 0;
        while (idx < poolBlocks.length && acc < target) {
            blocks.push(poolBlocks[idx].id);
            acc += poolBlocks[idx].cards;
            idx++;
        }
        if (i === quotas.length - 1) {
            while (idx < poolBlocks.length) {
                blocks.push(poolBlocks[idx].id);
                acc += poolBlocks[idx].cards;
                idx++;
            }
        }
        plans.push({ wave: i + 1, quota: quotasRaw[i] ?? 0, cards: acc, blocks });
    }
    return plans;
}

export function buildFlashAttr(meta: FlashWaveMeta): string {
    return JSON.stringify({ wave: meta.wave, cards: meta.cards, blocks: meta.blocks, ...(meta.due ? { due: meta.due } : {}), ...(meta.at ? { at: meta.at } : {}) });
}

/** 坏档宽容：null/坏 JSON/缺字段/类型不对→null（勿在对账面误报） */
export function parseFlashAttr(v: string | null | undefined): FlashWaveMeta | null {
    if (!v) return null;
    let raw: any;
    try {
        raw = JSON.parse(v);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const wave = raw.wave;
    const cards = raw.cards;
    const blocks = raw.blocks;
    if (!Number.isInteger(wave) || wave < 1) return null;
    if (!Number.isInteger(cards) || cards < 0) return null;
    if (!Array.isArray(blocks) || blocks.some((b: any) => typeof b !== "string" || !b)) return null;
    const due = typeof raw.due === "string" && /^\d{14}$/.test(raw.due) ? raw.due : undefined;
    const at = typeof raw.at === "string" && /^\d{14}$/.test(raw.at) ? raw.at : undefined;
    return { wave, cards, blocks, ...(due ? { due } : {}), ...(at ? { at } : {}) };
}

export function flashWaveSummary(base: string, wave: number, cards: number): string {
    let name = (base ?? "").trim();
    // 防叠罗汉（主实例实锤）：AI 把旧波全文「闪卡·第 1 波 14 张」当 summary 传入 base →
    // 直接拼=两层波尾。先剥净旧波尾（循环剥——输入本身已叠两层也剥到底）再拼本波。
    for (let i = 0; i < 10; i++) {
        const next = name.replace(/·\s*第\s*\d+\s*波\s*\d+\s*张\s*$/, "").trim();
        if (next === name) break;
        name = next;
    }
    if (!name) name = "闪卡";
    return `${name}·第 ${wave} 波 ${cards} 张`;
}

/** plan_context flashcards.note 的官方上限提示句（方案 A：池=全空间，点开官方复习受
 *  Conf.Flashcard 每日新卡/复习上限截断——池量≠实际可刷量，AI 定波数配额须知情）。
 *  limits=null（getConf 读不到：3.8.3 前无该字段/请求失败）→无实数固定句兜底。 */
export function flashLimitHint(limits: { newCardLimit: number; reviewCardLimit: number } | null): string {
    if (limits && Number.isFinite(limits.newCardLimit) && Number.isFinite(limits.reviewCardLimit)) {
        return `官方每日新卡/复习上限 ${limits.newCardLimit}/${limits.reviewCardLimit} 可能截断点开复习的队列`;
    }
    return "官方每日新卡/复习上限（设置→闪卡）可能截断点开复习的队列";
}

/** 波次 due 14 位绝对时刻（date+HH:mm → YYYYMMDDHHmm00；秒补 00——batchSetRiffCardsDueTime 同形态）。
 *  坏入参→空串（调用方拒条目，勿拼出半形态时刻）。 */
export function flashDueTimestamp(date: string, hm: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(hm)) return "";
    return `${date.replaceAll("-", "")}${hm.replace(":", "")}00`;
}

/** schedule_set 输入载荷校验：flash:{quota:正整数} */
export function normFlashInput(x: any): { quota: number } | null {
    if (!x || typeof x !== "object" || Array.isArray(x)) return null;
    const q = x.quota;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1) return null;
    return { quota: q };
}

/** RFC3339 → 14 位紧凑（仅取本地字面时刻，不做时区换算——内核 due 恒带本地 offset，
 *  与规整时刻同钟面直接可比）；坏值→null */
export function rfc3339ToCompact(v: string): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(v ?? "");
    return m ? `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}` : null;
}

/** 番茄推迟标记判定：块属性 custom-card-priority-stop 值（番茄 dateFormat 写的
 *  "YYYY-MM-DD HH:mm:ss" 本地形态）非空且在未来=推迟中。空/坏形态/已过期=false 不挡
 *  波次（过期值是番茄恢复链路的自愈面，坏形态不能静默吞块）。正则收紧值域防越界数字
 *  被 Date 进位成未来时刻误判；多参 Date 构造不依赖 goja 的字符串解析实现差异。 */
export function isPostponedByTomato(v: string | null | undefined, now = Date.now()): boolean {
    if (!v) return false;
    const m = /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(v);
    if (!m) return false;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime() > now;
}


/** SchedItem.flash 字段归一（petal 往返防线：normItem/normalizeBoardItems 共用） */
export function normFlashMeta(v: any): FlashWaveMeta | undefined {
    const meta = parseFlashAttr(typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
    return meta ?? undefined;
}

// ── 方案 A（09-20 bear）：全空间到期池纯逻辑 ──────────────────────────────────────
// 池口径从「活跃项目子树引用文档」改全空间（官方复习队列同视野）：内置卡组+用户卡组合并流
// （getRiffCards deckID=""）分页拉全卡→筛目标日到期→按 root 聚簇。旧日记/驾照等旧卡全收。

/** buildGlobalPool 输入卡行（getRiffCards 响应块形态——api.RiffCardBlock 结构兼容；
 *  core 零依赖纪律=本地鸭子声明，rootID 内核 Block JSON 原生自带） */
export interface GlobalPoolCardRow {
    id: string;
    rootID?: string;
    riffCardID?: string;
    riffCard?: { due?: string; state?: number };
}

/** 全空间到期池（与编排层 FlashScout 同构——schedule_set/plan_context 消费面不变） */
export interface GlobalPoolResult {
    /** 到期池（块粒度、文档聚簇序=root 字典序、同 root 内首现序——分波保持刷卡上下文连续） */
    blocks: FlashPoolBlock[];
    /** 池内卡总数 */
    cards: number;
    /** New 卡（state=0）张数 */
    newCards: number;
    reviewCards: number;
    /** 实际贡献了到期卡的文档数（distinct root） */
    docs: number;
    /** 信息性异常（页截断等：池计数偏低的原因，不阻塞分波） */
    errors: string[];
}

/** 单卡组分页拉全卡的页护栏（1000/页×100 页=10 万卡——旧 MAX_TREE_PAGES 同量级语义，
 *  病态全库卡量防挂；超限截断=池计数偏低（errors 标记说明） */
export const MAX_GLOBAL_POOL_PAGES = 100;

/** 全空间到期池（纯逻辑+注入页拉取）：分页护栏→入池判定（New 恒入——其 due 动态 now
 *  不可信；其余 due 紧凑字面≤目标日 235959，内核 due 恒带本地 offset 同钟面直比；
 *  畸形 due/占位卡/rootID 缺失的死块剔除）→同块多卡合一行+root 聚簇（root 字典序）。
 *  fetchPage 抛错向上传播（单流无局部根可容错——调用方决定整包缺席还是重试）。 */
export async function buildGlobalPool(
    fetchPage: (page: number) => Promise<{ blocks?: GlobalPoolCardRow[]; pageCount?: number } | null>,
    day: string,
): Promise<GlobalPoolResult> {
    const dayEnd = `${day.replaceAll("-", "")}235959`;
    const blockCards = new Map<string, number>(); // 块 id → 池内卡数（同块多卡合一行）
    const rootBlocks = new Map<string, string[]>(); // root → 块 id 序（首现序=卡 due 升序）
    const blockRoot = new Map<string, string>(); // 块 id → root（同块恒同 root，首见定钉）
    let cards = 0;
    let newCards = 0;
    const errors: string[] = [];
    for (let page = 1; page <= MAX_GLOBAL_POOL_PAGES; page++) {
        const ret = await fetchPage(page);
        const rows: GlobalPoolCardRow[] = Array.isArray(ret?.blocks) ? ret.blocks : [];
        for (const b of rows) {
            if (!b || typeof b.id !== "string" || !b.riffCardID) continue; // 占位/非真卡
            const rc = b.riffCard;
            if (!rc || typeof rc.due !== "string") continue; // 畸形 due 剔除（形态守卫）
            const isNew = rc.state === 0; // New 恒入（due=响应时动态 now 非静态存储值）
            if (!isNew) {
                const compact = rfc3339ToCompact(rc.due);
                if (!compact || compact > dayEnd) continue; // 畸形/未来到期剔除
            }
            const root = typeof b.rootID === "string" && b.rootID ? b.rootID : null;
            if (!root) continue; // rootID 缺失（块已删/占位）——无文档锚不入池
            cards++;
            if (isNew) newCards++;
            if (!blockCards.has(b.id)) {
                blockCards.set(b.id, 0);
                blockRoot.set(b.id, root);
                const list = rootBlocks.get(root);
                if (list) list.push(b.id);
                else rootBlocks.set(root, [b.id]);
            }
            blockCards.set(b.id, (blockCards.get(b.id) ?? 0) + 1);
        }
        const pageCount = Number(ret?.pageCount ?? 1);
        if (page === MAX_GLOBAL_POOL_PAGES && pageCount > MAX_GLOBAL_POOL_PAGES) {
            errors.push(`全空间卡流 ${pageCount} 页超上限 ${MAX_GLOBAL_POOL_PAGES} 截断（池计数偏低）`);
        }
        if (!Number.isFinite(pageCount) || page >= pageCount) break;
    }
    const out: FlashPoolBlock[] = [];
    for (const root of [...rootBlocks.keys()].sort()) {
        for (const id of rootBlocks.get(root) ?? []) out.push({ id, cards: blockCards.get(id) ?? 0 });
    }
    return { blocks: out, cards, newCards, reviewCards: cards - newCards, docs: rootBlocks.size, errors };
}
