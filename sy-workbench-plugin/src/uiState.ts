// lsfix 2026-10-13 家族战役：UI 跨重启状态 petal 档集中定义（entryToggles/ganttPrefs 同款
// 轻量存储惯例——project 无 settingCfg 基建，走插件原生 loadData/saveData 读写 petal 目录）。
// 根因：思源桌面 Electron 壳每次启动给内置内核随机分配端口（server.listen(0)，origin 含
// 端口），浏览器 localStorage 按 origin 隔离=桌面端每次重启全部蒸发（会话内一切正常）——
// 凡 localStorage 持久化的跨重启状态必丢（群实报「块编辑器收缩球位置重启丢失」同族）。
// 本文件=登记层（类型+默认+容错归一+legacyKey 注释）；index.ts 同批登记预载与写盘方法族。
// 各消费者从 localStorage 迁到本档的改造由迁移工逐文件接管：旧 localStorage 键=一次性
// 收编源（收编时读取、收编后不回写，参照 tomato qeBall.loadQEBallPos）。

/** 弹药库悬浮窗开合记忆档（消费者 AmmoFloat.ts：onload 读档恢复 Wish / openPanel·closePanel 写档；
 *  插件 unload 收尾 persist=false 不写=重载不重置用户开合记忆——迁移后同语义：unload 路径不调 save）
 *  旧档收编源：localStorage "pj-ammo-float-open"（值 "1"=上次会话开/"0"=关） */
export const AMMO_FLOAT_OPEN_FILE = "ammo-float-open.json";

/** 存档容错归一：loadData 双形态（字符串/对象）+旧 localStorage 值（"1"/"0"）兼容；缺档=false */
export function normalizeAmmoFloatOpen(raw: unknown): boolean {
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw || "null");
        } catch {
            raw = null;
        }
    }
    return raw === true || raw === 1;
}

/** 弹药库悬浮窗几何记忆档（消费者 AmmoFloatPanel.svelte：拖拽/resize 松手+透明度 change 写档，
 *  onMount loadGeo 读档；null=无存档，消费侧 fallback 默认右下落位）
 *  旧档收编源：localStorage "pj-ammo-float-panel"（同形 JSON {x,y,w,h,o}） */
export const AMMO_FLOAT_GEO_FILE = "ammo-float-geo.json";

/** 几何存档：x/y=左上像素，w/h=宽高，o=透明度（0.4~1，消费侧 clamp） */
export interface AmmoFloatGeo {
    x: number;
    y: number;
    w: number;
    h: number;
    o: number;
}

/** 存档容错归一：x/y/w/h 任一非 finite 判无档（AmmoFloatPanel.loadGeo 同款容错——不猜半个几何）；
 *  o 缺失/坏值回 1 */
export function normalizeAmmoFloatGeo(raw: unknown): AmmoFloatGeo | null {
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw || "null");
        } catch {
            raw = null;
        }
    }
    const p = (raw && typeof raw === "object" ? raw : null) as Partial<AmmoFloatGeo> | null;
    if (!p) return null;
    if (![p.x, p.y, p.w, p.h].every((v) => Number.isFinite(Number(v)))) return null;
    const o = Number(p.o);
    return { x: Number(p.x), y: Number(p.y), w: Number(p.w), h: Number(p.h), o: Number.isFinite(o) ? o : 1 };
}

/** 周报已读周集档（消费者 TimelineTab.svelte：点击周报 chip 置位——轻 push 角标只消本机。
 *  注：petal 档随工作空间目录走，同库多端会共享已读态（原 localStorage 本机隔离）；单机零差异，
 *  多端反而更一致——家族战役统一口径，如需本机隔离另立专题）
 *  旧档收编源：localStorage "pj-weekly-read-<weekStart>"（动态键族——收编须扫前缀，值恒 "1"） */
export const WEEKLY_READ_FILE = "weekly-read.json";

/** weekStart（YYYY-MM-DD，周日）→true */
export type WeeklyRead = Record<string, true>;

/** 存档容错归一：坏值键剔除（手改坏档不炸；键集合消费侧以周报表 weeks 为准裁剪） */
export function normalizeWeeklyRead(raw: unknown): WeeklyRead {
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw || "null");
        } catch {
            raw = null;
        }
    }
    const out: WeeklyRead = {};
    const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    for (const k of Object.keys(src)) {
        if (src[k] === true || src[k] === 1 || src[k] === "1") out[k] = true;
    }
    return out;
}

/** 文档停留采集按天档（消费者 behavior/tracker.ts：结算/hourly 写当日档，翻日推旧日档给
 *  kernel 后清键——rpc behavior-stay 推 kernel 是主持久链，本档=重启恢复源（当日累计+
 *  昨日档补推）。⚠️写频高（每次文档切换/结算即写）：写路径必须 saveData 两参官方通道
 *  （恒带 app=本窗免重载，AGENTS petal 写纪律）——原注释「不触 petal 零重载副作用」选
 *  localStorage 的顾虑由本通道消除，勿改走 window.siyuan.storage 广播通道）
 *  旧档收编源：localStorage "sy-project-stay-<day>"（动态键族——收编须扫前缀；值原形
 *  {"entries":[...]}，收编零变形） */
export const STAY_ARCHIVE_FILE = "stay-archive.json";

/** 单文档停留累计（id=文档根块 id；title=尽力拿的文档标题，消费侧按 id 对齐画像） */
export interface StayEntry {
    id: string;
    title: string;
    seconds: number;
    sessions: number;
}

/** day（YYYY-MM-DD）→当日档（保留旧档 {entries:[...]} 包层原形） */
export type StayArchive = Record<string, { entries: StayEntry[] }>;

/** 存档容错归一：坏条目剔除（非 string id/非数值秒数跳过，tracker.restoreToday 同款容错）；
 *  翻日清档语义由消费侧 checkDay 承担（本档只存不删） */
export function normalizeStayArchive(raw: unknown): StayArchive {
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw || "null");
        } catch {
            raw = null;
        }
    }
    const out: StayArchive = {};
    const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
    if (!src) return out;
    for (const day of Object.keys(src)) {
        const entries = (src[day] as { entries?: unknown })?.entries;
        if (!Array.isArray(entries)) continue;
        const list: StayEntry[] = [];
        for (const e of entries) {
            const r = (e && typeof e === "object" ? e : null) as Partial<StayEntry> | null;
            if (typeof r?.id !== "string") continue;
            list.push({ id: r.id, title: String(r.title ?? ""), seconds: Number(r.seconds) || 0, sessions: Number(r.sessions) || 0 });
        }
        out[day] = { entries: list };
    }
    return out;
}

/** 当日已触发提醒键集档（消费者 schedNotify.ts：30s tick 读、触发即写——跨 reload/重启
 *  去重防重弹；day 非当日=空集重记（迟开不追旧账语义由消费侧 GRACE 窗承担））
 *  旧档收编源：localStorage "pj-sched-fired"（同形 JSON {day,keys}） */
export const SCHED_FIRED_FILE = "sched-fired.json";

/** day=逻辑日（YYYY-MM-DD）；keys=已触发键（rs:<块id>=开始 / re:<块id>=结束） */
export interface SchedFired {
    day: string;
    keys: string[];
}

export const EMPTY_SCHED_FIRED: SchedFired = { day: "", keys: [] };

/** 存档容错归一：坏档=空集重记（loadFired 同款语义） */
export function normalizeSchedFired(raw: unknown): SchedFired {
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw || "null");
        } catch {
            raw = null;
        }
    }
    const p = (raw && typeof raw === "object" ? raw : null) as Partial<SchedFired> | null;
    return {
        day: typeof p?.day === "string" ? p.day : "",
        keys: Array.isArray(p?.keys) ? p!.keys.filter((k) => typeof k === "string") : [],
    };
}

/** 飞书授权坏提醒去重档（消费者 index.ts onCalendarStatus：每轮同步状态广播读、触发提醒
 *  才写——同因当天只弹一次）
 *  旧档收编源：localStorage "pj-auth-notify"（同形 JSON {code,day}） */
export const AUTH_NOTIFY_DEDUP_FILE = "auth-notify.json";

/** code=authErrorCode（20064/token 失效族，CalendarStatus.authErrorCode）；day=逻辑日 */
export interface AuthNotifyDedup {
    code: number;
    day: string;
}

/** 存档容错归一：code 非 finite/day 非 string 判无档（null=未提醒过，消费侧弹一次后写档） */
export function normalizeAuthNotifyDedup(raw: unknown): AuthNotifyDedup | null {
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw || "null");
        } catch {
            raw = null;
        }
    }
    const p = (raw && typeof raw === "object" ? raw : null) as Partial<AuthNotifyDedup> | null;
    if (!p || !Number.isFinite(Number(p.code)) || typeof p.day !== "string") return null;
    return { code: Number(p.code), day: p.day };
}
