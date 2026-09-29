globalThis.__ModuleLoader__.load({ id: "@lzhida/dsh-session-stats", factory: function (require) { var module = { exports: {} };
"use strict";var _=Object.defineProperty;var le=Object.getOwnPropertyDescriptor;var de=Object.getOwnPropertyNames;var ce=Object.prototype.hasOwnProperty;var pe=(a,t)=>{for(var o in t)_(a,o,{get:t[o],enumerable:!0})},ue=(a,t,o,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let p of de(t))!ce.call(a,p)&&p!==o&&_(a,p,{get:()=>t[p],enumerable:!(r=le(t,p))||r.enumerable});return a};var ge=a=>ue(_({},"__esModule",{value:!0}),a);var Le={};pe(Le,{apply:()=>Ae,inject:()=>Ce,name:()=>Me});module.exports=ge(Le);var J=`/* dsh \u5185\u5D4C\u4EEA\u8868\u76D8\u6837\u5F0F:\u5168\u90E8\u89C4\u5219\u9650\u5B9A\u5728 .dss-scope \u5B50\u6811,\u4E0D\u6C61\u67D3 dsh \u9875\u9762\u5168\u5C40\u3002 */

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
  position: relative;
  container-type: inline-size;
}

/* \u5185\u5D4C\u6A21\u5F0F:\u5360\u6EE1 dsh tab body\u3002\u6839\u5143\u7D20\u53EA\u505A\u5B9A\u4F4D\u4E0E\u88C1\u526A\u3001\u4E0D\u6EDA\u52A8,\u6EDA\u52A8\u7531
   \u5185\u5C42 .app \u627F\u62C5\u2014\u2014\u62BD\u5C49/\u906E\u7F69/tooltip \u76F8\u5BF9\u6839\u5143\u7D20\u5B9A\u4F4D,\u7EDD\u4E0D\u4F1A\u8D8A\u51FA\u9762\u677F
   (position:fixed \u4F1A\u6309\u89C6\u53E3\u5B9A\u4F4D,\u66FE\u628A\u5BBF\u4E3B\u6574\u9875\u7F69\u4F4F)\u3002 */
.dss-scope.dss-embedded {
  height: 100%;
  overflow: hidden;
}

.dss-scope.dss-embedded .app {
  height: 100%;
  overflow: hidden auto;
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

  /* \u5D4C\u5165 dsh \u9762\u677F:\u62BD\u5C49\u4E0E\u906E\u7F69\u6539\u4E3A\u76F8\u5BF9\u63D2\u4EF6\u6839\u5143\u7D20\u5B9A\u4F4D\u3002\u6839\u5143\u7D20
     overflow:hidden \u8D1F\u8D23\u88C1\u526A\u6536\u8D77\u6001,\u5185\u5C42 .app \u6EDA\u52A8\u4E0D\u5F71\u54CD\u5176\u4F4D\u7F6E\u3002 */
  .dss-scope.dss-embedded .sidebar {
    position: absolute;
    overflow-y: auto;
  }

  .dss-scope.dss-embedded .scrim {
    position: absolute;
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
  position: absolute;
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
`;var l=require("react"),e=require("react/jsx-runtime"),E={zh:{brand:"DSH \u4F1A\u8BDD\u7EDF\u8BA1",subtitle:"\u672C\u5730\u4F1A\u8BDD\u6587\u4EF6 \xB7 \u7528\u91CF\u89C2\u6D4B",navOverview:"\u6982\u89C8",navModels:"\u6A21\u578B",navTools:"\u5DE5\u5177",navProjects:"\u9879\u76EE",navSessions:"\u4F1A\u8BDD",navErrors:"\u9519\u8BEF",viewHintOverview:"\u6838\u5FC3\u6307\u6807\u4E0E\u6BCF\u65E5\u7528\u91CF\u8D8B\u52BF",viewHintModels:"\u6309 provider/model \u7C92\u5EA6\u7684\u7528\u91CF\u5206\u5E03",viewHintTools:"\u5DE5\u5177\u8C03\u7528\u6392\u884C\u4E0E\u8017\u65F6",viewHintProjects:"\u6309\u5DE5\u4F5C\u76EE\u5F55\u6C47\u603B",viewHintSessions:"\u6700\u8FD1\u7684\u4F1A\u8BDD\u6D3B\u52A8",viewHintErrors:"LLM \u91CD\u8BD5\u4E0E\u5931\u8D25\u7801\u5206\u5E03",range7d:"7 \u5929",range30d:"30 \u5929",range90d:"90 \u5929",rangeAll:"\u5168\u90E8",sync:"\u540C\u6B65",syncing:"\u540C\u6B65\u4E2D\u2026",loading:"\u52A0\u8F7D\u4E2D\u2026",loadFailed:"\u52A0\u8F7D\u5931\u8D25",syncDone:"\u540C\u6B65\u5B8C\u6210",generatedAt:"\u751F\u6210\u4E8E",justNow:"\u521A\u521A",minutesAgo:" \u5206\u949F\u524D",hoursAgo:" \u5C0F\u65F6\u524D",daysAgo:" \u5929\u524D",cardSessions:"\u4F1A\u8BDD\u6570",cardProjectsSuffix:" \u4E2A\u9879\u76EE",cardTotalTokens:"\u603B Token\uFF08API \u7B49\u4EF7\uFF09",cardInputOutput:"\u8F93\u5165 / \u8F93\u51FA",cardCacheRead:"\u7F13\u5B58\u8BFB\u53D6",cardMessages:"\u6D88\u606F\u6570",cardTurnsSuffix:" \u8F6E \xB7 ",cardStepsSuffix:" \u6B65",cardToolCalls:"\u5DE5\u5177\u8C03\u7528",toolFailedSuffix:" \u6B21\u5931\u8D25",allToolsOk:"\u5168\u90E8\u6210\u529F",cardActiveDays:"\u6D3B\u8DC3\u5929\u6570",cardDailyAvg:"\u65E5\u5747 Token",cardLlmCallsPrefix:"LLM \u8C03\u7528 ",cardCallsSuffix:" \u6B21",cardTopModel:"Top \u6A21\u578B",cardTopTool:"Top \u5DE5\u5177",cardTopToolSub:"\u6309\u8C03\u7528\u6B21\u6570",cardRetries:"LLM \u91CD\u8BD5",seeErrors:"\u89C1\u9519\u8BEF\u89C6\u56FE",noRetries:"\u65E0\u91CD\u8BD5",dailyChartTitle:"\u6BCF\u65E5\u7528\u91CF",dailyChartHint:"\u5806\u53E0\uFF1A\u7F13\u5B58\u8BFB\u53D6 / \u8F93\u5165 / \u8F93\u51FA\uFF08\u8D26\u672C\u8865\u9F50\u7684\u5386\u53F2\u65E5\u671F\u5E26 \u2022 \u6807\u8BB0\uFF09",legendCache:"\u7F13\u5B58\u8BFB\u53D6",legendInput:"\u8F93\u5165",legendOutput:"\u8F93\u51FA",legendLedger:"\u8D26\u672C\u8865\u9F50\u7684\u5386\u53F2\u65E5\u671F",chartEmpty:"\u8303\u56F4\u5185\u6CA1\u6709\u7528\u91CF\u6570\u636E \u2014\u2014 \u70B9\u51FB\u300C\u540C\u6B65\u300D\u7D22\u5F15\u6700\u8FD1\u6D3B\u52A8\u3002",tableEmpty:"\u6682\u65E0\u6570\u636E",thCalls:"\u8C03\u7528",thInput:"\u8F93\u5165",thOutput:"\u8F93\u51FA",thCacheRead:"\u7F13\u5B58\u8BFB",thCacheWrite:"\u7F13\u5B58\u5199",thTotal:"\u603B\u91CF",thModel:"\u6A21\u578B",thTool:"\u5DE5\u5177",thAvgDuration:"\u5E73\u5747\u8017\u65F6",thTotalDuration:"\u7D2F\u8BA1\u8017\u65F6",thProject:"\u9879\u76EE",thSessions:"\u4F1A\u8BDD",thMessages:"\u6D88\u606F",thTokens:"Token",thLastActive:"\u6700\u540E\u6D3B\u8DC3",thTitle:"\u6807\u9898",thSpan:"\u8DE8\u5EA6",thActive:"\u6D3B\u8DC3",thCode:"\u5931\u8D25\u7801",thCount:"\u6B21\u6570",thProvider:"Provider",thTokenTotal:"Token \u603B\u91CF",hourlyTitle:"\u5C0F\u65F6\u5206\u5E03",hourlyHint:"LLM \u8C03\u7528\u7684\u672C\u5730\u5C0F\u65F6\u70ED\u5EA6",hourlyTooltipPrefix:":00 \u2013 ",hourlyTooltipSuffix:" \u6B21 LLM \u8C03\u7528",errorsTitle:"LLM \u91CD\u8BD5 / \u9519\u8BEF",errorsHint:"llm/retry \u5931\u8D25\u7801\u5206\u5E03",errorsEmpty:"\u8303\u56F4\u5185\u6CA1\u6709\u91CD\u8BD5\u8BB0\u5F55",toolFailedNote:"\uFF08{n} \u5931\u8D25\uFF09",providersSub:"\u6309 provider \u6C47\u603B",exportRangeNote:"\u9759\u6001\u5BFC\u51FA\u6587\u4EF6\u4EC5\u5305\u542B\u5BFC\u51FA\u65F6\u6240\u9009\u8303\u56F4\u7684\u6570\u636E\u3002",footer:"dsh-session-stats \xB7 \u6570\u636E\u6765\u81EA\u672C\u5730 ~/.dsh \u4F1A\u8BDD\u6587\u4EF6\u4E0E usage-ledger",themeTitle:"\u5207\u6362\u4E3B\u9898",langTitle:"Language",openMenu:"\u6253\u5F00\u83DC\u5355"},en:{brand:"DSH Session Stats",subtitle:"Local session files \xB7 usage insights",navOverview:"Overview",navModels:"Models",navTools:"Tools",navProjects:"Projects",navSessions:"Sessions",navErrors:"Errors",viewHintOverview:"Key metrics and daily usage trend",viewHintModels:"Usage breakdown by provider/model",viewHintTools:"Tool call ranking and durations",viewHintProjects:"Aggregated by working directory",viewHintSessions:"Recent session activity",viewHintErrors:"LLM retry and failure code distribution",range7d:"7d",range30d:"30d",range90d:"90d",rangeAll:"All",sync:"Sync",syncing:"Syncing\u2026",loading:"Loading\u2026",loadFailed:"Load failed",syncDone:"Sync done",generatedAt:"generated",justNow:"just now",minutesAgo:" min ago",hoursAgo:" h ago",daysAgo:" d ago",cardSessions:"Sessions",cardProjectsSuffix:" projects",cardTotalTokens:"Total Tokens (API-equiv.)",cardInputOutput:"Input / Output",cardCacheRead:"Cache Read",cardMessages:"Messages",cardTurnsSuffix:" turns \xB7 ",cardStepsSuffix:" steps",cardToolCalls:"Tool Calls",toolFailedSuffix:" failed",allToolsOk:"all succeeded",cardActiveDays:"Active Days",cardDailyAvg:"Daily Avg Tokens",cardLlmCallsPrefix:"LLM calls ",cardCallsSuffix:"",cardTopModel:"Top Model",cardTopTool:"Top Tool",cardTopToolSub:"by call count",cardRetries:"LLM Retries",seeErrors:"see Errors view",noRetries:"no retries",dailyChartTitle:"Daily Usage",dailyChartHint:"Stacked: cache read / input / output (\u2022 marks ledger-only history)",legendCache:"Cache read",legendInput:"Input",legendOutput:"Output",legendLedger:"ledger-only history",chartEmpty:'No usage in this range \u2014 hit "Sync" to index recent activity.',tableEmpty:"No data",thCalls:"Calls",thInput:"Input",thOutput:"Output",thCacheRead:"Cache read",thCacheWrite:"Cache write",thTotal:"Total",thModel:"Model",thTool:"Tool",thAvgDuration:"Avg duration",thTotalDuration:"Total duration",thProject:"Project",thSessions:"Sessions",thMessages:"Messages",thTokens:"Tokens",thLastActive:"Last active",thTitle:"Title",thSpan:"Span",thActive:"Active",thCode:"Code",thCount:"Count",thProvider:"Provider",thTokenTotal:"Token total",hourlyTitle:"Peak Hours",hourlyHint:"LLM calls by local hour of day",hourlyTooltipPrefix:":00 \u2013 ",hourlyTooltipSuffix:" LLM calls",errorsTitle:"LLM Retries / Errors",errorsHint:"llm/retry failure code distribution",errorsEmpty:"No retries in this range",toolFailedNote:"({n} failed)",providersSub:"aggregated by provider",exportRangeNote:"Static export embeds only the range selected at export time.",footer:"dsh-session-stats \xB7 data from local ~/.dsh session files and usage-ledger",themeTitle:"Toggle theme",langTitle:"Language",openMenu:"Open menu"}};function be(){try{let a=localStorage.getItem("dsh-stats-lang");if(a==="en"||a==="zh")return a}catch{}return navigator.language.toLowerCase().startsWith("zh")?"zh":"en"}function g(a){return Number(a??0).toLocaleString("en-US")}function c(a){let t=Number(a??0);return t>=1e8?`${(t/1e8).toFixed(2)}\u4EBF`:t>=1e4?`${(t/1e4).toFixed(1)}\u4E07`:g(t)}function W(a){let t=Number(a??0);if(t<1e3)return`${Math.round(t)}ms`;if(t<6e4)return`${(t/1e3).toFixed(1)}s`;if(t<36e5){let p=Math.floor(t/6e4),h=Math.round(t%6e4/1e3);return`${p}m${String(h).padStart(2,"0")}s`}let o=Math.floor(t/36e5),r=Math.round(t%36e5/6e4);return`${o}h${String(r).padStart(2,"0")}m`}function Q(a){if(!a)return"\u2014";let t=new Date(a),o=r=>String(r).padStart(2,"0");return`${t.getFullYear()}-${o(t.getMonth()+1)}-${o(t.getDate())} ${o(t.getHours())}:${o(t.getMinutes())}`}function F(a,t){let o=Date.now()-a;return o<6e4?t("justNow"):o<36e5?`${Math.floor(o/6e4)}${t("minutesAgo")}`:o<864e5?`${Math.floor(o/36e5)}${t("hoursAgo")}`:`${Math.floor(o/864e5)}${t("daysAgo")}`}function z(a,t,o){return{x:a.clientX-(o?.left??0)+14,y:a.clientY-(o?.top??0)+14,content:t}}var te=[{key:"overview",icon:"\u25D4",labelKey:"navOverview"},{key:"models",icon:"\u25A6",labelKey:"navModels"},{key:"tools",icon:"\u2699",labelKey:"navTools"},{key:"projects",icon:"\u25A4",labelKey:"navProjects"},{key:"sessions",icon:"\u276F",labelKey:"navSessions"},{key:"errors",icon:"\u26A0",labelKey:"navErrors"}],me=[["7d","range7d"],["30d","range30d"],["90d","range90d"],["all","rangeAll"]];function ve(a){return te.some(t=>t.key===a)?a:"overview"}function Z(){return ve(window.location.hash.replace(/^#\/?/,""))}function fe(a){return{overview:"navOverview",models:"navModels",tools:"navTools",projects:"navProjects",sessions:"navSessions",errors:"navErrors"}[a]}function ye(a){return{overview:"viewHintOverview",models:"viewHintModels",tools:"viewHintTools",projects:"viewHintProjects",sessions:"viewHintSessions",errors:"viewHintErrors"}[a]}function k({title:a,hint:t,children:o}){return(0,e.jsxs)("section",{className:"panel",children:[(0,e.jsxs)("div",{className:"panel-head",children:[(0,e.jsx)("h2",{children:a}),t?(0,e.jsx)("span",{className:"hint",children:t}):null]}),o]})}function M({columns:a,rows:t,empty:o}){return t.length===0?(0,e.jsx)("div",{className:"empty",children:o}):(0,e.jsx)("div",{className:"table-scroll",children:(0,e.jsxs)("table",{children:[(0,e.jsx)("thead",{children:(0,e.jsx)("tr",{children:a.map(r=>(0,e.jsx)("th",{className:r.num?"num":"",children:r.label},r.label))})}),(0,e.jsx)("tbody",{children:t.map((r,p)=>(0,e.jsx)("tr",{children:r.map((h,d)=>(0,e.jsx)("td",{className:a[d]?.num?"num":"",children:h},d))},p))})]})})}function xe({data:a,t}){let o=a.overview,r=o.usage,p=[{label:t("cardSessions"),value:g(o.sessions),sub:`${g(o.projects)}${t("cardProjectsSuffix")}`},{label:t("cardTotalTokens"),value:c(r.totalTokens),sub:`${t("thInput")} ${c(r.inputTokens)} \xB7 ${t("thOutput")} ${c(r.outputTokens)} \xB7 ${t("thCacheRead")} ${c(r.cacheReadTokens)} \xB7 ${t("thCacheWrite")} ${c(r.cacheWriteTokens)}`},{label:t("cardInputOutput"),value:`${c(r.inputTokens)} / ${c(r.outputTokens)}`,sub:`${t("thCacheRead")} ${c(r.cacheReadTokens)} \xB7 ${t("thCacheWrite")} ${c(r.cacheWriteTokens)}`},{label:t("cardCacheRead"),value:c(r.cacheReadTokens),sub:`${t("thCacheWrite")} ${c(r.cacheWriteTokens)}`},{label:t("cardMessages"),value:g(o.messages),sub:`${g(o.turns)}${t("cardTurnsSuffix")}${g(o.steps)}${t("cardStepsSuffix")}`},{label:t("cardToolCalls"),value:g(o.toolCalls),sub:o.toolErrors>0?(0,e.jsxs)("span",{className:"bad",children:[g(o.toolErrors),t("toolFailedSuffix")]}):t("allToolsOk")},{label:t("cardActiveDays"),value:g(o.activeDays),sub:o.firstDay?`${o.firstDay} ~ ${o.lastDay}`:"\u2014"},{label:t("cardDailyAvg"),value:c(o.avgTokensPerActiveDay),sub:`${t("cardLlmCallsPrefix")}${g(r.calls)}${t("cardCallsSuffix")}`},{label:t("cardTopModel"),value:o.topModel?o.topModel.split("/").slice(1).join("/"):"\u2014",sub:o.topModel?o.topModel.split("/")[0]:""},{label:t("cardTopTool"),value:o.topTool??"\u2014",sub:t("cardTopToolSub")},{label:t("cardRetries"),value:g(o.retryCount),sub:o.retryCount>0?t("seeErrors"):t("noRetries")}];return(0,e.jsx)("section",{className:"cards",children:p.map(h=>(0,e.jsxs)("div",{className:"card",children:[(0,e.jsx)("div",{className:"label",children:h.label}),(0,e.jsx)("div",{className:"value",children:h.value}),(0,e.jsx)("div",{className:"sub",children:h.sub})]},h.label))})}var V=1e3,B=240,P=46,ee=10,G=10,Te=26;function we({daily:a,t,setTip:o,getOrigin:r}){let p=(0,l.useMemo)(()=>{let i=B-G-Te,f=Math.max(...a.map(w=>w.totalTokens),1);return{plotH:i,maxTotal:f,y:w=>G+i-w/f*i}},[a]);if(a.length===0)return(0,e.jsx)("div",{className:"empty",children:t("chartEmpty")});let{plotH:h,y:d}=p,y=(V-P-ee)/a.length,x=Math.max(1,y*.72),N=Math.max(1,Math.ceil(a.length/12)),b=[];for(let i=0;i<=4;i++){let f=p.maxTotal/4*i,u=d(f);b.push((0,e.jsx)("line",{x1:P,y1:u,x2:V-ee,y2:u,stroke:"var(--border)",strokeWidth:1,strokeDasharray:i===0?void 0:"3 4"},i),(0,e.jsx)("text",{x:P-6,y:u+4,textAnchor:"end",fontSize:10,fill:"var(--text-dim)",children:c(f)},`t${i}`))}let C=i=>(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)("b",{children:i.date}),i.source==="ledger"?(0,e.jsxs)("span",{className:"warn",children:[" (",t("legendLedger"),")"]}):null,(0,e.jsx)("br",{}),t("thTotal")," ",c(i.totalTokens)," \xB7 ",t("thCalls")," ",g(i.calls),i.sessions>0?` \xB7 ${g(i.sessions)} ${t("navSessions").toLowerCase()}`:"",(0,e.jsx)("br",{}),t("thInput")," ",c(i.inputTokens)," \xB7 ",t("thOutput")," ",c(i.outputTokens),(0,e.jsx)("br",{}),t("thCacheRead")," ",c(i.cacheReadTokens)," \xB7 ",t("thCacheWrite")," ",c(i.cacheWriteTokens)]});return(0,e.jsxs)("div",{className:"daily-chart",children:[(0,e.jsxs)("svg",{viewBox:`0 0 ${V} ${B}`,preserveAspectRatio:"none",role:"img",children:[b,a.map((i,f)=>{let u=P+y*f+y/2,w=u-x/2,R=[{v:i.cacheReadTokens,color:"var(--chart-cache)",key:"cache"},{v:i.inputTokens,color:"var(--chart-input)",key:"input"},{v:i.outputTokens,color:"var(--chart-output)",key:"output"}],S=0,D=R.filter(m=>m.v>0).map(m=>{let A=d(S+m.v),L=Math.max(1,d(S)-d(S+m.v));return S+=m.v,(0,e.jsx)("rect",{x:w,y:A,width:x,height:L,fill:m.color,rx:1},m.key)});return(0,e.jsxs)("g",{children:[D,f%N===0?(0,e.jsx)("text",{x:u,y:B-8,textAnchor:"middle",fontSize:10,fill:"var(--text-dim)",children:i.date.slice(5)}):null,i.source==="ledger"?(0,e.jsx)("circle",{cx:u,cy:d(i.totalTokens)-6,r:2.5,fill:"var(--warn)"}):null,(0,e.jsx)("rect",{className:"hit",x:w-1,y:G,width:x+2,height:h,fill:"transparent",onMouseEnter:m=>o(z(m,C(i),r())),onMouseMove:m=>o(z(m,C(i),r())),onMouseLeave:()=>o(null)})]},i.date)})]}),(0,e.jsxs)("div",{className:"legend",children:[(0,e.jsxs)("span",{children:[(0,e.jsx)("span",{className:"dot",style:{background:"var(--chart-cache)"}}),t("legendCache")]}),(0,e.jsxs)("span",{children:[(0,e.jsx)("span",{className:"dot",style:{background:"var(--chart-input)"}}),t("legendInput")]}),(0,e.jsxs)("span",{children:[(0,e.jsx)("span",{className:"dot",style:{background:"var(--chart-output)"}}),t("legendOutput")]}),(0,e.jsxs)("span",{children:[(0,e.jsx)("span",{className:"dot",style:{background:"var(--warn)",borderRadius:"50%"}}),t("legendLedger")]})]})]})}function ke({hourly:a,t,setTip:o,getOrigin:r}){let p=Math.max(...a,1);return(0,e.jsx)("div",{className:"hourly-heat",children:a.map((h,d)=>{let y=h/p,x=h>0?{background:`color-mix(in srgb, var(--accent) ${Math.round(15+y*85)}%, transparent)`,color:y>.5?"#fff":"var(--text-dim)"}:void 0,N=`${String(d).padStart(2,"0")}${t("hourlyTooltipPrefix")}${g(h)}${t("hourlyTooltipSuffix")}`;return(0,e.jsx)("div",{className:"hour-cell",style:x,onMouseEnter:b=>o(z(b,N,r())),onMouseMove:b=>o(z(b,N,r())),onMouseLeave:()=>o(null),children:d},d)})})}function Se({data:a,t}){let o=Math.max(...a.providers.map(r=>r.totalTokens),1);return(0,e.jsx)(M,{empty:t("tableEmpty"),columns:[{label:t("thProvider")},{label:t("thCalls"),num:!0},{label:t("thTokenTotal"),num:!0}],rows:a.providers.map(r=>{let p=(r.totalTokens/o*100).toFixed(1);return[(0,e.jsx)("span",{className:"mono",children:r.provider},"k"),g(r.calls),(0,e.jsxs)("span",{children:[c(r.totalTokens)," ",(0,e.jsxs)("span",{className:"dim",children:["(",p,"%)"]}),(0,e.jsx)("span",{className:"share-bar",children:(0,e.jsx)("span",{style:{display:"block",height:"100%",width:`${p}%`}})})]},"t")]})})}function Ne(){try{let a=localStorage.getItem("dsh-stats-theme");if(a==="dark"||a==="light")return a}catch{}return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}function se(a){let{dataBase:t,syncBase:o,standalone:r=!1,showSidebar:p=!0}=a,h=a.initialData??null,[d,y]=(0,l.useState)(()=>a.initialLang??be()),[x,N]=(0,l.useState)(()=>Ne()),[b,C]=(0,l.useState)(()=>r&&typeof window<"u"?Z():"overview"),[i,f]=(0,l.useState)(a.initialRange??"30d"),[u,w]=(0,l.useState)(h),[R,S]=(0,l.useState)(""),[D,m]=(0,l.useState)(null),[A,L]=(0,l.useState)(!1),[H,Y]=(0,l.useState)(null),[ae,K]=(0,l.useState)(!1),O=(0,l.useRef)(null),X=(0,l.useCallback)(()=>O.current?.getBoundingClientRect()??null,[]),I=h!==null,s=(0,l.useCallback)(n=>E[d][n],[d]);(0,l.useEffect)(()=>{r&&(document.documentElement.lang=d,document.title=E[d].brand)},[d,r]),(0,l.useEffect)(()=>{try{localStorage.setItem("dsh-stats-lang",d)}catch{}},[d]),(0,l.useEffect)(()=>{if(!r)return;let n=()=>C(Z());return window.addEventListener("hashchange",n),()=>window.removeEventListener("hashchange",n)},[r]);let $=(0,l.useCallback)(async n=>{m(null);try{let v=await fetch(`${t}?range=${encodeURIComponent(n)}`);if(!v.ok)throw new Error(`HTTP ${v.status}`);w(await v.json())}catch(v){m(v instanceof Error?v.message:String(v))}},[t]),oe=(0,l.useCallback)(n=>{if(f(n),I){S(E[d].exportRangeNote);return}$(n)},[I,d,$]),ne=(0,l.useCallback)(async()=>{L(!0);try{let v=await(await fetch(o,{method:"POST"})).json();S(`${E[d].syncDone}: ${v.files} / ${v.processed} / ${v.sessions} (${v.durationMs}ms)`),await $(i)}catch(n){m(n instanceof Error?n.message:String(n))}finally{L(!1)}},[d,$,i,o]);(0,l.useEffect)(()=>{h||$(i)},[]);let re=(0,l.useCallback)(()=>{let n=x==="dark"?"light":"dark";N(n);try{localStorage.setItem("dsh-stats-theme",n)}catch{}r&&(document.documentElement.dataset.theme=n)},[r,x]),ie=(0,l.useCallback)(n=>{r&&(window.location.hash=`#/${n}`),C(n),K(!1)},[r]),q=u?.overview;return(0,e.jsxs)("div",{ref:O,className:`dss-scope${r?"":" dss-embedded"}${ae?" drawer-open":""}`,"data-theme":x,children:[(0,e.jsxs)("div",{className:"app",children:[p?(0,e.jsxs)("aside",{className:"sidebar",children:[(0,e.jsxs)("div",{className:"brand",children:[(0,e.jsx)("span",{className:"brand-icon",children:"\u25C8"}),(0,e.jsxs)("span",{className:"brand-text",children:[s("brand"),(0,e.jsx)("small",{children:s("subtitle")})]})]}),(0,e.jsx)("nav",{className:"nav",children:te.map(n=>(0,e.jsxs)("button",{type:"button",className:`nav-item${b===n.key?" active":""}`,onClick:()=>ie(n.key),children:[(0,e.jsx)("span",{className:"nav-icon",children:n.icon}),(0,e.jsx)("span",{children:s(n.labelKey)})]},n.key))}),(0,e.jsxs)("div",{className:"sidebar-footer",children:[(0,e.jsxs)("div",{className:"lang-switch",title:s("langTitle"),children:[(0,e.jsx)("button",{type:"button",className:d==="zh"?"active":"",onClick:()=>y("zh"),children:"\u4E2D\u6587"}),(0,e.jsx)("button",{type:"button",className:d==="en"?"active":"",onClick:()=>y("en"),children:"EN"})]}),(0,e.jsxs)("button",{className:"btn full",type:"button",title:s("themeTitle"),onClick:re,children:["\u25D0 ",s("themeTitle")]})]})]}):null,(0,e.jsx)("button",{type:"button",className:"scrim","aria-label":s("openMenu"),onClick:()=>K(!1)}),(0,e.jsxs)("main",{className:"main",children:[(0,e.jsxs)("header",{className:"topbar",children:[(0,e.jsxs)("div",{className:"topbar-title",children:[(0,e.jsx)("h1",{children:s(fe(b))}),(0,e.jsx)("span",{className:"subtitle",children:s(ye(b))})]}),(0,e.jsxs)("div",{className:"topbar-actions",children:[(0,e.jsx)("button",{type:"button",className:"btn icon menu-btn","aria-label":s("openMenu"),title:s("openMenu"),onClick:()=>K(!0),children:"\u2630"}),(0,e.jsx)("div",{className:"range-tabs",role:"tablist",children:me.map(([n,v])=>(0,e.jsx)("button",{type:"button",role:"tab",className:i===n?"active":"",onClick:()=>oe(n),children:s(v)},n))}),I?null:(0,e.jsx)("button",{className:"btn",type:"button",disabled:A,onClick:()=>{ne()},children:s(A?"syncing":"sync")})]})]}),(0,e.jsx)("div",{className:"meta-line",children:D?(0,e.jsxs)("span",{className:"bad",children:[s("loadFailed"),": ",D]}):(0,e.jsxs)(e.Fragment,{children:[R,u&&q?`${R?" \xB7 ":""}${s("generatedAt")} ${Q(u.generatedAt)} \xB7 ${F(u.generatedAt,s)}`:R?"":s("loading")]})}),u&&q?(0,e.jsxs)(e.Fragment,{children:[b==="overview"?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(xe,{data:u,t:s}),(0,e.jsx)(k,{title:s("dailyChartTitle"),hint:s("dailyChartHint"),children:(0,e.jsx)(we,{daily:u.daily,t:s,setTip:Y,getOrigin:X})}),(0,e.jsx)(k,{title:s("hourlyTitle"),hint:s("hourlyHint"),children:(0,e.jsx)(ke,{hourly:u.hourly,t:s,setTip:Y,getOrigin:X})})]}):null,b==="models"?(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(k,{title:s("navModels"),hint:s("viewHintModels"),children:(0,e.jsx)(M,{empty:s("tableEmpty"),columns:[{label:s("thModel")},{label:s("thCalls"),num:!0},{label:s("thInput"),num:!0},{label:s("thOutput"),num:!0},{label:s("thCacheRead"),num:!0},{label:s("thTotal"),num:!0}],rows:u.models.map(n=>[(0,e.jsxs)("span",{className:"mono",children:[n.provider,"/",n.model]},"k"),g(n.calls),c(n.inputTokens),c(n.outputTokens),c(n.cacheReadTokens),c(n.totalTokens)])})}),(0,e.jsx)(k,{title:s("thProvider"),hint:s("providersSub"),children:(0,e.jsx)(Se,{data:u,t:s})})]}):null,b==="tools"?(0,e.jsx)(k,{title:s("navTools"),hint:s("viewHintTools"),children:(0,e.jsx)(M,{empty:s("tableEmpty"),columns:[{label:s("thTool")},{label:s("thCalls"),num:!0},{label:s("thAvgDuration"),num:!0},{label:s("thTotalDuration"),num:!0}],rows:u.tools.map(n=>[(0,e.jsx)("span",{className:"mono",children:n.name},"k"),g(n.calls),W(n.avgDurationMs),(0,e.jsxs)(e.Fragment,{children:[W(n.totalDurationMs),n.errors>0?(0,e.jsx)("span",{className:"bad",children:s("toolFailedNote").replace("{n}",String(n.errors))}):null]})])})}):null,b==="projects"?(0,e.jsx)(k,{title:s("navProjects"),hint:s("viewHintProjects"),children:(0,e.jsx)(M,{empty:s("tableEmpty"),columns:[{label:s("thProject")},{label:s("thSessions"),num:!0},{label:s("thMessages"),num:!0},{label:s("thTokens"),num:!0},{label:s("thLastActive"),num:!0}],rows:u.projects.map(n=>[n.project,g(n.sessions),g(n.messages),c(n.usage.totalTokens),(0,e.jsx)("span",{className:"dim",children:F(n.lastActiveAt,s)},"k")])})}):null,b==="sessions"?(0,e.jsx)(k,{title:s("navSessions"),hint:s("viewHintSessions"),children:(0,e.jsx)(M,{empty:s("tableEmpty"),columns:[{label:s("thTitle")},{label:s("thProject")},{label:s("thModel")},{label:s("thMessages"),num:!0},{label:s("navTools"),num:!0},{label:s("thTokens"),num:!0},{label:s("thSpan"),num:!0},{label:s("thActive"),num:!0}],rows:u.recent.map(n=>[(0,e.jsx)("span",{title:n.id,children:n.title},"k"),n.project,(0,e.jsx)("span",{className:"mono",children:n.model},"m"),g(n.messages),g(n.toolCalls),c(n.usage.totalTokens),W(n.activeMs),(0,e.jsx)("span",{className:"dim",title:Q(n.lastActiveAt),children:F(n.lastActiveAt,s)},"a")])})}):null,b==="errors"?(0,e.jsx)(k,{title:s("errorsTitle"),hint:s("errorsHint"),children:(0,e.jsx)(M,{empty:s("errorsEmpty"),columns:[{label:s("thCode")},{label:s("thCount"),num:!0}],rows:u.errors.map(n=>[(0,e.jsx)("span",{className:"mono",children:n.code},"k"),g(n.count)])})}):null]}):null,(0,e.jsx)("footer",{className:"footer",children:s("footer")})]})]}),H?(0,e.jsx)("div",{className:"tooltip",style:{left:Math.max(8,Math.min(H.x,(O.current?.clientWidth??window.innerWidth)-340)),top:Math.max(8,H.y)},children:H.content}):null]})}var T=require("react/jsx-runtime"),Me="session-stats",Ce=["slots","locale","sidebarRight","sidebarRightTabs"],U="dsh-session-stats",Re="session-stats",j="session-stats";function $e(){return(0,T.jsx)(se,{dataBase:"/api/session-stats",syncBase:"/api/session-stats/sync"})}function De({title:a,description:t,kind:o,useTabInfo:r}){let{tab:p}=r(),h=t?`${a} \u2014 ${t}`:a;return(0,T.jsxs)("div",{"data-sidebar-right-guide-entry":o,style:{position:"relative",display:"flex",alignItems:"center",gap:14,width:"100%",minHeight:56,padding:"14px 20px",boxSizing:"border-box",border:"0.5px solid var(--dsw-alias-border-l3, #2a3140)",borderRadius:"var(--dsl-guide-entry-radius, 12px)",background:"var(--dsw-alias-bg-layer-1, #161b22)",cursor:"pointer"},children:[(0,T.jsx)("button",{type:"button","aria-label":h,onClick:()=>p.actions.openTab(o,{replaceTab:!0}),style:{position:"absolute",inset:0,width:"100%",height:"100%",borderRadius:0,border:0,background:"transparent",cursor:"pointer"}}),(0,T.jsx)("span",{"aria-hidden":"true",style:{fontSize:22,color:"var(--dsw-alias-label-secondary, #8b95a5)",pointerEvents:"none"},children:"\u25C8"}),(0,T.jsxs)("span",{style:{display:"flex",flexDirection:"column",gap:3,flex:1,minWidth:0,pointerEvents:"none"},children:[(0,T.jsx)("span",{style:{fontSize:14,lineHeight:1.4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",color:"var(--dsw-alias-label-primary, #e6e9ef)"},children:a}),t?(0,T.jsx)("span",{style:{fontSize:11,lineHeight:1.4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",color:"var(--dsw-alias-label-tertiary, #8b95a5)"},children:t}):null]})]})}function Ae(a){let t=a;t.effect(()=>{if(document.querySelector('style[data-dsh-session-stats="true"]'))return;let r=document.createElement("style");return r.dataset.dshSessionStats="true",r.textContent=J,document.head.appendChild(r),()=>r.remove()},"session-stats: styles"),t.effect(()=>{t.locale.register(j,{zh:{tabTitle:"\u4F1A\u8BDD\u7EDF\u8BA1",guideTitle:"\u4F1A\u8BDD\u7EDF\u8BA1",guideDesc:"\u672C\u5730\u5168\u90E8\u4F1A\u8BDD\u7684\u7528\u91CF\u89C2\u6D4B:Token\u3001\u6A21\u578B\u3001\u5DE5\u5177\u3001\u9879\u76EE\u4E0E\u9519\u8BEF"},en:{tabTitle:"Session Stats",guideTitle:"Session Stats",guideDesc:"Usage insights across all local sessions: tokens, models, tools, projects, errors"}})},"session-stats: locale");let o=t.locale.bind(j);t.effect(()=>t.sidebarRightTabs.register({id:U,kind:Re,priority:"extension",title:()=>o("tabTitle"),guide:[{id:"open",order:30,title:()=>o("guideTitle"),description:()=>o("guideDesc")}]}),"session-stats: tab type"),t.effect(()=>{t.slots.inject("sidebar.right.pane.tab",()=>t.slots.register({name:"sidebar.right.pane.tab",key:U,locale:j,inject:()=>({})},$e))},"session-stats: tab body"),t.effect(()=>{t.slots.inject("sidebar.right.tab.guide.entry",()=>t.slots.register({name:"sidebar.right.tab.guide.entry",key:U,locale:j,inject:()=>({})},De))},"session-stats: guide entry")}
return module.exports; } });
