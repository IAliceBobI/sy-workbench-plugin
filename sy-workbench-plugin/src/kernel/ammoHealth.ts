// ammo □8：格式体检聚合读面（kernel rpc——fail-soft 的可见面）。三域行批读（配置/日账/班表，
// 各自模块的 lines 读面——与读链同一容器定位通道零建档）+不想做分区读（readAversions
// healthNote/docId）→ core/ammoHealth.buildAmmoHealth 汇总成清单。只做汇总呈现：
// ①分区结构异常（□1 顺序锚）②未认行（□2 双通道解析失败）③文本与属性冲突（文本即真相，
// 属性是缓存——不一致出示不拦截）。任何子域读炸=errors 带出（fail-soft 不炸整面），
// 读通道零副作用零建档（sched-board-read 先例同款）。
import { readAversions, readDayConfigLines } from "./ammoQuadrant";
import { readDayLedgerLines } from "./ammoLedger";
import { readBoardLines } from "./schedboard";
import { buildAmmoHealth, type AmmoHealthItem } from "./core/ammoHealth";
import { isValidDay } from "./core/schedule";

/** 体检报告（rpc 返回形态——面板 props 直喂） */
export interface AmmoHealthReport {
    ok: boolean;
    day: string;
    /** 发现清单（①分区②未认③冲突——分类序即呈现序；空=全健康） */
    items: AmmoHealthItem[];
    /** 子域读取失败（读炸≠格式异常；面板错误行展示，不炸整面） */
    errors?: string[];
}

/** 本地日 YYYY-MM-DD（ammoPanelRpc localDay 同款——rpc 缺省日参用） */
function localDay(now: number): string {
    const d = new Date(now);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 体检聚合 rpc（零写零建档；子域并行读互相独立）。参数 {day?} 缺省=当日。 */
export async function ammoHealthRpc(day?: string): Promise<AmmoHealthReport> {
    const today = isValidDay(day ?? "") ? day! : localDay(Date.now());
    const [cfgRes, ledgerRes, boardRes, avRes] = await Promise.all([
        readDayConfigLines(today).catch((e: any) => ({ ok: false as const, lines: null, error: `每日配置行读取失败：${String(e?.message ?? e)}` })),
        readDayLedgerLines(today).catch((e: any) => ({ ok: false as const, lines: null, error: `日账行读取失败：${String(e?.message ?? e)}` })),
        readBoardLines(today).catch((e: any) => ({ ok: false as const, lines: null, error: `班表行读取失败：${String(e?.message ?? e)}` })),
        readAversions().catch((e: any) => ({ items: [], error: `不想做清单读取失败：${String(e?.message ?? e)}` })),
    ]);
    const errors: string[] = [];
    if (!cfgRes.ok) errors.push(cfgRes.error ?? "每日配置行读取失败");
    if (!ledgerRes.ok) errors.push(ledgerRes.error ?? "日账行读取失败");
    if (!boardRes.ok) errors.push(boardRes.error ?? "班表行读取失败");
    if ((avRes as any).error) errors.push((avRes as any).error);
    const items = buildAmmoHealth({
        config: cfgRes.ok ? cfgRes.lines ?? null : null,
        ledger: ledgerRes.ok ? ledgerRes.lines ?? null : null,
        board: boardRes.ok ? boardRes.lines ?? null : null,
        aversions: { healthNote: (avRes as any).healthNote ?? null, docId: (avRes as any).docId ?? null },
    });
    return { ok: true, day: today, items, ...(errors.length ? { errors } : {}) };
}
