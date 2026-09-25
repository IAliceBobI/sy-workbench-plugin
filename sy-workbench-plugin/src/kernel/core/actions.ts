// 主文档「## 动作」段（□2 项目动作子系统）：声明式动作清单的解析/回写纯函数。
// 轻结构列表项 `- 名称 | 命令`——人可读可编辑、AI 经 MCP 可读写（tasks.json 思源版）。
// 消费方：kernel project.get/set_actions 与前端驾驶舱动作区（同源解析，两侧渲染永不漂移）。
// 纯逻辑零 siyuan 依赖（kernel bundle import 前端纯模块纪律）。

export const ACTIONS_HEADING = "## 动作";

/** 白名单首 token：点击直接执行。play=思源内打开（视频/资产）并 seek，不起外部进程 */
const WHITELIST = ["code", "open", "mpv", "play"];

export type ActionKind =
    /** 可执行动作 */
    | "action"
    /** 注释行（label 以（开头或无竖线）——驾驶舱浅色提示展示 */
    | "comment"
    /** 坏行：竖线后空命令/引号不配平——就地提示「无法解析」 */
    | "bad";

export interface ParsedAction {
    kind: ActionKind;
    /** 段内原始行（剥 IAL 后）——写侧用它匹配列表项块 id（记进度/set_actions 定位块） */
    rawLine: string;
    /** action=按钮名；comment/bad=行原文（提示展示） */
    label: string;
    /** action：竖线右侧原始命令文本 */
    command: string;
    /** action：引号感知分词产物 */
    tokens: string[];
    /** action：首 token */
    program: string;
    /** --start= 解析出的秒数（视频从哪开始看） */
    startSeconds?: number;
    /** 首 token 是否白名单（false=点击须弹确认显示命令全文） */
    whitelisted: boolean;
    /** 是否需要起外部进程（play=false——openTab 前端 API 即可，浏览器版也能用） */
    desktopOnly: boolean;
    /** play 目标：文档块 id 或 assets/ 路径 */
    playTarget?: string;
}

/** kramdown IAL 剥离（`{: id="…"}` 家族）。文档 kramdown 里列表项 IAL 是**内嵌**的
 *  （`- {: id="…"}内容`），行尾锚定剥不全——统一全行剥；
 *  导出供写侧做「文档行 ↔ 块表 markdown 列」归一化匹配（SQL markdown 列本身无 IAL，剥=恒等） */
export function stripIal(line: string): string {
    return line.replace(/\s*\{:[^}]*\}/g, "").trimEnd();
}

/** 文档 markdown → 「## 动作」段体（到下一个 ## 截止）；无段=null（动作区不显示） */
export function extractActionsSection(md: string): string | null {
    const lines = md.split(/\r?\n/);
    let inSection = false;
    const out: string[] = [];
    for (const raw of lines) {
        const bare = stripIal(raw).trim();
        if (/^##\s/.test(bare)) {
            if (inSection) break;
            if (/^##\s*动作$/.test(bare)) inSection = true;
            continue;
        }
        if (inSection) out.push(raw);
    }
    return inSection ? out.join("\n") : null;
}

/** 引号感知分词（双/单引号包裹含空格参数）；引号不配平 throw（坏行判定用） */
export function tokenizeCommand(cmd: string): string[] {
    const tokens: string[] = [];
    let cur = "";
    let quote: string | null = null;
    let has = false;
    const push = (): void => {
        if (has) {
            tokens.push(cur);
            cur = "";
            has = false;
        }
    };
    for (const ch of cmd) {
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            has = true;
        } else if (/\s/.test(ch)) {
            push();
        } else {
            cur += ch;
            has = true;
        }
    }
    if (quote) throw new Error("unbalanced quote");
    push();
    return tokens;
}

/** --start 值：HH:MM:SS / MM:SS / 纯秒 → 秒；非法→undefined */
export function parseStartValue(v: string): number | undefined {
    const m = /^(\d+)(?::(\d+))?(?::(\d+))?$/.exec(v.trim());
    if (!m) return undefined;
    if (m[2] === undefined) return Number(m[1]);
    if (m[3] === undefined) return Number(m[1]) * 60 + Number(m[2]);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 秒 → HH:MM:SS（回写 --start 用，与解析往返一致） */
export function formatStartValue(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function findStartSeconds(tokens: string[]): number | undefined {
    for (const t of tokens) {
        if (t.startsWith("--start=")) return parseStartValue(t.slice("--start=".length));
    }
    return undefined;
}

const EMPTY_ACTION: Omit<ParsedAction, "kind" | "label" | "rawLine"> = {
    command: "",
    tokens: [],
    program: "",
    whitelisted: false,
    desktopOnly: true,
};

/** 单行解析：列表项→action/comment/bad；任务项/段落/空行→null（非本段关心的行）。
 *  `\s*` 宽松=文档 kramdown 列表项 IAL 内嵌（`- {: id=…}内容`）剥除后 dash 与内容间无空格；
 *  rawLine 归一化为 `- 内容`（与块表 markdown 列同形，写侧匹配依赖） */
export function parseActionLine(line: string): ParsedAction | null {
    const bare = stripIal(line).trimEnd();
    const m = /^-\s*(.+)$/.exec(bare);
    if (!m) return null;
    const content = m[1].trim();
    const rawLine = `- ${content}`;
    if (/^\[[ xX]\]\s/.test(content)) return null; // 任务项归任务段语义
    const pipe = content.indexOf("|");
    if (pipe === -1) return { kind: "comment", label: content, rawLine, ...EMPTY_ACTION };
    const label = content.slice(0, pipe).trim();
    const command = content.slice(pipe + 1).trim();
    if (label.startsWith("（")) return { kind: "comment", label: content, rawLine, ...EMPTY_ACTION };
    if (!command) return { kind: "bad", label: content, rawLine, ...EMPTY_ACTION };
    let tokens: string[];
    try {
        tokens = tokenizeCommand(command);
    } catch {
        return { kind: "bad", label: content, rawLine, ...EMPTY_ACTION };
    }
    if (tokens.length === 0) return { kind: "bad", label: content, rawLine, ...EMPTY_ACTION };
    const program = tokens[0];
    return {
        kind: "action",
        rawLine,
        label,
        command,
        tokens,
        program,
        startSeconds: findStartSeconds(tokens),
        whitelisted: WHITELIST.includes(program),
        desktopOnly: program !== "play",
        ...(program === "play" && tokens[1] ? { playTarget: tokens[1] } : {}),
    };
}

/** 文档 markdown → 段内全部条目（保序；无段=空数组） */
export function parseActionsSection(md: string): ParsedAction[] {
    const body = extractActionsSection(md);
    if (!body) return [];
    const out: ParsedAction[] = [];
    for (const line of body.split(/\r?\n/)) {
        const a = parseActionLine(line);
        if (a) out.push(a);
    }
    return out;
}

/** 含空格/引号的参数回写时重新加引号（双引号包裹） */
function quoteToken(t: string): string {
    return /[\s'"]/.test(t) ? `"${t.replace(/"/g, "")}"` : t;
}

/** 回写 --start：已有则原地换值，没有则追加行尾（解析扫全 token 不受位置影响）。返回新命令文本 */
export function rewriteStart(tokens: string[], seconds: number): string {
    const val = `--start=${formatStartValue(seconds)}`;
    const idx = tokens.findIndex((t) => t.startsWith("--start="));
    const out = idx >= 0 ? tokens.map((t, i) => (i === idx ? val : t)) : [...tokens, val];
    return out.map(quoteToken).join(" ");
}

/** 写入用动作行构造（label 竖线/换行剥除——竖线是分隔符、换行会拆块） */
export function buildActionLine(label: string, command: string): string {
    const cleanLabel = label.replace(/[|\r\n]/g, " ").trim();
    const cleanCmd = command.replace(/[\r\n]/g, " ").trim();
    return `- ${cleanLabel} | ${cleanCmd}`;
}
