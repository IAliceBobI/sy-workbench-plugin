// dataview □7：任务徽标纯逻辑层（渲染条件/徽标文本/菜单构建/步进与日期计算）。
// 徽标=只读属性的可视化（契约 §2 例外条款：面板可编辑的参数放属性——任务日期族留属性，
// 池/配额是降级缓存）：渲染条件=挂属性才显示，且值过白名单（非法 slug/坏日期 fail-soft 不出，
// 归 □8 体检）。菜单描述（BadgeMenuItem[]）是纯数据——siyuan Menu 落地在 reminder/taskBadge.ts
// 注入器，单测在此钉死「菜单项→动作意图」与日期/步进计算，不碰 siyuan。
// 零 siyuan/DOM/网络依赖（gui 纯逻辑层惯例）；「今天」走 getLogicalDay 与全插件同源。

import { AMMO_POOL_SLUGS, POOL_LABEL, isPoolSlug, type AmmoPoolSlug } from "@/kernel/core/ammoQuadrant";
import { addDays, getLogicalDay } from "@/kernel/core/dates";
import { TASK_ATTRS, parseTags, serializeTaskDates } from "@/kernel/core/schema";

/** 徽标数据面（块属性的规整视图；pool/due 均空=无徽标） */
export interface BadgeView {
    pool: AmmoPoolSlug | null;
    /** 分钟；仅当 pool 非空时随池徽标出示 */
    quota: number | null;
    /** YYYY-MM-DD */
    due: string | null;
}

/** 非负整数宽容读（块属性数字串→number|null；坏值/0/负数=null——normCount 同语义） */
export function quotaOfAttr(raw: unknown): number | null {
    if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw.trim());
    return n > 0 ? n : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 块属性 → 徽标视图（渲染条件单点）：池=合法 slug 才认；日期=YYYY-MM-DD 形态才认；
 *  quota 宽容读（坏值=null 不拖垮池徽标）。全空=null（不渲染——挂属性才显示）。 */
export function badgeViewFromAttrs(attrs: Record<string, string> | null | undefined): BadgeView | null {
    if (!attrs) return null;
    const pool = isPoolSlug(attrs["custom-ammo-pool"]) ? attrs["custom-ammo-pool"] : null;
    const dueRaw = attrs[TASK_ATTRS.dueDate];
    const due = typeof dueRaw === "string" && DATE_RE.test(dueRaw) ? dueRaw : null;
    const quota = quotaOfAttr(attrs["custom-ammo-quota"]);
    if (!pool && !due) return null;
    return { pool, quota: pool ? quota : null, due };
}

/** 池徽标文本：「黄金产出 · 30min」（quota 并入池徽标出示，不独立成徽标） */
export function poolBadgeText(v: BadgeView): string {
    if (!v.pool) return "";
    return v.quota != null ? `${POOL_LABEL[v.pool]} · ${v.quota}min` : POOL_LABEL[v.pool];
}

/** 四池性格色单（亮色）——gold=#d4a017/deadline=#e05252/hearth=#e07b39/crumbs=#7a9e7e */
export const POOL_COLORS: Record<AmmoPoolSlug, string> = {
    gold: "#d4a017",
    deadline: "#e05252",
    hearth: "#e07b39",
    crumbs: "#7a9e7e",
};

/** 四池性格色单（暗色）——gold=#e3b341/deadline=#f87171/hearth=#fb923c/crumbs=#86efac */
export const POOL_COLORS_DARK: Record<AmmoPoolSlug, string> = {
    gold: "#e3b341",
    deadline: "#f87171",
    hearth: "#fb923c",
    crumbs: "#86efac",
};

/**
 * 池色值映射（四池×亮/暗两套；非法池=null 不染）。色值单一事实源=本表（对齐注释先例见
 * BoardView.svelte .pj-board__pooldot）：
 *   AmmoQuadrantPanel.svelte .pj-ammo__pool-dot[data-pool=…]（亮 1433-1443 段/暗 :global 段）
 *   ── 消费点 taskBadge 徽标走 CSS 变量桥（--pj-badge-pool / --pj-badge-pool-dark，remind.css
 *   ::before 与 .pj-taskbadge-text 引用），暗色自动切由双变量+html[data-theme-mode=dark] 分支
 *   承担，色值不再在 CSS 侧复制（「色值对照色单别自造」——此前 remind.css 亮色四值已漂移）。
 */
export function poolColorOf(pool: AmmoPoolSlug | null, dark: boolean): string | null {
    if (!pool) return null;
    return (dark ? POOL_COLORS_DARK : POOL_COLORS)[pool] ?? null;
}

/** 日期徽标文本：当年省年份「09-24」，非当年全形「2027-01-02」（跨年歧义优先精确） */
export function dueBadgeText(due: string, now: Date): string {
    return due.slice(0, 4) === getLogicalDay(now).slice(0, 4) ? due.slice(5) : due;
}

/** 配额步进（15min 格——与时间线落点吸附同格）：null 起步=+15 得 15、−15 得 null
 *  （无值无可减）；钳 [15, 1440]（不足一格=一格，超一天=一天）。 */
export function quotaStep(cur: number | null, delta: number): number | null {
    if (cur == null) return delta > 0 ? 15 : null;
    return Math.max(15, Math.min(1440, cur + delta));
}

// ── 菜单构建 ──

/** 菜单动作（纯意图数据——写链落地在 taskBadge.ts applyBadgeAction）：
 *  pool=换池（走 kernel moveTaskPool：配置行归属+块缓存双写）；
 *  quota=配额步进/清（quota=null=清；走 kernel setTaskQuota：行在改行文本+块缓存恒写）；
 *  date=日期选择（day=null=清；直写 custom-task-due-date——真相即属性，契约 §3）；
 *  more=「更多…」属性面板（UI 面动作——taskBadge.ts 开 popover 非写链，纯函数面 no-op）。 */
export type BadgeAction =
    | { type: "pool"; pool: AmmoPoolSlug }
    | { type: "quota"; quota: number | null }
    | { type: "date"; day: string | null }
    | { type: "more" };

/** 菜单项描述（纯数据；current=落地层给 iconSelect 勾选） */
export interface BadgeMenuItem {
    label: string;
    current?: boolean;
    submenu?: BadgeMenuItem[];
    action?: BadgeAction;
}

/** 模板填槽（composeRepeatShort 同款 split/join） */
function fill(tpl: string, key: string, val: string): string {
    return tpl.split(`{${key}}`).join(val);
}

export interface TaskBadgeTexts {
    taskBadgePool: string;
    taskBadgeQuotaMinus: string;
    taskBadgeQuotaPlus: string;
    taskBadgeQuotaClear: string;
    taskBadgeDate: string;
    taskBadgeDateToday: string;
    taskBadgeDateTomorrow: string;
    taskBadgeDateDayAfter: string;
    taskBadgeDatePlus7: string;
    taskBadgeDateClear: string;
    taskBadgeMore: string;
}

/**
 * 快捷菜单构建：换池四选一（当前池 current 勾选）/配额 ±15min（label 带步进结果——现值
 * 透明）/清配额/日期快捷（今天/明天/后天/+7 天带具体日期）/清日期/「更多…」（尾项——
 * 开属性面板：截止日期+时刻+开始日期+标签平铺直写）。
 * 任意日期走速记命令（□6 全局小窗整词数形族）——本菜单=快捷面，日期计算与速记同源
 * （getLogicalDay/addDays）。label 全部为常量/正则产物/i18n 模板（无用户文本——
 * Menu label 走 innerHTML 的转义坑免疫）。
 */
export function buildTaskBadgeMenu(v: BadgeView, t: TaskBadgeTexts, now: Date): BadgeMenuItem[] {
    const today = getLogicalDay(now);
    const quotaText = (n: number | null) => (n != null ? `${n}min` : "—");
    const dateLabel = (day: string) => day.slice(5).replace("-", "/");
    const minus = quotaStep(v.quota, -15);
    const plus = quotaStep(v.quota, 15);
    return [
        {
            label: t.taskBadgePool,
            submenu: AMMO_POOL_SLUGS.map((pool) => ({
                label: POOL_LABEL[pool],
                current: v.pool === pool,
                action: { type: "pool", pool } as BadgeAction,
            })),
        },
        { label: fill(t.taskBadgeQuotaMinus, "to", quotaText(minus)), action: { type: "quota", quota: minus } },
        { label: fill(t.taskBadgeQuotaPlus, "to", quotaText(plus)), action: { type: "quota", quota: plus } },
        { label: t.taskBadgeQuotaClear, action: { type: "quota", quota: null } },
        {
            label: t.taskBadgeDate,
            submenu: [
                { label: fill(t.taskBadgeDateToday, "day", dateLabel(today)), action: { type: "date", day: today } },
                { label: fill(t.taskBadgeDateTomorrow, "day", dateLabel(addDays(today, 1))), action: { type: "date", day: addDays(today, 1) } },
                { label: fill(t.taskBadgeDateDayAfter, "day", dateLabel(addDays(today, 2))), action: { type: "date", day: addDays(today, 2) } },
                { label: fill(t.taskBadgeDatePlus7, "day", dateLabel(addDays(today, 7))), action: { type: "date", day: addDays(today, 7) } },
                { label: t.taskBadgeDateClear, action: { type: "date", day: null } },
            ],
        },
        { label: t.taskBadgeMore, action: { type: "more" } },
    ];
}

// ── 「更多…」属性面板保存面（纯函数） ──

/** 面板字段值（TaskPropsPanel 直出；""=清空该属性——tagsRaw=逗号分隔原文） */
export interface TaskPropsFields {
    /** 截止日期 YYYY-MM-DD；""=清空 */
    dueDate: string;
    /** 截止时刻 HH:mm；""=清空 */
    dueTime: string;
    /** 开始日期 YYYY-MM-DD；""=清空 */
    startDate: string;
    /** 标签原文（逗号分隔；""/纯空白=清空标签属性——规格默认） */
    tagsRaw: string;
}

const PROPS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROPS_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 真实历法日校验（quickParse validYmd 同款：正午锚点往返比对——2026-02-30 拒） */
function validPropsDay(day: string): boolean {
    if (!PROPS_DATE_RE.test(day)) return false;
    const dt = new Date(`${day}T12:00:00`);
    if (Number.isNaN(dt.getTime())) return false;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}` === day;
}

/**
 * 面板保存值 → 块属性集（纯函数；键名+空串清空语义=serializeTaskDates 单一事实源，
 * 标签切分=parseTags 同规则）。日期非真实历法日/时刻非合法 24h → null（面板就地报错
 * 不写盘——契约 §2 fail-soft：宁可拒写不可写坏值）。
 */
export function taskPropsSaveAttrs(f: TaskPropsFields): Record<string, string> | null {
    if (f.dueDate !== "" && !validPropsDay(f.dueDate)) return null;
    if (f.startDate !== "" && !validPropsDay(f.startDate)) return null;
    if (f.dueTime !== "" && !PROPS_TIME_RE.test(f.dueTime)) return null;
    return serializeTaskDates({
        dueDate: f.dueDate,
        dueTime: f.dueTime,
        startDate: f.startDate,
        tags: parseTags(f.tagsRaw),
    });
}

/**
 * 面板时刻控件初值（TimeSpinner 吃完整 YYYY-MM-DDTHH:mm）：日期+时刻双全=真值；
 * 只有时刻无日期（速记「9:30 站会」建出的 time-only 任务）=today 补日期段让时刻
 * 显示出来——补位日期只作显示基不落盘（保存时 dueDate 照旧空=time-only 形态保留，
 * 时刻不再因面板「看不到→存成空串」被静默清掉）；无时刻=""空态。
 */
export function initialDueWhen(dueDate: string, dueTime: string, today: string): string {
    if (!PROPS_TIME_RE.test(dueTime)) return "";
    return `${PROPS_DATE_RE.test(dueDate) ? dueDate : today}T${dueTime}`;
}
