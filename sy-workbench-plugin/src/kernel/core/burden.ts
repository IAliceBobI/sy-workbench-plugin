// □11 闪卡今日负担·纯逻辑层（timeblock 期 4 burden 源退役后瘦身）：burdenKey/prune/载荷
// 已随「今日到期 N 张」信息性事件退役（信息被波次条目+plan_context 侦察包替代），存活面=
// 活跃项目子树引用的目标文档扫描（buildRefsSql/collectTargetRootIds——期 3 flashwave 侦察
// 同口径复用：波次池=活跃项目子树引用文档的到期卡）。

export const BURDEN_KEY_PREFIX = "flashcard-burden";

/** burden 账本键解析（视图层消费：月历/时间线的 burden 源行——期 4 退役后无新事件，
 *  旧化石条目仍可显示，源自然枯竭）。 */
export function parseBurdenKey(key: string): { projectId: string; day: string } | null {
    const m = /^flashcard-burden:(20\d{12}-[0-9a-z]{7}):(\d{4}-\d{2}-\d{2})$/.exec(key);
    return m ? { projectId: m[1], day: m[2] } : null;
}

/** refs 行 → 目标文档 id 去重集（字典序稳定：跨次运行 SQL 行序无关） */
export function collectTargetRootIds(rows: Array<{ def_root_id?: string | null } | null | undefined>): string[] {
    const set = new Set<string>();
    for (const r of rows) {
        if (r?.def_root_id) set.add(r.def_root_id);
    }
    return [...set].sort();
}

/** 项目子树全部块引用 → 目标文档（handoff □11：锚=子树内所有块引用，不限主文档，
 *  兼容外部引用挪进线文档）。refs 行自带 root_id/path=源块所在文档，免 join。
 *  ⚠️ 子文档物理目录=父文档 id 不带 .sy——前缀须剥 .sy 加 '/'（带 .sy 只匹配父自身，既有坑）。
 *  注入面=零依赖不变式：projectId 值域=块 id、path 物理段恒为文档 id（标题不进 path），
 *  引号/%/_ 不可达；若未来 path 语义变化此处需先补转义。 */
export function buildRefsSql(projectId: string, projectPath: string): string {
    const dirPrefix = projectPath.replace(/\.sy$/, "");
    return `SELECT DISTINCT def_block_root_id AS def_root_id FROM refs
        WHERE (root_id='${projectId}' OR path LIKE '${dirPrefix}/%')`;
}
