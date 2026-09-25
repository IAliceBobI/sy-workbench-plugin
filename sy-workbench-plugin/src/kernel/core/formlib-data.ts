// 作息训练·期 3（sloop □5）：形态库 v1 数据层——10 职业身份模板（设计档 §3 定案）。
// 条目=构造依据（职业约束），非名人出处；铁律 11：参照只做方向指引不做计分。
// 双语内嵌（handoffSeed 同款 TS 单一制，i18n 双轨惯例）；anchors[0] 恒=起床锚（projectDraft 约定，
// 单测断言）；时刻=基色参考方向，非用户初值——初版粗排经 projectDraft 从现实投影（铁律 2）。

import type { Archetype } from "./formlib";

export const FORMLIB_VERSION = 1;

export const ARCHETYPES: Archetype[] = [
    {
        id: "dev-remote",
        name: { zh: "程序员 · 远程弹性", en: "Remote Developer" },
        chrono: "night",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "09:30", end: null, hard: false },
            { label: { zh: "深度块", en: "Deep work" }, start: "11:00", end: "13:00", hard: true },
            { label: { zh: "锻炼", en: "Workout" }, start: "17:30", end: null, hard: false },
            { label: { zh: "晚深度块", en: "Evening deep work" }, start: "20:00", end: "22:00", hard: true },
            { label: { zh: "熄屏", en: "Screens off" }, start: "01:30", end: null, hard: false },
        ],
        stageNote: {
            zh: "无通勤与班表约束，风险是边界漂移——靠两个深度块把一天钉出形状",
            en: "No commute or fixed shifts; the risk is drift — two deep-work blocks pin the shape",
        },
        conflictAnchor: { zh: "赶工期守住 20:00 晚深度块，其余可让", en: "In crunch weeks keep the 20:00 evening block; the rest can give" },
    },
    {
        id: "dev-commute",
        name: { zh: "程序员 · 通勤上班", en: "Commuting Developer" },
        chrono: "flex",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "07:20", end: null, hard: true },
            { label: { zh: "到岗", en: "At the office" }, start: "09:00", end: null, hard: true },
            { label: { zh: "锻炼", en: "Workout" }, start: "19:00", end: null, hard: false },
            { label: { zh: "晚间自学", en: "Evening study" }, start: "20:30", end: "22:00", hard: false },
            { label: { zh: "熄屏", en: "Screens off" }, start: "23:30", end: null, hard: true },
        ],
        stageNote: {
            zh: "班表与通勤吃掉两头，自主时间集中在晚间——自学块放 20:30",
            en: "Shift and commute eat both ends; free time concentrates in the evening — study at 20:30",
        },
        conflictAnchor: { zh: "发版周守住 07:20 起床，锻炼可全让", en: "In release weeks keep the 07:20 wake; workouts can all give" },
    },
    {
        id: "writer",
        name: { zh: "作家 / 写作者", en: "Writer" },
        chrono: "morning",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "06:40", end: null, hard: true },
            { label: { zh: "晨写", en: "Morning writing" }, start: "07:30", end: "10:00", hard: true },
            { label: { zh: "阅读", en: "Reading" }, start: "16:00", end: "17:00", hard: false },
            { label: { zh: "锻炼", en: "Workout" }, start: "18:00", end: null, hard: false },
            { label: { zh: "熄屏", en: "Screens off" }, start: "22:30", end: null, hard: false },
        ],
        stageNote: {
            zh: "上午脑力最好，晨写块是身份锚——世界还没醒时写作",
            en: "Mornings are the sharpest; the morning-writing block is the identity anchor — write before the world wakes",
        },
        conflictAnchor: { zh: "截稿期守 07:30–10:00 晨写，作息其余可乱", en: "On deadline keep the 07:30–10:00 writing block; the rest can slide" },
    },
    {
        id: "student",
        name: { zh: "备考学生", en: "Exam Student" },
        chrono: "flex",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "07:50", end: null, hard: true },
            { label: { zh: "上午学习块", en: "Morning study" }, start: "09:00", end: "11:30", hard: true },
            { label: { zh: "下午学习块", en: "Afternoon study" }, start: "14:30", end: "17:00", hard: true },
            { label: { zh: "晚间复盘", en: "Evening review" }, start: "21:00", end: "22:00", hard: false },
            { label: { zh: "熄屏", en: "Screens off" }, start: "23:50", end: null, hard: false },
        ],
        stageNote: {
            zh: "宿舍诱惑多，用「去图书馆」这个动作当启动器，节奏贴课表",
            en: "Dorms are full of temptations — use the act of going to the library as the starter; rhythm follows the timetable",
        },
        conflictAnchor: { zh: "冲刺期守 09:00 上午块，下午块可让", en: "In final sprints keep the 09:00 morning block; afternoons can give" },
    },
    {
        id: "parent",
        name: { zh: "带娃家长", en: "Parent with Kids" },
        chrono: "flex",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "06:50", end: null, hard: true },
            { label: { zh: "自有块", en: "Own time" }, start: "09:30", end: "11:00", hard: false },
            { label: { zh: "接娃", en: "Pickup" }, start: "16:30", end: null, hard: true },
            { label: { zh: "陪娃晚饭", en: "Family dinner" }, start: "18:00", end: "20:00", hard: true },
            { label: { zh: "自有块", en: "Own time" }, start: "21:00", end: "22:00", hard: false },
        ],
        stageNote: {
            zh: "锚点跟着孩子走，自有时间=娃在园校的两段；疲劳期不硬排",
            en: "Anchors follow the kids; own time = the two stretches while they're at school; don't over-plan tired weeks",
        },
        conflictAnchor: { zh: "娃生病一切让位，只守 21:00 半小时自有块", en: "When the kid is sick everything gives; keep only the 21:00 half-hour of own time" },
    },
    {
        id: "academic",
        name: { zh: "高校教师 / 科研人", en: "Academic" },
        chrono: "flex",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "07:30", end: null, hard: false },
            { label: { zh: "课务块", en: "Teaching block" }, start: "09:00", end: "11:30", hard: true },
            { label: { zh: "科研块", en: "Research block" }, start: "15:00", end: "18:00", hard: true },
            { label: { zh: "锻炼", en: "Workout" }, start: "19:30", end: null, hard: false },
            { label: { zh: "熄屏", en: "Screens off" }, start: "23:30", end: null, hard: false },
        ],
        stageNote: {
            zh: "课表按学期变——锚点跟学期走，寒暑假切「科研冲刺」变体",
            en: "The timetable changes by semester — anchors follow the term; switch to a research-sprint variant on breaks",
        },
        conflictAnchor: { zh: "结题周守 15:00 科研块，上课时间随课表", en: "In proposal weeks keep the 15:00 research block; teaching follows the timetable" },
    },
    {
        id: "creator",
        name: { zh: "自媒体创作者", en: "Content Creator" },
        chrono: "night",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "09:00", end: null, hard: false },
            { label: { zh: "选题脚本", en: "Scripting" }, start: "11:00", end: "13:00", hard: true },
            { label: { zh: "拍摄剪辑", en: "Shooting & editing" }, start: "15:00", end: "18:00", hard: true },
            { label: { zh: "发布互动", en: "Publish & engage" }, start: "21:00", end: null, hard: false },
            { label: { zh: "熄屏", en: "Screens off" }, start: "01:00", end: null, hard: false },
        ],
        stageNote: {
            zh: "平台流量高峰在晚间——创作服务于发布节奏，不硬凑早睡",
            en: "Platform traffic peaks at night — creation serves the publishing rhythm; don't force early sleep",
        },
        conflictAnchor: { zh: "冲热点周守 21:00 发布，拍摄块可让", en: "In trending weeks keep the 21:00 publish; shooting blocks can give" },
    },
    {
        id: "freelance",
        name: { zh: "自由职业者", en: "Freelancer" },
        chrono: "flex",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "08:30", end: null, hard: true },
            { label: { zh: "开工仪式", en: "Opening ritual" }, start: "09:30", end: null, hard: true },
            { label: { zh: "深度块", en: "Deep work" }, start: "10:00", end: "12:30", hard: true },
            { label: { zh: "运动", en: "Exercise" }, start: "17:00", end: null, hard: false },
            { label: { zh: "熄屏", en: "Screens off" }, start: "23:59", end: null, hard: true },
        ],
        stageNote: {
            zh: "没有外部约束最容易漂——靠开工仪式和固定深度块自造结构",
            en: "No external constraints means drift — self-impose structure via the opening ritual and a fixed deep block",
        },
        conflictAnchor: { zh: "接急单守 08:30 起床，其余可让", en: "On rush orders keep the 08:30 wake; the rest can give" },
    },
    {
        id: "shiftwork",
        name: { zh: "轮班制（医护等）", en: "Shift Worker" },
        chrono: "flex",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "06:30", end: null, hard: true },
            { label: { zh: "到岗", en: "Shift starts" }, start: "08:00", end: null, hard: true },
            { label: { zh: "班后小睡", en: "Post-shift nap" }, start: "16:00", end: "17:00", hard: false },
            { label: { zh: "晚饭散步", en: "Evening walk" }, start: "19:00", end: null, hard: false },
            { label: { zh: "熄屏", en: "Screens off" }, start: "22:30", end: null, hard: true },
        ],
        stageNote: {
            zh: "此处为白班基色；夜班日整组平移（17:00 小睡起夜班、次日补觉）——相对锚（班前睡够）比绝对时刻重要",
            en: "This is the day-shift base; on night shifts shift the whole set — relative anchors (sleep enough before shift) matter more than clock times",
        },
        conflictAnchor: { zh: "连班周只守班前 6 小时睡眠，其余全让", en: "In back-to-back weeks keep only 6h sleep before shifts; everything else gives" },
    },
    {
        id: "retired",
        name: { zh: "退休族", en: "Retired" },
        chrono: "flex",
        anchors: [
            { label: { zh: "起床", en: "Wake up" }, start: "07:00", end: null, hard: false },
            { label: { zh: "晨练散步", en: "Morning walk" }, start: "08:00", end: "09:00", hard: true },
            { label: { zh: "午休", en: "Nap" }, start: "13:00", end: "14:00", hard: false },
            { label: { zh: "爱好块", en: "Hobby block" }, start: "15:30", end: "17:00", hard: false },
            { label: { zh: "熄屏", en: "Screens off" }, start: "22:30", end: null, hard: false },
        ],
        stageNote: {
            zh: "轻量锚就够——重点晒太阳+规律两餐，不排满",
            en: "Light anchors suffice — prioritize sunshine and regular meals; don't fill the day",
        },
        conflictAnchor: { zh: "带孙周守每天一次晨练，其余随缘", en: "On grandchild weeks keep one morning walk a day; the rest flows" },
    },
];
