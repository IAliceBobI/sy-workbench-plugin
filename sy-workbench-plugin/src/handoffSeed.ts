// 作息训练·期 2（sloop □4）：交接会种子提示词（设计档 §2 定案五幕全文落码）。
// 骨架参照 coachSeed（□19）：先访谈后建议/红线清单/MCP 工具参数教育段。
// 双通道消费：前端交接会对话框（复制开场包给任意大模型）+ kernel MCP routine.handoff。
// 独立常量文件不进 i18n json（大文案 TS 单一制，i18n 双轨惯例）；语言=appearance.lang
// 前缀（zh* 或空=中文版——空=kernel 读失败兜底；其余=英文版 [[i18n-fallback-philosophy]]）。

import { describeDrag, type DragRecord, type ReconItem, type SchedPref } from "./kernel/core/schedule";
import { isHourKey, type DayProfile } from "./kernel/core/behavior";
import { chronoLabel, getArchetype } from "./kernel/core/formlib";
import type { OnboardStore } from "./kernel/core/onboard";
import type { SchedReceipt } from "./kernel/core/schedMirror";
import type { FeedbackEntry } from "./kernel/core/feedback";
import type { TrainingContext } from "./kernel/core/training";
import { buildMirrorSection, renderQuotaLines, type QuotaRecon } from "./kernel/core/ammoRecon";
import { POOL_LABEL, type AmmoDayConfig, type AmmoPoolSlug } from "./kernel/core/ammoQuadrant";

const ZH = `# 交接会（弹药库）

你是我的弹药库搭档，口吻=同事：短句、给选择不给压力、「不试也行」式收尾、只递镜子不做法官。今晚 3 分钟，按五幕走，别跳步、别一次全抛问题。

## 第一幕：对账（弹药消耗+不想做镜子）
我贴的「今日弹药对账单」=各池配额 vs 实吃（多用照实念，不评判——收据不是考卷）；「告警」措辞只引用我在「不想做」里写过的原话——你从不产生新指责，没原话可引就照实念数据。
- 弹药对账单照念（不问问题）；锚点对账单照旧：只把 ❓ 的挑出来问我（一次最多两三个）
- 不想做清单固定过一遍：戒条逐条一问（「今天这条守住了吗」——答了就记账，不追问）；怕来不及/防沉迷的条目在对应对账行里顺口带一句我的原话

## 第二幕：一句感想
问我一句：今天有什么感想、搞砸了什么、想变什么？低信息量回答没关系，禁止作文式追问。

## 第三幕：复盘（白天评论+AI 观察）
基于对账+行为画像给预填（每轴最多一句话，没把握就明说）：
- 太松/太紧（各池吃量 vs 配额——参照训练参数，别拿一天说事）
- 增删改不想做（今天有新的不想做的事吗？旧的还成立吗？）
- 拆树/挪枝（结构手术必须我点头，你不动手也不催）
- 拖动确认：对账单里「待确认拖动」逐条顺口问「以后都这样排吗」——点头我会在下一步告诉你记入长期偏好。

## 第四幕：明日弹药
- 各池配比与任务挂载参照训练参数（该日型近几周真实吃量），宁少勿多
- 只有锚点（接送/会议等窗口硬的事）进时刻表；弹性任务只有配额没有时刻——你不再假装知道我下午三点该干嘛
- 软配额全程不拦截：用完显示已消耗、多用显示多用 X 分钟

## 第五幕：点头落三件套（顺序固定，失败从断点重跑自愈）
我点头后，若你能调思源 MCP 工具（routine）：
1. 森林增量：不想做条目增删改（routine.aversion_set）+任务完成勾选（task.complete）
2. 明日象限配置+锚点日程：routine.schedule_set{day:明天, ammo:{pools,tasks}, items:[锚点]}（单次调用内配置先落再落锚点）
- routine.recon_record 记今日锚点对账结果（results=[{key,verdict,note?}]——key/verdict 用对账单里的）
- 我对拖动点了头 → routine.pref_add 记长期偏好（text=一句话）
没有工具就把最终弹药配置完整打出来，我自己维护。收尾一句「已备好，明天见」。

## 红线（不可软化）
- 不评价人——收据不是考卷；不情绪施压（不说坚持/自律/加油）
- 告警/超限措辞只引用我的原话，你从不产生新指责；戒条一问=答了记账不追问
- 不做 streak，断签不追责（昨晚没开交接会=计划已自动顺延，一句带过即可）；禁作文式追问
- 结构手术（拆树/挪枝/删枝）必须我点头后才动，且不在工具面；配弹药任务行只能指向森林真实任务块

## 样例（语气基准）
AI：今天弹药：黄金产出保底 120min 实吃 47min（还差 73min）；维持炉火上限 40min 实吃 77min（多用 37min）。你 09-18 说过「不想天天改 bug」——今天维持炉火吃了 77 分钟。接孩子 ✅、闪卡第 2 波 ✅、锻炼 ❓（没看到运动记录，去了吗？）
你：锻炼下雨没去。bug 那个是帮朋友救急。
AI：好，记下了，不追问。戒条「不想跟人吵架」今天守住了吗？
你：守住了。
AI：好。明天：黄金产出保底 90min（练笔 30+看书 60），维持炉火上限 40min，碎片照弹性。接孩子 16:30 锚点照旧。你今天达成了保底的一半，明天要不要试着凑满？不试也行。
你：先试 90。
AI：好，已备好，明天见。`;

const EN = `# Handoff Meeting (Ammo Depot)

You are my ammo-depot partner, tone = coworker: short sentences, offer choices not pressure, end with "no pressure" style outs, hold up the mirror — never judge. Tonight takes 3 minutes; follow the five acts below, no skipping, don't dump all questions at once.

## Act 1: Reconciliation (ammo spent + the don't-want mirror)
The "Ammo reconciliation sheet" pasted below = per-pool quota vs actually spent (read the overage as-is, no judging — receipts, not exams); "Alerts" quote only my own words from the "Don't want" list — you never invent new accusations; with nothing to quote, just read the data.
- Read the ammo sheet aloud (no questions there); the anchor sheet stays as before: only ask me about the ❓ ones (a couple at a time)
- Walk the don't-want list every night: one question per vow ("did this one hold today?" — record the answer, no follow-up); for fear/swallow items, drop my own words into the matching reconciliation line

## Act 2: One-line reflection
Ask me one thing: any thoughts today, anything that went wrong, anything to change? Low-info answers are fine; no essay-style follow-ups.

## Act 3: Review (daytime comments + your observations)
From the sheets + behavior profile, pre-fill (one sentence each; say so if unsure):
- Too loose / too tight (pool intake vs quota — reference the training params, don't extrapolate from one day)
- Don't-want list edits (anything new today? do the old ones still stand?)
- Tree surgery (splitting/moving branches needs my nod — you don't do it, don't push it)
- Drag confirm: for each line under "Drags awaiting confirm", casually ask "keep it this way from now on?" — if I nod, you'll record it in the next act.

## Act 4: Tomorrow's ammo
- Pool ratios and task mounts reference the training params (real intake for that day-type in recent weeks); fewer beats more
- Only anchors (hard-window things like pickups/meetings) get clock times; elastic tasks have quotas, not times — you no longer pretend to know what I should do at 3pm
- Soft quotas never block: spent shows as spent, extra shows as "X min over"

## Act 5: Write the three pieces on nod (fixed order; on failure re-run from the break, it heals)
After I nod, if you can call SiYuan MCP tools (routine):
1. Forest increments: don't-want list edits (routine.aversion_set) + task completion checks (task.complete)
2. Tomorrow's quadrant config + anchor schedule: routine.schedule_set{day:tomorrow, ammo:{pools,tasks}, items:[anchors]} (within one call the config lands before the anchors)
- routine.recon_record to record today's anchor reconciliation (results=[{key,verdict,note?}] — use the keys/verdicts from the sheet)
- If I nodded on a drag → routine.pref_add to record a long-term preference (text=one line)
Without tools, print the final ammo setup in full and I'll maintain it myself. Close with "loaded, see you tomorrow".

## Hard lines (non-negotiable)
- No judging the person — receipts, not exams; no motivational pressure (no "persist/discipline/you got this")
- Alert/overage wording quotes only my own words — you never invent new accusations; vow check = record the answer, no follow-up
- No streaks; a missed evening is not a fault (the plan auto-rolled forward this morning — mention it once, move on); no essay-style probing
- Tree surgery (split/move/delete branches) only after my explicit nod, and never via tools; ammo task rows may only point at real forest task blocks

## Sample (tone baseline)
AI: Today's ammo: gold floor 120min, took 47min (73min short); hearth cap 40min, took 77min (37min over). You said on 09-18 "no daily bugfixing" — hearth took 77 minutes today. Pickup ✅, flashcards wave 2 ✅, workout ❓ (no activity record — did it happen?)
You: Skipped the workout, rain. The bug thing was a friend's emergency.
AI: Got it, recorded, no follow-up. Vow "no more arguments" — did it hold today?
You: It held.
AI: Good. Tomorrow: gold floor 90min (writing 30 + reading 60), hearth cap 40min, crumbs as they come. Pickup anchor at 16:30 as usual. You made half the floor today — want to try for the full 90 tomorrow? No pressure.
You: Let's try 90.
AI: OK, loaded. See you tomorrow.`;

export function getHandoffPrompt(lang: string): string {
    return !lang || lang.toLowerCase().startsWith("zh") ? ZH : EN; // 空 lang=kernel 读失败兜底中文（与包体一致）
}

// ── 排期规则段（□26 三层分工·提示词层：软知识常量——交接会第四幕与白天重排 plan_context 共用；
//    设计档 §8.1「规则进提示词，情报进工具面，红线进守卫」：启发式是与用户讨论的语义规则，不做硬编码引擎） ──

const RULES_ZH = `## 排期规则（排明日方案/白天重排共用）
- 什么任务排什么时段：深度块（写作/编程/学习）放精力最好的时段；琐事、沟通、杂务放低谷；锻炼/晒太阳放白天
- 节假日怎么排：休=保睡眠锚点+一两件真正想做的事，宁少勿满；调休上班=按工作日结构
- 错峰避让：目标日已有的日历占用（外来事件/硬性约）绕开，前后留缓冲；硬性事先占位，弹性事填缝
- 出门成组+顺路相邻：同一次出门的事排相邻时段；能一次出门办完的合并（顺路）
- 讨论沉淀：用户说「以后出门的事排一起」这类话 → routine.pref_add 记一条长期偏好，下次自动遵守
- 白天崩盘重排：用户任何时点说「崩了/重排」→ routine.plan_context{target_day:今天} 拿 now+今日剩余 → 出方案 → 点头后 routine.schedule_set{day:今天, clear_from:"now", items:剩余时段}——从 now 起不重排全天，已过条目保留当对账证据`;

const RULES_EN = `## Scheduling rules (for tomorrow's plan & daytime replans)
- Right task, right slot: deep blocks (writing/coding/study) in the best-energy hours; chores, comms and errands in the troughs; exercise/sunlight in daytime
- Days off: keep the sleep anchor + one or two things truly wanted — fewer beats more; make-up workdays follow the workday structure
- Steer around existing occupancy: known calendar commitments on the target day (foreign events / fixed appointments) get buffered around; fixed things claim slots first, flexible things fill the gaps
- Group outings + adjacency: things for the same trip go in adjacent slots; merge what one trip can cover (on the way)
- Discussion sediment: when the user says things like "always group the outings" → routine.pref_add to record it as a long-term preference, honored automatically afterwards
- Daytime crash replan: whenever the user says "it's off the rails / replan" → routine.plan_context{target_day:today} for now + today's remainder → propose → on nod, routine.schedule_set{day:today, clear_from:"now", items:remaining slots} — replan from now on, not the whole day; past items stay as reconciliation evidence`;

/** 排期规则段（提示词层软知识；空 lang 与 zh* 同判中文——与 buildHandoffPacket 兜底一致） */
export function getPlanningRules(lang: string): string {
    return !lang || lang.toLowerCase().startsWith("zh") ? RULES_ZH : RULES_EN;
}

// ── 开场包（模板+今日数据一次成型：前端复制/routine.handoff 共用同一份源） ──

export interface HandoffData {
    /** 对账日（交接会盘的对象；通常=今天，深夜开也可能盘今天） */
    day: string;
    recon: ReconItem[];
    /** 待确认拖动（当日） */
    drags: DragRecord[];
    prefs: SchedPref[];
    profile: DayProfile | null;
    /** onboarding 档（sloop □5；null=未开始/坏档=开场包不带身份基色段） */
    onboard?: OnboardStore | null;
    /** 同步回执（期 4=飞书自动存入落块回执；空/缺省=不带该段（今日无自动同步/kernel 刚重启） */
    fsReceipts?: SchedReceipt[];
    /** 今日随手记（sloop □23：执行期时间线行上记的——AI 第二幕「一句感想」顺口融合，别逐条
     *  念清单；undefined/空=不带该段） */
    notes?: FeedbackEntry[];
    /** 训练参数（ammo □5 v2：各池吃量按日型学+异常周感知+结构守卫余量——第四幕明日弹药的
     *  量化参照；undefined/null=不带该段（训练档读失败）） */
    training?: TrainingContext | null;
    /** 弹药对账（ammo □5：配额消耗对账+不想做镜子——森林原话+今日吃量拼接不做评分；
     *  undefined/null=不带段（森林/配置/日账全缺席） */
    ammo?: {
        recon: QuotaRecon;
        mirror: ReturnType<typeof buildMirrorSection>;
        /** 今日象限配置缺席标记（true=对账单注「未配置」） */
        noConfig: boolean;
        config: AmmoDayConfig | null;
    } | null;
}

const WEEKDAYS_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function weekday(day: string, zh: boolean): string {
    const d = new Date(day + "T12:00:00");
    if (Number.isNaN(d.getTime())) return "";
    const idx = (d.getDay() + 6) % 7;
    return zh ? `周${WEEKDAYS_ZH[idx]}` : WEEKDAYS_EN[idx];
}

const V_LABEL_ZH: Record<ReconItem["verdict"], string> = { done: "✅", missed: "❌", unknown: "❓" };
const V_LABEL_EN: Record<ReconItem["verdict"], string> = { done: "✅", missed: "❌", unknown: "❓" };

function fmtSlot(start: string | null, end: string | null): string {
    if (!start) return "";
    return end ? `${start}–${end}` : start;
}

function profileSummary(p: DayProfile | null, zh: boolean): string[] {
    if (!p) return zh ? ["（今日画像暂缺——六路采集首轮未就绪，一小时后自愈；先把班表对完）"] : ["(No behavior profile yet — first collect round pending, self-heals in an hour; reconcile the schedule first)"];
    const lines: string[] = [];
    const topDoc = p.docs[0];
    // O2②：标题空兜底（docs.title 构建=content||hpath||id 恒非空，但归档直通可带空标题——
    // 空则去书名号只念事实，不出《》空形态）
    const docName = topDoc?.title ?? "";
    lines.push(
        zh
            ? `文档 ${p.docs.length} 篇动过${topDoc ? `（编辑最多${docName ? `《${docName}》` : ""}约 ${topDoc.edits} 次）` : ""}；新建 ${p.ops.docsCreated} 篇`
            : `${p.docs.length} docs touched${topDoc ? ` (top edits: ${docName ? `"${docName}" ` : ""}~${topDoc.edits})` : ""}; ${p.ops.docsCreated} created`,
    );
    const topStay = p.stays[0];
    if (topStay) {
        // O2②：tracker docTitle 尽力拿可空（tracker.ts「空=消费侧按 id 对齐画像 docs.title」
        // 契约在此兑现）；对齐不到=去书名号只念时长
        const stayName = topStay.title || p.docs.find((d) => d.id === topStay.id)?.title || "";
        lines.push(zh
            ? `停留最长${stayName ? `《${stayName}》` : ""}约 ${Math.round(topStay.seconds / 60)} 分钟`
            : `Longest stay ${stayName ? `"${stayName}" ` : ""}~${Math.round(topStay.seconds / 60)} min`);
    }
    // O2① 读面兜底：旧档脏小时键（15 位 updated 残值产物 92/60 等）滤除——归档直通不重写，
    // 写面归一只管新采集；滤后键恒两位 00-23，字典序=数值序
    const hours = Object.keys(p.activeHours ?? {}).filter(isHourKey).sort();
    if (hours.length) {
        const peak = hours.reduce((a, b) => (p.activeHours[a] >= p.activeHours[b] ? a : b));
        lines.push(zh ? `活跃 ${hours[0]}–${hours[hours.length - 1]} 点，峰值 ${peak} 点（约 ${p.activeHours[peak]} 次改动）` : `Active ${hours[0]}:00–${hours[hours.length - 1]}:00, peak ${peak}:00 (~${p.activeHours[peak]} edits)`);
    } else if (zh) {
        lines.push("全天无编辑记录");
    } else {
        lines.push("No edits recorded all day");
    }
    const done = p.tasks.filter((t) => t.done).length;
    lines.push(zh ? `任务 ${done}/${p.tasks.length} 勾选；日历 ${p.calendar.length} 条；提醒 ${p.reminders.length} 条` : `Tasks ${done}/${p.tasks.length} checked; ${p.calendar.length} calendar events; ${p.reminders.length} reminders`);
    return lines;
}

export function buildHandoffPacket(lang: string, d: HandoffData): string {
    const zh = !lang || lang.toLowerCase().startsWith("zh");
    const vLabel = zh ? V_LABEL_ZH : V_LABEL_EN;
    const wd = weekday(d.day, zh);
    const alm = d.profile?.almanac;
    const head = zh
        ? `# 今日数据 · ${d.day}${wd ? `（${wd}${alm?.lunarText ? ` · ${alm.lunarText}` : ""}${alm?.off ? " · 休" : alm?.work ? " · 班" : ""}）` : ""}`
        : `# Today's data · ${d.day}${wd ? ` (${wd}${alm?.lunarText ? ` · ${alm.lunarText}` : ""})` : ""}`;

    const sections: string[] = [getHandoffPrompt(lang), "---", head];

    // 锚点对账单（班表=锚点域——三态预填照旧；弹性任务侧对账归弹药对账单）
    sections.push(zh ? "## 锚点对账单（预填三态；❓ 才问我）" : "## Anchor reconciliation sheet (pre-filled; ask only the ❓)");
    if (!d.recon.length) {
        sections.push(zh ? "（今天锚点班表为空——锚点侧跳过对账）" : "(No anchors today — skip the anchor sheet)");
    } else {
        for (const r of d.recon) {
            const slot = fmtSlot(r.start, r.end);
            const hardTag = r.hard ? (zh ? "·硬" : "·fixed") : zh ? "·弹" : "·flex";
            const ev = r.evidence.length ? `（${r.evidence.join("；")}）` : "";
            sections.push(`- ${vLabel[r.verdict]} ${slot ? `${slot} ` : ""}${r.summary} ${hardTag}${ev}`);
        }
    }

    // 弹药对账单+告警+不想做镜子（ammo □5：配额消耗对账——清单原话+今日数据拼接，不做评分）
    if (d.ammo) {
        sections.push(zh ? "## 今日弹药对账单（各池配额 vs 实吃——照实念不评判）" : "## Ammo reconciliation (per-pool quota vs spent — read as-is, no judging)");
        const quotaLines = renderQuotaLines(d.ammo.recon, zh);
        if (quotaLines.length) sections.push(...quotaLines);
        else sections.push(zh ? "（今天各池零吃量、无配额行——弹性任务侧无对账）" : "(No pool intake and no quota rows today — nothing to reconcile on the elastic side)");
        if (d.ammo.noConfig) {
            sections.push(zh ? "（今日无象限配置——配额照吃照记，不评判；第四幕把明天的配上）" : "(No quadrant config today — intake recorded as-is, no judging; set up tomorrow's in Act 4)");
        }
        if (d.ammo.mirror.citations.length || d.ammo.mirror.bareAlerts.length) {
            sections.push(zh ? "## 告警（措辞只引用你的原话，不产生新指责）" : "## Alerts (wording quotes only your own words — no new accusations)");
            sections.push(...d.ammo.mirror.citations, ...d.ammo.mirror.bareAlerts);
        }
        const mirrorLines = [...d.ammo.mirror.vows, ...d.ammo.mirror.fears, ...d.ammo.mirror.swallows];
        if (mirrorLines.length) {
            sections.push(zh ? "## 不想做清单（镜子——对账段固定过一遍）" : "## Don't-want list (the mirror — walk it every reconciliation)");
            sections.push(...mirrorLines);
            sections.push(zh ? "（镜子只递你自己的话+今日数据；戒条答了就记账，不追问。）" : "(The mirror only holds your own words + today's data; vow answers get recorded, no follow-up.)");
        } else if (d.ammo.config || quotaLines.length) {
            sections.push(zh ? "## 不想做清单（镜子）\n（清单为空——今天有新的不想做的事吗？讨论后 aversion_set 落盘）" : "## Don't-want list (the mirror)\n(Empty — anything new you don't want today? Discuss, then aversion_set)");
        }
    }

    // 今日随手记（□23：执行期记的——素材给第二幕「一句感想」顺口融合，不是念清单）
    if (d.notes !== undefined && d.notes.length) {
        sections.push(zh ? "## 今日随手记（执行期记的，第二幕顺口融合）" : "## Quick notes (jotted during the day; weave into Act 2)");
        for (const n of d.notes) {
            const tgt = n.target ? `（→ ${n.target.summary}）` : "";
            sections.push(`- ${n.at} ${n.text}${tgt}`);
        }
        sections.push(zh
            ? "（这是我当天随手记的——第二幕里顺口回应一两句就好（「你今天记了 3 笔，我看到了…」），别逐条念清单）"
            : "(These are my in-the-moment notes — acknowledge them casually in Act 2 (\"you jotted 3 notes, I saw…\"), don't read them out one by one)");
    }

    // 拖动待确认
    sections.push(zh ? "## 待确认拖动" : "## Drags awaiting confirm");
    if (!d.drags.length) {
        sections.push(zh ? "（无）" : "(none)");
    } else {
        for (const g of d.drags) sections.push(`- ${describeDrag(g)}`);
    }

    // 飞书侧改动·已同步回执（□25 完全同步：已自动写回班表，呈现给用户对账+顺口确认偏好）
    if (d.fsReceipts !== undefined && d.fsReceipts.length) {
        sections.push(zh ? "## 飞书侧改动（已自动同步回班表）" : "## Changes on the Feishu side (auto-synced back)");
        for (const f of d.fsReceipts) {
            sections.push(f.kind === "deleted"
                ? (zh ? `- ${f.summary}：事件被删了，本地已同步删除` : `- ${f.summary}: event deleted, removed locally too`)
                : `- ${f.summary}：${f.detail}`);
        }
        sections.push(zh
            ? "（班表已按飞书侧改好；逐条顺口问一句「以后都这样排吗」——点头=pref_add 记长期偏好；被删的问「明天还排吗」，要恢复可按删痕重排）"
            : "(The schedule has been updated to match; ask casually: \"keep it this way from now on?\" — a nod means pref_add; for deleted ones ask \"schedule again tomorrow?\")");
    }

    // 长期偏好
    sections.push(zh ? "## 长期偏好（已生效，排明日时遵守）" : "## Long-term prefs (active; honor them in tomorrow's plan)");
    if (!d.prefs.length) {
        sections.push(zh ? "（无）" : "(none)");
    } else {
        for (const p of d.prefs) sections.push(`- ${p.text}`);
    }

    // 训练参数（ammo □5 v2：各池吃量按日型学+异常周感知+结构守卫余量——第四幕量化参照）
    if (d.training) {
        const t = d.training;
        const KIND_ZH: Record<string, string> = { workday: "工作日", weekend: "周末", holiday: "节假日" };
        const KIND_EN: Record<string, string> = { workday: "workday", weekend: "weekend", holiday: "holiday" };
        const kindName = zh ? KIND_ZH[t.dayKind] ?? t.dayKind : KIND_EN[t.dayKind] ?? t.dayKind;
        const EN_LABEL: Record<AmmoPoolSlug, string> = { gold: "gold", deadline: "deadline", hearth: "hearth", crumbs: "crumbs" };
        sections.push(zh ? "## 训练参数（各池吃量·按日型学）" : "## Training params (per-pool intake, learned per day-type)");
        const poolEntries = Object.entries(t.capacity?.pools ?? {}).filter(([, v]) => v != null) as Array<[AmmoPoolSlug, number]>;
        if (t.capacity && poolEntries.length) {
            const poolBits = poolEntries.map(([slug, v]) => `${zh ? POOL_LABEL[slug] : EN_LABEL[slug]} ${Math.round(v)}min`);
            sections.push(
                zh
                    ? `- 明天是${kindName}：近几周该日型各池日均吃量——${poolBits.join(" / ")}（样本 ${t.capacity.sampleDays} 天）——第四幕配池配比参照这个，宁少勿多`
                    : `- Tomorrow is a ${kindName}: recent per-pool daily intake — ${poolBits.join(" / ")} (${t.capacity.sampleDays} sample days) — size tomorrow's pool ratios accordingly; fewer beats more`,
            );
        } else {
            sections.push(zh ? `- 明天是${kindName}：该日型还没有池吃量参数（样本不足）——按今天实际吃量配，宁少勿多` : `- Tomorrow is a ${kindName}: no pool intake learned yet for this day-type — size it on today's actuals; fewer beats more`);
        }
        const devs = t.structure.deviations.length ? `（${t.structure.deviations.join("；")}）` : "";
        sections.push(
            zh
                ? `- 本周锚点变动已用 ${t.structure.used}/${t.structure.limit}${devs}——结构慢变：再超出的方案写不进（工具会拒并说明超在哪）`
                : `- Anchor changes used this week: ${t.structure.used}/${t.structure.limit}${devs ? ` (${t.structure.deviations.join("; ")})` : ""} — structure changes slowly; the guard rejects plans that go over`,
        );
        if (t.anomaly) {
            const hint = t.anomaly.hits.length ? `（${t.anomaly.hits[0].slice(0, 30)}…）` : "";
            sections.push(
                zh
                    ? `- 最近一周（${t.anomaly.weekStart} 起）已标记为异常周${hint}——那一周的数据没进训练参数；今晚也先不问「更进一步」（异常周别学）`
                    : `- The week of ${t.anomaly.weekStart} was flagged anomalous${hint} — its data is excluded from learning; skip the "push further" question tonight`,
            );
        }
    }

    // 排期规则段（□26：第四幕明日方案的软知识——白天崩盘重排走 plan_context 同一份规则）
    sections.push(getPlanningRules(lang));

    // 身份基色（sloop □5：onboarding 挑的身份=排班方向参照，铁律 11 只做方向指引不做计分）
    const arch = d.onboard ? getArchetype(d.onboard.archetypeId) : null;
    if (d.onboard && arch) {
        sections.push(zh ? "## 身份基色（方向参照，不是考卷）" : "## Identity base (directional reference, not a scorecard)");
        const anchors = arch.anchors.map((an) => `${an.label.zh} ${an.start}${an.end ? `–${an.end}` : ""}（${an.hard ? "硬" : "弹"}）`).join(" / ");
        const anchorsEn = arch.anchors.map((an) => `${an.label.en} ${an.start}${an.end ? `–${an.end}` : ""} (${an.hard ? "fixed" : "flex"})`).join(" / ");
        sections.push(zh ? `- 身份：${arch.name.zh}（${chronoLabel(arch.chrono, true)}）；锚点基色：${anchors}` : `- Identity: ${arch.name.en} (${chronoLabel(arch.chrono, false)}); base anchors: ${anchorsEn}`);
        sections.push(zh ? `- 构造依据：${arch.stageNote.zh}；冲突容忍：${arch.conflictAnchor.zh}` : `- Rationale: ${arch.stageNote.en}; crunch fallback: ${arch.conflictAnchor.en}`);
        if (d.onboard.constraints.wake) sections.push(zh ? `- 用户口述：通常 ${d.onboard.constraints.wake} 起床${d.onboard.constraints.sleep ? `、${d.onboard.constraints.sleep} 入睡` : ""}` : `- Self-reported: usually up at ${d.onboard.constraints.wake}${d.onboard.constraints.sleep ? `, asleep by ${d.onboard.constraints.sleep}` : ""}`);
        for (const n of d.onboard.constraints.notes ?? []) sections.push(`- ${n}`);
    }

    // 画像摘要
    sections.push(zh ? "## 今日行为画像摘要" : "## Behavior profile digest");
    sections.push(...profileSummary(d.profile, zh));

    return sections.join("\n\n");
}
