<script lang="ts">
    // 设置双栏 □1「用法示例」页：提示词五组（一键复制）——自 Conf.svelte 纯搬家，交互文案零变化。
    import { ONBOARD_SAMPLE } from "./gui/queries";

    let { t }: { t: Record<string, string> } = $props();

    let copiedKey = $state<string | null>(null);

    let PROMPTS = $derived<Array<{ key: string; desc: string; samples: string[] }>>([
        { key: "create", desc: t.promptCreateDesc, samples: [ONBOARD_SAMPLE] },
        { key: "due", desc: t.promptDueDesc, samples: [t.promptDueSample] },
        { key: "progress", desc: t.promptProgressDesc, samples: [t.promptProgressSample] },
        { key: "structure", desc: t.promptStructureDesc, samples: [t.promptStructureSample1, t.promptStructureSample2] },
        { key: "rebind", desc: t.promptRebindDesc, samples: [t.promptRebindSample] },
    ]);

    // mainfix0923 □5：文件地图行（文案=i18n fm* 键；顺序=项目域→生活域→照镜子，
    // 与队列条目逐行对应；hpath 串=真实文档路径本体，双语同串不翻译。
    // $derived=PROMPTS 同款惰性取值——勿在组件顶层快照 t 初值）
    const FILE_MAP = $derived([
        { key: "mainDoc", file: t.fmMainDoc, desc: t.fmMainDocDesc },
        { key: "line", file: t.fmLine, desc: t.fmLineDesc },
        { key: "archive", file: t.fmArchive, desc: t.fmArchiveDesc },
        { key: "mainline", file: t.fmMainline, desc: t.fmMainlineDesc },
        { key: "diary", file: t.fmDiary, desc: t.fmDiaryDesc },
        { key: "dayConfig", file: t.fmDayConfig, desc: t.fmDayConfigDesc },
        { key: "aversion", file: t.fmAversion, desc: t.fmAversionDesc },
        { key: "mirror", file: t.fmMirror, desc: t.fmMirrorDesc },
    ]);

    function flashCopied(key: string): void {
        copiedKey = key;
        setTimeout(() => {
            if (copiedKey === key) copiedKey = null;
        }, 1500);
    }

    async function copy(text: string, key: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            flashCopied(key);
        } catch {
            // 剪贴板不可用（headless/权限）静默
        }
    }
</script>

<div class="pj-conf__section">
    <!-- mainfix0923 □5：文件地图——「怎么用」节首块（用户向零文件说明：README 讲概念不讲路径，
         这里把每类文档的路径与用途平铺全显示，不藏 hover；title 只当布局截断时的兜底）。
         行文案=i18n fm* 键；hpath 字面量=真实文档路径（zh 文件名即路径本体，双语同串）。 -->
    <div class="pj-conf__map-title">{t.confHowTo}</div>
    {#each FILE_MAP as row (row.key)}
        <div class="pj-conf__map-row" title={row.desc}>
            <span class="pj-conf__map-file">{row.file}</span>
            <span class="pj-conf__map-desc">{row.desc}</span>
        </div>
    {/each}
    <div class="pj-conf__lead">{t.confLead}</div>
    {#each PROMPTS as p (p.key)}
        <div class="pj-conf__row">
            <div class="pj-conf__desc">{p.desc}</div>
            {#each p.samples as sample, i}
                <div class="pj-conf__sample fn__flex">
                    <code class="pj-conf__code fn__flex-1">{sample}</code>
                    <button
                        class="b3-button b3-button--small b3-button--outline"
                        onclick={() => copy(sample, `${p.key}-${i}`)}
                    >{copiedKey === `${p.key}-${i}` ? t.copied : t.copyBtn}</button>
                </div>
            {/each}
        </div>
    {/each}
</div>

<style lang="scss">
    .pj-conf__section {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .pj-conf__lead {
        font-size: 13px;
        color: var(--b3-theme-on-surface);
    }

    /* mainfix0923 □5 文件地图：行内两格平铺全显示（desc 不截断可换行——bear 拍板
       「不藏 hover」，title 仅布局截断兜底）；文件列窄栏对齐，路径串可换行不断词 */
    .pj-conf__map-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--b3-theme-on-background);
        padding: 2px 0;
    }

    .pj-conf__map-row {
        display: flex;
        gap: 10px;
        align-items: baseline;
        padding: 4px 0;
        border-bottom: 1px solid var(--b3-border-color);

        &:last-child {
            border-bottom: none;
        }
    }

    .pj-conf__map-file {
        flex: 0 0 auto;
        max-width: 46%;
        font-size: 12px;
        font-family: var(--b3-font-family-code);
        color: var(--b3-theme-primary);
        overflow-wrap: anywhere;
    }

    .pj-conf__map-desc {
        flex: 1;
        min-width: 0;
        font-size: 12px;
        color: var(--b3-theme-on-surface); /* AA 对比（.pj-conf__desc 同规） */
        overflow-wrap: anywhere;
    }

    .pj-conf__row {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px 0;
        border-bottom: 1px solid var(--b3-border-color);

        &:last-child {
            border-bottom: none;
        }
    }

    .pj-conf__desc {
        font-size: 12px;
        color: var(--b3-theme-on-surface); /* 操作说明须达 AA 对比（vision P1-2） */
    }

    .pj-conf__sample {
        gap: 8px;
        align-items: center;
    }

    .pj-conf__code {
        font-size: 13px;
        padding: 4px 8px;
        border-radius: var(--b3-border-radius);
        background-color: var(--b3-theme-surface);
        border: 1px solid var(--b3-border-color);
        color: var(--b3-theme-on-background);
        overflow-wrap: anywhere;
        text-align: left;
    }

    /* 复制→已复制两字变三字的宽度抖动（vision P2-2） */
    .pj-conf__sample .b3-button {
        min-width: 48px;
    }
</style>
