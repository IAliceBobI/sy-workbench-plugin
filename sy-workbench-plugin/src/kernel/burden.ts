// □11 闪卡今日负担·编排层（timeblock 期 4 burden 源退役后瘦身）：
// 「项目X 今日到期 N 张」信息性事件链（runDailyBurden）已退役——信息被期 3 波次条目
// （日记班表块「闪卡·第 N 波 X 张」）+plan_context 侦察包（targetDayPool）替代；
// 存活面=listActiveProjects（活跃项目清单——期 3 flashwave 侦察同口径单一事实源）。
import { sql } from "./api";
import { ATTR_PROJECT_STATUS, PROJECT_STATUS } from "./core/schema";

/** 活跃项目清单（type='d' 守卫防段落 id 冒充——与 projectTools.list 同锚多一道类型闸；
 *  期 3 flashwave 侦察同口径复用：波次池=活跃项目子树引用文档的到期卡） */
export async function listActiveProjects(): Promise<{ id: string; name: string; path: string }[]> {
    return sql<{ id: string; name: string; path: string }>(
        `SELECT a.block_id AS id, b.content AS name, b.path AS path
        FROM attributes a JOIN blocks b ON b.id=a.block_id
        WHERE a.name='${ATTR_PROJECT_STATUS}' AND a.value='${PROJECT_STATUS.ACTIVE}' AND b.type='d'`,
    );
}
