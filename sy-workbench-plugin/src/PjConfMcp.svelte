<script lang="ts">
    // 设置双栏 □1「AI 接入」页：MCP 引导卡（三插件同款组件，plugin="project" 只讲主线（项目容器）自己的工具）。
    // 卡框/标题样式由 IndexConf.css 的 .tomato-settings-dialog .settingBox/.section-title 供给
    // （壳已引入该体系，旧 .pj-conf__mcp 三条 :global 补齐退役——值与公共规则一致）。
    import McpPromo from "../../sy-tomato-plugin/src/McpPromo.svelte";
</script>

<McpPromo plugin="project"></McpPromo>
