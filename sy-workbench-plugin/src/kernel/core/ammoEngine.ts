// ammo □3：单任务运行引擎·纯层——未闭合条目分类（running 候选/悬账两分）与引擎词表守卫。
// 契约=docs/ammo-concept.md B2.5（恢复协议）：running 候选窗=当日+昨日（跨零点续跑候选）；
// 昨日之前与窗口内非最新=悬账（交上层提示补结，引擎不擅自闭合）。排序键=(day,start)=
// 真实时间序（YYYY-MM-DD 与 HH:mm 字典序=时间序）；并列取容器序（数组位）靠后=后插入=后开始。
// 纪律对齐 core/pomodoro 退役前骨架：零 siyuan/网络/DOM 依赖，now/today 全注入可测。
import { shiftDay } from "./behavior";
import type { AmmoLedgerEntry } from "./ammoLedger";

/** 池 slug 白名单（B3 冻结值域：gold/deadline/hearth/crumbs；空串=锚点出发型/无池临时合法） */
export const AMMO_POOL_SLUGS: ReadonlyArray<string> = ["gold", "deadline", "hearth", "crumbs"];

/** running 候选窗天数（含当日：2=当日+昨日——B2.5「当日条目续跑、昨日之前的悬账提示补结」
 *  与跨零点续跑（昨日 23:50 开的任务）两语义的最小覆盖） */
export const AMMO_RUNNING_WINDOW_DAYS = 2;

/** 悬账扫描窗天数（B2.5「启动读当日+近日」——状态面按此窗扫悬账交上层提示） */
export const AMMO_DANGLING_SCAN_DAYS = 7;

/** 分类入参：一个未闭合条目+其落账日（entry 由读链 attrsToLedgerEntry 产出；closed 条目
 *  由分类器内部防御性滤除——调用方无须预过滤） */
export interface AmmoUnclosedRow {
    day: string;
    entry: AmmoLedgerEntry;
}

export interface AmmoClassifyResult {
    /** running 候选（至多一条=单任务互斥不变量；null=无运行中） */
    running: AmmoUnclosedRow | null;
    /** 悬账（含窗口内非最新+窗外的全部未闭合；时间升序=发生序，提示面按序逐条） */
    dangling: AmmoUnclosedRow[];
}

/** 池 slug 守卫（引擎入参面：野 slug 拒绝——词表冻结不收编新值） */
export function isValidAmmoPool(pool: string): boolean {
    return pool === "" || AMMO_POOL_SLUGS.includes(pool);
}

/** HH:mm→当日分钟数（PomoTarget.startMin 口径——番茄区只读关联的行锚；非法→NaN） */
export function hmToMinutes(hm: string): number {
    const m = /^(\d{2}):(\d{2})$/.exec(hm ?? "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** 未闭合分类：running=窗口内（当日+昨日）真实时间最晚的未闭合条目；其余全悬账。
 *  窗外（昨日之前/异常未来日）条目再新也不进 running——事故现场只上浮不接管。 */
export function classifyUnclosedLedger(rows: AmmoUnclosedRow[], today: string): AmmoClassifyResult {
    const unclosed = rows
        .map((r, i) => ({ ...r, __i: i }))
        .filter((r) => r.entry && !r.entry.closed && typeof r.entry.start === "string");
    const winLo = shiftDay(today, -(AMMO_RUNNING_WINDOW_DAYS - 1));
    let running: (AmmoUnclosedRow & { __i: number }) | null = null;
    const dangling: Array<AmmoUnclosedRow & { __i: number }> = [];
    for (const r of unclosed) {
        const inWindow = r.day >= winLo && r.day <= today;
        if (!inWindow || !running) {
            if (!inWindow) dangling.push(r);
            else running = r; // 首个窗口内条目先落 running
            continue;
        }
        // 窗口内比较：(day,start) 时间序，并列取数组位靠后（容器序=后插入=后开始）
        const a = r.day + r.entry.start;
        const b = running.day + running.entry.start;
        if (a > b || (a === b && r.__i > running.__i)) {
            dangling.push(running);
            running = r;
        } else {
            dangling.push(r);
        }
    }
    dangling.sort((x, y) => (x.day + x.entry.start).localeCompare(y.day + y.entry.start) || x.__i - y.__i);
    const strip = (r: (AmmoUnclosedRow & { __i: number }) | null): AmmoUnclosedRow | null =>
        r ? { day: r.day, entry: r.entry } : null;
    return { running: strip(running), dangling: dangling.map((d) => ({ day: d.day, entry: d.entry })) };
}

