// kernel 侧副作用层：全部 siyuan.client.fetch / siyuan.storage 调用收口于此。
// core/ 纯逻辑零 siyuan 依赖；tools handler 只编排本模块（单测 mock 边界）。
// goja 无 fetch/setTimeout/console——唯一外联通道 siyuan.client.fetch（path 须 / 开头）。
import { parseListItemId } from "./core/schedboard";

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

/** 文档树上建文档；返回 docId。⚠️ markdown 含围栏时须裸 ;;; 闭合（围栏吞尾坑）。
 *  parentID：同级同名孪生时 hpath 解析有歧义（kernel GetBlockTreeRootByHPath 撞名命中哪个不定），
 *  指定父文档 id 精确定位（kernel/api/filetree.go parentID 入参，issue 8138）。 */
export async function createDocWithMd(
    notebook: string,
    path: string,
    markdown: string,
    parentID?: string,
): Promise<string> {
    return (await post("/api/filetree/createDocWithMd", {
        notebook,
        path,
        markdown,
        ...(parentID ? { parentID } : {}),
    })) as string;
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
