// src/shared/homePaths.ts —— 主线目录路径单源（folder-model spec §1；
// kernel/gui 全部 import 此处，禁再自持副本）。目录=全插件唯一数据根（默认名 Project，
// 数据层硬编码不随界面语言变——同旧「主线数据」中文硬编码先例）。
export const ROOT_NAME = "Project";
export const ROOT_HPATH = "/Project";
/** 目录根 IAL 标记（沿用 home-split 旧 attr 名——bear 主实例已打标零迁移成本；语义=目录根） */
export const HOME_MARK_ATTR = "custom-mainline-home";
/** 三件套文档名（目录下固定名；「日志」=旧「日记」改名） */
export const DIARY_NAME = "日志";
export const DAYCONFIG_NAME = "每日配置";
export const AVERSION_NAME = "不想做";
export const TRIPLET_NAMES = [DIARY_NAME, DAYCONFIG_NAME, AVERSION_NAME];
export const HOME_DIARY_HPATH = `${ROOT_HPATH}/${DIARY_NAME}`;
export const HOME_DAYCONFIG_HPATH = `${ROOT_HPATH}/${DAYCONFIG_NAME}`;
export const HOME_AVERSION_HPATH = `${ROOT_HPATH}/${AVERSION_NAME}`;
/** 起点A（v1.0.1 外部用户）：三件套+线挂「我的主线」下——迁移只读，勿再用于写入 */
export const LEGACY_MAINLINE_HPATH = "/我的主线";
export const LEGACY_MAINLINE_NAME = "我的主线";
/** 起点B（bear 主实例，home-split 未发版形态）：三件套挂 /主线数据 下——迁移只读 */
export const LEGACY_SPLIT_HPATH = "/主线数据";
export const LEGACY_SPLIT_NAME = "主线数据";
/** 两代起点的旧日记层名（迁移改名用） */
export const LEGACY_DIARY_NAME = "日记";
