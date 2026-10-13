// lsfix 2026-10-13 家族战役（TimelineTab 站点）：周报已读周集 localStorage→petal 档读写门面
// （qeBall.ts 同族姿势的 props 桥变体）。根因与家族头注见 uiState.ts——思源桌面 Electron 壳
// 每次启动给内核随机端口，origin 含端口变=localStorage 换格子清空，跨重启必丢（群实报）。
// store 实体=插件实例内存态 uiWeeklyRead＋saveWeeklyRead 写盘方法族（index.ts 登记层——
// workbench 无 settingCfg 基建，不走 tomato stores.ts 模块单例，由挂载方以 channel 对象
// 注入组件）；localStorage 旧档（pj-weekly-read-<weekStart> 动态键族，值恒 "1"）由
// loadReadWeeks 一次性收编：收编时读取、收编后不回写。
import type { WeeklyRead } from "./uiState";

/** 旧档收编源前缀（键族按周动态——扫前缀而非枚举固定键） */
const LS_PREFIX = "pj-weekly-read-";

/** 周报已读周集 store 通道（挂载方注入：get=内存态读、save=置值＋立即落盘；
 *  缺=null=无桥降级：已读态仅会话内，重启后角标复现——迁移接线前的兜底语义） */
export interface WeeklyReadChannel {
    get(): WeeklyRead;
    save(v: WeeklyRead): void;
}

/** localStorage 可用性守卫（隐私模式等不可用=返回 null——原「角标常亮，无碍」语义沿用） */
function safeLocalStorage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

/** 旧档收编扫描：pj-weekly-read- 前缀键收 weekStart→true（原 getItem 真值判定沿用——
 *  空串不认；空 weekStart 尾段跳过） */
export function adoptLegacyWeeklyRead(ls: Storage | null): WeeklyRead {
    const out: WeeklyRead = {};
    if (!ls) return out;
    for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!k || !k.startsWith(LS_PREFIX)) continue;
        const wk = k.slice(LS_PREFIX.length);
        if (wk && ls.getItem(k)) out[wk] = true;
    }
    return out;
}

/** 已读周集读取：store 档优先；无档时收编 localStorage 旧档（固定端口环境有真值，桌面端
 *  随机端口 origin 下恒空）并落新档（收编幂等：落盘后 store 非空不再触旧档）。
 *  无桥（channel=null）=只读收编不落盘 */
export function loadReadWeeks(ch: WeeklyReadChannel | null, ls: Storage | null = safeLocalStorage()): WeeklyRead {
    const store = ch ? ch.get() : {};
    if (Object.keys(store).length > 0) return store;
    const legacy = adoptLegacyWeeklyRead(ls);
    if (Object.keys(legacy).length > 0) ch?.save(legacy);
    return legacy;
}

/** 已读视图裁剪：只留周报表 weeks 键集内的周（表外周不参与角标判定——已读集以周报表为准） */
export function clipReadWeeks(read: WeeklyRead, weeks: string[]): Record<string, boolean> {
    const view: Record<string, boolean> = {};
    for (const wk of weeks) if (read[wk]) view[wk] = true;
    return view;
}
