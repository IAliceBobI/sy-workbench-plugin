---
name: sy-project
description: 思源「项目容器」插件 MCP 工具说明书——项目=工作上下文容器（打开即开工）。用户说「建个项目/打开 X 项目/把现场存了/进展如何/这条线归档/拆线/到点提醒」等时使用；经 mcporter 调思源实例的 project/task/line/calendar 四工具。
---

# 项目容器（sy-workbench-plugin）MCP 工具技能

项目=一篇「项目主文档」挂起的文档树子树（森林模型）：主文档=目录+「给 Agent 的话」+外部引用列表；**线**=项目下的子文档（生长/分裂/死亡/复活）；任务=原生 `- [ ]` 任务列表块（可嵌套）。数据全在块上（卸载插件零丢失），归属=文档树位置。

## 进场礼仪（最重要的一条）

**打开任何项目工作前，先 `project get` 读主文档的「给 Agent 的话」段**——那是用户写给 Agent 的项目约定（工作流、注意事项、口径）。跳过它直接干活=违背用户明示约定。

## 工具发现

四个工具经思源实例的 /mcp 暴露，全名前缀 `plugin__sy_mainline_plugin__`（后缀 hash 随 schema 版本变，用 `mcporter list <实例>` 现查）：

- **project** — 项目容器：`list` / `create` / `open` / `get` / `get_progress` / `set_status`
- **task** — 任务块：`list` / `create` / `complete` / `schedule`
- **line** — 换线四件套：`blocks` / `split` / `merge` / `archive` / `restore`
- **calendar** — 飞书日历：`set_config` / `oauth_start` / `get_config` / `test` / `sync` / `unlink`

## 工作流对话模式

| 用户说 | 你做 |
|---|---|
| 「建个项目 X」 | `project create`（name+notebook 必填；notebook id 不确定就先问或查 lsNotebooks）→ 建议用户在思源里写骨架，或问要不要你代拟 |
| 「打开 X 项目」 | `project list` 找到 id → `project open`（广播前端恢复页签现场+定位上次块）→ `project get` 读「给 Agent 的话」→开工 |
| 「把现场存了」 | 现场由前端壳自动存（切项目时自动互存）；手动确认=让用户敲命令面板的「保存现场」命令。你无需（也不能）直接调快照 API |
| 「切到 Y 项目」 | 直接 `project open` Y——旧项目现场自动保存，无需先存 |
| 「进展如何」 | `project get_progress`（总数/已完成/今日到期/逾期/最近活跃）→ 附 `task list status=open dueBefore=<今天>` 看逾期清单 |
| 「周五前要交」 | `task create`（带 dueDate）或 `task schedule` 已有任务；单填日期默认语义=截止。已配日历则任务写完顺手挂上飞书日程（失败不阻塞，回报 calendarHint 一句原因与出路） |
| 「这条线归档」 | 先 `line archive` 试——有未完任务会报错并附盘点材料；与用户议定每个任务迁移（`openTaskPolicy=migrate`+目标线）还是作废（`abandon`）再执行 |
| 「把这条线拆短」 | `line blocks` 读顶层结构 → 给用户拆分方案（哪些段成新线）→ 点头后逐个 `line split` 执行 |
| 「把 B 并进 A」 | `line merge`（B 顶层块搬 A 尾、B 删除、块 id 保留双链不断；**必须显式 confirm:true**，这是破坏性操作的二次确认） |

## 到点提醒怎么开（飞书日历）

任务带截止日期→自动写飞书日程，**到点由飞书服务端推送**（思源关着也 100% 到达）。未配置时任务照常写入，回报只多一句 calendarHint 提示出路。

**一次配置（B 通道·主推）**：`calendar oauth_start`（带 `appId`/`appSecret`，自建应用凭证、需开通日历权限）→ 返回授权链接+安全设置直达链接 → 用户先在安全设置登记回调地址（默认 `http://localhost:19876/callback`，返回值里有 `securitySettingsUrl` 直达页）→ 浏览器打开授权链接同意 → 跳转地址栏里的 `code` 传回 `set_config {channel:"oauth", appId, appSecret, code}`。收到配置立即跑三步体检（换 token→列日历→建删测试日程），卡在哪步把飞书报错原文给出——权限没开时飞书报 99991672 自带一键开通链接，直接给用户点。B 通道=以**用户本人身份**授权：日程直接进主日历，提醒精确到分钟（全天日程也生效）。

**备选：A′ 通道（何时选它）**——低频用户（B 的授权约 30 天要重走一次）或不想日程混进主日历、要一块独立可隐藏日历的。`set_config` 三件套：`appId`/`appSecret`+`userOpenId`（你的 open_id，以**该应用视角**为准——跨应用不通用）。体检通过=机器人建共享日历「思源任务」并把你加为 **writer 成员**——飞书发「日历分享」卡片，接受后侧边栏常驻可见。注意：A′ 日程由机器人创建，「提前 N 分钟提醒」按调用身份生效——**你实际收到的提醒走你飞书客户端的默认日程提醒**（带用户去 飞书 设置→日历→日程默认提醒 调成想要的时间，一次设置全局生效）。

**同步语义**：单向。带 dueDate 的 create/schedule→建/改事件；完成或清 due→删事件；取消勾选**不自动恢复**（重新 schedule 或 `calendar sync`）。纯日期=全天日程（A′/应用身份飞书不落显式提醒、走用户客户端默认；B/OAuth 通道全天提醒可精确设置）；改期只认显式 dueDate 入参（只调 dueTime 不触发）。`calendar sync {projectId}` 全项目对齐并报告孤儿映射（任务块已不在项目的钩子），确认不要了逐个 `calendar unlink`。停用=`set_config {enabled:false}`（免体检）。凭证配置坏掉时 set_config 不会覆盖旧配置，修好再试。

1. **归档前未完任务必须处置**——不处置工具报错附清单，这是「换线不丢活」的硬规矩；与用户盘点后带 policy 重调。
2. merge 删除 B 线文档需 `confirm:true`；B 有子文档时工具拒绝（先逐个处理子文档）。
3. 块 id 全程保留（split/merge/migrate 都是搬移非复制）——别建议用户复制粘贴代替换线，会断双链+丢历史。

## token 经济学与坑

- **写后 3~10s SQL 索引窗口**：create/schedule/complete/split 后别立即 list/get 复核同一数据，先干别的再查（工具描述里也有此提示）。
- `project get` 返回主文档全量 markdown——大主文档费 token；只要进展用 `get_progress`。
- 任务多的大项目统计有 500 上限，响应带 `truncated:true` 时告诉用户数字是下界。
- `task list` 默认 status=open 限 50；盘点归档任务时显式传 `status=all`。
- `line blocks` 只返回顶层块（够拆线出方案用）；要看嵌套内容让用户在思源里看，或 `project get` 读 markdown。
- 日期一律 `YYYY-MM-DD`、时间 `HH:MM`；schedule 传空串=清空该字段。
