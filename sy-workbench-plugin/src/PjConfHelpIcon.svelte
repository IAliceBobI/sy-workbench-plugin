<script lang="ts">
    // 标题行帮助直达入口（tomato ConfHelpIcon 同款形态，help.json 换本插件自家快照——
    // 工作台有飞书文档，走 tomato 全参模式非 recite 降级态）：iconHelp 小图标 + 内核
    // b3-tooltips 气泡，点击 openHelpDialog 插件内弹窗秒开分篇快照（无快照回落飞书）。
    import helpDocs from "./help.json";
    import { openHelpDialog } from "../../sy-tomato-plugin/src/libs/helpDialog";

    let { token, label }: { token: string; label: string } = $props();
    // token 是一次性 props（挂载时分篇文档 id 定死不响应变化），模板字符串取初始值是故意的
    // svelte-ignore state_referenced_locally
    const url = `https://my.feishu.cn/docx/${token}?from=from_copylink`;
    const open = () => openHelpDialog(url, helpDocs);
</script>

<span
    class="b3-tooltips b3-tooltips__n conf-help-icon"
    aria-label={label}
    role="button"
    tabindex="0"
    onclick={open}
    onkeydown={(e: KeyboardEvent) => e.key === "Enter" && open()}
>
    <svg aria-hidden="true"><use xlink:href="#iconHelp"></use></svg>
</span>

<style>
    .conf-help-icon {
        display: inline-flex;
        align-items: center;
        margin-left: 6px;
        cursor: pointer;
        color: var(--b3-theme-on-surface-light, var(--b3-theme-on-surface));
    }
    .conf-help-icon:hover {
        color: var(--b3-theme-primary);
    }
    .conf-help-icon svg {
        width: 14px;
        height: 14px;
    }
</style>
