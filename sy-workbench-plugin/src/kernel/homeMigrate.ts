// src/kernel/homeMigrate.ts —— folder-model 存量迁移（spec §3，两代起点幂等搬家）：
// 起点A（v1.0.1 外部用户）：「我的主线」下三件套（旧名 日记/每日配置/不想做）整树搬目录
//   （日记先改名「日志」再搬）；其余一级子文档（线）整树搬升格为目录一级文档（=项目）；
//   搬空后（listDocsByPath 复核零子文档）删空壳（bear 已授权）。
// 起点B（bear 主实例，home-split 未发版形态）：/主线数据 三件套同搬同改名；壳不删、其余子文档不动。
// 通用：顶层注册项目（custom-project-status 命中且 hpath 顶层）收编进目录一级（幂等——
//   覆盖两代起点散落顶层的项目；spec 起点B 明写，起点A 的顶层项目同病同治）。
// 「日记」→「日志」改名先于 move（旧 path 从 SQL 拿——旧处存续已久索引稳定）；目录下残留
// 「日记」兜底改名（半迁移态）。幂等（各起点查不到=零操作）；定位走文件树真相防索引窗；
// move 失败不炸（onload 下轮重试）。绝不自动删：「我的主线」空壳外的一切。
import { listDocsByPath, moveDocsByID, removeDocByID, renameDoc, setBlockAttrs, sql } from "./api";
import { ensureRoot } from "./schedboard";
import {
    DIARY_NAME, HOME_MARK_ATTR, LEGACY_DIARY_NAME, LEGACY_MAINLINE_HPATH, LEGACY_SPLIT_HPATH,
    ROOT_HPATH, TRIPLET_NAMES,
} from "../shared/homePaths";

export interface FolderMigrateResult {
    moved: string[];
    renamed: string[];
    removedShells: string[];
    noop: boolean;
    error?: string;
}

/** 三件套名匹配（新旧两套名都认——改名失败/半迁移态按旧名也搬） */
const LEGACY_TRIPLET_NAMES = [LEGACY_DIARY_NAME, "每日配置", "不想做"];
const isTripletName = (n: unknown): boolean =>
    typeof n === "string" && (TRIPLET_NAMES.includes(n) || LEGACY_TRIPLET_NAMES.includes(n));

/** 顶层旧容器定位（hpath 精确；LIMIT 2 防同 id 脏行膨胀取首行） */
async function findLegacyDoc(hpath: string): Promise<{ id: string; box: string } | null> {
    const rows = await sql<{ id: string; box: string }>(
        `SELECT id, box FROM blocks WHERE type='d' AND hpath='${hpath}' LIMIT 2`);
    const r = rows?.[0];
    return r?.id && r.box ? { id: r.id, box: r.box } : null;
}

/** listDocsByPath 容错读：ENOENT（物理目录不存在）=零子文档铁证（文件系统真相——无子文档
 *  的档其目录不落盘，搬运清空后同形态）；其他错误原样 throw（勿把真 IO 故障当搬空删壳） */
async function listOrEmpty(box: string, id: string): Promise<{ files: any[] }> {
    try {
        return (await listDocsByPath(box, id)) ?? { files: [] };
    } catch (e: any) {
        if (String(e?.message ?? e).includes("no such file or directory")) return { files: [] };
        throw e;
    }
}

/** 单容器搬家：三件套整树进目录；upgradeRest（仅起点A）=其余一级子文档（线）升格+搬空删壳 */
async function migrateLegacyContainer(
    root: { id: string; box: string },
    hpath: string,
    upgradeRest: boolean,
): Promise<{ moved: string[]; shellRemoved: boolean }> {
    const legacy = await findLegacyDoc(hpath);
    if (!legacy) return { moved: [], shellRemoved: false };
    const tops = await listOrEmpty(legacy.box, legacy.id);
    const files = (tops?.files ?? []).filter((f: any) => f?.id);
    const triplet = files.filter((f: any) => isTripletName(f.name));
    const rest = files.filter((f: any) => !isTripletName(f.name));
    if (triplet.length) await moveDocsByID(triplet.map((f: any) => f.id), root.id);
    if (upgradeRest && rest.length) await moveDocsByID(rest.map((f: any) => f.id), root.id);
    let shellRemoved = false;
    if (upgradeRest) {
        // 搬空复核：子文档搬走后壳变叶子档，物理目录随搬消失——ENOENT=搬空证据（listOrEmpty）
        const recheck = await listOrEmpty(legacy.box, legacy.id);
        if ((recheck.files?.length ?? 0) === 0) {
            await removeDocByID(legacy.id);
            shellRemoved = true;
        }
    }
    return {
        moved: [...triplet, ...(upgradeRest ? rest : [])]
            .map((f: any) => (f.name === LEGACY_DIARY_NAME ? DIARY_NAME : f.name)),
        shellRemoved,
    };
}

/** 顶层注册项目收编（幂等；同 id 脏行去重）。范围=顶层（hpath 一级）+两代 LEGACY 容器内
 *  （后者治「旧屋檐被当目录期误收编进去的注册项目」自愈——hpath 在 LEGACY 前缀下也搬）。 */
async function collectTopLevelProjects(root: { id: string; box: string }): Promise<string[]> {
    const rows = await sql<{ id: string; box: string; hpath: string }>(
        `SELECT a.block_id AS id, b.box, b.hpath FROM attributes a JOIN blocks b ON b.id=a.block_id
         WHERE a.name='custom-project-status' LIMIT 100`);
    const seen = new Set<string>();
    const inLegacy = (hp: string) => hp === LEGACY_MAINLINE_HPATH || hp.startsWith(LEGACY_MAINLINE_HPATH + "/")
        || hp === LEGACY_SPLIT_HPATH || hp.startsWith(LEGACY_SPLIT_HPATH + "/");
    const tops = (rows ?? []).filter((r) => {
        if (!r?.id || !r.box || typeof r.hpath !== "string" || r.id === root.id || seen.has(r.id)) return false;
        seen.add(r.id);
        return r.hpath.lastIndexOf("/") === 0 || inLegacy(r.hpath);
    });
    if (tops.length) await moveDocsByID(tops.map((r) => r.id), root.id);
    return tops.map((r) => r.hpath.slice(1));
}

/** ⓪ 旧宿主标记清理：home-split 期 IAL 标记打在 /主线数据（或「我的主线」）上——不清则
 *  ensureRoot 的标记主通道会把旧屋檐错当新目录（三件套 move-to-self 失效、注册项目收编
 *  进旧屋檐，bear 主实例实弹形态；dev 复刻空间无标记故 e2e 不暴露）。幂等：宿主非两代
 *  LEGACY hpath 时零操作。 */
async function unmarkLegacyHosts(): Promise<void> {
    const rows = await sql<{ block_id: string; hpath: string }>(
        `SELECT a.block_id, b.hpath FROM attributes a JOIN blocks b ON b.id=a.block_id
         WHERE a.name='${HOME_MARK_ATTR}' AND a.value='1' LIMIT 5`);
    for (const r of rows ?? []) {
        if (r?.block_id && (r.hpath === LEGACY_MAINLINE_HPATH || r.hpath === LEGACY_SPLIT_HPATH)) {
            await setBlockAttrs(r.block_id, { [HOME_MARK_ATTR]: "" });
        }
    }
}

export async function migrateFolderModel(): Promise<FolderMigrateResult> {
    const out: FolderMigrateResult = { moved: [], renamed: [], removedShells: [], noop: true };
    try {
        await unmarkLegacyHosts();
        const legacyA = await findLegacyDoc(LEGACY_MAINLINE_HPATH);
        const legacyB = await findLegacyDoc(LEGACY_SPLIT_HPATH);
        const root = await ensureRoot(legacyA?.box ?? legacyB?.box);
        if (!root || "error" in root) {
            return { ...out, noop: false, error: (root as any)?.error ?? "目录不可用" };
        }
        // ①「日记」→「日志」（rename 先于 move：path 从 SQL 拿，覆盖两代旧处+目录内残留）
        const diaries = await sql<{ id: string; box: string; path: string; hpath: string }>(
            `SELECT id, box, path, hpath FROM blocks WHERE type='d' AND hpath IN ('${LEGACY_MAINLINE_HPATH}/${LEGACY_DIARY_NAME}','${LEGACY_SPLIT_HPATH}/${LEGACY_DIARY_NAME}','${ROOT_HPATH}/${LEGACY_DIARY_NAME}')`);
        for (const d of diaries ?? []) {
            if (d?.id && d.box && d.path) {
                await renameDoc(d.box, d.path, DIARY_NAME);
                out.renamed.push(d.hpath);
            }
        }
        // ② 起点A：三件套+线升格+空壳删
        const a = await migrateLegacyContainer(root, LEGACY_MAINLINE_HPATH, true);
        out.moved.push(...a.moved);
        if (a.shellRemoved) out.removedShells.push(LEGACY_MAINLINE_HPATH);
        // ③ 起点B：三件套搬（不升格不删壳）
        const b = await migrateLegacyContainer(root, LEGACY_SPLIT_HPATH, false);
        out.moved.push(...b.moved);
        // ④ 顶层注册项目收编（通用幂等）
        out.moved.push(...(await collectTopLevelProjects(root)));
        out.noop = out.moved.length === 0 && out.renamed.length === 0 && out.removedShells.length === 0;
        return out;
    } catch (e: any) {
        return { ...out, noop: false, error: String(e?.message ?? e) };
    }
}
