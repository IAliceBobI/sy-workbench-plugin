export const DEFAULT_DAY_START = "00:00";

export function parseHM(hm: string): { h: number; m: number } {
    const m = /^(\d{2}):(\d{2})$/.exec(hm);
    if (!m) throw new Error(`invalid HH:MM: ${hm}`);
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) throw new Error(`invalid HH:MM: ${hm}`);
    return { h, m: min };
}

/** 唯一逻辑天函数：全部日期判断必须过它（handoff □2 定案）。 */
export function getLogicalDay(now: Date, dayStart: string = DEFAULT_DAY_START): string {
    const { h, m } = parseHM(dayStart);
    const d = new Date(now);
    if (d.getHours() < h || (d.getHours() === h && d.getMinutes() < m)) {
        d.setDate(d.getDate() - 1);
    }
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
}

/** YYYY-MM-DD 日期算术（□26 plan_context 默认 target_day=明天；正午锚点免疫时区/夏令时边界） */
export function addDays(day: string, n: number): string {
    const d = new Date(`${day}T12:00:00`);
    if (Number.isNaN(d.getTime())) throw new Error(`invalid day: ${day}`);
    d.setDate(d.getDate() + n);
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mo}-${da}`;
}
