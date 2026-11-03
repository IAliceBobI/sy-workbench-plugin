// kernel 侧副作用层：全部 siyuan.client.fetch / siyuan.storage 调用收口于此。
// core/ 纯逻辑零 siyuan 依赖；tools handler 只编排本模块（单测 mock 边界）。
// goja 无 fetch/setTimeout/console——唯一外联通道 siyuan.client.fetch（path 须 / 开头）。
import { parseListItemId } from "./core/schedboard";
// 循环依赖说明：loki.ts 反向 import 本模块的 proxyRequest——两侧均函数体内调用（非顶层执行），
// rollup/vitest 线性化下安全；打点通道唯一（kernelLog），勿为避环复制 loki 逻辑。
import { kernelLog } from "./loki";

interface KernelResp {
    code: number;
    msg: string;
    data: any;
}

/** kernel API POST 通用通道（behavior 等编排层共用：code!=0 throw） */
export async function post(path: `/${string}`, body: Record<string, any>): Promise<any> {
    const resp = await siyuan.client.fetch(path, {
        method: "POST",
        body: JSON.stringify(body),
    });
    const json = (await resp.json()) as KernelResp;
    if (json.code !== 0) throw new Error(`${path}: ${json.msg}`);
    return json.data;
}

export async function sql<T = any>(stmt: string): Promise<T[]> {
    return (await post("/api/query/sql", { stmt })) as T[];
}

export interface BlockRow {
    id: string;
    content: string;
    markdown?: string;
    updated: string;
    root_id: string;
    box?: string;
    path?: string;
    hpath?: string;
    type?: string;
    subtype?: string;
}

export async function getBlockRow(id: string): Promise<BlockRow | null> {
    const rows = await sql<BlockRow>(`SELECT * FROM blocks WHERE id='${id}'`);
    return rows[0] ?? null;
}

// ── 建档双通道（思源 3.8.9 寻址适配；方案=docs/addr-adapt/master-spec.md §2，决策六项已拍板）──
// 旧端点 createDocWithMd 优先（干净路径行为与 3.8.8 一致：hpath 自动补层+同名静默认领）；
// 命中 legacy 拒绝（data.reason=legacyPathUnsupported/pathAmbiguous/indexUnavailable）或端点被删
// （HTTP 404/响应非 JSON）→ 按路径记拒绝集后切新端点 createDocByParent（parentID 寻址、不补层）；
// 穷尽后显式 throw DocCreateError。本插件调用点全部=C 档（parentID 在手）或根级（缺省=null），
// 无 A 档逐级解析需求（周报「照镜子」层走 report.ts 显式 ensure，见 impl §5）。

/** 思源式块 id：yyyymmddhhmmss-xxxxxxx（内核 IsNodeIDPattern 严校验；goja 无 Lute.NewNodeID
 *  ——自实现，recite kernel/api.ts 同款） */
export function newNodeID(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    let rnd = "";
    for (let i = 0; i < 7; i++) rnd += Math.floor(Math.random() * 36).toString(36);
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`;
}

/** 建档族穷尽失败（决策 §4.1：只建档族 throw 显式化，post 对外语义不动）。
 *  message 含内核 msg——现有收口面（wrapHandler/{ok:false,error}/logger.error）按
 *  String(e.message) 消费的契约不破；reason/commitState/docID 供细查（committed=已落盘勿盲目重试）。 */
export class DocCreateError extends Error {
    readonly reason: string;
    readonly commitState: string;
    readonly docID?: string;
    constructor(reason: string, lastMsg: string, commitState = "none", docID?: string) {
        super(`${lastMsg}${reason ? ` [${reason}]` : ""}`);
        this.name = "DocCreateError";
        this.reason = reason;
        this.commitState = commitState;
        this.docID = docID;
    }
}

/** callFull 返回形态（不 throw——双通道判定要看完整信封；endpointGone=端点被删形态） */
interface FullResp {
    code: number;
    msg: string;
    data: any;
    endpointGone: boolean;
}

/** 建档族专用完整响应通道：json 解析不 throw。endpointGone=HTTP 404 或响应非 JSON
 *  （附加加固：端点被删形态视同 legacy 信号切新通道，不留死角）；client.fetch 本身
 *  reject（网络层异常）照常上抛——那是通道故障不是端点形态。 */
async function callFull(path: `/${string}`, body: Record<string, any>): Promise<FullResp> {
    const resp = await siyuan.client.fetch(path, {
        method: "POST",
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        return { code: -1, msg: `${path}: HTTP ${resp.status}`, data: null, endpointGone: resp.status === 404 };
    }
    let json: any;
    try {
        json = JSON.parse(await resp.text());
    } catch {
        return { code: -1, msg: `${path}: non-JSON response (endpoint removed?)`, data: null, endpointGone: true };
    }
    return {
        code: typeof json?.code === "number" ? json.code : -1,
        msg: String(json?.msg ?? ""),
        data: json?.data,
        endpointGone: false,
    };
}

/** 旧端点的 legacy 拒绝信号（contract §6/§3：路径级判定——该路径候选脏且无干净/歧义/索引未就绪） */
const LEGACY_REASONS = new Set(["legacyPathUnsupported", "pathAmbiguous", "indexUnavailable"]);
function isLegacyRejection(r: FullResp): boolean {
    if (r.endpointGone) return true;
    return LEGACY_REASONS.has(String(r?.data?.reason ?? ""));
}

/** 按路径记的旧端点拒绝集（决策 §4.2：Set<"notebook|path">、≤128 条 FIFO、模块级=
 *  插件重载清零、不持久化——同路径二访直走新通道，异路径仍先试旧通道） */
const legacyRejected = new Set<string>();
const LEGACY_REJECT_MAX = 128;
function markLegacyRejected(notebook: string, path: string): void {
    const key = `${notebook}|${path}`;
    if (legacyRejected.has(key)) return;
    while (legacyRejected.size >= LEGACY_REJECT_MAX) {
        const oldest = legacyRejected.values().next().value;
        if (oldest === undefined) break;
        legacyRejected.delete(oldest);
    }
    legacyRejected.add(key);
}

/** 测试专用：清拒绝集（生产勿调） */
export function __resetLegacyRejected(): void {
    legacyRejected.clear();
}

/** 新端点标题净化（对齐旧端点防劈层纪律，contract §10）：/→全角／（新端点合法但含 /
 *  标题令整条旧寻址链变 Unsupported=制造 legacy 脏数据）、控制符→空格、两端 trim（3.8.9
 *  createDocByParent invalidTitle 拒前导/尾随空白——含全角空格 U+3000，JS .trim() 全覆盖，
 *  句中空白无碍；trim 须在控制符→空格替换之后，否则替出的空格漏网）、超 512 rune 截断
 *  （旧端点静默截断对齐，新端点 invalidTitle 拒——截断防 throw；截断点可恰落空白——
 *  出口再 trim 钉死两端净）。trim 后空串=createDocSmart 空检查快速失败。 */
function sanitizeTitleForNew(title: string): string {
    let t = title.replace(/\//g, "／").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    const chars = [...t];
    if (chars.length > 512) {
        t = chars.slice(0, 512).join("").trim();
        kernelLog("addr", `createDocByParent title 超 512 rune 截断（原长 ${chars.length}）`);
    }
    return t;
}

/** hpath 尾段=新端点标题（C 档 parentID 已指父，hpath 其余段仅供旧端点） */
function splitTailTitle(path: string): string {
    const segs = path.split("/").filter((s) => s.length > 0);
    return segs.length ? segs[segs.length - 1] : "";
}

/** 旧端点 code=0 的 data 兜底序（评审#2：code=0=文档已落盘，误判失败诱重试=建重复文档）：
 *  data 裸 id → 回填 opts.id（预生成 id 已随文档落盘最稳）→ SQL 回查 → 索引窗内查不到
 *  =返 ""+留痕（显式 throw 只留给寻址被拒，维持旧静默契约）。 */
async function pickLegacyId(data: any, presetId: string | undefined, notebook: string, path: string): Promise<string> {
    if (typeof data === "string" && data) return data;
    if (presetId) return presetId;
    const esc = path.replace(/'/g, "''");
    try {
        const rows = await sql(`SELECT id FROM blocks WHERE type='d' AND box='${notebook}' AND hpath='${esc}' LIMIT 1`);
        if (rows?.[0]?.id) return rows[0].id;
    } catch { /* 查询失败走索引窗口径 */ }
    kernelLog("addr", `createDocWithMd code=0 但 data 空（索引窗）→ 返空串不重试: ${path}`);
    return "";
}

/** 新端点可重试失败（父级并发变动/乐观锁失配/预生成 id 冲突——重试一次，仍败 throw） */
const NEW_RETRY_REASONS = new Set(["parentUnavailable", "planChanged", "documentIDConflict"]);

/** 建档双通道主入口（方案 §2.2 createDocSmart 的 workbench C 档形态）。
 *  返回新文档 id 字符串——新端点 {id,document} 封内解包，13 个调用点零迁移。
 *  kernel 侧无锁（残留并发窗口诚实接受，spec §2.1——nameConditions 乐观锁属 A 档解析链，
 *  C 档 parentID 直给不携带；上层 ensure* 幂等先查后建兜底）。 */
async function createDocSmart(
    notebook: string,
    hpath: string,
    markdown: string,
    opts: { id?: string; parentID?: string } = {},
): Promise<string> {
    if (opts.parentID === "") {
        throw new Error("createDocWithMd: parentID 空串非法（undefined/缺省=笔记本根）");
    }
    const path = hpath.startsWith("/") ? hpath : `/${hpath}`;
    // 标题生成即净化（含两端 trim）：全空白末段 trim 后空串=快速失败同「无标题段」语义，
    // 不带空白发请求吃内核 invalidTitle 往返；旧通道 path 原样（3.8.9 起旧端点已全禁恒拒）
    const title = sanitizeTitleForNew(splitTailTitle(path));
    if (!title) throw new Error(`createDocWithMd: path 无标题段: ${path}`);

    // 旧端点优先（该路径不在拒绝集）
    const legacyKey = `${notebook}|${path}`;
    if (!legacyRejected.has(legacyKey)) {
        const r = await callFull("/api/filetree/createDocWithMd", {
            notebook,
            path,
            markdown,
            ...(opts.parentID !== undefined ? { parentID: opts.parentID } : {}),
        });
        if (r.code === 0) return pickLegacyId(r.data, opts.id, notebook, path);
        if (isLegacyRejection(r)) {
            markLegacyRejected(notebook, path);
            const why = r.endpointGone ? "endpointGone" : String(r.data?.reason ?? "?");
            kernelLog("addr", `createDocWithMd 拒绝（${why}）切新通道: ${path}`);
        } else {
            throw new DocCreateError(String(r.data?.reason ?? ""), `${path}: ${r.msg}`);
        }
    }

    // 新端点 createDocByParent（未知字段零携带——DisallowUnknownFields；根级 parentID=null 键必须在）
    let last: FullResp | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const id = attempt === 0 ? (opts.id ?? newNodeID()) : newNodeID();
        const r = await callFull("/api/filetree/createDocByParent", {
            notebook,
            parentID: opts.parentID ?? null,
            id,
            title: { format: "plain", text: title },
            markdown,
        });
        if (r.code === 0) {
            // 解包 {id,document}（⑤ 坑）——data.id 空兜底=回填请求 id（code=0=已建成的最稳凭据）
            const newId = typeof r.data?.id === "string" && r.data.id ? r.data.id : id;
            kernelLog("addr", `createDocByParent ok: ${path} → ${newId}`);
            return newId;
        }
        last = r;
        if (r.data?.commitState === "committed" && typeof r.data?.id === "string" && r.data.id) {
            // 已落盘当成功（排序/模板阶段失败——盲目重试=重复建档，contract §3.1）
            kernelLog("addr", `createDocByParent commitState=committed 认成功: ${path} → ${r.data.id}`);
            return r.data.id;
        }
        const reason = String(r.data?.reason ?? "");
        if (attempt === 0 && NEW_RETRY_REASONS.has(reason)) {
            kernelLog("addr", `createDocByParent ${reason} 重试一次: ${path}`);
            continue;
        }
        break;
    }
    const d = last?.data;
    throw new DocCreateError(
        String(d?.reason ?? ""),
        `${path}: ${last?.msg ?? "unknown"}`,
        String(d?.commitState ?? "none"),
        typeof d?.id === "string" ? d.id : undefined,
    );
}

/** 文档树上建文档；返回 docId。⚠️ markdown 含围栏时须裸 ;;; 闭合（围栏吞尾坑）。
 *  parentID：同级同名孪生时 hpath 解析有歧义（kernel GetBlockTreeRootByHPath 撞名命中哪个不定），
 *  指定父文档 id 精确定位（kernel/api/filetree.go parentID 入参，issue 8138）——新通道
 *  （createDocByParent）上即主寻址入参。3.8.9 寻址适配：内部走双通道（见上），对外签名/返回不变；
 *  寻址被拒穷尽后 throw（此前直调报错同样 throw——语义等价冒泡，收口面零改动）。 */
export async function createDocWithMd(
    notebook: string,
    path: string,
    markdown: string,
    parentID?: string,
): Promise<string> {
    return createDocSmart(notebook, path, markdown, { parentID });
}

/** 目录直接子文档（walk 文件系统真相，不走 SQL 索引——破坏性守卫专用通道，索引窗口 3~10s 坑不住它）。
 *  ⚠️ 空目录时内核回 data=null（非 {files:[]}），调用方须空值防护（dev 6809 实测）。 */
export async function listDocsByPath(notebook: string, path: string): Promise<{ files: any[] } | null> {
    return (await post("/api/filetree/listDocsByPath", { notebook, path })) as { files: any[] } | null;
}

/** 笔记本列表（主线定位的文件树兜底链用——SQL 索引窗内假零时逐 open 本直查顶层） */
export async function lsNotebooks(): Promise<{ notebooks: any[] } | null> {
    return (await post("/api/notebook/lsNotebooks", {})) as { notebooks: any[] } | null;
}

/** data 恒 null 非 failure（siyuan.call null 契约）；写后不广播 */
/** IAL 直读（恒新鲜——attributes SQL 立读窗口闪回旧值家族，判生死一律走此通道） */
export async function getBlockAttrs(id: string): Promise<Record<string, string> | null> {
    return (await post("/api/attr/getBlockAttrs", { id })) as Record<string, string> | null;
}

export async function setBlockAttrs(id: string, attrs: Record<string, string>): Promise<void> {
    await post("/api/attr/setBlockAttrs", { id, attrs });
}

/** /api/block/updateBlock（HTTP transactions 假成功坑的绕行正道） */
export async function updateBlockMarkdown(id: string, markdown: string): Promise<void> {
    await post("/api/block/updateBlock", { id, dataType: "markdown", data: markdown });
}

/** /api/block/deleteBlock（真删无 confirm——调用方须先定位复核目标块，防误删红线） */
export async function deleteBlock(id: string): Promise<void> {
    await post("/api/block/deleteBlock", { id });
}

/** 文档/块全文 kramdown（IAL 直读族——blocks.markdown 列对文档行恒空，正文在子块） */
export async function getBlockKramdown(id: string): Promise<string> {
    const d = (await post("/api/block/getBlockKramdown", { id })) as { kramdown?: string };
    return d?.kramdown ?? "";
}

/** /api/block/insertBlock（markdown 通道）；返回任务项/块的内核真实 id。
 *  previousID=插在该块后（追加语义）；nextID=插在该块前。
 *  ⚠️ markdown 插 `- [ ] x` 产生两层结构：响应 op.id=外层 NodeList 容器 id，
 *  blocks 表 subtype='t' 的行=内层 NodeListItem——属性必须挂内层，从响应 HTML 解析
 *  （实测 09-10：挂容器 id=属性与 SQL 任务行永不相交）。 */
export async function insertBlockMarkdown(
    parentID: string,
    markdown: string,
    nextID?: string,
    previousID?: string,
): Promise<string> {
    const txs = await post("/api/block/insertBlock", {
        dataType: "markdown",
        data: markdown,
        parentID,
        ...(nextID ? { nextID } : {}),
        ...(previousID ? { previousID } : {}),
    });
    const ops = Array.isArray(txs) && txs[0]?.doOperations ? txs[0].doOperations : [];
    const html: string = ops[0]?.data ?? "";
    // 任务项特征=data-task 属性（容器 NodeList 无此属性）；顺序按实测 HTML：data-task 在 data-node-id 前。
    // 任务 markdown 失配时 throw 而非回退 op.id——回退=属性挂外层容器的静默 bug 复活（review P2-4）
    const isTaskMarkdown = /\[[ xX]\]/.test(markdown);
    const liMatch = /data-task="[^"]*" data-node-id="([^"]+)"/.exec(html);
    let id: string | undefined;
    if (isTaskMarkdown) {
        id = liMatch?.[1];
        if (!id) throw new Error("insertBlock: task markdown but no NodeListItem id in response (kernel HTML shape drifted?)");
    } else {
        id = ops[0]?.id;
    }
    if (!id) throw new Error("insertBlock: no block id in response");
    return id;
}

/** /api/block/insertBlock（markdown 通道）插单个列表项；返回 {liId, containerId}。
 *  6808 探针（09-18 实测）：`- x` 单插=容器( NodeList )+li( NodeListItem )两层、ops[0].id=容器；
 *  li 级并入既有容器=parentID=文档 + previousID/nextID=锚 li（内核自动并容器）；
 *  parentID=容器直接插被拒（invalid block structure: NodeList cannot contain NodeList）。 */
export async function insertListItem(
    parentID: string,
    markdown: string,
    anchor: { previousID?: string; nextID?: string } = {},
): Promise<{ liId: string; containerId: string }> {
    const txs = await post("/api/block/insertBlock", {
        dataType: "markdown",
        data: markdown,
        parentID,
        ...(anchor.previousID ? { previousID: anchor.previousID } : {}),
        ...(anchor.nextID ? { nextID: anchor.nextID } : {}),
    });
    const ops = Array.isArray(txs) && txs[0]?.doOperations ? txs[0].doOperations : [];
    const html: string = ops[0]?.data ?? "";
    const liId = parseListItemId(html);
    const containerId = ops[0]?.id;
    if (!liId || !containerId) {
        throw new Error("insertListItem: no NodeListItem/container id in response (kernel HTML shape drifted?)");
    }
    return { liId, containerId };
}

// ── siyuan.storage：根=data/storage/petal/<插件名>/，与前端 loadData/saveData 同目录 ──

/** 文档/容器块的直接子块（P2 换线：读顶层结构/盘点）；文档 id=顶层块全集 */
export interface ChildBlockInfo {
    id: string;
    type: string;
    subType?: string;
    content?: string;
}

export async function getChildBlocks(id: string): Promise<ChildBlockInfo[]> {
    return ((await post("/api/block/getChildBlocks", { id })) ?? []) as ChildBlockInfo[];
}

/** 块搬移（P2 换线：parentID 定位=追加进容器尾；块 id 保留双链不断） */
export async function moveBlock(id: string, parentID: string): Promise<void> {
    await post("/api/block/moveBlock", { id, parentID });
}

/** 文档搬移（P2 换线：toID=目标父文档 id；块 id 不变引用安全） */
export async function moveDocsByID(fromIDs: string[], toID: string): Promise<void> {
    await post("/api/filetree/moveDocsByID", { fromIDs, toID });
}

/** 删文档——⚠️ 无 confirm 一发即删且连整个子树（merge 只许在块已搬空后调） */
export async function removeDocByID(id: string): Promise<void> {
    await post("/api/filetree/removeDocByID", { id });
}

/** 文档改名（文件树通道；path=文档 data-path 带 .sy——Dashboard 重命名同端点先例） */
export async function renameDoc(notebook: string, path: string, title: string): Promise<void> {
    await post("/api/filetree/renameDoc", { notebook, path, title });
}


export async function storageGetJson<T = any>(key: string): Promise<T | null> {
    try {
        const obj = await siyuan.storage.get(key);
        return (await obj.json()) as T;
    } catch {
        return null; // 不存在/损坏→null（懒初始化红线：缺文件不算错）
    }
}

export async function storagePutJson(key: string, value: unknown): Promise<void> {
    await siyuan.storage.put(key, JSON.stringify(value));
}

/** 原文直读（写盘验真通道：与写入 payload 字节级比对，不过 parse 免键序噪音；缺文件=null） */
export async function storageGetText(key: string): Promise<string | null> {
    try {
        const obj = await siyuan.storage.get(key);
        return (await obj.text()) as string;
    } catch {
        return null;
    }
}

/** /api/file/putFile 直写（storage.put 静默失败家族的独立兜底通道，calauth □1）。
 *  goja 无 FormData——multipart 体手拼（内容纯文本，boundary 取不撞随机值）；
 *  putFile 恒 HTTP 200，成败只看 body code==0；path=工作区绝对路径（/data/… 开头）。
 *  client.fetch 自动带插件 token（CheckAuth/CheckAdminRole 均过——proxyRequest 同源实证）。 */
export async function putFileText(path: string, content: string): Promise<boolean> {
    const boundary = "----syproject" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const body = ""
        + `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${path}\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="isDir"\r\n\r\nfalse\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="modTime"\r\n\r\n${Date.now()}\r\n` // 毫秒——传秒钉到 1970（实锤）
        + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.json"\r\n`
        + `Content-Type: application/json\r\n\r\n${content}\r\n`
        + `--${boundary}--\r\n`;
    const resp = await siyuan.client.fetch("/api/file/putFile", {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
    });
    if (!resp.ok) return false;
    try {
        return (JSON.parse(await resp.text()) as KernelResp).code === 0;
    } catch {
        return false;
    }
}

// ── petal 文件直读（□7：绕 storage.get 读缓存） ──

/** petal 工作区绝对路径（与 storageVerify 同款拼法；getFile 直读/putFile 兜底共用） */
export const PETAL_DIR = "/data/storage/petal/sy-workbench-plugin";

export function petalPath(file: string): string {
    return `${PETAL_DIR}/${file}`;
}

/** /api/file/getFile 直读（工作区绝对路径）。成功=body 即文件内容本体，失败才有 code 包装
 *  （kernel/api 契约）。三态：text=文件本体；missing=缺档（HTTP 202+code 404，实测 6808）；
 *  failed=读失败（传输/权限/其他错误码）。为什么不用 siyuan.storage.get：读缓存按 key 命中
 *  （□6 坑），前端 saveData 写盘后 kernel 恒拿旧值——镜像增量化这类「前端写→kernel 读」链
 *  必须直读盘。 */
export interface FileTextResult {
    text: string | null;
    missing: boolean;
    failed: boolean;
}

export async function getFileTextEx(path: string): Promise<FileTextResult> {
    try {
        const resp = await siyuan.client.fetch("/api/file/getFile", {
            method: "POST",
            body: JSON.stringify({ path }),
        });
        if (!resp.ok) return { text: null, missing: false, failed: true };
        const text = await resp.text();
        if (!text) return { text: null, missing: true, failed: false }; // 空响应按缺档（petal 文件至少有 JSON 体）
        try {
            const j = JSON.parse(text);
            if (typeof j?.code === "number" && j.code !== 0) {
                return j.code === 404 ? { text: null, missing: true, failed: false } : { text: null, missing: false, failed: true };
            }
        } catch {
            // 非 JSON=文件本体
        }
        return { text, missing: false, failed: false };
    } catch {
        return { text: null, missing: false, failed: true };
    }
}

/** getFile 直读 petal JSON；缺文件/坏 JSON/读失败=null（缺档与失败不分——纯读消费面够用） */
export async function petalGetJsonFresh<T = any>(file: string): Promise<T | null> {
    const r = await getFileTextEx(petalPath(file));
    if (r.text == null) return null;
    try {
        return JSON.parse(r.text) as T;
    } catch {
        return null;
    }
}

/** 写路径守卫版（review P2-3）：ok:false=读失败或坏档——写路径必须放弃本轮（缓存兜底会把
 *  旧档整档覆盖前端新写=用户计划丢失）；ok:true+data:null=缺档（合法空档）。 */
export async function petalGetJsonFreshEx<T = any>(file: string): Promise<{ ok: boolean; data: T | null }> {
    const r = await getFileTextEx(petalPath(file));
    if (r.failed || r.text == null) return { ok: !r.failed, data: null };
    try {
        return { ok: true, data: JSON.parse(r.text) as T };
    } catch {
        return { ok: false, data: null }; // 坏档按读失败——写路径放弃，勿静默重建覆盖
    }
}

export async function storageRemove(key: string): Promise<void> {
    await siyuan.storage.remove(key);
}

/** /api/file/getFile 直读（calauth 09-16 验真读回的文件层权威通道）：绕开 siyuan.storage
 *  整条实现（其读写共享同一缓存视图——put 留缓存未刷盘时同通道读回恒命中=验真假绿，
 *  09-15 20:05「save ok via put 而盘上 mtime 纹丝不动」实锤形态）。
 *  契约（AGENTS.md file API 坑表）：成功=HTTP 200 且 body 即文件内容本体；失败/缺文件≠200 或
 *  body 为 JSON 错误壳——统一回 null（调用方与预期 payload 全文比对，错壳不可能恰好相等） */
export async function getFileText(path: string): Promise<string | null> {
    try {
        const resp = await siyuan.client.fetch("/api/file/getFile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });
        if (!resp.ok) return null;
        return (await resp.text()) as string;
    } catch {
        return null;
    }
}

// ── 外网通道（P2 飞书日历用；P0 验证 1 结论：/api/network/proxy 转发） ──

// goja 无 btoa：纯 JS base64url（RawURLEncoding）编码器
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function base64UrlEncode(s: string): string {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c > 0x7f) {
            if (c < 0x800) {
                bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            } else {
                bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            }
        } else {
            bytes.push(c);
        }
    }
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        out += B64URL_ALPHABET[b0 >> 2];
        out += B64URL_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
        if (b1 === undefined) break;
        out += B64URL_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
        if (b2 === undefined) break;
        out += B64URL_ALPHABET[b2 & 63];
    }
    return out;
}

export interface ProxyResponse {
    status: number;
    ok: boolean;
    body: string;
}

/** 经 /api/network/proxy 的外网请求（P0 验证 1 实测通道；P2 飞书日历用）——全量响应体。
 *  Content-Type 双保险：init.headers（resty 对 string body 默认 text/plain，会被 proxy 原样置首）
 *  + h 参（proxy 在其后 Add）——两处一致才保证目标收到 application/json。 */
export async function proxyRequest(
    target: string,
    method: string,
    bodyJson?: any,
    headers?: Record<string, string[]>,
): Promise<ProxyResponse> {
    let path = `/api/network/proxy?u=${base64UrlEncode(target)}`;
    if (headers && Object.keys(headers).length > 0) {
        path += `&h=${base64UrlEncode(JSON.stringify(headers))}`;
    }
    const init: any = { method, headers: { "Content-Type": "application/json; charset=utf-8" } };
    if (bodyJson !== undefined) {
        init.body = JSON.stringify(bodyJson);
    }
    const resp = await siyuan.client.fetch(path as `/${string}`, init);
    return { status: resp.status, ok: resp.ok, body: await resp.text() };
}

/** □11 闪卡负担：单文档树当前到期卡数（data.unreviewedCount=新+旧未复习到期数；
 *  排期随每次复习实时重算——只做「今日」保准确，静态投影必过期） */
export interface TreeRiffDueInfo {
    unreviewedCount: number;
    unreviewedNewCardCount: number;
    unreviewedOldCardCount: number;
}

export async function getTreeRiffDueCards(rootID: string): Promise<TreeRiffDueInfo> {
    return (await post("/api/riff/getTreeRiffDueCards", { rootID })) as TreeRiffDueInfo;
}

/** 期 3 闪卡波次：块级卡形态（riffCard.due=RFC3339 带本地 offset；state 0=New 卡——
 *  其 due 是内核响应时动态 now 非静态存储值，判定恒视为「已到期」，e2e 实锤在档） */
export interface RiffCardInfo {
    due: string;
    state: number;
    reps: number;
    /** 最后刷卡时刻（RFC3339；从未刷过=空/零值） */
    lastReview?: string;
}

export interface RiffCardBlock {
    id: string;
    riffCardID: string;
    riffCard: RiffCardInfo;
    /** 块所在文档 root id（内核 Block JSON 原生自带 block.go RootID——getRiffCards/
     *  getTreeRiffCards 响应同序列化；方案 A 全空间侦察靠它免 SQL 聚簇查 root） */
    rootID?: string;
}

export interface TreeRiffCardsRet {
    blocks: RiffCardBlock[];
    total: number;
    pageCount: number;
}

/** 按块 id 批量查卡（微调联动重规整/对账完成度用）。内核对无卡块补占位条目
 *  （riffCardID=""，tomato □7 实锤）——此处已过滤，真卡判定=riffCardID 非空。 */
export async function getRiffCardsByBlockIDs(blockIDs: string[]): Promise<RiffCardBlock[]> {
    const ret = (await post("/api/riff/getRiffCardsByBlockIDs", { blockIDs })) as { blocks?: RiffCardBlock[] };
    return (ret?.blocks ?? []).filter((b) => b && typeof b.id === "string" && !!b.riffCardID);
}

/** 按卡组分页拉全卡含未到期（POST /api/riff/getRiffCards {id,page,pageSize}；riff.go:162）。
 *  deckID=""（内核 GetDeckFlashcards 空串分支 flashcard.go:538）=全部卡组合并——含用户自建
 *  卡组清单接口（getRiffDecks 形态）拿不到的内置卡组（⚠️内核 GetDecks 剔除内置卡组
 *  flashcard.go:1284——内置卡组 id 不可从清单响应认，官方复习队列=内置卡组口径
 *  flashcard.go:775；方案 A 勿硬编码：全空间拉卡恒走 deckID="" 合并流）+用户卡组
 *  （旧日记/驾照等旧卡全收）。响应形态={blocks,total,pageCount}，
 *  blocks 按卡 due 升序（同块多卡=多行）。 */
export async function getRiffCards(deckID: string, page = 1, pageSize = 1000): Promise<TreeRiffCardsRet> {
    return (await post("/api/riff/getRiffCards", { id: deckID, page, pageSize })) as TreeRiffCardsRet;
}

/** /api/system/getConf 读闪卡每日上限（AppConf.Flashcard=model/conf.go:75，live 实测在返回中；
 *  behavior.ts getConf 同款 data 内包一层 conf 前例）。读不到（字段缺失/请求失败）=null——
 *  调用方 flashLimitHint 固定提示句兜底。 */
export async function getFlashcardLimits(): Promise<{ newCardLimit: number; reviewCardLimit: number } | null> {
    try {
        const f = (await post("/api/system/getConf", {}))?.conf?.flashcard;
        const n = Number(f?.newCardLimit);
        const r = Number(f?.reviewCardLimit);
        if (Number.isFinite(n) && Number.isFinite(r)) return { newCardLimit: n, reviewCardLimit: r };
        return null;
    } catch {
        return null;
    }
}

/** 卡级批量改 due（{id:卡id, due:"YYYYMMDDHHmmss"}；块级→卡级展开在编排层） */
export async function batchSetRiffCardsDueTime(cardDues: Array<{ id: string; due: string }>): Promise<unknown> {
    return post("/api/riff/batchSetRiffCardsDueTime", { cardDues });
}
