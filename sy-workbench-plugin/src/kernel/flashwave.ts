// timeblock 期 3：闪卡波次编排层——侦察（方案 A 全空间：全卡组合并流→目标日到期池）
// + 块级→卡级 due 规整（batchSetRiffCardsDueTime 块级粒度=同块多卡同波）。
// 副作用全走 api 层（单测 mock 边界）；分波/属性/对账/入池聚簇纯逻辑在 core/flashwave。
// 拍板（09-19 bear）：写入者=schedule_set 内消化；分波=纯均分；刷卡=官方复习界面零 UI 开发。
// 拍板（09-20 bear 方案 A）：池改全空间——旧口径（活跃项目子树引用文档，burden.buildRefsSql）
// 与官方复习队列（全空间）不重合（主实例实测 30 张对 0 张重叠）；旧日记/驾照等旧卡全收。
// ⚠️ burden.ts 本体保留勿动（其他消费方仍在用）——本文件已 retire 对它的依赖。
import { getRiffCards, getRiffCardsByBlockIDs, getBlockAttrs, batchSetRiffCardsDueTime } from "./api";
import { rfc3339ToCompact, buildGlobalPool, isPostponedByTomato, type GlobalPoolResult } from "./core/flashwave";

/** 全空间合并流的 deckID 哨兵：内核 GetDeckFlashcards 空串分支（flashcard.go:538）=全部
 *  卡组合并——含 getRiffDecks 响应里没有的内置卡组（GetDecks 剔除之 flashcard.go:1284；
 *  官方复习队列=内置卡组口径 flashcard.go:775）与用户卡组（驾照等旧卡全收）。零硬编码。 */
const ALL_DECKS = "";

export type FlashScout = GlobalPoolResult;

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** 侦察目标日到期池（方案 A 全空间）：全卡组合并流分页拉全卡（含未到期）→筛目标日到期
 *  →root 聚簇（root 字典序=文档聚簇序，同块多卡合一行——纯逻辑在 core.buildGlobalPool）。
 *  卡筛选含「今日已到期未清」（due≤目标日 24:00 全收）——崩盘重排全量重分幂等。
 *  单流无局部根可容错：拉流抛错向上传播（plan_context 整块缺席/schedule_set 显式报错重试）。 */
export async function scoutFlashPool(day: string): Promise<FlashScout> {
    return buildGlobalPool((page) => getRiffCards(ALL_DECKS, page), day);
}

export interface FlashDueResult {
    ok: boolean;
    /** 实际改 due 的卡数 */
    cards: number;
    /** 被番茄推迟守卫跳过的块数（回参留痕：推迟中的卡不进本轮波次） */
    skippedPostponed?: number;
    error?: string;
}

export interface FlashProtect {
    /** 旧规整时刻：卡 due 已被推过它=被番茄推迟，跳过 */
    due?: string;
    /** 排班动作时刻：lastReview 晚于它=排班后已刷卡（FSRS 新卡首刷间隔分钟级、due 仍可能
     *  ≤波次时刻，只看 due 盖不住「先斩后奏」），跳过 */
    at?: string;
}

/** 块级→卡级展开+批量改 due（块清单全卡同 due=同块多卡同波铁律在分波层保证，此处只展开）。
 *  protect=重规整保护线（微调联动传）：已处理的卡跳过不覆盖 FSRS 调度（用户先斩后奏的
 *  处理优先于波次重排）；缺省=全改（schedule_set 首排——池语义本身就是「明日真到期」）。
 *  番茄推迟硬闸（两通道共用，09-24 主实例实锤补）：块挂未来 custom-card-priority-stop=
 *  番茄推迟中，整块跳过——微调 protect.due 线只护住「推迟过旧规整时刻」的卡，首排无旧线
 *  护不住；且池「New 恒入」按 state 判不看 due（番茄推迟只改 due 不改 state），推迟过的
 *  New 卡会被收进池，无此闸=波次把推迟打回当刻。失败=ok:false（半完成态可接受：再次
 *  排波/番茄推迟闪卡自愈）。 */
export async function applyFlashDue(blockIds: string[], due14: string, protect?: FlashProtect): Promise<FlashDueResult> {
    if (!blockIds.length) return { ok: true, cards: 0 };
    try {
        let skippedPostponed = 0;
        const writable: string[] = [];
        for (const id of blockIds) {
            const attrs = await Promise.resolve(getBlockAttrs(id)).catch(() => null);
            if (isPostponedByTomato(attrs?.["custom-card-priority-stop"])) {
                skippedPostponed++;
                continue;
            }
            writable.push(id);
        }
        const cards = writable.length ? await getRiffCardsByBlockIDs(writable) : [];
        const cardDues = cards
            .filter((c) => {
                if (!protect) return true;
                const rc = c?.riffCard;
                if (!rc) return true;
                const compact = rfc3339ToCompact(rc.due);
                if (compact && protect.due && compact > protect.due) return false; // 已被推迟
                const last = rfc3339ToCompact(rc.lastReview ?? "");
                if (last && protect.at && last > protect.at) return false; // 排班后已刷卡
                return true;
            })
            .map((c) => ({ id: c.riffCardID, due: due14 }));
        if (cardDues.length) await batchSetRiffCardsDueTime(cardDues);
        return { ok: true, cards: cardDues.length, ...(skippedPostponed ? { skippedPostponed } : {}) };
    } catch (e) {
        return { ok: false, cards: 0, error: errText(e) };
    }
}

/** 对账：波次清单查卡现状（被推走=已刷卡或被 tomato 推迟，两种都算已处理） */
export async function waveCompletion(blockIds: string[], due14: string): Promise<{ processed: number; total: number } | null> {
    if (!blockIds.length) return null;
    try {
        const cards = await getRiffCardsByBlockIDs(blockIds);
        let processed = 0;
        for (const c of cards) {
            const compact = c?.riffCard ? rfc3339ToCompact(c.riffCard.due) : null;
            if (compact && compact > due14) processed++;
        }
        return { processed, total: cards.length };
    } catch {
        return null; // 查询失败=无证据（对账三态 unknown），不误报
    }
}
