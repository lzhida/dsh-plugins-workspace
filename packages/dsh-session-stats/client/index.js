globalThis.__ModuleLoader__.load({ id: "@lzhida/dsh-session-stats", factory: function (require) { var module = { exports: {} };
"use strict";var O=Object.defineProperty;var re=Object.getOwnPropertyDescriptor;var ie=Object.getOwnPropertyNames;var le=Object.prototype.hasOwnProperty;var de=(s,t)=>{for(var n in t)O(s,n,{get:t[n],enumerable:!0})},ce=(s,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let c of ie(t))!le.call(s,c)&&c!==n&&O(s,c,{get:()=>t[c],enumerable:!(r=re(t,c))||r.enumerable});return s};var pe=s=>ce(O({},"__esModule",{value:!0}),s);var De={};de(De,{apply:()=>Re,inject:()=>Ne,name:()=>Se});module.exports=pe(De);var X=`/* dsh \u5185\u5D4C\u4EEA\u8868\u76D8\u6837\u5F0F:\u5168\u90E8\u89C4\u5219\u9650\u5B9A\u5728 .dss-scope \u5B50\u6811,\u4E0D\u6C61\u67D3 dsh \u9875\u9762\u5168\u5C40\u3002 */

.dss-scope {
  --bg: #0e1116;
  --panel: #161b22;
  --panel-2: #1d2330;
  --border: #2a3140;
  --text: #e6e9ef;
  --text-dim: #8b95a5;
  --accent: #4c8dff;
  --accent-2: #a78bfa;
  --good: #34d399;
  --warn: #fbbf24;
  --bad: #f87171;
  --chart-cache: #33507e;
  --chart-input: #2f6feb;
  --chart-output: #10b981;
  --shadow: 0 1px 3px rgb(0 0 0 / 40%);

  background: var(--bg);
  color: var(--text);
  font-family:
    'Segoe UI',
    'Microsoft YaHei',
    system-ui,
    -apple-system,
    sans-serif;
  font-size: 14px;
  line-height: 1.5;
  min-height: 100%;
  box-sizing: border-box;
  container-type: inline-size;
}

/* \u5185\u5D4C\u6A21\u5F0F:\u5360\u6EE1 dsh tab body \u5E76\u81EA\u6301\u6EDA\u52A8(\u5BBF\u4E3B\u5BB9\u5668\u901A\u5E38\u88C1\u526A\u6EA2\u51FA)\u3002 */
.dss-scope.dss-embedded {
  height: 100%;
  overflow: auto;
}

.dss-scope[data-theme='light'] {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --panel-2: #f0f2f5;
  --border: #dfe3e8;
  --text: #1c2128;
  --text-dim: #5c6773;
  --accent: #2563eb;
  --accent-2: #7c3aed;
  --good: #059669;
  --warn: #d97706;
  --bad: #dc2626;
  --chart-cache: #93c5fd;
  --chart-input: #3b82f6;
  --chart-output: #10b981;
  --shadow: 0 1px 3px rgb(0 0 0 / 8%);
}

.dss-scope * {
  box-sizing: border-box;
}

.dss-scope .menu-btn {
  display: none;
}

.dss-scope .scrim {
  display: none;
}

.dss-scope .app {
  display: flex;
  align-items: flex-start;
}

.dss-scope .sidebar {
  width: 224px;
  flex-shrink: 0;
  position: sticky;
  top: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 12px 14px;
  background: var(--panel);
  border-right: 1px solid var(--border);
}

.dss-scope .brand {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 10px 14px;
  font-weight: 700;
  font-size: 15px;
}

.dss-scope .brand-icon {
  color: var(--accent);
  font-size: 18px;
  line-height: 1.3;
}

.dss-scope .brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.dss-scope .brand-text small {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 400;
  margin-top: 2px;
}

.dss-scope .nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dss-scope .nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.dss-scope .nav-item:hover {
  background: var(--panel-2);
  color: var(--text);
}

.dss-scope .nav-item.active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-weight: 600;
}

.dss-scope .nav-icon {
  width: 18px;
  text-align: center;
}

.dss-scope .sidebar-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.dss-scope .lang-switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.dss-scope .lang-switch button {
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  padding: 5px 0;
  cursor: pointer;
  font-size: 12px;
}

.dss-scope .lang-switch button.active {
  background: var(--accent);
  color: #fff;
}

.dss-scope .btn {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}

.dss-scope .btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.dss-scope .btn.full {
  width: 100%;
}

.dss-scope .btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.dss-scope .main {
  flex: 1;
  min-width: 0;
  padding: 16px 18px 32px;
}

.dss-scope .topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.dss-scope .topbar-title {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.dss-scope .topbar h1 {
  font-size: 20px;
  margin: 0;
}

.dss-scope .subtitle {
  color: var(--text-dim);
  font-size: 12px;
}

.dss-scope .topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dss-scope .range-tabs {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}

.dss-scope .range-tabs button {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}

.dss-scope .range-tabs button.active {
  background: var(--accent);
  color: #fff;
}

.dss-scope .meta-line {
  color: var(--text-dim);
  font-size: 12px;
  margin: 10px 0 16px;
}

.dss-scope .cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}

.dss-scope .card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  box-shadow: var(--shadow);
}

.dss-scope .card .label {
  color: var(--text-dim);
  font-size: 12px;
}

.dss-scope .card .value {
  font-size: 20px;
  font-weight: 600;
  margin-top: 2px;
}

.dss-scope .card .sub {
  color: var(--text-dim);
  font-size: 11px;
  margin-top: 2px;
}

.dss-scope .panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  box-shadow: var(--shadow);
  margin-bottom: 16px;
  min-width: 0;
}

.dss-scope .panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.dss-scope .panel-head h2 {
  font-size: 15px;
  margin: 0;
}

.dss-scope .panel-head .hint {
  color: var(--text-dim);
  font-size: 11px;
}

.dss-scope .grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.dss-scope .menu-btn {
  display: none;
}

.dss-scope .scrim {
  display: none;
}

/* \u7A84\u5BB9\u5668(\u5185\u5D4C dsh \u4FA7\u680F tab \u6216\u7A84\u7A97\u53E3):\u5DE6\u83DC\u5355\u6536\u8D77\u4E3A\u62BD\u5C49,\u70B9 \u2630 \u5F39\u51FA\u3002 */
@container (max-width: 900px) {
  .dss-scope .menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .dss-scope .grid-2 {
    grid-template-columns: 1fr;
  }

  .dss-scope .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    height: auto;
    align-self: auto;
    width: 232px;
    z-index: 60;
    transform: translateX(-105%);
    transition: transform 0.18s ease;
    box-shadow: 0 0 28px rgb(0 0 0 / 40%);
  }

  .dss-scope.drawer-open .sidebar {
    transform: none;
  }

  .dss-scope .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgb(0 0 0 / 45%);
    border: 0;
    padding: 0;
    cursor: default;
  }

  .dss-scope:not(.drawer-open) .scrim {
    display: none;
  }

  .dss-scope .main {
    padding: 12px 12px 28px;
  }
}

.dss-scope table {
  width: 100%;
  border-collapse: collapse;
}

.dss-scope th,
.dss-scope td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  white-space: nowrap;
}

.dss-scope th {
  color: var(--text-dim);
  font-weight: 500;
  font-size: 12px;
}

.dss-scope td.num,
.dss-scope th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.dss-scope tr:last-child td {
  border-bottom: 0;
}

.dss-scope .table-scroll {
  overflow-x: auto;
}

.dss-scope .mono {
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
}

.dss-scope .dim {
  color: var(--text-dim);
}

.dss-scope .bad {
  color: var(--bad);
}

.dss-scope .warn {
  color: var(--warn);
}

.dss-scope .share-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--panel-2);
  overflow: hidden;
  margin-top: 4px;
  display: block;
}

.dss-scope .share-bar > * {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

.dss-scope .daily-chart {
  width: 100%;
}

.dss-scope .daily-chart svg {
  width: 100%;
  height: 240px;
  display: block;
}

.dss-scope .legend {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-dim);
  flex-wrap: wrap;
}

.dss-scope .legend .dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
  margin-right: 5px;
  vertical-align: -1px;
}

.dss-scope .hourly-heat {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 4px;
}

.dss-scope .hour-cell {
  border-radius: 5px;
  background: var(--panel-2);
  padding: 6px 0;
  text-align: center;
  font-size: 10px;
  color: var(--text-dim);
  cursor: default;
}

.dss-scope .tooltip {
  position: fixed;
  z-index: 10000;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
  padding: 8px 10px;
  font-size: 12px;
  pointer-events: none;
  max-width: 320px;
  color: var(--text);
}

.dss-scope .empty {
  color: var(--text-dim);
  font-size: 13px;
  padding: 12px 0;
}

.dss-scope .footer {
  color: var(--text-dim);
  font-size: 11px;
  margin-top: 8px;
}
`;var d=require("react"),e=require("react/jsx-runtime"),L={zh:{brand:"DSH \u4F1A\u8BDD\u7EDF\u8BA1",subtitle:"\u672C\u5730\u4F1A\u8BDD\u6587\u4EF6 \xB7 \u7528\u91CF\u89C2\u6D4B",navOverview:"\u6982\u89C8",navModels:"\u6A21\u578B",navTools:"\u5DE5\u5177",navProjects:"\u9879\u76EE",navSessions:"\u4F1A\u8BDD",navErrors:"\u9519\u8BEF",viewHintOverview:"\u6838\u5FC3\u6307\u6807\u4E0E\u6BCF\u65E5\u7528\u91CF\u8D8B\u52BF",viewHintModels:"\u6309 provider/model \u7C92\u5EA6\u7684\u7528\u91CF\u5206\u5E03",viewHintTools:"\u5DE5\u5177\u8C03\u7528\u6392\u884C\u4E0E\u8017\u65F6",viewHintProjects:"\u6309\u5DE5\u4F5C\u76EE\u5F55\u6C47\u603B",viewHintSessions:"\u6700\u8FD1\u7684\u4F1A\u8BDD\u6D3B\u52A8",viewHintErrors:"LLM \u91CD\u8BD5\u4E0E\u5931\u8D25\u7801\u5206\u5E03",range7d:"7 \u5929",range30d:"30 \u5929",range90d:"90 \u5929",rangeAll:"\u5168\u90E8",sync:"\u540C\u6B65",syncing:"\u540C\u6B65\u4E2D\u2026",loading:"\u52A0\u8F7D\u4E2D\u2026",loadFailed:"\u52A0\u8F7D\u5931\u8D25",syncDone:"\u540C\u6B65\u5B8C\u6210",generatedAt:"\u751F\u6210\u4E8E",justNow:"\u521A\u521A",minutesAgo:" \u5206\u949F\u524D",hoursAgo:" \u5C0F\u65F6\u524D",daysAgo:" \u5929\u524D",cardSessions:"\u4F1A\u8BDD\u6570",cardProjectsSuffix:" \u4E2A\u9879\u76EE",cardTotalTokens:"\u603B Token\uFF08API \u7B49\u4EF7\uFF09",cardInputOutput:"\u8F93\u5165 / \u8F93\u51FA",cardCacheRead:"\u7F13\u5B58\u8BFB\u53D6",cardMessages:"\u6D88\u606F\u6570",cardTurnsSuffix:" \u8F6E \xB7 ",cardStepsSuffix:" \u6B65",cardToolCalls:"\u5DE5\u5177\u8C03\u7528",toolFailedSuffix:" \u6B21\u5931\u8D25",allToolsOk:"\u5168\u90E8\u6210\u529F",cardActiveDays:"\u6D3B\u8DC3\u5929\u6570",cardDailyAvg:"\u65E5\u5747 Token",cardLlmCallsPrefix:"LLM \u8C03\u7528 ",cardCallsSuffix:" \u6B21",cardTopModel:"Top \u6A21\u578B",cardTopTool:"Top \u5DE5\u5177",cardTopToolSub:"\u6309\u8C03\u7528\u6B21\u6570",cardRetries:"LLM \u91CD\u8BD5",seeErrors:"\u89C1\u9519\u8BEF\u89C6\u56FE",noRetries:"\u65E0\u91CD\u8BD5",dailyChartTitle:"\u6BCF\u65E5\u7528\u91CF",dailyChartHint:"\u5806\u53E0\uFF1A\u7F13\u5B58\u8BFB\u53D6 / \u8F93\u5165 / \u8F93\u51FA\uFF08\u8D26\u672C\u8865\u9F50\u7684\u5386\u53F2\u65E5\u671F\u5E26 \u2022 \u6807\u8BB0\uFF09",legendCache:"\u7F13\u5B58\u8BFB\u53D6",legendInput:"\u8F93\u5165",legendOutput:"\u8F93\u51FA",legendLedger:"\u8D26\u672C\u8865\u9F50\u7684\u5386\u53F2\u65E5\u671F",chartEmpty:"\u8303\u56F4\u5185\u6CA1\u6709\u7528\u91CF\u6570\u636E \u2014\u2014 \u70B9\u51FB\u300C\u540C\u6B65\u300D\u7D22\u5F15\u6700\u8FD1\u6D3B\u52A8\u3002",tableEmpty:"\u6682\u65E0\u6570\u636E",thCalls:"\u8C03\u7528",thInput:"\u8F93\u5165",thOutput:"\u8F93\u51FA",thCacheRead:"\u7F13\u5B58\u8BFB",thCacheWrite:"\u7F13\u5B58\u5199",thTotal:"\u603B\u91CF",thModel:"\u6A21\u578B",thTool:"\u5DE5\u5177",thAvgDuration:"\u5E73\u5747\u8017\u65F6",thTotalDuration:"\u7D2F\u8BA1\u8017\u65F6",thProject:"\u9879\u76EE",thSessions:"\u4F1A\u8BDD",thMessages:"\u6D88\u606F",thTokens:"Token",thLastActive:"\u6700\u540E\u6D3B\u8DC3",thTitle:"\u6807\u9898",thSpan:"\u8DE8\u5EA6",thActive:"\u6D3B\u8DC3",thCode:"\u5931\u8D25\u7801",thCount:"\u6B21\u6570",thProvider:"Provider",thTokenTotal:"Token \u603B\u91CF",hourlyTitle:"\u5C0F\u65F6\u5206\u5E03",hourlyHint:"LLM \u8C03\u7528\u7684\u672C\u5730\u5C0F\u65F6\u70ED\u5EA6",hourlyTooltipPrefix:":00 \u2013 ",hourlyTooltipSuffix:" \u6B21 LLM \u8C03\u7528",errorsTitle:"LLM \u91CD\u8BD5 / \u9519\u8BEF",errorsHint:"llm/retry \u5931\u8D25\u7801\u5206\u5E03",errorsEmpty:"\u8303\u56F4\u5185\u6CA1\u6709\u91CD\u8BD5\u8BB0\u5F55",toolFailedNote:"\uFF08{n} \u5931\u8D25\uFF09",providersSub:"\u6309 provider \u6C47\u603B",exportRangeNote:"\u9759\u6001\u5BFC\u51FA\u6587\u4EF6\u4EC5\u5305\u542B\u5BFC\u51FA\u65F6\u6240\u9009\u8303\u56F4\u7684\u6570\u636E\u3002",footer:"dsh-session-stats \xB7 \u6570\u636E\u6765\u81EA\u672C\u5730 ~/.dsh \u4F1A\u8BDD\u6587\u4EF6\u4E0E usage-ledger",themeTitle:"\u5207\u6362\u4E3B\u9898",langTitle:"Language",openMenu:"\u6253\u5F00\u83DC\u5355"},en:{brand:"DSH Session Stats",subtitle:"Local session files \xB7 usage insights",navOverview:"Overview",navModels:"Models",navTools:"Tools",navProjects:"Projects",navSessions:"Sessions",navErrors:"Errors",viewHintOverview:"Key metrics and daily usage trend",viewHintModels:"Usage breakdown by provider/model",viewHintTools:"Tool call ranking and durations",viewHintProjects:"Aggregated by working directory",viewHintSessions:"Recent session activity",viewHintErrors:"LLM retry and failure code distribution",range7d:"7d",range30d:"30d",range90d:"90d",rangeAll:"All",sync:"Sync",syncing:"Syncing\u2026",loading:"Loading\u2026",loadFailed:"Load failed",syncDone:"Sync done",generatedAt:"generated",justNow:"just now",minutesAgo:" min ago",hoursAgo:" h ago",daysAgo:" d ago",cardSessions:"Sessions",cardProjectsSuffix:" projects",cardTotalTokens:"Total Tokens (API-equiv.)",cardInputOutput:"Input / Output",cardCacheRead:"Cache Read",cardMessages:"Messages",cardTurnsSuffix:" turns \xB7 ",cardStepsSuffix:" steps",cardToolCalls:"Tool Calls",toolFailedSuffix:" failed",allToolsOk:"all succeeded",cardActiveDays:"Active Days",cardDailyAvg:"Daily Avg Tokens",cardLlmCallsPrefix:"LLM calls ",cardCallsSuffix:"",cardTopModel:"Top Model",cardTopTool:"Top Tool",cardTopToolSub:"by call count",cardRetries:"LLM Retries",seeErrors:"see Errors view",noRetries:"no retries",dailyChartTitle:"Daily Usage",dailyChartHint:"Stacked: cache read / input / output (\u2022 marks ledger-only history)",legendCache:"Cache read",legendInput:"Input",legendOutput:"Output",legendLedger:"ledger-only history",chartEmpty:'No usage in this range \u2014 hit "Sync" to index recent activity.',tableEmpty:"No data",thCalls:"Calls",thInput:"Input",thOutput:"Output",thCacheRead:"Cache read",thCacheWrite:"Cache write",thTotal:"Total",thModel:"Model",thTool:"Tool",thAvgDuration:"Avg duration",thTotalDuration:"Total duration",thProject:"Project",thSessions:"Sessions",thMessages:"Messages",thTokens:"Tokens",thLastActive:"Last active",thTitle:"Title",thSpan:"Span",thActive:"Active",thCode:"Code",thCount:"Count",thProvider:"Provider",thTokenTotal:"Token total",hourlyTitle:"Peak Hours",hourlyHint:"LLM calls by local hour of day",hourlyTooltipPrefix:":00 \u2013 ",hourlyTooltipSuffix:" LLM calls",errorsTitle:"LLM Retries / Errors",errorsHint:"llm/retry failure code distribution",errorsEmpty:"No retries in this range",toolFailedNote:"({n} failed)",providersSub:"aggregated by provider",exportRangeNote:"Static export embeds only the range selected at export time.",footer:"dsh-session-stats \xB7 data from local ~/.dsh session files and usage-ledger",themeTitle:"Toggle theme",langTitle:"Language",openMenu:"Open menu"}};function ge(){try{let s=localStorage.getItem("dsh-stats-lang");if(s==="en"||s==="zh")return s}catch{}return navigator.language.toLowerCase().startsWith("zh")?"zh":"en"}function g(s){return Number(s??0).toLocaleString("en-US")}function l(s){let t=Number(s??0);return t>=1e8?`${(t/1e8).toFixed(2)}\u4EBF`:t>=1e4?`${(t/1e4).toFixed(1)}\u4E07`:g(t)}function I(s){let t=Number(s??0);if(t<1e3)return`${Math.round(t)}ms`;if(t<6e4)return`${(t/1e3).toFixed(1)}s`;if(t<36e5){let c=Math.floor(t/6e4),p=Math.round(t%6e4/1e3);return`${c}m${String(p).padStart(2,"0")}s`}let n=Math.floor(t/36e5),r=Math.round(t%36e5/6e4);return`${n}h${String(r).padStart(2,"0")}m`}function q(s){if(!s)return"\u2014";let t=new Date(s),n=r=>String(r).padStart(2,"0");return`${t.getFullYear()}-${n(t.getMonth()+1)}-${n(t.getDate())} ${n(t.getHours())}:${n(t.getMinutes())}`}function _(s,t){let n=Date.now()-s;return n<6e4?t("justNow"):n<36e5?`${Math.floor(n/6e4)}${t("minutesAgo")}`:n<864e5?`${Math.floor(n/36e5)}${t("hoursAgo")}`:`${Math.floor(n/864e5)}${t("daysAgo")}`}function E(s,t){return{x:s.clientX+14,y:s.clientY+14,content:t}}var Z=[{key:"overview",icon:"\u25D4",labelKey:"navOverview"},{key:"models",icon:"\u25A6",labelKey:"navModels"},{key:"tools",icon:"\u2699",labelKey:"navTools"},{key:"projects",icon:"\u25A4",labelKey:"navProjects"},{key:"sessions",icon:"\u276F",labelKey:"navSessions"},{key:"errors",icon:"\u26A0",labelKey:"navErrors"}],he=[["7d","range7d"],["30d","range30d"],["90d","range90d"],["all","rangeAll"]];function be(s){return Z.some(t=>t.key===s)?s:"overview"}function J(){return be(window.location.hash.replace(/^#\/?/,""))}function me(s){return{overview:"navOverview",models:"navModels",tools:"navTools",projects:"navProjects",sessions:"navSessions",errors:"navErrors"}[s]}function ve(s){return{overview:"viewHintOverview",models:"viewHintModels",tools:"viewHintTools",projects:"viewHintProjects",sessions:"viewHintSessions",errors:"viewHintErrors"}[s]}function N({title:s,hint:t,children:n}){return(0,e.jsxs)("section",{className:"panel",children:[(0,e.jsxs)("div",{className:"panel-head",children:[(0,e.jsx)("h2",{children:s}),t?(0,e.jsx)("span",{className:"hint",children:t}):null]}),n]})}function C({columns:s,rows:t,empty:n}){return t.length===0?(0,e.jsx)("div",{className:"empty",children:n}):(0,e.jsx)("div",{className:"table-scroll",children:(0,e.jsxs)("table",{children:[(0,e.jsx)("thead",{children:(0,e.jsx)("tr",{children:s.map(r=>(0,e.jsx)("th",{className:r.num?"num":"",children:r.label},r.label))})}),(0,e.jsx)("tbody",{children:t.map((r,c)=>(0,e.jsx)("tr",{children:r.map((p,u)=>(0,e.jsx)("td",{className:s[u]?.num?"num":"",children:p},u))},c))})]})})}function ye({data:s,t}){let n=s.overview,r=n.usage,c=[{label:t("cardSessions"),value:g(n.sessions),sub:`${g(n.projects)}${t("cardProjectsSuffix")}`},{label:t("cardTotalTokens"),value:l(r.totalTokens),sub:`${t("thInput")} ${l(r.inputTokens)} \xB7 ${t("thOutput")} ${l(r.outputTokens)} \xB7 ${t("thCacheRead")} ${l(r.cacheReadTokens)} \xB7 ${t("thCacheWrite")} ${l(r.cacheWriteTokens)}`},{label:t("cardInputOutput"),value:`${l(r.inputTokens)} / ${l(r.outputTokens)}`,sub:`${t("thCacheRead")} ${l(r.cacheReadTokens)} \xB7 ${t("thCacheWrite")} ${l(r.cacheWriteTokens)}`},{label:t("cardCacheRead"),value:l(r.cacheReadTokens),sub:`${t("thCacheWrite")} ${l(r.cacheWriteTokens)}`},{label:t("cardMessages"),value:g(n.messages),sub:`${g(n.turns)}${t("cardTurnsSuffix")}${g(n.steps)}${t("cardStepsSuffix")}`},{label:t("cardToolCalls"),value:g(n.toolCalls),sub:n.toolErrors>0?(0,e.jsxs)("span",{className:"bad",children:[g(n.toolErrors),t("toolFailedSuffix")]}):t("allToolsOk")},{label:t("cardActiveDays"),value:g(n.activeDays),sub:n.firstDay?`${n.firstDay} ~ ${n.lastDay}`:"\u2014"},{label:t("cardDailyAvg"),value:l(n.avgTokensPerActiveDay),sub:`${t("cardLlmCallsPrefix")}${g(r.calls)}${t("cardCallsSuffix")}`},{label:t("cardTopModel"),value:n.topModel?n.topModel.split("/").slice(1).join("/"):"\u2014",sub:n.topModel?n.topModel.split("/")[0]:""},{label:t("cardTopTool"),value:n.topTool??"\u2014",sub:t("cardTopToolSub")},{label:t("cardRetries"),value:g(n.retryCount),sub:n.retryCount>0?t("seeErrors"):t("noRetries")}];return(0,e.jsx)("section",{className:"cards",children:c.map(p=>(0,e.jsxs)("div",{className:"card",children:[(0,e.jsx)("div",{className:"label",children:p.label}),(0,e.jsx)("div",{className:"value",children:p.value}),(0,e.jsx)("div",{className:"sub",children:p.sub})]},p.label))})}var F=1e3,V=240,H=46,Q=10,W=10,fe=26;function xe({daily:s,t,setTip:n}){let r=(0,d.useMemo)(()=>{let i=V-W-fe,v=Math.max(...s.map(h=>h.totalTokens),1);return{plotH:i,maxTotal:v,y:h=>W+i-h/v*i}},[s]);if(s.length===0)return(0,e.jsx)("div",{className:"empty",children:t("chartEmpty")});let{plotH:c,y:p}=r,u=(F-H-Q)/s.length,T=Math.max(1,u*.72),w=Math.max(1,Math.ceil(s.length/12)),k=[];for(let i=0;i<=4;i++){let v=r.maxTotal/4*i,f=p(v);k.push((0,e.jsx)("line",{x1:H,y1:f,x2:F-Q,y2:f,stroke:"var(--border)",strokeWidth:1,strokeDasharray:i===0?void 0:"3 4"},i),(0,e.jsx)("text",{x:H-6,y:f+4,textAnchor:"end",fontSize:10,fill:"var(--text-dim)",children:l(v)},`t${i}`))}let y=i=>(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("b",{children:i.date}),i.source==="ledger"?(0,e.jsxs)("span",{className:"warn",children:[" (",t("legendLedger"),")"]}):null,(0,e.jsx)("br",{}),t("thTotal")," ",l(i.totalTokens)," \xB7 ",t("thCalls")," ",g(i.calls),i.sessions>0?` \xB7 ${g(i.sessions)} ${t("navSessions").toLowerCase()}`:"",(0,e.jsx)("br",{}),t("thInput")," ",l(i.inputTokens)," \xB7 ",t("thOutput")," ",l(i.outputTokens),(0,e.jsx)("br",{}),t("thCacheRead")," ",l(i.cacheReadTokens)," \xB7 ",t("thCacheWrite")," ",l(i.cacheWriteTokens)]});return(0,e.jsxs)("div",{className:"daily-chart",children:[(0,e.jsxs)("svg",{viewBox:`0 0 ${F} ${V}`,preserveAspectRatio:"none",role:"img",children:[k,s.map((i,v)=>{let f=H+u*v+u/2,h=f-T/2,z=[{v:i.cacheReadTokens,color:"var(--chart-cache)",key:"cache"},{v:i.inputTokens,color:"var(--chart-input)",key:"input"},{v:i.outputTokens,color:"var(--chart-output)",key:"output"}],S=0,R=z.filter(b=>b.v>0).map(b=>{let M=p(S+b.v),D=Math.max(1,p(S)-p(S+b.v));return S+=b.v,(0,e.jsx)("rect",{x:h,y:M,width:T,height:D,fill:b.color,rx:1},b.key)});return(0,e.jsxs)("g",{children:[R,v%w===0?(0,e.jsx)("text",{x:f,y:V-8,textAnchor:"middle",fontSize:10,fill:"var(--text-dim)",children:i.date.slice(5)}):null,i.source==="ledger"?(0,e.jsx)("circle",{cx:f,cy:p(i.totalTokens)-6,r:2.5,fill:"var(--warn)"}):null,(0,e.jsx)("rect",{className:"hit",x:h-1,y:W,width:T+2,height:c,fill:"transparent",onMouseEnter:b=>n(E(b,y(i))),onMouseMove:b=>n(E(b,y(i))),onMouseLeave:()=>n(null)})]},i.date)})]}),(0,e.jsxs)("div",{className:"legend",children:[(0,e.jsxs)("span",{children:[(0,e.jsx)("span",{className:"dot",style:{background:"var(--chart-cache)"}}),t("legendCache")]}),(0,e.jsxs)("span",{children:[(0,e.jsx)("span",{className:"dot",style:{background:"var(--chart-input)"}}),t("legendInput")]}),(0,e.jsxs)("span",{children:[(0,e.jsx)("span",{className:"dot",style:{background:"var(--chart-output)"}}),t("legendOutput")]}),(0,e.jsxs)("span",{children:[(0,e.jsx)("span",{className:"dot",style:{background:"var(--warn)",borderRadius:"50%"}}),t("legendLedger")]})]})]})}function Te({hourly:s,t,setTip:n}){let r=Math.max(...s,1);return(0,e.jsx)("div",{className:"hourly-heat",children:s.map((c,p)=>{let u=c/r,T=c>0?{background:`color-mix(in srgb, var(--accent) ${Math.round(15+u*85)}%, transparent)`,color:u>.5?"#fff":"var(--text-dim)"}:void 0,w=`${String(p).padStart(2,"0")}${t("hourlyTooltipPrefix")}${g(c)}${t("hourlyTooltipSuffix")}`;return(0,e.jsx)("div",{className:"hour-cell",style:T,onMouseEnter:k=>n(E(k,w)),onMouseMove:k=>n(E(k,w)),onMouseLeave:()=>n(null),children:p},p)})})}function we({data:s,t}){let n=Math.max(...s.providers.map(r=>r.totalTokens),1);return(0,e.jsx)(C,{empty:t("tableEmpty"),columns:[{label:t("thProvider")},{label:t("thCalls"),num:!0},{label:t("thTokenTotal"),num:!0}],rows:s.providers.map(r=>{let c=(r.totalTokens/n*100).toFixed(1);return[(0,e.jsx)("span",{className:"mono",children:r.provider},"k"),g(r.calls),(0,e.jsxs)("span",{children:[l(r.totalTokens)," ",(0,e.jsxs)("span",{className:"dim",children:["(",c,"%)"]}),(0,e.jsx)("span",{className:"share-bar",children:(0,e.jsx)("span",{style:{display:"block",height:"100%",width:`${c}%`}})})]},"t")]})})}function ke(){try{let s=localStorage.getItem("dsh-stats-theme");if(s==="dark"||s==="light")return s}catch{}return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}function ee(s){let{dataBase:t,syncBase:n,standalone:r=!1,showSidebar:c=!0}=s,p=s.initialData??null,[u,T]=(0,d.useState)(()=>s.initialLang??ge()),[w,k]=(0,d.useState)(()=>ke()),[y,i]=(0,d.useState)(()=>r&&typeof window<"u"?J():"overview"),[v,f]=(0,d.useState)(s.initialRange??"30d"),[h,z]=(0,d.useState)(p),[S,R]=(0,d.useState)(""),[b,M]=(0,d.useState)(null),[D,G]=(0,d.useState)(!1),[A,U]=(0,d.useState)(null),[te,j]=(0,d.useState)(!1),K=p!==null,a=(0,d.useCallback)(o=>L[u][o],[u]);(0,d.useEffect)(()=>{r&&(document.documentElement.lang=u,document.title=L[u].brand)},[u,r]),(0,d.useEffect)(()=>{try{localStorage.setItem("dsh-stats-lang",u)}catch{}},[u]),(0,d.useEffect)(()=>{if(!r)return;let o=()=>i(J());return window.addEventListener("hashchange",o),()=>window.removeEventListener("hashchange",o)},[r]);let $=(0,d.useCallback)(async o=>{M(null);try{let m=await fetch(`${t}?range=${encodeURIComponent(o)}`);if(!m.ok)throw new Error(`HTTP ${m.status}`);z(await m.json())}catch(m){M(m instanceof Error?m.message:String(m))}},[t]),ae=(0,d.useCallback)(o=>{if(f(o),K){R(L[u].exportRangeNote);return}$(o)},[K,u,$]),se=(0,d.useCallback)(async()=>{G(!0);try{let m=await(await fetch(n,{method:"POST"})).json();R(`${L[u].syncDone}: ${m.files} / ${m.processed} / ${m.sessions} (${m.durationMs}ms)`),await $(v)}catch(o){M(o instanceof Error?o.message:String(o))}finally{G(!1)}},[u,$,v,n]);(0,d.useEffect)(()=>{p||$(v)},[]);let oe=(0,d.useCallback)(()=>{let o=w==="dark"?"light":"dark";k(o);try{localStorage.setItem("dsh-stats-theme",o)}catch{}r&&(document.documentElement.dataset.theme=o)},[r,w]),ne=(0,d.useCallback)(o=>{r&&(window.location.hash=`#/${o}`),i(o),j(!1)},[r]),Y=h?.overview;return(0,e.jsxs)("div",{className:`dss-scope app${r?"":" dss-embedded"}${te?" drawer-open":""}`,"data-theme":w,children:[c?(0,e.jsxs)("aside",{className:"sidebar",children:[(0,e.jsxs)("div",{className:"brand",children:[(0,e.jsx)("span",{className:"brand-icon",children:"\u25C8"}),(0,e.jsxs)("span",{className:"brand-text",children:[a("brand"),(0,e.jsx)("small",{children:a("subtitle")})]})]}),(0,e.jsx)("nav",{className:"nav",children:Z.map(o=>(0,e.jsxs)("button",{type:"button",className:`nav-item${y===o.key?" active":""}`,onClick:()=>ne(o.key),children:[(0,e.jsx)("span",{className:"nav-icon",children:o.icon}),(0,e.jsx)("span",{children:a(o.labelKey)})]},o.key))}),(0,e.jsxs)("div",{className:"sidebar-footer",children:[(0,e.jsxs)("div",{className:"lang-switch",title:a("langTitle"),children:[(0,e.jsx)("button",{type:"button",className:u==="zh"?"active":"",onClick:()=>T("zh"),children:"\u4E2D\u6587"}),(0,e.jsx)("button",{type:"button",className:u==="en"?"active":"",onClick:()=>T("en"),children:"EN"})]}),(0,e.jsxs)("button",{className:"btn full",type:"button",title:a("themeTitle"),onClick:oe,children:["\u25D0 ",a("themeTitle")]})]})]}):null,(0,e.jsx)("button",{type:"button",className:"scrim","aria-label":a("openMenu"),onClick:()=>j(!1)}),(0,e.jsxs)("main",{className:"main",children:[(0,e.jsxs)("header",{className:"topbar",children:[(0,e.jsxs)("div",{className:"topbar-title",children:[(0,e.jsx)("h1",{children:a(me(y))}),(0,e.jsx)("span",{className:"subtitle",children:a(ve(y))})]}),(0,e.jsxs)("div",{className:"topbar-actions",children:[(0,e.jsx)("button",{type:"button",className:"btn icon menu-btn","aria-label":a("openMenu"),title:a("openMenu"),onClick:()=>j(!0),children:"\u2630"}),(0,e.jsx)("div",{className:"range-tabs",role:"tablist",children:he.map(([o,m])=>(0,e.jsx)("button",{type:"button",role:"tab",className:v===o?"active":"",onClick:()=>ae(o),children:a(m)},o))}),K?null:(0,e.jsx)("button",{className:"btn",type:"button",disabled:D,onClick:()=>{se()},children:a(D?"syncing":"sync")})]})]}),(0,e.jsx)("div",{className:"meta-line",children:b?(0,e.jsxs)("span",{className:"bad",children:[a("loadFailed"),": ",b]}):(0,e.jsxs)(e.Fragment,{children:[S,h&&Y?`${S?" \xB7 ":""}${a("generatedAt")} ${q(h.generatedAt)} \xB7 ${_(h.generatedAt,a)}`:S?"":a("loading")]})}),h&&Y?(0,e.jsxs)(e.Fragment,{children:[y==="overview"?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(ye,{data:h,t:a}),(0,e.jsx)(N,{title:a("dailyChartTitle"),hint:a("dailyChartHint"),children:(0,e.jsx)(xe,{daily:h.daily,t:a,setTip:U})}),(0,e.jsx)(N,{title:a("hourlyTitle"),hint:a("hourlyHint"),children:(0,e.jsx)(Te,{hourly:h.hourly,t:a,setTip:U})})]}):null,y==="models"?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(N,{title:a("navModels"),hint:a("viewHintModels"),children:(0,e.jsx)(C,{empty:a("tableEmpty"),columns:[{label:a("thModel")},{label:a("thCalls"),num:!0},{label:a("thInput"),num:!0},{label:a("thOutput"),num:!0},{label:a("thCacheRead"),num:!0},{label:a("thTotal"),num:!0}],rows:h.models.map(o=>[(0,e.jsxs)("span",{className:"mono",children:[o.provider,"/",o.model]},"k"),g(o.calls),l(o.inputTokens),l(o.outputTokens),l(o.cacheReadTokens),l(o.totalTokens)])})}),(0,e.jsx)(N,{title:a("thProvider"),hint:a("providersSub"),children:(0,e.jsx)(we,{data:h,t:a})})]}):null,y==="tools"?(0,e.jsx)(N,{title:a("navTools"),hint:a("viewHintTools"),children:(0,e.jsx)(C,{empty:a("tableEmpty"),columns:[{label:a("thTool")},{label:a("thCalls"),num:!0},{label:a("thAvgDuration"),num:!0},{label:a("thTotalDuration"),num:!0}],rows:h.tools.map(o=>[(0,e.jsx)("span",{className:"mono",children:o.name},"k"),g(o.calls),I(o.avgDurationMs),(0,e.jsxs)(e.Fragment,{children:[I(o.totalDurationMs),o.errors>0?(0,e.jsx)("span",{className:"bad",children:a("toolFailedNote").replace("{n}",String(o.errors))}):null]})])})}):null,y==="projects"?(0,e.jsx)(N,{title:a("navProjects"),hint:a("viewHintProjects"),children:(0,e.jsx)(C,{empty:a("tableEmpty"),columns:[{label:a("thProject")},{label:a("thSessions"),num:!0},{label:a("thMessages"),num:!0},{label:a("thTokens"),num:!0},{label:a("thLastActive"),num:!0}],rows:h.projects.map(o=>[o.project,g(o.sessions),g(o.messages),l(o.usage.totalTokens),(0,e.jsx)("span",{className:"dim",children:_(o.lastActiveAt,a)},"k")])})}):null,y==="sessions"?(0,e.jsx)(N,{title:a("navSessions"),hint:a("viewHintSessions"),children:(0,e.jsx)(C,{empty:a("tableEmpty"),columns:[{label:a("thTitle")},{label:a("thProject")},{label:a("thModel")},{label:a("thMessages"),num:!0},{label:a("navTools"),num:!0},{label:a("thTokens"),num:!0},{label:a("thSpan"),num:!0},{label:a("thActive"),num:!0}],rows:h.recent.map(o=>[(0,e.jsx)("span",{title:o.id,children:o.title},"k"),o.project,(0,e.jsx)("span",{className:"mono",children:o.model},"m"),g(o.messages),g(o.toolCalls),l(o.usage.totalTokens),I(o.activeMs),(0,e.jsx)("span",{className:"dim",title:q(o.lastActiveAt),children:_(o.lastActiveAt,a)},"a")])})}):null,y==="errors"?(0,e.jsx)(N,{title:a("errorsTitle"),hint:a("errorsHint"),children:(0,e.jsx)(C,{empty:a("errorsEmpty"),columns:[{label:a("thCode")},{label:a("thCount"),num:!0}],rows:h.errors.map(o=>[(0,e.jsx)("span",{className:"mono",children:o.code},"k"),g(o.count)])})}):null]}):null,(0,e.jsx)("footer",{className:"footer",children:a("footer")})]}),A?(0,e.jsx)("div",{className:"tooltip",style:{left:Math.max(8,Math.min(A.x,window.innerWidth-340)),top:Math.max(8,A.y)},children:A.content}):null]})}var x=require("react/jsx-runtime"),Se="session-stats",Ne=["slots","locale","sidebarRight","sidebarRightTabs"],B="dsh-session-stats",Ce="session-stats",P="session-stats";function Me(){return(0,x.jsx)(ee,{dataBase:"/api/session-stats",syncBase:"/api/session-stats/sync"})}function $e({title:s,description:t,kind:n,useTabInfo:r}){let{tab:c}=r(),p=t?`${s} \u2014 ${t}`:s;return(0,x.jsxs)("div",{"data-sidebar-right-guide-entry":n,style:{position:"relative",display:"flex",alignItems:"center",gap:14,width:"100%",minHeight:56,padding:"14px 20px",boxSizing:"border-box",border:"0.5px solid var(--dsw-alias-border-l3, #2a3140)",borderRadius:"var(--dsl-guide-entry-radius, 12px)",background:"var(--dsw-alias-bg-layer-1, #161b22)",cursor:"pointer"},children:[(0,x.jsx)("button",{type:"button","aria-label":p,onClick:()=>c.actions.openTab(n,{replaceTab:!0}),style:{position:"absolute",inset:0,width:"100%",height:"100%",borderRadius:0,border:0,background:"transparent",cursor:"pointer"}}),(0,x.jsx)("span",{"aria-hidden":"true",style:{fontSize:22,color:"var(--dsw-alias-label-secondary, #8b95a5)",pointerEvents:"none"},children:"\u25C8"}),(0,x.jsxs)("span",{style:{display:"flex",flexDirection:"column",gap:3,flex:1,minWidth:0,pointerEvents:"none"},children:[(0,x.jsx)("span",{style:{fontSize:14,lineHeight:1.4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",color:"var(--dsw-alias-label-primary, #e6e9ef)"},children:s}),t?(0,x.jsx)("span",{style:{fontSize:11,lineHeight:1.4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",color:"var(--dsw-alias-label-tertiary, #8b95a5)"},children:t}):null]})]})}function Re(s){let t=s;t.effect(()=>{if(document.querySelector('style[data-dsh-session-stats="true"]'))return;let r=document.createElement("style");return r.dataset.dshSessionStats="true",r.textContent=X,document.head.appendChild(r),()=>r.remove()},"session-stats: styles"),t.effect(()=>{t.locale.register(P,{zh:{tabTitle:"\u4F1A\u8BDD\u7EDF\u8BA1",guideTitle:"\u4F1A\u8BDD\u7EDF\u8BA1",guideDesc:"\u672C\u5730\u5168\u90E8\u4F1A\u8BDD\u7684\u7528\u91CF\u89C2\u6D4B:Token\u3001\u6A21\u578B\u3001\u5DE5\u5177\u3001\u9879\u76EE\u4E0E\u9519\u8BEF"},en:{tabTitle:"Session Stats",guideTitle:"Session Stats",guideDesc:"Usage insights across all local sessions: tokens, models, tools, projects, errors"}})},"session-stats: locale");let n=t.locale.bind(P);t.effect(()=>t.sidebarRightTabs.register({id:B,kind:Ce,priority:"extension",title:()=>n("tabTitle"),guide:[{id:"open",order:30,title:()=>n("guideTitle"),description:()=>n("guideDesc")}]}),"session-stats: tab type"),t.effect(()=>{t.slots.inject("sidebar.right.pane.tab",()=>t.slots.register({name:"sidebar.right.pane.tab",key:B,locale:P,inject:()=>({})},Me))},"session-stats: tab body"),t.effect(()=>{t.slots.inject("sidebar.right.tab.guide.entry",()=>t.slots.register({name:"sidebar.right.tab.guide.entry",key:B,locale:P,inject:()=>({})},$e))},"session-stats: guide entry")}
return module.exports; } });
