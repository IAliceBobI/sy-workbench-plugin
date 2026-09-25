// □16 历法层（pjux □10 拍板§六 Q5）：lunar-typescript 单一封装——月历农历/节气/节日
// 文案+法定假日休/班判定（月历角标）+森林图轴假日段扫描共用。纯函数零 siyuan/window
// 依赖可单测；Map 缓存按 iso 键（月历 42 格/翻月/森林轴段扫同键反复问，lunar 计算
// 非平凡）。干支不显示（拍板）；初一回退月名「正月」（闰月带「闰」前缀）=通行历面惯例。
// 年度数据随包版本走（历史节奏每年 Q4 发新版），跨年数据缺=两角标静默不显非报错。
import { HolidayUtil, Solar } from "lunar-typescript";

export interface DayAlmanac {
    /** 农历文案：传统节日>公历节日>节气>农历日（初一=月名） */
    lunarText: string;
    /** 命中节日/节气=高亮态（月历主色小字） */
    highlight: boolean;
    /** 法定假日（休角标） */
    off: boolean;
    /** 调休补班（班角标） */
    work: boolean;
}

const cache = new Map<string, DayAlmanac>();

export function dayAlmanac(iso: string): DayAlmanac {
    const hit = cache.get(iso);
    if (hit) return hit;
    let r: DayAlmanac = { lunarText: "", highlight: false, off: false, work: false };
    const [y, m, d] = iso.split("-").map(Number);
    if (y && m && d) {
        const solar = Solar.fromYmd(y, m, d);
        const lunar = solar.getLunar();
        const fest = lunar.getFestivals()[0] ?? solar.getFestivals()[0] ?? lunar.getJieQi();
        const dayCn = lunar.getDayInChinese();
        // 初一回退月名（getMonthInChinese 自带「闰」前缀——闰六月等无需手工判）
        const dayText = dayCn === "初一" ? `${lunar.getMonthInChinese()}月` : dayCn;
        const holiday = HolidayUtil.getHoliday(y, m, d);
        r = {
            lunarText: fest || dayText,
            highlight: !!fest,
            off: !!holiday && !holiday.isWork(),
            work: !!holiday && holiday.isWork(),
        };
    }
    cache.set(iso, r);
    return r;
}

export interface HolidaySpan {
    /** 段首本地零点 ts（森林图 xOf 映射用） */
    start: number;
    /** 假日名（HolidayUtil 原名如「国庆节」——不借道 lunarText，法假首日非节日名的
     *  排布形态下文案层巧合不可依赖） */
    name: string;
}

/** 森林图轴假日段（拍板：只标法定假日）：[tMin,tMax] 内连续休日（work=false）并段，
 *  段与段之间被任一非休日（含补班日）断开。逐日本地日界扫描（setDate+1 防 DST 漂移）。 */
export function holidaySpans(tMin: number, tMax: number): HolidaySpan[] {
    const spans: HolidaySpan[] = [];
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax <= tMin) return spans;
    let cur = new Date(tMin);
    cur.setHours(0, 0, 0, 0);
    const end = new Date(tMax);
    let open = false;
    while (cur.getTime() <= end.getTime()) {
        const h = HolidayUtil.getHoliday(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
        const off = !!h && !h.isWork();
        if (off && !open) {
            spans.push({ start: cur.getTime(), name: h!.getName() });
            open = true;
        } else if (!off) {
            open = false;
        }
        cur.setDate(cur.getDate() + 1);
    }
    return spans;
}
