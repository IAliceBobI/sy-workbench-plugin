// ammo □2：日账打点条目 ↔ 日记列表块 的纯函数映射层。
// 契约=docs/ammo-concept.md B2.4/B2.5/B3（词表冻结）：start/end=HH:mm；end 缺失/空串=未闭合
// （崩溃恢复判据）；跨零点（end<start）读面 +24h 归一；容器识别=custom-role=ammo-ledger。
// dataview □2（契约 §8 修订 3）：行文本升为真相——条目文本=`HH:mm-HH:mm 摘要`=闭合 /
// `HH:mm- 摘要`=进行中；读面文本优先、属性兜底（老条目零迁移：纯 summary 旧文本按属性认）；
// 引擎写链双写保持（文本+属性缓存）；解析失败的行=忽略+收集（□8 体检素材）。
// 确定性全键输出（缺省键=空串，setBlockAttrs 合并写删键语义）；零宽空格归一（内核空块
// content=\u200b）。pool/task/anchor 无自然文本形态——留属性（契约 §2/§3）。

/** 日账容器识别属性值（挂 custom-role；sched-board 同款先例） */
export const AMMO_LEDGER_ROLE_VALUE = "ammo-ledger";

/** 日账区装饰标题（纯展示不挂属性；缺失才补，恒在容器前） */
export const LEDGER_TITLE = "## 日账";

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 感想子块（打点条目 append-only 子块；text=纯文本归一后） */
export interface AmmoReflection {
    id: string;
    text: string;
}

/** 结构化打点条目（读面形态：UI 渲染与 AI 消费共用） */
export interface AmmoLedgerEntry {
    /** 打点条目块 id（闭合/感想挂载的锚） */
    id: string;
    /** 任务名（纯 summary；空串=合法真值） */
    summary: string;
    start: string | null;
    /** HH:mm；null=未闭合（end 键缺失/空串/坏值） */
    end: string | null;
    closed: boolean;
    /** 池 slug（空串=锚点出发型/无池临时） */
    pool: string;
    /** 树任务块 id（锚点出发型=班表锚点条目块 id；空串=临时事项） */
    task: string;
    /** 锚点出发型打点（一键「出发」） */
    anchor: boolean;
    /** 闭合段时长（分钟，跨零点 +24h 归一）；未闭合=null */
    durationMin: number | null;
    /** 感想子块（容器序=append 序） */
    reflections: AmmoReflection[];
}

/** 块文本归一：trim+剔零宽空格（内核空块 content=\u200b——trim 剔不掉；schedboard 同款） */
function stripZeroWidth(s: string | null | undefined): string {
    return (s ?? "").replace(/\u200b/g, "").trim();
}

/** 开始打点→块属性：确定性全键输出（end 显式空串=未闭合语义落在键上——合并写不残留） */
export function ammoStartAttrs(p: { start: string; pool?: string; task?: string; anchor?: boolean }): Record<string, string> {
    return {
        "custom-ammo-start": p.start,
        "custom-ammo-end": "",
        "custom-ammo-pool": p.pool ?? "",
        "custom-ammo-task": p.task ?? "",
        "custom-ammo-anchor": p.anchor ? "1" : "",
    };
}

/** 时长分钟差：任一非法→null；end<start=跨零点（次日，+24h 归一——账随开始日不迁移） */
export function ledgerDurationMin(start: string | null | undefined, end: string | null | undefined): number | null {
    if (typeof start !== "string" || typeof end !== "string" || !HM_RE.test(start) || !HM_RE.test(end)) return null;
    const toMin = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
    const d = toMin(end) - toMin(start);
    return d < 0 ? d + 24 * 60 : d;
}

/** 块属性→结构化条目（dataview □2 起文本优先）：行文本=时刻头（`09:00-10:30 摘要`/`14:00- 摘要`）
 *  →start/end/summary 全从文本认（文本赢——人刚改过=最新意图，属性是机器缓存）；文本非时刻行
 *  →属性兜底（老条目零迁移：无合法 custom-ammo-start→null=容器内非打点 li，读面跳过）；
 *  end 缺失/空串/坏值→未闭合（B2.4「缺失/空串=未闭合」宽容面：坏值归 null 不炸读链）。
 *  pool/task/anchor 恒从属性（无文本形态）。reflections 由编排层填（纯层无 IO）。 */
export function attrsToLedgerEntry(
    id: string,
    content: string | null | undefined,
    attrs: Record<string, string> | null | undefined,
): AmmoLedgerEntry | null {
    const pool = attrs?.["custom-ammo-pool"];
    const task = attrs?.["custom-ammo-task"];
    const anchor = attrs?.["custom-ammo-anchor"] === "1";
    const text = parseLedgerText(content);
    if (text) {
        return {
            id,
            summary: text.summary,
            start: text.start,
            end: text.end,
            closed: text.end !== null,
            pool: typeof pool === "string" ? pool : "",
            task: typeof task === "string" ? task : "",
            anchor,
            durationMin: text.end === null ? null : ledgerDurationMin(text.start, text.end),
            reflections: [],
        };
    }
    const start = attrs?.["custom-ammo-start"];
    if (typeof start !== "string" || !HM_RE.test(start)) return null;
    const endRaw = attrs?.["custom-ammo-end"] ?? "";
    const end = HM_RE.test(endRaw) ? endRaw : null;
    return {
        id,
        summary: stripZeroWidth(content),
        start,
        end,
        closed: end !== null,
        pool: typeof pool === "string" ? pool : "",
        task: typeof task === "string" ? task : "",
        anchor,
        durationMin: end === null ? null : ledgerDurationMin(start, end),
        reflections: [],
    };
}

// ── 行文本语法（dataview □2：文本即真相的读/写两半） ──

/** 引擎写面：条目行文本（start 必填；end null=进行中「14:00-」；summary 压单行）。 */
export function ledgerEntryText(start: string, end: string | null | undefined, summary: string): string {
    const head = `${start}-${end ?? ""}`;
    const s = (summary ?? "").replace(/\s+/g, " ").trim();
    return s ? `${head} ${s}` : head;
}

/** 时刻头文本解析产物：end=null=进行中（「14:00-」尾悬挂） */
export interface LedgerTextParse {
    start: string;
    end: string | null;
    summary: string;
}

/** 行文本→时刻头（读面纯半边）：`09:00-10:30 摘要`=闭合 / `14:00- 摘要`/`14:00-`=进行中；
 *  摘要与时刻头紧贴（CJK 无空格习惯）容忍。非时刻行（老条目纯 summary/用户散文/时刻后
 *  接时刻形的坏行）→null（属性兜底或 □8 收集）。严格 HH:mm（宁可少认：`9:00-`/全角冒号
 *  不认——体检可见，格式对就认的「对」=引擎同款）。 */
export function parseLedgerText(content: string | null | undefined): LedgerTextParse | null {
    const t = stripZeroWidth(content);
    if (!t) return null;
    const closed = /^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)\s*(.*)$/.exec(t);
    if (closed) return { start: closed[1], end: closed[2], summary: closed[3].trim() };
    const open = /^((?:[01]\d|2[0-3]):[0-5]\d)-\s*(.*)$/.exec(t);
    // 开放形尾部又像时刻（`09:00- 10:30摘要` 闭合形乱加空格）=坏行——不误认成进行中
    if (open && !/^[0-2]\d:[0-5]\d/.test(open[2])) return { start: open[1], end: null, summary: open[2].trim() };
    return null;
}

/** kramdown 首行→行文本（stop 闭合重写的复核读半边）：取首行（li 带感想子块时 kramdown 多行
 *  ——子块行不掺和）+剥列表标记/任务标记+剥内联 IAL。⚠IAL 前后两形都剥：内核 kramdown 对
 *  带属性的 li 实际输出 IAL 前置（`- {: id=… custom-…}14:00- 练笔`，6808 实测 09-21 收官
 *  e2e 实锤——只剥行尾形=前置 IAL 漏进 summary，闭合文本被拼成 `HH:mm-HH:mm {: id=…}…`
 *  脏形态落盘）；行尾形（无属性窗/其他块形）保留兼容。 */
export function ledgerTextFromKramdown(kramdown: string): string {
    const firstLine = (kramdown ?? "").split("\n", 1)[0] ?? "";
    return firstLine
        .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, "")
        .replace(/^\s*\{:[^{}]*\}\s*/, "")
        .replace(/\s*\{:[^{}]*\}\s*$/, "")
        .replace(/\u200b/g, "")
        .trim();
}

/** 未认行收集入参（编排层 IO 收集——读链/□8 体检共用同一纯函数） */
export interface LedgerLineInput {
    id: string;
    content: string | null;
    attrs?: Record<string, string> | null;
}

export interface LedgerLinesRead {
    entries: AmmoLedgerEntry[];
    /** 未认行原文（非空且文本/属性双通道都不认——□8 体检素材；空行静默跳过） */
    unrecognized: string[];
}

/** 容器行批解析（读链与 □8 体检的同一判官：条目=文本/属性双源；其余=未认收集） */
export function parseLedgerEntries(lines: LedgerLineInput[]): LedgerLinesRead {
    const entries: AmmoLedgerEntry[] = [];
    const unrecognized: string[] = [];
    for (const l of lines) {
        const e = attrsToLedgerEntry(l.id, l.content, l.attrs);
        if (e) {
            entries.push(e);
            continue;
        }
        const t = stripZeroWidth(l.content);
        if (t) unrecognized.push(t);
    }
    return { entries, unrecognized };
}

/** 容器识别：attrs.custom-role === ammo-ledger */
export function isAmmoLedgerAttrs(attrs: Record<string, string> | null | undefined): boolean {
    return attrs?.["custom-role"] === AMMO_LEDGER_ROLE_VALUE;
}
