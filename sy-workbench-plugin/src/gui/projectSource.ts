// 前端项目发现 fetch 链（folder-model：目录一级文档=项目）——接线层，纯函数在 queries.ts。
// 枚举源=listDocsByPath 文件树真相（破坏性/枚举面纪律）；归档态/updated=SQL IN 批查（辅助
// 元数据）；目录定位=IAL 标记主通道+hpath 兜底（kernel locateRoot 同语义）。目录未建=空快照。
import { feCall, feQuery } from "./fe";
import {
    projectMetaSql, projectRowsFromListing, rootFallbackSql, rootLocateSql,
    type ProjectRow,
} from "./queries";
import { TRIPLET_NAMES } from "../shared/homePaths";

export interface ProjectSnapshot {
    rootId: string;
    rootBox: string;
    /** 目录文档 data-path（带 .sy）——boardTasksByRootSql 单前缀锚 */
    rootPath: string;
    /** 三件套 {id, path}（任务面排除用） */
    triplet: Array<{ id: string; path: string }>;
    projects: ProjectRow[];
}

/** 目录快照+项目列表（目录未建/未定位=空快照，调用方按零项目处理） */
export async function fetchProjectSnapshot(): Promise<ProjectSnapshot> {
    let root = (await feQuery<{ id: string; box: string; path: string }>(rootLocateSql()))
        .find((r) => r?.id && r.box) ?? null;
    if (!root) {
        root = (await feQuery<{ id: string; box: string; path: string }>(rootFallbackSql()))
            .find((r) => r?.id && r.box) ?? null;
    }
    if (!root?.id || !root.box) {
        return { rootId: "", rootBox: "", rootPath: "", triplet: [], projects: [] };
    }
    // 空目录 data=null（api 实测）——feCall 返回 null 防护
    const tops = await feCall<{ files?: Array<{ id?: string; name?: string; path?: string }> } | null>(
        "/api/filetree/listDocsByPath", { notebook: root.box, path: root.id });
    const files = (tops?.files ?? []).filter((f) => f?.id);
    if (!files.length) {
        return { rootId: root.id, rootBox: root.box, rootPath: root.path ?? "", triplet: [], projects: [] };
    }
    const triplet = files
        .filter((f) => TRIPLET_NAMES.includes(f.name ?? ""))
        .map((f) => ({ id: f.id!, path: f.path ?? "" }));
    const meta = await feQuery<{ id: string; status?: string | null; updated?: string }>(
        projectMetaSql(files.map((f) => f.id!)));
    return {
        rootId: root.id,
        rootBox: root.box,
        rootPath: root.path ?? "",
        triplet,
        projects: projectRowsFromListing(files, meta),
    };
}
