import type { AdminLocale } from './types';

const en = {
  ui: {
    operationDone: 'Operation completed', busy: 'The previous action is still in progress.', testing: 'Testing…', confirmTitle: 'Confirm action', confirm: 'Confirm',
    mapError: 'The map could not load. You can still use the data list.', expandMap: 'Expand map',
    levelFirst: 'Level 1', levelSecond: 'Level 2', levelThird: 'Level 3',
    defaultPasswordWarning: 'The default administrator password is active. Change it before continuing.',
    passwordChangeRequired: 'Change the default password before using other administrator features.',
    addressTotal: 'Valid addresses', residentialShare: '{count} residential', todayGrowth: 'Net growth today',
    schedulerStale: 'Scheduler heartbeat missing', databaseDown: 'Database unavailable',
    filterAll: 'All', filterAttention: 'Needs attention', filterActive: 'In progress', filterWaiting: 'Waiting', filterDone: 'Goal met', filterLimited: 'Source limit',
    sortLabel: 'Sort countries', sortDeficit: 'Largest gap first', sortName: 'Country name', sortCoverage: 'Lowest coverage first',
    queueStale: 'The sync queue snapshot is stale (generated {time}).', queueFresh: 'Queue snapshot {time}', nextRunPending: 'Awaiting scheduler',
    rulesColumn: 'Completion rules', unlimitedQuota: 'Unlimited', coverageNodes: '{covered} / {total} nodes with addresses', minimumNodes: '{count} nodes with ≥{min}', ruleTotal: 'Total', ruleCoverage: 'Coverage', ruleMinimum: 'Minimums', backToList: 'Back to list',
    tabOverview: 'Overview', tabTargets: 'Targets', tabNodes: 'Node targets', tabSources: 'Sources', tabHistory: 'History', tabChina: 'District coverage',
    currentState: 'Current state', stateReason: 'Details', notFound: 'This country is not configured.',
    keyCount: '{count} keys', keyCountOne: '1 key', eta: 'ETA', untilRetry: 'retry in {time}', listSeparator: ', ',
    seconds: '{s}s', minutes: '{m}m {s}s', hours: '{h}h {m}m', quotaWaitFor: 'Waiting for the {provider} quota reset'
  },
  model: {
    format: 'Request format', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'Index-Translate sends one user message with the Index prompt and turns thinking off; use it for bilibili Index-Translate models or proxies of them. Only English and Simplified Chinese targets.', httpWarning: 'This endpoint uses plain HTTP: the API key and address text travel unencrypted.',
    all: 'Show all models', empty: 'No matches. You can enter a model ID directly.', unavailable: 'Chat Completions unsupported', count: 'models', blocked: 'incompatible',
    hint: 'Choose from the list or enter a model ID.',
    reasoningUnknown: 'The endpoint did not advertise reasoning levels. This project sends low initially; adjust it using the provider documentation. This is not the provider default.',
    reasoningKnown: 'Suggestions come from this model’s API metadata. The entered value is sent with requests.',
    endpointHint: "Enter the provider prefix (for example https://api.example.com or …/v1) or the full /chat/completions URL. For a prefix without a version segment the server detects the API path when saving (usually /v1). Only the Chat Completions format is supported."
  },
  queueStates: { retry_wait: 'Waiting to retry', scheduled_wait: 'Waiting for next check', suspended: 'Retries suspended', no_source: 'No runnable source' },
  reasons: {
    missingKey: 'Missing API key: {name}', missingChinaKeys: 'Configure at least one China map API key: {name}',
    keyUnavailable: 'API key unavailable; review it under Map Keys: {name}', keyExpired: 'API key expired; update it under Map Keys: {name}',
    importingKey: 'Importing API key from the environment: {name}', missingSource: 'Missing source configuration: {name}',
    source_limited_cache: 'Every source has been imported at its current version; no new extractable data.',
    source_version_checked: 'Source version checked; no update available.', source_growth_step: 'Importing in steps; the next step starts shortly.', retry_suspended: 'Automatic retries paused after repeated failures.',
    retry_backoff: 'Backing off after a failure before retrying.', shared_failure_circuit: 'Paused because related sources hit the same failure.',
    source_partial_checkpoint: 'Processing the source in batches; waiting for the next batch.', source_partial_stalled: 'Batch processing stalled; paused.',
    no_source_shard: 'No usable source is configured.', cooldown: "Credentials are cooling down", coverage_sources_exhausted: "Target count met; available sources cannot improve coverage further", validated_sources_exhausted: "Every validated source has been used; no new qualifying data", credential_broker_unavailable: "Credential service unavailable", unconfigured: "No map API key configured", china_worker: 'Handled by the China sync worker.', quota: 'Waiting for quota reset'
  },
  googleQuota: {
    budget: 'Monthly sync budget', baseline: 'Usage before setup', hint: 'Enter Geocoding usage already incurred this month under the same Google billing account.',
    official: 'Google free usage: 10,000 monthly events per billing account; automatic sync uses at most 9,000 by default.'
  },
  translationCost: {
    google: 'Cache first; online services follow the priorities configured below. OpenAI-compatible usage follows your configured provider billing; Google uses the keyless web interface, not the billed Cloud Translation API, and may rate-limit or be unavailable.',
    youdao: 'Youdao is usage-based and may charge after trial credits run out, including tests and automatic translation. Project limits are not free-credit guarantees. Do not add or enable credentials unless you accept the charges.'
  },
  deepl: {
    notice: 'DeepL API Free only; never switches to Pro. The lower of the account allowance and project cap applies. Each key keeps its own character ledger. The test button checks usage without translating.',
    budget: 'Character cap (current quota period)', characters: 'characters', provider: 'Account used / limit', observed: 'Usage checked', unknown: 'Usage not checked',
    reset: 'DeepL Free reports no reset date; a key starts over when DeepL reports lower account usage, and exhausted keys are rechecked hourly.', add: 'Add DeepL key'
  },
  test: {"title": "Test connection", "mode": "Test mode", "modeChat": "Connectivity (send \"hi\")", "modeTranslate": "Address translation", "start": "Testing credential", "running": "Waiting for the provider…", "passed": "Test passed", "failed": "Test failed", "retry": "Retry", "model": "Model", "prompt": "Prompt", "addressSample": "address sample", "endpointProbe": "detected on save", "endpointPreview": "Request URL", "restoreDefaultPrompt": "Restore default prompt", "steps": {"invalidConfig": "The saved configuration is invalid", "endpoint": "Endpoint", "model": "Model", "parameters": "Parameters", "sendTranslation": "Sending address sample", "sendChat": "Sending test message", "timeout": "Request timed out", "network": "Network error", "status": "Connected", "providerError": "Provider error", "invalidJson": "Response is not JSON", "respondedModel": "Responding model", "finishReason": "Finish reason", "usage": "Token usage", "reasoning": "Reasoning characters", "response": "Response", "done": "Test completed", "truncated": "Output was truncated before the JSON finished; increase the output budget", "invalidTranslation": "The reply is not the expected JSON translations array", "translations": "Parsed translations", "identifiersChanged": "The model changed numbers or identifiers"}},
  shortcut: {
    nav: 'Quick Locations', country: 'Country or region', customized: 'Customized', defaults: 'Using defaults', specialTitle: 'Special area title',
    adminAreas: 'Popular administrative areas', cities: 'Popular cities', specialAreas: 'Special areas', type: 'Type', region: 'Region', city: 'City', postcode: 'Postcode',
    choose: 'Search and select', selected: '{count} selected', loading: 'Loading', noOptions: 'No matches', available: '{count} addresses',
    save: 'Save configuration', reset: 'Restore defaults', saved: 'Quick locations saved', resetDone: 'Default configuration restored',
    moveUp: 'Move up', moveDown: 'Move down', remove: 'Delete', confirmReset: 'Restore the default quick locations for this country?'
  },
  history: {
    nav: 'Sync history', title: 'Sync history', schedulerActive: 'Scheduler active', schedulerIdle: 'Scheduler idle',
    lastHeartbeat: 'Last heartbeat', country: 'Country or region', allCountries: 'All countries', status: 'Status',
    source: 'Source', period: 'Time period', duration: 'Duration', growth: 'Address growth', trigger: 'Trigger',
    details: 'Details', empty: 'No synchronization history', queued: 'Queued', running: 'Running', succeeded: 'Execution succeeded',
    failed: 'Failed', paused_quota: 'Paused for quota', needs_review: 'Needs review', cancelled: 'Not executed', previous: 'Previous', next: 'Next',
    candidates: 'Candidates', qualityPassed: 'Quality passed', rejected: 'Rejected', coveredNodes: 'Covered nodes', qualifiedNodes: 'Qualified nodes', interrupted: 'Interrupted', keptRows: 'Kept {count} published rows that passed quality checks',
    inProgress: 'In progress', chinaProviders: 'China map providers',
    phases: { discover: 'Source discovery', download: 'Download', materialize: 'Data preparation', import: 'Import', coverage: 'Coverage statistics', postcode: 'Postcode inference', publish: 'Publication' },
    errors: { interrupted: 'Interrupted by a restart or deployment; requeued automatically', timeout: 'Exceeded the processing time limit', stuck: 'Worker did not stop in time after cancellation', databaseTimeout: 'Database statement timed out', databaseLock: 'Database lock wait timed out', database: 'Database error', quality: 'Failed the quality gates', partial: 'Partially completed; progress saved', credential: 'Key or quota unavailable', source: 'Source unavailable or returned invalid data', failed: 'Synchronization failed ({code})' }
  }
};

export type LocaleText = typeof en;

export const localeText: Record<AdminLocale, LocaleText> = {
  en,
  'zh-CN': {
    ui: {
      operationDone: '操作已完成', busy: '上一个操作仍在处理中。', testing: '正在测试…', confirmTitle: '请确认', confirm: '确认',
      mapError: '地图加载失败，仍可使用数据列表。', expandMap: '展开地图',
      levelFirst: '第一级', levelSecond: '第二级', levelThird: '第三级',
      defaultPasswordWarning: '当前使用默认管理员密码。请先修改管理员密码。',
      passwordChangeRequired: '使用其他管理员功能前必须先修改默认密码',
      addressTotal: '有效地址', residentialShare: '其中住宅 {count}', todayGrowth: '今日净增',
      schedulerStale: '调度器无心跳', databaseDown: '数据库不可用',
      filterAll: '全部', filterAttention: '需要处理', filterActive: '进行中', filterWaiting: '等待中', filterDone: '已达标', filterLimited: '来源上限',
      sortLabel: '排序方式', sortDeficit: '缺口从大到小', sortName: '国家名称', sortCoverage: '覆盖率从低到高',
      queueStale: '同步队列快照已过期（生成于 {time}）。', queueFresh: '队列快照 {time}', nextRunPending: '等待调度',
      rulesColumn: '完成规则', unlimitedQuota: '无限额度', coverageNodes: '{covered} / {total} 个节点有地址', minimumNodes: '{count} 个节点达到 ≥{min} 条', ruleTotal: '总量', ruleCoverage: '覆盖', ruleMinimum: '最低数量', backToList: '返回列表',
      tabOverview: '概览', tabTargets: '目标设置', tabNodes: '节点目标', tabSources: '数据来源', tabHistory: '同步历史', tabChina: '区县覆盖',
      currentState: '当前状态', stateReason: '说明', notFound: '未找到该国家的配置。',
      keyCount: '{count} 个密钥', keyCountOne: '1 个密钥', eta: '预计', untilRetry: '{time} 后重试', listSeparator: '、',
      seconds: '{s} 秒', minutes: '{m} 分 {s} 秒', hours: '{h} 小时 {m} 分', quotaWaitFor: '等待 {provider} 额度重置'
    },
    model: {
      format: '请求格式', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'Index-Translate 按 Index 提示词只发送一条 user 消息并关闭思考，适用于 bilibili Index-Translate 模型及其反代；仅支持英文和简体中文目标。', httpWarning: '此接口使用 HTTP 明文：API Key 和地址文本未经加密传输。',
      all: '查看全部模型', empty: '没有匹配项，可直接输入模型名称', unavailable: '不支持 Chat Completions', count: '个模型', blocked: '个不兼容',
      hint: '从列表选择，或直接输入模型名称。',
      reasoningUnknown: '接口未提供思考强度列表。项目默认发送 low，可按供应商文档修改；这不代表供应商的默认值。',
      reasoningKnown: '候选值来自该模型的接口元数据，所填值将随请求发送。',
      endpointHint: "填写供应商前缀（如 https://api.example.com 或 …/v1），或完整的 /chat/completions 地址。未包含版本号的前缀会在保存时自动探测并补全（通常为 /v1）。仅支持 Chat Completions 格式。"
    },
    queueStates: { retry_wait: '等待重试', scheduled_wait: '等待下次检查', suspended: '重试已暂停', no_source: '没有可执行来源' },
    reasons: {
      missingKey: '缺少 API Key：{name}', missingChinaKeys: '至少配置一个中国地图 API Key：{name}',
      keyUnavailable: 'API Key 不可用，请在地图密钥中检查：{name}', keyExpired: 'API Key 已过期，请在地图密钥中更新：{name}',
      importingKey: '正在导入环境变量中的 API Key：{name}', missingSource: '缺少数据源配置：{name}',
      source_limited_cache: '所有来源的当前版本均已导入，没有新的可提取数据。', source_version_checked: '已检查来源版本，暂无更新。', source_growth_step: '正在分步导入，下一步即将开始。',
      retry_suspended: '连续失败，已暂停自动重试。', retry_backoff: '失败后退避，等待重试。', shared_failure_circuit: '同类来源出现相同故障，已暂停。',
      source_partial_checkpoint: '来源正在分批处理，等待下一批。', source_partial_stalled: '分批处理没有进展，已暂停。',
      no_source_shard: '没有配置可用来源。', cooldown: "密钥冷却中", coverage_sources_exhausted: "总量已达标，现有来源无法继续提升覆盖", validated_sources_exhausted: "已验证来源均已使用，没有新的合格数据", credential_broker_unavailable: "凭据服务不可用", unconfigured: "尚未配置地图 API Key", china_worker: '由中国同步任务处理。', quota: '等待额度重置'
    },
    googleQuota: {
      budget: '自动同步月度预算', baseline: '本月已有用量', hint: '填写接入本项目之前在同一 Google 结算账户产生的 Geocoding 用量。',
      official: 'Google 官方免费用量：每个结算账户每月 10,000 次；项目自动同步默认最多使用 9,000 次。'
    },
    translationCost: {
      google: '优先使用缓存；在线服务按下方配置的优先级执行。OpenAI 兼容接口按你配置的供应商计费；谷歌是免密钥网页接口（非 Cloud Translation 计费 API），可能限流或不可用。',
      youdao: '有道按量收费，试用额度用完后可能扣费，测试和自动翻译也可能产生费用。项目限额不代表供应商免费额度；若不接受费用，请勿添加或启用凭据。'
    },
    deepl: {
      notice: '仅支持 DeepL API Free，不切换付费版。以账户实际额度和项目上限中较小者为准；每个密钥单独计算字符用量。测试按钮只查询额度，不消耗翻译字符。',
      budget: '字符使用上限（当前额度周期）', characters: '字符', provider: '账户已用 / 上限', observed: '额度查询时间', unknown: '尚未查询额度',
      reset: 'DeepL 免费版不提供重置日期；DeepL 报告的账户用量下降时重新计数，额度用完的密钥每小时复查一次。', add: '添加 DeepL 密钥'
    },
    test: {"title": "测试连接", "mode": "测试模式", "modeChat": "连通性（发送 \"hi\"）", "modeTranslate": "地址翻译", "start": "开始测试凭据", "running": "等待供应商响应…", "passed": "测试通过", "failed": "测试失败", "retry": "重试", "model": "模型", "prompt": "提示词", "addressSample": "地址样例", "endpointProbe": "保存时自动探测", "endpointPreview": "实际请求地址", "restoreDefaultPrompt": "恢复默认提示词", "steps": {"invalidConfig": "已保存的配置无效", "endpoint": "请求地址", "model": "模型", "parameters": "参数", "sendTranslation": "发送地址样例", "sendChat": "发送测试消息", "timeout": "请求超时", "network": "网络错误", "status": "已连接", "providerError": "供应商返回错误", "invalidJson": "响应不是 JSON", "respondedModel": "响应模型", "finishReason": "结束原因", "usage": "Token 用量", "reasoning": "思考内容字数", "response": "响应", "done": "测试完成", "truncated": "输出在 JSON 结束前被截断，请调大输出预算", "invalidTranslation": "回复不是约定的 JSON 翻译数组", "translations": "解析出的译文", "identifiersChanged": "模型改动了数字或编号"}},
    shortcut: {
      nav: '快捷区域', country: '国家和地区', customized: '已自定义', defaults: '使用默认值', specialTitle: '特殊区域标题',
      adminAreas: '热门行政区', cities: '热门城市', specialAreas: '特殊区域', type: '类型', region: '行政区', city: '城市', postcode: '邮编',
      choose: '搜索并选择', selected: '已选择 {count} 个', loading: '正在加载', noOptions: '没有匹配项', available: '{count} 个地址',
      save: '保存配置', reset: '恢复默认', saved: '快捷区域配置已保存', resetDone: '已恢复默认配置',
      moveUp: '上移', moveDown: '下移', remove: '删除', confirmReset: '确定恢复这个国家的默认快捷区域吗？'
    },
    history: {
      nav: '同步历史', title: '同步历史', schedulerActive: '调度器运行中', schedulerIdle: '调度器未运行',
      lastHeartbeat: '最近心跳', country: '国家和地区', allCountries: '全部国家', status: '状态', source: '数据来源',
      period: '占用时间段', duration: '持续时间', growth: '总量净增', trigger: '触发方式', details: '结果说明',
      empty: '暂无同步历史', queued: '排队中', running: '同步中', succeeded: '执行成功', failed: '失败',
      paused_quota: '等待额度', needs_review: '需要检查', cancelled: '未执行', previous: '上一页', next: '下一页',
      candidates: '候选', qualityPassed: '质量通过', rejected: '拒绝', coveredNodes: '覆盖节点', qualifiedNodes: '达标节点', interrupted: '已中断', keptRows: '已保留 {count} 条已通过质量校验的地址',
      inProgress: '进行中', chinaProviders: '中国地图服务商',
      phases: { discover: '发现数据源', download: '下载', materialize: '数据准备', import: '导入', coverage: '覆盖统计', postcode: '邮编推断', publish: '发布' },
      errors: { interrupted: '因重启或部署中断，已自动重新排队', timeout: '超过处理时间上限', stuck: '取消后工作进程未及时停止', databaseTimeout: '数据库语句超时', databaseLock: '数据库锁等待超时', database: '数据库错误', quality: '未通过质量门禁', partial: '部分完成，进度已保存', credential: '密钥或额度不可用', source: '数据源不可用或返回异常', failed: '同步失败（{code}）' }
    }
  },
  'zh-TW': {
    ui: {
      operationDone: '操作已完成', busy: '上一個操作仍在處理中。', testing: '正在測試…', confirmTitle: '請確認', confirm: '確認',
      mapError: '地圖載入失敗，仍可使用資料列表。', expandMap: '展開地圖',
      levelFirst: '第一級', levelSecond: '第二級', levelThird: '第三級',
      defaultPasswordWarning: '目前使用預設管理員密碼。請先修改管理員密碼。',
      passwordChangeRequired: '使用其他管理員功能前必須先修改預設密碼',
      addressTotal: '有效地址', residentialShare: '其中住宅 {count}', todayGrowth: '今日淨增',
      schedulerStale: '排程器無心跳', databaseDown: '資料庫無法使用',
      filterAll: '全部', filterAttention: '需要處理', filterActive: '進行中', filterWaiting: '等待中', filterDone: '已達標', filterLimited: '來源上限',
      sortLabel: '排序方式', sortDeficit: '缺口由大到小', sortName: '國家名稱', sortCoverage: '覆蓋率由低到高',
      queueStale: '同步佇列快照已過期（產生於 {time}）。', queueFresh: '佇列快照 {time}', nextRunPending: '等待排程',
      rulesColumn: '完成規則', unlimitedQuota: '無限額度', coverageNodes: '{covered} / {total} 個節點有地址', minimumNodes: '{count} 個節點達到 ≥{min} 筆', ruleTotal: '總量', ruleCoverage: '覆蓋', ruleMinimum: '最低數量', backToList: '返回列表',
      tabOverview: '概覽', tabTargets: '目標設定', tabNodes: '節點目標', tabSources: '資料來源', tabHistory: '同步歷史', tabChina: '區縣覆蓋',
      currentState: '目前狀態', stateReason: '說明', notFound: '找不到此國家的設定。',
      keyCount: '{count} 個金鑰', keyCountOne: '1 個金鑰', eta: '預計', untilRetry: '{time} 後重試', listSeparator: '、',
      seconds: '{s} 秒', minutes: '{m} 分 {s} 秒', hours: '{h} 小時 {m} 分', quotaWaitFor: '等待 {provider} 額度重設'
    },
    model: {
      format: '請求格式', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'Index-Translate 依 Index 提示詞只傳送一則 user 訊息並關閉思考，適用於 bilibili Index-Translate 模型及其反向代理；僅支援英文與簡體中文目標。', httpWarning: '此介面使用 HTTP 明文：API Key 與地址文字未經加密傳輸。',
      all: '查看全部模型', empty: '沒有符合項目，可直接輸入模型名稱', unavailable: '不支援 Chat Completions', count: '個模型', blocked: '個不相容',
      hint: '從清單選取，或直接輸入模型名稱。',
      reasoningUnknown: '介面未提供思考強度清單。專案預設傳送 low，可依供應商文件修改；這不代表供應商的預設值。',
      reasoningKnown: '候選值來自模型的介面中繼資料，填入的值會隨請求傳送。',
      endpointHint: "填入供應商前綴（如 https://api.example.com 或 …/v1），或完整的 /chat/completions 網址。未含版本號的前綴會在儲存時自動偵測並補全（通常為 /v1）。僅支援 Chat Completions 格式。"
    },
    queueStates: { retry_wait: '等待重試', scheduled_wait: '等待下次檢查', suspended: '重試已暫停', no_source: '沒有可執行來源' },
    reasons: {
      missingKey: '缺少 API Key：{name}', missingChinaKeys: '至少設定一個中國地圖 API Key：{name}',
      keyUnavailable: 'API Key 無法使用，請在地圖金鑰中檢查：{name}', keyExpired: 'API Key 已過期，請在地圖金鑰中更新：{name}',
      importingKey: '正在匯入環境變數中的 API Key：{name}', missingSource: '缺少資料來源設定：{name}',
      source_limited_cache: '所有來源的目前版本均已匯入，沒有新的可擷取資料。', source_version_checked: '已檢查來源版本，暫無更新。', source_growth_step: '正在分步匯入，下一步即將開始。',
      retry_suspended: '連續失敗，已暫停自動重試。', retry_backoff: '失敗後退避，等待重試。', shared_failure_circuit: '同類來源出現相同故障，已暫停。',
      source_partial_checkpoint: '來源正在分批處理，等待下一批。', source_partial_stalled: '分批處理沒有進展，已暫停。',
      no_source_shard: '沒有設定可用來源。', cooldown: "金鑰冷卻中", coverage_sources_exhausted: "總量已達標，現有來源無法繼續提升覆蓋", validated_sources_exhausted: "已驗證來源均已使用，沒有新的合格資料", credential_broker_unavailable: "憑據服務無法使用", unconfigured: "尚未設定地圖 API Key", china_worker: '由中國同步工作處理。', quota: '等待額度重設'
    },
    googleQuota: {
      budget: '自動同步月度預算', baseline: '本月已有用量', hint: '填寫接入本專案之前在同一 Google 結算帳戶產生的 Geocoding 用量。',
      official: 'Google 官方免費用量：每個結算帳戶每月 10,000 次；專案自動同步預設最多使用 9,000 次。'
    },
    translationCost: {
      google: '優先使用快取；線上服務依下方設定的優先順序執行。OpenAI 相容介面按你設定的供應商計費；Google 是免密鑰網頁介面（非 Cloud Translation 計費 API），可能限流或無法使用。',
      youdao: '有道按量收費，試用額度用完後可能扣費，測試和自動翻譯也可能產生費用。專案限額不代表供應商免費額度；若不接受費用，請勿新增或啟用憑據。'
    },
    deepl: {
      notice: '僅支援 DeepL API Free，不切換付費版。以帳戶實際額度和專案上限中較小者為準；每個金鑰單獨計算字元用量。測試按鈕僅查詢額度，不消耗翻譯字元。',
      budget: '字元使用上限（目前額度週期）', characters: '字元', provider: '帳戶已用 / 上限', observed: '額度查詢時間', unknown: '尚未查詢額度',
      reset: 'DeepL 免費版不提供重置日期；DeepL 回報的帳戶用量下降時重新計數，額度用完的金鑰每小時複查一次。', add: '新增 DeepL 金鑰'
    },
    test: {"title": "測試連線", "mode": "測試模式", "modeChat": "連通性（傳送 \"hi\"）", "modeTranslate": "地址翻譯", "start": "開始測試憑據", "running": "等待供應商回應…", "passed": "測試通過", "failed": "測試失敗", "retry": "重試", "model": "模型", "prompt": "提示詞", "addressSample": "地址樣例", "endpointProbe": "儲存時自動偵測", "endpointPreview": "實際請求網址", "restoreDefaultPrompt": "恢復預設提示詞", "steps": {"invalidConfig": "已儲存的設定無效", "endpoint": "請求網址", "model": "模型", "parameters": "參數", "sendTranslation": "傳送地址樣例", "sendChat": "傳送測試訊息", "timeout": "請求逾時", "network": "網路錯誤", "status": "已連線", "providerError": "供應商回傳錯誤", "invalidJson": "回應不是 JSON", "respondedModel": "回應模型", "finishReason": "結束原因", "usage": "Token 用量", "reasoning": "思考內容字數", "response": "回應", "done": "測試完成", "truncated": "輸出在 JSON 結束前被截斷，請調大輸出預算", "invalidTranslation": "回覆不是約定的 JSON 翻譯陣列", "translations": "解析出的譯文", "identifiersChanged": "模型改動了數字或編號"}},
    shortcut: {
      nav: '快捷區域', country: '國家和地區', customized: '已自訂', defaults: '使用預設值', specialTitle: '特殊區域標題',
      adminAreas: '熱門行政區', cities: '熱門城市', specialAreas: '特殊區域', type: '類型', region: '行政區', city: '城市', postcode: '郵遞區號',
      choose: '搜尋並選擇', selected: '已選擇 {count} 個', loading: '正在載入', noOptions: '沒有符合項目', available: '{count} 個地址',
      save: '儲存設定', reset: '恢復預設', saved: '快捷區域設定已儲存', resetDone: '已恢復預設設定',
      moveUp: '上移', moveDown: '下移', remove: '刪除', confirmReset: '確定恢復這個國家的預設快捷區域嗎？'
    },
    history: {
      nav: '同步歷史', title: '同步歷史', schedulerActive: '排程器執行中', schedulerIdle: '排程器未執行',
      lastHeartbeat: '最近心跳', country: '國家和地區', allCountries: '全部國家', status: '狀態', source: '資料來源',
      period: '佔用時段', duration: '持續時間', growth: '總量淨增', trigger: '觸發方式', details: '結果說明',
      empty: '暫無同步歷史', queued: '排隊中', running: '同步中', succeeded: '執行成功', failed: '失敗',
      paused_quota: '等待額度', needs_review: '需要檢查', cancelled: '未執行', previous: '上一頁', next: '下一頁',
      candidates: '候選', qualityPassed: '品質通過', rejected: '拒絕', coveredNodes: '覆蓋節點', qualifiedNodes: '達標節點', interrupted: '已中斷', keptRows: '已保留 {count} 筆已通過品質校驗的地址',
      inProgress: '進行中', chinaProviders: '中國地圖服務商',
      phases: { discover: '探索資料來源', download: '下載', materialize: '資料準備', import: '匯入', coverage: '覆蓋統計', postcode: '郵遞區號推斷', publish: '發布' },
      errors: { interrupted: '因重新啟動或部署中斷，已自動重新排隊', timeout: '超過處理時間上限', stuck: '取消後工作程序未及時停止', databaseTimeout: '資料庫語句逾時', databaseLock: '資料庫鎖定等待逾時', database: '資料庫錯誤', quality: '未通過品質門檻', partial: '部分完成，進度已儲存', credential: '金鑰或額度無法使用', source: '資料來源無法使用或回傳異常', failed: '同步失敗（{code}）' }
    }
  },
  ja: {
    ui: {
      operationDone: '操作が完了しました', busy: '前の操作をまだ処理しています。', testing: 'テスト中…', confirmTitle: '確認', confirm: '実行',
      mapError: '地図を読み込めませんでした。データ一覧は引き続き利用できます。', expandMap: '地図を拡大',
      levelFirst: '第1階層', levelSecond: '第2階層', levelThird: '第3階層',
      defaultPasswordWarning: '既定の管理者パスワードが使われています。先に変更してください。',
      passwordChangeRequired: '他の管理機能を使う前に既定のパスワードを変更してください。',
      addressTotal: '有効な住所', residentialShare: 'うち住宅 {count}', todayGrowth: '本日の純増',
      schedulerStale: 'スケジューラーの応答なし', databaseDown: 'データベースに接続できません',
      filterAll: 'すべて', filterAttention: '対応が必要', filterActive: '進行中', filterWaiting: '待機中', filterDone: '目標達成', filterLimited: 'ソース上限',
      sortLabel: '並べ替え', sortDeficit: '不足が大きい順', sortName: '国名', sortCoverage: '網羅率が低い順',
      queueStale: '同期キューのスナップショットが古くなっています（{time} 生成）。', queueFresh: 'キュー更新 {time}', nextRunPending: 'スケジュール待ち',
      rulesColumn: '完了条件', unlimitedQuota: '無制限', coverageNodes: '{covered} / {total} ノードに住所あり', minimumNodes: '{count} ノードが {min} 件以上', ruleTotal: '総数', ruleCoverage: '網羅', ruleMinimum: '最低数', backToList: '一覧に戻る',
      tabOverview: '概要', tabTargets: '目標設定', tabNodes: 'ノード目標', tabSources: 'データソース', tabHistory: '同期履歴', tabChina: '区・県の網羅',
      currentState: '現在の状態', stateReason: '詳細', notFound: 'この国は設定されていません。',
      keyCount: 'キー {count} 件', keyCountOne: 'キー 1 件', eta: '予測', untilRetry: '{time} 後に再試行', listSeparator: '、',
      seconds: '{s} 秒', minutes: '{m} 分 {s} 秒', hours: '{h} 時間 {m} 分', quotaWaitFor: '{provider} のクォータのリセット待ち'
    },
    model: {
      format: 'リクエスト形式', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'Index-Translate は Index プロンプトで user メッセージを 1 件だけ送り、思考を無効にします。bilibili Index-Translate モデルとそのプロキシ向けで、英語と簡体字中国語のみ対応します。', httpWarning: 'このエンドポイントは平文 HTTP です。API キーと住所テキストは暗号化されずに送信されます。',
      all: 'すべてのモデルを表示', empty: '一致する項目がありません。モデル ID を直接入力できます。', unavailable: 'Chat Completions 非対応', count: 'モデル', blocked: '件が非対応',
      hint: '一覧から選ぶか、モデル ID を直接入力してください。',
      reasoningUnknown: 'エンドポイントが推論レベルを提示していません。このプロジェクトは初期値として low を送信します。プロバイダーのドキュメントに沿って調整してください。これはプロバイダーの既定値ではありません。',
      reasoningKnown: '候補はこのモデルの API メタデータに基づきます。入力した値はリクエストに含めて送信されます。',
      endpointHint: "プロバイダーのプレフィックス（例: https://api.example.com または …/v1）か、/chat/completions の完全な URL を入力してください。バージョンのないプレフィックスは保存時に API パスを自動検出して補完します（通常は /v1）。Chat Completions 形式のみ対応しています。"
    },
    queueStates: { retry_wait: '再試行待ち', scheduled_wait: '次回チェック待ち', suspended: '再試行を一時停止', no_source: '実行可能なソースなし' },
    reasons: {
      missingKey: 'API キーがありません: {name}', missingChinaKeys: '中国の地図 API キーを少なくとも 1 つ設定してください: {name}',
      keyUnavailable: 'API キーを利用できません。地図キーで確認してください: {name}', keyExpired: 'API キーの有効期限が切れています。地図キーで更新してください: {name}',
      importingKey: '環境変数から API キーを取り込み中: {name}', missingSource: 'データソースの設定がありません: {name}',
      source_limited_cache: 'すべてのソースの現行バージョンを取り込み済みで、新たに抽出できるデータはありません。', source_version_checked: 'ソースのバージョンを確認しました。更新はありません。', source_growth_step: '段階的に取り込み中です。次の段階はまもなく始まります。',
      retry_suspended: '失敗が続いたため自動再試行を停止しました。', retry_backoff: '失敗後の待機中です。', shared_failure_circuit: '関連ソースで同じ障害が発生したため停止しました。',
      source_partial_checkpoint: 'ソースを分割処理中です。次のバッチを待っています。', source_partial_stalled: '分割処理が進まないため停止しました。',
      no_source_shard: '利用可能なソースが設定されていません。', cooldown: "認証情報のクールダウン中", coverage_sources_exhausted: "件数は達成済みですが、既存のソースでは網羅率をこれ以上上げられません", validated_sources_exhausted: "検証済みソースをすべて使用し、新しい対象データはありません", credential_broker_unavailable: "認証情報サービスを利用できません", unconfigured: "地図 API キーが未設定です", china_worker: '中国同期ワーカーが処理します。', quota: 'クォータのリセット待ち'
    },
    googleQuota: {
      budget: '自動同期の月間予算', baseline: 'セットアップ前の使用量', hint: '同じ Google 請求先アカウントで今月すでに発生した Geocoding の使用量を入力してください。',
      official: 'Google の無料枠: 請求先アカウントごとに月 10,000 件。自動同期は既定で最大 9,000 件を使用します。'
    },
    translationCost: {
      google: 'キャッシュを優先し、オンラインサービスは下記の優先度に従います。OpenAI 互換インターフェースは設定したプロバイダーの料金体系に従います。Google はキー不要の Web インターフェース（有料の Cloud Translation API ではありません）で、制限や停止が起こる場合があります。',
      youdao: 'Youdao は従量課金で、試用クレジットを使い切るとテストや自動翻訳でも料金が発生する場合があります。プロジェクトの上限は無料枠を保証するものではありません。料金を受け入れない場合は、認証情報を追加・有効化しないでください。'
    },
    deepl: {
      notice: 'DeepL API Free のみ対応し、Pro には切り替えません。アカウントの利用枠とプロジェクト上限のうち小さい方が適用されます。文字数台帳はキーごとに管理します。テストボタンは利用状況を確認するだけで翻訳は行いません。',
      budget: '文字数上限（現在の利用期間）', characters: '文字', provider: 'アカウント使用量 / 上限', observed: '利用状況の確認時刻', unknown: '利用状況は未確認',
      reset: 'DeepL Free はリセット日を返しません。DeepL が報告する利用量が減ると再計算し、上限に達したキーは 1 時間ごとに再確認します。', add: 'DeepL キーを追加'
    },
    test: {"title": "接続テスト", "mode": "テストモード", "modeChat": "疎通確認（\"hi\" を送信）", "modeTranslate": "住所の翻訳", "start": "認証情報をテスト中", "running": "プロバイダーの応答を待っています…", "passed": "テスト成功", "failed": "テスト失敗", "retry": "再試行", "model": "モデル", "prompt": "プロンプト", "addressSample": "住所サンプル", "endpointProbe": "保存時に自動検出", "endpointPreview": "リクエスト URL", "restoreDefaultPrompt": "既定のプロンプトに戻す", "steps": {"invalidConfig": "保存された設定が無効です", "endpoint": "エンドポイント", "model": "モデル", "parameters": "パラメーター", "sendTranslation": "住所サンプルを送信", "sendChat": "テストメッセージを送信", "timeout": "タイムアウトしました", "network": "ネットワークエラー", "status": "接続済み", "providerError": "プロバイダーのエラー", "invalidJson": "応答が JSON ではありません", "respondedModel": "応答したモデル", "finishReason": "終了理由", "usage": "トークン使用量", "reasoning": "推論の文字数", "response": "応答", "done": "テスト完了", "truncated": "JSON の途中で出力が打ち切られました。出力上限を増やしてください", "invalidTranslation": "応答が想定した JSON 翻訳配列ではありません", "translations": "解析した訳文", "identifiersChanged": "モデルが数字や識別子を変更しました"}},
    shortcut: {
      nav: 'クイック地域', country: '国・地域', customized: 'カスタム', defaults: '既定値を使用中', specialTitle: '特別地域のタイトル',
      adminAreas: '人気の行政区', cities: '人気の都市', specialAreas: '特別地域', type: '種類', region: '行政区', city: '都市', postcode: '郵便番号',
      choose: '検索して選択', selected: '{count} 件選択', loading: '読み込み中', noOptions: '一致する項目がありません', available: '住所 {count} 件',
      save: '設定を保存', reset: '既定に戻す', saved: 'クイック地域を保存しました', resetDone: '既定の設定に戻しました',
      moveUp: '上へ', moveDown: '下へ', remove: '削除', confirmReset: 'この国のクイック地域を既定に戻しますか？'
    },
    history: {
      nav: '同期履歴', title: '同期履歴', schedulerActive: 'スケジューラー稼働中', schedulerIdle: 'スケジューラー停止中',
      lastHeartbeat: '最終応答', country: '国・地域', allCountries: 'すべての国', status: '状態', source: 'データソース',
      period: '実行期間', duration: '所要時間', growth: '純増数', trigger: 'トリガー', details: '結果',
      empty: '同期履歴はありません', queued: '待機中', running: '実行中', succeeded: '成功', failed: '失敗',
      paused_quota: 'クォータ待ち', needs_review: '要確認', cancelled: '未実行', previous: '前へ', next: '次へ',
      candidates: '候補', qualityPassed: '品質合格', rejected: '除外', coveredNodes: '網羅ノード', qualifiedNodes: '基準達成ノード', interrupted: '中断', keptRows: '品質チェック済みの {count} 件を保持',
      inProgress: '実行中', chinaProviders: '中国の地図サービス',
      phases: { discover: 'データソースの検出', download: 'ダウンロード', materialize: 'データ準備', import: 'インポート', coverage: 'カバレッジ集計', postcode: '郵便番号推定', publish: '公開' },
      errors: { interrupted: '再起動またはデプロイで中断され、自動で再キューされました', timeout: '処理時間の上限を超えました', stuck: 'キャンセル後にワーカーが時間内に停止しませんでした', databaseTimeout: 'データベースのステートメントがタイムアウトしました', databaseLock: 'データベースのロック待ちがタイムアウトしました', database: 'データベースエラー', quality: '品質ゲートを通過しませんでした', partial: '一部完了し、進捗を保存しました', credential: 'キーまたは利用枠を使用できません', source: 'データソースが利用できないか異常な応答を返しました', failed: '同期に失敗しました（{code}）' }
    }
  },
  ko: {
    ui: {
      operationDone: '작업을 완료했습니다', busy: '이전 작업을 아직 처리하고 있습니다.', testing: '테스트 중…', confirmTitle: '작업 확인', confirm: '확인',
      mapError: '지도를 불러오지 못했습니다. 데이터 목록은 계속 사용할 수 있습니다.', expandMap: '지도 확대',
      levelFirst: '1단계', levelSecond: '2단계', levelThird: '3단계',
      defaultPasswordWarning: '기본 관리자 비밀번호를 사용 중입니다. 먼저 변경하세요.',
      passwordChangeRequired: '다른 관리자 기능을 사용하기 전에 기본 비밀번호를 변경하세요.',
      addressTotal: '유효 주소', residentialShare: '주거 {count}', todayGrowth: '오늘 순증가',
      schedulerStale: '스케줄러 응답 없음', databaseDown: '데이터베이스 사용 불가',
      filterAll: '전체', filterAttention: '조치 필요', filterActive: '진행 중', filterWaiting: '대기 중', filterDone: '목표 달성', filterLimited: '원본 한도',
      sortLabel: '정렬', sortDeficit: '부족분 큰 순', sortName: '국가 이름', sortCoverage: '커버리지 낮은 순',
      queueStale: '동기화 대기열 스냅샷이 오래되었습니다({time} 생성).', queueFresh: '대기열 스냅샷 {time}', nextRunPending: '스케줄 대기',
      rulesColumn: '완료 조건', unlimitedQuota: '무제한', coverageNodes: '{covered} / {total}개 노드에 주소 있음', minimumNodes: '{count}개 노드가 {min}건 이상', ruleTotal: '총계', ruleCoverage: '커버리지', ruleMinimum: '최소 수', backToList: '목록으로',
      tabOverview: '개요', tabTargets: '목표 설정', tabNodes: '노드 목표', tabSources: '데이터 원본', tabHistory: '동기화 기록', tabChina: '구·현 커버리지',
      currentState: '현재 상태', stateReason: '상세', notFound: '이 국가는 설정되어 있지 않습니다.',
      keyCount: '키 {count}개', keyCountOne: '키 1개', eta: '예상', untilRetry: '{time} 후 재시도', listSeparator: ', ',
      seconds: '{s}초', minutes: '{m}분 {s}초', hours: '{h}시간 {m}분', quotaWaitFor: '{provider} 할당량 초기화 대기'
    },
    model: {
      format: '요청 형식', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'Index-Translate는 Index 프롬프트로 user 메시지 하나만 보내고 사고 모드를 끕니다. bilibili Index-Translate 모델과 그 프록시용이며 영어와 간체 중국어만 지원합니다.', httpWarning: '이 엔드포인트는 평문 HTTP입니다. API 키와 주소 텍스트가 암호화되지 않은 채 전송됩니다.',
      all: '모든 모델 보기', empty: '일치하는 항목이 없습니다. 모델 ID를 직접 입력할 수 있습니다.', unavailable: 'Chat Completions 미지원', count: '개 모델', blocked: '개 호환되지 않음',
      hint: '목록에서 선택하거나 모델 ID를 직접 입력하세요.',
      reasoningUnknown: '엔드포인트가 추론 수준을 제공하지 않습니다. 이 프로젝트는 처음에 low를 보내며, 공급자 문서에 따라 조정할 수 있습니다. 이는 공급자 기본값이 아닙니다.',
      reasoningKnown: '후보 값은 이 모델의 API 메타데이터에서 가져왔으며, 입력한 값이 요청과 함께 전송됩니다.',
      endpointHint: "공급자 접두사(예: https://api.example.com 또는 …/v1)나 전체 /chat/completions URL을 입력하세요. 버전이 없는 접두사는 저장할 때 API 경로를 자동 감지해 보완합니다(보통 /v1). Chat Completions 형식만 지원합니다."
    },
    queueStates: { retry_wait: '재시도 대기', scheduled_wait: '다음 확인 대기', suspended: '재시도 일시 중지', no_source: '실행 가능한 원본 없음' },
    reasons: {
      missingKey: 'API 키가 없습니다: {name}', missingChinaKeys: '중국 지도 API 키를 하나 이상 설정하세요: {name}',
      keyUnavailable: 'API 키를 사용할 수 없습니다. 지도 키에서 확인하세요: {name}', keyExpired: 'API 키가 만료되었습니다. 지도 키에서 업데이트하세요: {name}',
      importingKey: '환경 변수에서 API 키를 가져오는 중: {name}', missingSource: '데이터 원본 설정이 없습니다: {name}',
      source_limited_cache: '모든 원본의 현재 버전을 가져왔으며 새로 추출할 데이터가 없습니다.', source_version_checked: '원본 버전을 확인했으며 업데이트가 없습니다.', source_growth_step: '단계별로 가져오는 중이며 다음 단계가 곧 시작됩니다.',
      retry_suspended: '연속 실패로 자동 재시도를 중지했습니다.', retry_backoff: '실패 후 재시도를 기다리는 중입니다.', shared_failure_circuit: '관련 원본에서 같은 오류가 발생해 중지했습니다.',
      source_partial_checkpoint: '원본을 나누어 처리 중이며 다음 배치를 기다립니다.', source_partial_stalled: '분할 처리가 진행되지 않아 중지했습니다.',
      no_source_shard: '사용 가능한 원본이 설정되어 있지 않습니다.', cooldown: "자격 증명 대기 시간 중", coverage_sources_exhausted: "목표 수는 달성했지만 기존 원본으로는 커버리지를 더 높일 수 없습니다", validated_sources_exhausted: "검증된 원본을 모두 사용했으며 새 적격 데이터가 없습니다", credential_broker_unavailable: "자격 증명 서비스를 사용할 수 없습니다", unconfigured: "지도 API 키가 설정되지 않았습니다", china_worker: '중국 동기화 작업에서 처리합니다.', quota: '할당량 초기화 대기'
    },
    googleQuota: {
      budget: '자동 동기화 월 예산', baseline: '설정 전 사용량', hint: '같은 Google 결제 계정에서 이번 달 이미 발생한 Geocoding 사용량을 입력하세요.',
      official: 'Google 무료 사용량: 결제 계정당 월 10,000건, 자동 동기화는 기본적으로 최대 9,000건을 사용합니다.'
    },
    translationCost: {
      google: '캐시를 우선 사용하며 온라인 서비스는 아래 우선순위를 따릅니다. OpenAI 호환 인터페이스는 설정한 공급자의 요금을 따르고, Google은 키가 필요 없는 웹 인터페이스(유료 Cloud Translation API 아님)로 제한되거나 사용할 수 없을 수 있습니다.',
      youdao: 'Youdao는 사용량 기반 요금이며 체험 크레딧 소진 후에는 테스트와 자동 번역에도 요금이 발생할 수 있습니다. 프로젝트 한도는 무료 크레딧을 보장하지 않습니다. 요금을 받아들이지 않으면 자격 증명을 추가하거나 사용하지 마세요.'
    },
    deepl: {
      notice: 'DeepL API Free만 지원하며 Pro로 전환하지 않습니다. 계정 허용량과 프로젝트 한도 중 작은 값이 적용되고, 문자 사용 장부는 키마다 따로 관리합니다. 테스트 버튼은 번역 없이 사용량만 확인합니다.',
      budget: '문자 한도(현재 할당 기간)', characters: '자', provider: '계정 사용량 / 한도', observed: '사용량 확인 시각', unknown: '사용량 미확인',
      reset: 'DeepL Free는 초기화 날짜를 제공하지 않습니다. DeepL이 보고한 계정 사용량이 줄면 다시 계산하며, 한도에 도달한 키는 1시간마다 다시 확인합니다.', add: 'DeepL 키 추가'
    },
    test: {"title": "연결 테스트", "mode": "테스트 모드", "modeChat": "연결 확인(\"hi\" 전송)", "modeTranslate": "주소 번역", "start": "자격 증명 테스트 시작", "running": "공급자 응답 대기 중…", "passed": "테스트 통과", "failed": "테스트 실패", "retry": "다시 시도", "model": "모델", "prompt": "프롬프트", "addressSample": "주소 샘플", "endpointProbe": "저장 시 자동 감지", "endpointPreview": "요청 URL", "restoreDefaultPrompt": "기본 프롬프트 복원", "steps": {"invalidConfig": "저장된 설정이 올바르지 않습니다", "endpoint": "엔드포인트", "model": "모델", "parameters": "매개변수", "sendTranslation": "주소 샘플 전송", "sendChat": "테스트 메시지 전송", "timeout": "요청 시간 초과", "network": "네트워크 오류", "status": "연결됨", "providerError": "공급자 오류", "invalidJson": "응답이 JSON이 아닙니다", "respondedModel": "응답 모델", "finishReason": "종료 사유", "usage": "토큰 사용량", "reasoning": "추론 글자 수", "response": "응답", "done": "테스트 완료", "truncated": "JSON이 끝나기 전에 출력이 잘렸습니다. 출력 예산을 늘리세요", "invalidTranslation": "응답이 약속된 JSON 번역 배열이 아닙니다", "translations": "파싱된 번역", "identifiersChanged": "모델이 숫자나 식별자를 변경했습니다"}},
    shortcut: {
      nav: '빠른 지역', country: '국가 또는 지역', customized: '사용자 지정', defaults: '기본값 사용 중', specialTitle: '특별 지역 제목',
      adminAreas: '인기 행정구역', cities: '인기 도시', specialAreas: '특별 지역', type: '유형', region: '행정구역', city: '도시', postcode: '우편번호',
      choose: '검색하여 선택', selected: '{count}개 선택됨', loading: '불러오는 중', noOptions: '일치하는 항목 없음', available: '주소 {count}개',
      save: '설정 저장', reset: '기본값 복원', saved: '빠른 지역을 저장했습니다', resetDone: '기본 설정으로 복원했습니다',
      moveUp: '위로', moveDown: '아래로', remove: '삭제', confirmReset: '이 국가의 빠른 지역을 기본값으로 복원할까요?'
    },
    history: {
      nav: '동기화 기록', title: '동기화 기록', schedulerActive: '스케줄러 실행 중', schedulerIdle: '스케줄러 유휴',
      lastHeartbeat: '최근 응답', country: '국가 또는 지역', allCountries: '모든 국가', status: '상태', source: '데이터 원본',
      period: '실행 기간', duration: '소요 시간', growth: '순증가', trigger: '트리거', details: '결과',
      empty: '동기화 기록이 없습니다', queued: '대기 중', running: '실행 중', succeeded: '성공', failed: '실패',
      paused_quota: '할당량 대기', needs_review: '검토 필요', cancelled: '실행 안 됨', previous: '이전', next: '다음',
      candidates: '후보', qualityPassed: '품질 통과', rejected: '제외', coveredNodes: '커버 노드', qualifiedNodes: '기준 충족 노드', interrupted: '중단됨', keptRows: '품질 검사를 통과한 {count}건 유지',
      inProgress: '진행 중', chinaProviders: '중국 지도 서비스',
      phases: { discover: '데이터 소스 탐색', download: '다운로드', materialize: '데이터 준비', import: '가져오기', coverage: '커버리지 집계', postcode: '우편번호 추정', publish: '게시' },
      errors: { interrupted: '재시작 또는 배포로 중단되어 자동으로 다시 대기열에 추가됨', timeout: '처리 시간 한도 초과', stuck: '취소 후 작업자가 제때 멈추지 않음', databaseTimeout: '데이터베이스 문 실행 시간 초과', databaseLock: '데이터베이스 잠금 대기 시간 초과', database: '데이터베이스 오류', quality: '품질 기준 미통과', partial: '일부 완료, 진행 상황 저장됨', credential: '키 또는 할당량 사용 불가', source: '데이터 소스를 사용할 수 없거나 비정상 응답', failed: '동기화 실패({code})' }
    }
  },
  de: {
    ui: {
      operationDone: 'Vorgang abgeschlossen', busy: 'Die vorherige Aktion läuft noch.', testing: 'Test läuft…', confirmTitle: 'Aktion bestätigen', confirm: 'Bestätigen',
      mapError: 'Die Karte konnte nicht geladen werden. Die Datenliste bleibt verfügbar.', expandMap: 'Karte vergrößern',
      levelFirst: 'Ebene 1', levelSecond: 'Ebene 2', levelThird: 'Ebene 3',
      defaultPasswordWarning: 'Das Standard-Administratorpasswort ist aktiv. Ändern Sie es, bevor Sie fortfahren.',
      passwordChangeRequired: 'Ändern Sie das Standardpasswort, bevor Sie andere Administratorfunktionen verwenden.',
      addressTotal: 'Gültige Adressen', residentialShare: 'davon {count} Wohnadressen', todayGrowth: 'Nettozuwachs heute',
      schedulerStale: 'Kein Scheduler-Heartbeat', databaseDown: 'Datenbank nicht erreichbar',
      filterAll: 'Alle', filterAttention: 'Handlungsbedarf', filterActive: 'In Arbeit', filterWaiting: 'Wartend', filterDone: 'Ziel erreicht', filterLimited: 'Quellenlimit',
      sortLabel: 'Länder sortieren', sortDeficit: 'Größte Lücke zuerst', sortName: 'Ländername', sortCoverage: 'Geringste Abdeckung zuerst',
      queueStale: 'Der Snapshot der Sync-Warteschlange ist veraltet (erstellt {time}).', queueFresh: 'Warteschlangen-Snapshot {time}', nextRunPending: 'Wartet auf Scheduler',
      rulesColumn: 'Abschlussregeln', unlimitedQuota: 'Unbegrenzt', coverageNodes: '{covered} / {total} Knoten mit Adressen', minimumNodes: '{count} Knoten mit ≥{min}', ruleTotal: 'Summe', ruleCoverage: 'Abdeckung', ruleMinimum: 'Minimum', backToList: 'Zurück zur Liste',
      tabOverview: 'Übersicht', tabTargets: 'Ziele', tabNodes: 'Knotenziele', tabSources: 'Quellen', tabHistory: 'Verlauf', tabChina: 'Kreisabdeckung',
      currentState: 'Aktueller Status', stateReason: 'Details', notFound: 'Dieses Land ist nicht konfiguriert.',
      keyCount: '{count} Schlüssel', keyCountOne: '1 Schlüssel', eta: 'Prognose', untilRetry: 'neuer Versuch in {time}', listSeparator: ', ',
      seconds: '{s} s', minutes: '{m} min {s} s', hours: '{h} h {m} min', quotaWaitFor: 'Warten auf Kontingent-Reset von {provider}'
    },
    model: {
      format: 'Anfrageformat', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'Index-Translate sendet eine einzige user-Nachricht mit dem Index-Prompt und schaltet das Denken ab – für bilibili-Index-Translate-Modelle und deren Proxys. Nur Englisch und vereinfachtes Chinesisch als Ziel.', httpWarning: 'Dieser Endpunkt nutzt unverschlüsseltes HTTP: API-Schlüssel und Adresstexte werden unverschlüsselt übertragen.',
      all: 'Alle Modelle anzeigen', empty: 'Keine Treffer. Sie können eine Modell-ID direkt eingeben.', unavailable: 'Chat Completions nicht unterstützt', count: 'Modelle', blocked: 'inkompatibel',
      hint: 'Aus der Liste wählen oder eine Modell-ID eingeben.',
      reasoningUnknown: 'Der Endpunkt nennt keine Reasoning-Stufen. Dieses Projekt sendet zunächst low; passen Sie den Wert gemäß Anbieterdokumentation an. Das ist nicht der Standardwert des Anbieters.',
      reasoningKnown: 'Die Vorschläge stammen aus den API-Metadaten dieses Modells. Der eingegebene Wert wird mit den Anfragen gesendet.',
      endpointHint: "Geben Sie das Anbieterpräfix (z. B. https://api.example.com oder …/v1) oder die vollständige /chat/completions-URL ein. Bei einem Präfix ohne Versionssegment erkennt der Server den API-Pfad beim Speichern (meist /v1). Nur das Chat-Completions-Format wird unterstützt."
    },
    queueStates: { retry_wait: 'Wartet auf neuen Versuch', scheduled_wait: 'Wartet auf nächste Prüfung', suspended: 'Neue Versuche pausiert', no_source: 'Keine ausführbare Quelle' },
    reasons: {
      missingKey: 'API-Schlüssel fehlt: {name}', missingChinaKeys: 'Konfigurieren Sie mindestens einen China-Karten-API-Schlüssel: {name}',
      keyUnavailable: 'API-Schlüssel nicht verfügbar; prüfen Sie ihn unter Kartenschlüssel: {name}', keyExpired: 'API-Schlüssel abgelaufen; aktualisieren Sie ihn unter Kartenschlüssel: {name}',
      importingKey: 'API-Schlüssel wird aus der Umgebung importiert: {name}', missingSource: 'Quellkonfiguration fehlt: {name}',
      source_limited_cache: 'Alle Quellen wurden in ihrer aktuellen Version importiert; keine neuen extrahierbaren Daten.', source_version_checked: 'Quellversion geprüft; kein Update verfügbar.', source_growth_step: 'Import in Schritten; der nächste Schritt startet in Kürze.',
      retry_suspended: 'Automatische Wiederholungen nach wiederholten Fehlern pausiert.', retry_backoff: 'Wartezeit nach einem Fehler vor dem nächsten Versuch.', shared_failure_circuit: 'Pausiert, weil verwandte Quellen denselben Fehler zeigen.',
      source_partial_checkpoint: 'Quelle wird in Teilen verarbeitet; wartet auf den nächsten Teil.', source_partial_stalled: 'Teilverarbeitung stockt; pausiert.',
      no_source_shard: 'Keine nutzbare Quelle konfiguriert.', cooldown: "Zugangsdaten in Abkühlzeit", coverage_sources_exhausted: "Zielanzahl erreicht; vorhandene Quellen verbessern die Abdeckung nicht weiter", validated_sources_exhausted: "Alle geprüften Quellen sind ausgeschöpft; keine neuen geeigneten Daten", credential_broker_unavailable: "Zugangsdatendienst nicht verfügbar", unconfigured: "Kein Karten-API-Schlüssel konfiguriert", china_worker: 'Wird vom China-Sync-Worker verarbeitet.', quota: 'Warten auf Kontingent-Reset'
    },
    googleQuota: {
      budget: 'Monatliches Sync-Budget', baseline: 'Nutzung vor der Einrichtung', hint: 'Geben Sie die in diesem Monat bereits angefallene Geocoding-Nutzung desselben Google-Rechnungskontos ein.',
      official: 'Kostenlose Google-Nutzung: 10.000 Ereignisse pro Monat und Rechnungskonto; der automatische Sync nutzt standardmäßig höchstens 9.000.'
    },
    translationCost: {
      google: 'Cache zuerst; Online-Dienste folgen den unten konfigurierten Prioritäten. OpenAI-kompatible Nutzung wird nach Ihrem Anbieter abgerechnet; Google nutzt die schlüssellose Weboberfläche (nicht die kostenpflichtige Cloud Translation API) und kann drosseln oder ausfallen.',
      youdao: 'Youdao wird nach Nutzung abgerechnet und kann nach Ablauf des Testguthabens Kosten verursachen, auch für Tests und automatische Übersetzung. Projektlimits garantieren kein Freikontingent. Fügen Sie Zugangsdaten nur hinzu oder aktivieren Sie sie, wenn Sie die Kosten akzeptieren.'
    },
    deepl: {
      notice: 'Nur DeepL API Free; es wird nie zu Pro gewechselt. Es gilt der kleinere Wert aus Kontokontingent und Projektlimit. Jeder Schlüssel führt ein eigenes Zeichenkonto. Die Testtaste prüft nur die Nutzung und übersetzt nichts.',
      budget: 'Zeichenlimit (aktueller Zeitraum)', characters: 'Zeichen', provider: 'Konto genutzt / Limit', observed: 'Nutzung geprüft', unknown: 'Nutzung nicht geprüft',
      reset: 'DeepL Free nennt kein Rücksetzdatum; sinkt die von DeepL gemeldete Kontonutzung, beginnt die Zählung neu, und ausgeschöpfte Schlüssel werden stündlich geprüft.', add: 'DeepL-Schlüssel hinzufügen'
    },
    test: {"title": "Verbindung testen", "mode": "Testmodus", "modeChat": "Erreichbarkeit („hi“ senden)", "modeTranslate": "Adressübersetzung", "start": "Zugangsdaten werden getestet", "running": "Warten auf den Anbieter…", "passed": "Test bestanden", "failed": "Test fehlgeschlagen", "retry": "Erneut versuchen", "model": "Modell", "prompt": "Prompt", "addressSample": "Adressbeispiel", "endpointProbe": "wird beim Speichern erkannt", "endpointPreview": "Anfrage-URL", "restoreDefaultPrompt": "Standard-Prompt wiederherstellen", "steps": {"invalidConfig": "Die gespeicherte Konfiguration ist ungültig", "endpoint": "Endpunkt", "model": "Modell", "parameters": "Parameter", "sendTranslation": "Adressbeispiel wird gesendet", "sendChat": "Testnachricht wird gesendet", "timeout": "Zeitüberschreitung", "network": "Netzwerkfehler", "status": "Verbunden", "providerError": "Fehler des Anbieters", "invalidJson": "Antwort ist kein JSON", "respondedModel": "Antwortendes Modell", "finishReason": "Abschlussgrund", "usage": "Token-Verbrauch", "reasoning": "Reasoning-Zeichen", "response": "Antwort", "done": "Test abgeschlossen", "truncated": "Die Ausgabe wurde vor dem Ende des JSON abgeschnitten; erhöhen Sie das Ausgabebudget", "invalidTranslation": "Die Antwort ist nicht das erwartete JSON-Übersetzungsarray", "translations": "Erkannte Übersetzungen", "identifiersChanged": "Das Modell hat Zahlen oder Kennungen verändert"}},
    shortcut: {
      nav: 'Schnellorte', country: 'Land oder Region', customized: 'Angepasst', defaults: 'Standardwerte', specialTitle: 'Titel für Sondergebiete',
      adminAreas: 'Beliebte Verwaltungsgebiete', cities: 'Beliebte Städte', specialAreas: 'Sondergebiete', type: 'Typ', region: 'Region', city: 'Stadt', postcode: 'Postleitzahl',
      choose: 'Suchen und auswählen', selected: '{count} ausgewählt', loading: 'Wird geladen', noOptions: 'Keine Treffer', available: '{count} Adressen',
      save: 'Konfiguration speichern', reset: 'Standard wiederherstellen', saved: 'Schnellorte gespeichert', resetDone: 'Standardkonfiguration wiederhergestellt',
      moveUp: 'Nach oben', moveDown: 'Nach unten', remove: 'Löschen', confirmReset: 'Standard-Schnellorte für dieses Land wiederherstellen?'
    },
    history: {
      nav: 'Sync-Verlauf', title: 'Sync-Verlauf', schedulerActive: 'Scheduler aktiv', schedulerIdle: 'Scheduler inaktiv',
      lastHeartbeat: 'Letzter Heartbeat', country: 'Land oder Region', allCountries: 'Alle Länder', status: 'Status', source: 'Quelle',
      period: 'Zeitraum', duration: 'Dauer', growth: 'Adresszuwachs', trigger: 'Auslöser', details: 'Ergebnis',
      empty: 'Kein Synchronisierungsverlauf', queued: 'In Warteschlange', running: 'Läuft', succeeded: 'Erfolgreich', failed: 'Fehlgeschlagen',
      paused_quota: 'Pausiert (Kontingent)', needs_review: 'Prüfung nötig', cancelled: 'Nicht ausgeführt', previous: 'Zurück', next: 'Weiter',
      candidates: 'Kandidaten', qualityPassed: 'Qualität bestanden', rejected: 'Abgelehnt', coveredNodes: 'Abgedeckte Knoten', qualifiedNodes: 'Qualifizierte Knoten', interrupted: 'Unterbrochen', keptRows: '{count} geprüfte Adressen behalten',
      inProgress: 'Läuft', chinaProviders: 'Kartendienste China',
      phases: { discover: 'Quellensuche', download: 'Download', materialize: 'Datenaufbereitung', import: 'Import', coverage: 'Abdeckungsstatistik', postcode: 'Postleitzahlen-Ableitung', publish: 'Veröffentlichung' },
      errors: { interrupted: 'Durch Neustart oder Deployment unterbrochen; automatisch neu eingereiht', timeout: 'Bearbeitungszeitlimit überschritten', stuck: 'Worker stoppte nach dem Abbruch nicht rechtzeitig', databaseTimeout: 'Datenbankanweisung hat das Zeitlimit überschritten', databaseLock: 'Warten auf Datenbanksperre hat das Zeitlimit überschritten', database: 'Datenbankfehler', quality: 'Qualitätsprüfung nicht bestanden', partial: 'Teilweise abgeschlossen; Fortschritt gespeichert', credential: 'Schlüssel oder Kontingent nicht verfügbar', source: 'Quelle nicht verfügbar oder ungültige Daten', failed: 'Synchronisierung fehlgeschlagen ({code})' }
    }
  },
  fr: {
    ui: {
      operationDone: 'Opération terminée', busy: 'L’action précédente est encore en cours.', testing: 'Test en cours…', confirmTitle: 'Confirmer l’action', confirm: 'Confirmer',
      mapError: 'La carte n’a pas pu être chargée. La liste des données reste disponible.', expandMap: 'Agrandir la carte',
      levelFirst: 'Niveau 1', levelSecond: 'Niveau 2', levelThird: 'Niveau 3',
      defaultPasswordWarning: 'Le mot de passe administrateur par défaut est actif. Modifiez-le avant de continuer.',
      passwordChangeRequired: 'Modifiez le mot de passe par défaut avant d’utiliser les autres fonctions d’administration.',
      addressTotal: 'Adresses valides', residentialShare: 'dont {count} résidentielles', todayGrowth: 'Croissance nette du jour',
      schedulerStale: 'Planificateur sans signal', databaseDown: 'Base de données indisponible',
      filterAll: 'Tous', filterAttention: 'À traiter', filterActive: 'En cours', filterWaiting: 'En attente', filterDone: 'Objectif atteint', filterLimited: 'Limite de source',
      sortLabel: 'Trier les pays', sortDeficit: 'Plus grand écart d’abord', sortName: 'Nom du pays', sortCoverage: 'Couverture la plus faible d’abord',
      queueStale: 'L’instantané de la file de synchronisation est périmé (généré {time}).', queueFresh: 'Instantané de la file {time}', nextRunPending: 'En attente du planificateur',
      rulesColumn: 'Règles d’achèvement', unlimitedQuota: 'Illimité', coverageNodes: '{covered} / {total} nœuds avec adresses', minimumNodes: '{count} nœuds avec ≥{min}', ruleTotal: 'Total', ruleCoverage: 'Couverture', ruleMinimum: 'Minimums', backToList: 'Retour à la liste',
      tabOverview: 'Vue d’ensemble', tabTargets: 'Objectifs', tabNodes: 'Objectifs de nœud', tabSources: 'Sources', tabHistory: 'Historique', tabChina: 'Couverture des districts',
      currentState: 'État actuel', stateReason: 'Détails', notFound: 'Ce pays n’est pas configuré.',
      keyCount: '{count} clés', keyCountOne: '1 clé', eta: 'Estimation', untilRetry: 'nouvel essai dans {time}', listSeparator: ', ',
      seconds: '{s} s', minutes: '{m} min {s} s', hours: '{h} h {m} min', quotaWaitFor: 'En attente de la réinitialisation du quota {provider}'
    },
    model: {
      format: 'Format de requête', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'Index-Translate envoie un seul message user avec l’invite Index et désactive la réflexion ; pour les modèles bilibili Index-Translate et leurs proxys. Cibles anglais et chinois simplifié uniquement.', httpWarning: 'Ce point d’accès utilise HTTP en clair : la clé API et les adresses circulent sans chiffrement.',
      all: 'Afficher tous les modèles', empty: 'Aucun résultat. Vous pouvez saisir directement un identifiant de modèle.', unavailable: 'Chat Completions non pris en charge', count: 'modèles', blocked: 'incompatibles',
      hint: 'Choisissez dans la liste ou saisissez un identifiant de modèle.',
      reasoningUnknown: 'Le point de terminaison n’indique pas de niveaux de raisonnement. Ce projet envoie low par défaut ; ajustez selon la documentation du fournisseur. Il ne s’agit pas de la valeur par défaut du fournisseur.',
      reasoningKnown: 'Les suggestions proviennent des métadonnées API de ce modèle. La valeur saisie est envoyée avec les requêtes.',
      endpointHint: "Saisissez le préfixe du fournisseur (par exemple https://api.example.com ou …/v1) ou l’URL complète /chat/completions. Pour un préfixe sans segment de version, le serveur détecte le chemin de l’API à l’enregistrement (généralement /v1). Seul le format Chat Completions est pris en charge."
    },
    queueStates: { retry_wait: 'En attente d’un nouvel essai', scheduled_wait: 'En attente de la prochaine vérification', suspended: 'Nouveaux essais suspendus', no_source: 'Aucune source exécutable' },
    reasons: {
      missingKey: 'Clé API manquante : {name}', missingChinaKeys: 'Configurez au moins une clé API de carte pour la Chine : {name}',
      keyUnavailable: 'Clé API indisponible ; vérifiez-la dans Clés de carte : {name}', keyExpired: 'Clé API expirée ; mettez-la à jour dans Clés de carte : {name}',
      importingKey: 'Import de la clé API depuis l’environnement : {name}', missingSource: 'Configuration de source manquante : {name}',
      source_limited_cache: 'Toutes les sources ont été importées dans leur version actuelle ; aucune nouvelle donnée exploitable.', source_version_checked: 'Version de la source vérifiée ; aucune mise à jour.', source_growth_step: 'Import par étapes ; la prochaine étape démarre bientôt.',
      retry_suspended: 'Nouveaux essais automatiques suspendus après des échecs répétés.', retry_backoff: 'Attente après un échec avant un nouvel essai.', shared_failure_circuit: 'Suspendu : des sources liées rencontrent la même panne.',
      source_partial_checkpoint: 'Traitement de la source par lots ; en attente du lot suivant.', source_partial_stalled: 'Le traitement par lots n’avance plus ; suspendu.',
      no_source_shard: 'Aucune source utilisable n’est configurée.', cooldown: "Identifiants en temporisation", coverage_sources_exhausted: "Objectif de volume atteint ; les sources disponibles ne peuvent plus améliorer la couverture", validated_sources_exhausted: "Toutes les sources validées ont été utilisées ; aucune nouvelle donnée éligible", credential_broker_unavailable: "Service d’identifiants indisponible", unconfigured: "Aucune clé API cartographique configurée", china_worker: 'Traité par le processus de synchronisation Chine.', quota: 'En attente de la réinitialisation du quota'
    },
    googleQuota: {
      budget: 'Budget mensuel de synchronisation', baseline: 'Usage avant configuration', hint: 'Indiquez l’usage Geocoding déjà consommé ce mois-ci sur le même compte de facturation Google.',
      official: 'Usage gratuit Google : 10 000 événements par mois et par compte de facturation ; la synchronisation automatique en utilise au plus 9 000 par défaut.'
    },
    translationCost: {
      google: 'Cache en priorité ; les services en ligne suivent les priorités configurées ci-dessous. L’usage compatible OpenAI suit la facturation de votre fournisseur ; Google utilise l’interface web sans clé (et non l’API Cloud Translation payante) et peut être limité ou indisponible.',
      youdao: 'Youdao est facturé à l’usage et peut entraîner des frais après épuisement des crédits d’essai, y compris pour les tests et la traduction automatique. Les limites du projet ne garantissent aucun crédit gratuit. N’ajoutez ni n’activez d’identifiants si vous n’acceptez pas ces frais.'
    },
    deepl: {
      notice: 'DeepL API Free uniquement ; aucun passage à Pro. La plus faible valeur entre l’allocation du compte et la limite du projet s’applique. Chaque clé tient son propre registre de caractères. Le bouton de test vérifie l’usage sans traduire.',
      budget: 'Plafond de caractères (période en cours)', characters: 'caractères', provider: 'Compte utilisé / limite', observed: 'Usage vérifié', unknown: 'Usage non vérifié',
      reset: 'DeepL Free n’indique pas de date de réinitialisation ; le décompte repart quand l’usage signalé par DeepL baisse, et les clés épuisées sont revérifiées toutes les heures.', add: 'Ajouter une clé DeepL'
    },
    test: {"title": "Tester la connexion", "mode": "Mode de test", "modeChat": "Connectivité (envoi de « hi »)", "modeTranslate": "Traduction d’adresse", "start": "Test de l’identifiant", "running": "En attente du fournisseur…", "passed": "Test réussi", "failed": "Échec du test", "retry": "Réessayer", "model": "Modèle", "prompt": "Invite", "addressSample": "exemple d’adresse", "endpointProbe": "détecté à l’enregistrement", "endpointPreview": "URL de requête", "restoreDefaultPrompt": "Rétablir l’invite par défaut", "steps": {"invalidConfig": "La configuration enregistrée est invalide", "endpoint": "Point de terminaison", "model": "Modèle", "parameters": "Paramètres", "sendTranslation": "Envoi de l’exemple d’adresse", "sendChat": "Envoi du message de test", "timeout": "Délai dépassé", "network": "Erreur réseau", "status": "Connecté", "providerError": "Erreur du fournisseur", "invalidJson": "La réponse n’est pas du JSON", "respondedModel": "Modèle ayant répondu", "finishReason": "Motif de fin", "usage": "Consommation de jetons", "reasoning": "Caractères de raisonnement", "response": "Réponse", "done": "Test terminé", "truncated": "La sortie a été tronquée avant la fin du JSON ; augmentez le budget de sortie", "invalidTranslation": "La réponse n’est pas le tableau JSON de traductions attendu", "translations": "Traductions analysées", "identifiersChanged": "Le modèle a modifié des nombres ou des identifiants"}},
    shortcut: {
      nav: 'Lieux rapides', country: 'Pays ou région', customized: 'Personnalisé', defaults: 'Valeurs par défaut', specialTitle: 'Titre des zones spéciales',
      adminAreas: 'Zones administratives populaires', cities: 'Villes populaires', specialAreas: 'Zones spéciales', type: 'Type', region: 'Région', city: 'Ville', postcode: 'Code postal',
      choose: 'Rechercher et sélectionner', selected: '{count} sélectionné(s)', loading: 'Chargement', noOptions: 'Aucun résultat', available: '{count} adresses',
      save: 'Enregistrer la configuration', reset: 'Rétablir les valeurs par défaut', saved: 'Lieux rapides enregistrés', resetDone: 'Configuration par défaut rétablie',
      moveUp: 'Monter', moveDown: 'Descendre', remove: 'Supprimer', confirmReset: 'Rétablir les lieux rapides par défaut pour ce pays ?'
    },
    history: {
      nav: 'Historique de synchronisation', title: 'Historique de synchronisation', schedulerActive: 'Planificateur actif', schedulerIdle: 'Planificateur inactif',
      lastHeartbeat: 'Dernier signal', country: 'Pays ou région', allCountries: 'Tous les pays', status: 'État', source: 'Source',
      period: 'Période', duration: 'Durée', growth: 'Croissance des adresses', trigger: 'Déclencheur', details: 'Résultat',
      empty: 'Aucun historique de synchronisation', queued: 'En file', running: 'En cours', succeeded: 'Réussi', failed: 'Échec',
      paused_quota: 'En pause (quota)', needs_review: 'À vérifier', cancelled: 'Non exécuté', previous: 'Précédent', next: 'Suivant',
      candidates: 'Candidats', qualityPassed: 'Qualité validée', rejected: 'Rejetés', coveredNodes: 'Nœuds couverts', qualifiedNodes: 'Nœuds conformes', interrupted: 'Interrompu', keptRows: '{count} adresses validées conservées',
      inProgress: 'En cours', chinaProviders: 'Services cartographiques chinois',
      phases: { discover: 'Découverte de la source', download: 'Téléchargement', materialize: 'Préparation des données', import: 'Import', coverage: 'Statistiques de couverture', postcode: 'Déduction des codes postaux', publish: 'Publication' },
      errors: { interrupted: 'Interrompu par un redémarrage ou un déploiement ; remis en file automatiquement', timeout: 'Durée maximale de traitement dépassée', stuck: 'Le processus ne s’est pas arrêté à temps après l’annulation', databaseTimeout: 'Délai de requête de la base de données dépassé', databaseLock: 'Délai d’attente de verrou de la base de données dépassé', database: 'Erreur de base de données', quality: 'Contrôles qualité non réussis', partial: 'Partiellement terminé ; progression enregistrée', credential: 'Clé ou quota indisponible', source: 'Source indisponible ou données invalides', failed: 'Échec de la synchronisation ({code})' }
    }
  },
  es: {
    ui: {
      operationDone: 'Operación completada', busy: 'La acción anterior sigue en curso.', testing: 'Probando…', confirmTitle: 'Confirmar acción', confirm: 'Confirmar',
      mapError: 'No se pudo cargar el mapa. La lista de datos sigue disponible.', expandMap: 'Ampliar mapa',
      levelFirst: 'Nivel 1', levelSecond: 'Nivel 2', levelThird: 'Nivel 3',
      defaultPasswordWarning: 'La contraseña de administrador predeterminada está activa. Cámbiela antes de continuar.',
      passwordChangeRequired: 'Cambie la contraseña predeterminada antes de usar otras funciones de administración.',
      addressTotal: 'Direcciones válidas', residentialShare: '{count} residenciales', todayGrowth: 'Crecimiento neto de hoy',
      schedulerStale: 'Planificador sin señal', databaseDown: 'Base de datos no disponible',
      filterAll: 'Todos', filterAttention: 'Requiere acción', filterActive: 'En curso', filterWaiting: 'En espera', filterDone: 'Objetivo cumplido', filterLimited: 'Límite de fuente',
      sortLabel: 'Ordenar países', sortDeficit: 'Mayor brecha primero', sortName: 'Nombre del país', sortCoverage: 'Menor cobertura primero',
      queueStale: 'La instantánea de la cola de sincronización está desactualizada (generada {time}).', queueFresh: 'Instantánea de la cola {time}', nextRunPending: 'Esperando al planificador',
      rulesColumn: 'Reglas de finalización', unlimitedQuota: 'Ilimitado', coverageNodes: '{covered} / {total} nodos con direcciones', minimumNodes: '{count} nodos con ≥{min}', ruleTotal: 'Total', ruleCoverage: 'Cobertura', ruleMinimum: 'Mínimos', backToList: 'Volver a la lista',
      tabOverview: 'Resumen', tabTargets: 'Objetivos', tabNodes: 'Objetivos por nodo', tabSources: 'Fuentes', tabHistory: 'Historial', tabChina: 'Cobertura de distritos',
      currentState: 'Estado actual', stateReason: 'Detalles', notFound: 'Este país no está configurado.',
      keyCount: '{count} claves', keyCountOne: '1 clave', eta: 'Estimación', untilRetry: 'reintento en {time}', listSeparator: ', ',
      seconds: '{s} s', minutes: '{m} min {s} s', hours: '{h} h {m} min', quotaWaitFor: 'Esperando el restablecimiento de la cuota de {provider}'
    },
    model: {
      format: 'Formato de solicitud', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'Index-Translate envía un único mensaje user con el prompt de Index y desactiva el razonamiento; para modelos bilibili Index-Translate y sus proxies. Solo destinos inglés y chino simplificado.', httpWarning: 'Este endpoint usa HTTP sin cifrar: la clave API y las direcciones viajan sin cifrado.',
      all: 'Ver todos los modelos', empty: 'Sin coincidencias. Puede escribir directamente un ID de modelo.', unavailable: 'Chat Completions no compatible', count: 'modelos', blocked: 'incompatibles',
      hint: 'Elija de la lista o escriba un ID de modelo.',
      reasoningUnknown: 'El endpoint no indica niveles de razonamiento. Este proyecto envía low al principio; ajústelo según la documentación del proveedor. No es el valor predeterminado del proveedor.',
      reasoningKnown: 'Las sugerencias provienen de los metadatos de la API de este modelo. El valor introducido se envía con las solicitudes.',
      endpointHint: "Introduzca el prefijo del proveedor (por ejemplo https://api.example.com o …/v1) o la URL completa de /chat/completions. Para un prefijo sin segmento de versión, el servidor detecta la ruta de la API al guardar (normalmente /v1). Solo se admite el formato Chat Completions."
    },
    queueStates: { retry_wait: 'Esperando reintento', scheduled_wait: 'Esperando la próxima comprobación', suspended: 'Reintentos suspendidos', no_source: 'Sin fuente ejecutable' },
    reasons: {
      missingKey: 'Falta la clave API: {name}', missingChinaKeys: 'Configure al menos una clave API de mapas de China: {name}',
      keyUnavailable: 'Clave API no disponible; revísela en Claves de mapas: {name}', keyExpired: 'Clave API caducada; actualícela en Claves de mapas: {name}',
      importingKey: 'Importando la clave API desde el entorno: {name}', missingSource: 'Falta la configuración de la fuente: {name}',
      source_limited_cache: 'Todas las fuentes se importaron en su versión actual; no hay datos nuevos que extraer.', source_version_checked: 'Versión de la fuente comprobada; sin actualizaciones.', source_growth_step: 'Importación por pasos; el siguiente paso empieza en breve.',
      retry_suspended: 'Reintentos automáticos suspendidos tras fallos repetidos.', retry_backoff: 'Esperando tras un fallo antes de reintentar.', shared_failure_circuit: 'En pausa porque fuentes relacionadas presentan el mismo fallo.',
      source_partial_checkpoint: 'Procesando la fuente por lotes; esperando el siguiente lote.', source_partial_stalled: 'El procesamiento por lotes no avanza; en pausa.',
      no_source_shard: 'No hay ninguna fuente utilizable configurada.', cooldown: "Credenciales en espera", coverage_sources_exhausted: "Objetivo de cantidad cumplido; las fuentes disponibles no pueden mejorar más la cobertura", validated_sources_exhausted: "Se usaron todas las fuentes validadas; no hay datos nuevos que cumplan", credential_broker_unavailable: "Servicio de credenciales no disponible", unconfigured: "No hay ninguna clave API de mapas configurada", china_worker: 'Lo gestiona el proceso de sincronización de China.', quota: 'Esperando el restablecimiento de la cuota'
    },
    googleQuota: {
      budget: 'Presupuesto mensual de sincronización', baseline: 'Uso previo a la configuración', hint: 'Introduzca el uso de Geocoding ya generado este mes en la misma cuenta de facturación de Google.',
      official: 'Uso gratuito de Google: 10.000 eventos mensuales por cuenta de facturación; la sincronización automática usa como máximo 9.000 por defecto.'
    },
    translationCost: {
      google: 'Primero la caché; los servicios en línea siguen las prioridades configuradas abajo. El uso compatible con OpenAI se factura según su proveedor; Google usa la interfaz web sin clave (no la API de pago Cloud Translation) y puede limitarse o no estar disponible.',
      youdao: 'Youdao se factura por uso y puede cobrar al agotarse los créditos de prueba, incluidas las pruebas y la traducción automática. Los límites del proyecto no garantizan créditos gratuitos. No añada ni active credenciales si no acepta los cargos.'
    },
    deepl: {
      notice: 'Solo DeepL API Free; nunca cambia a Pro. Se aplica el menor entre el cupo de la cuenta y el límite del proyecto. Cada clave lleva su propio registro de caracteres. El botón de prueba consulta el uso sin traducir.',
      budget: 'Límite de caracteres (periodo actual)', characters: 'caracteres', provider: 'Cuenta usada / límite', observed: 'Uso consultado', unknown: 'Uso no consultado',
      reset: 'DeepL Free no indica la fecha de restablecimiento; el recuento se reinicia cuando DeepL informa un uso menor y las claves agotadas se revisan cada hora.', add: 'Añadir clave de DeepL'
    },
    test: {"title": "Probar conexión", "mode": "Modo de prueba", "modeChat": "Conectividad (enviar \"hi\")", "modeTranslate": "Traducción de direcciones", "start": "Probando la credencial", "running": "Esperando al proveedor…", "passed": "Prueba superada", "failed": "Prueba fallida", "retry": "Reintentar", "model": "Modelo", "prompt": "Prompt", "addressSample": "muestra de dirección", "endpointProbe": "se detecta al guardar", "endpointPreview": "URL de solicitud", "restoreDefaultPrompt": "Restablecer prompt predeterminado", "steps": {"invalidConfig": "La configuración guardada no es válida", "endpoint": "Endpoint", "model": "Modelo", "parameters": "Parámetros", "sendTranslation": "Enviando muestra de dirección", "sendChat": "Enviando mensaje de prueba", "timeout": "Tiempo de espera agotado", "network": "Error de red", "status": "Conectado", "providerError": "Error del proveedor", "invalidJson": "La respuesta no es JSON", "respondedModel": "Modelo que respondió", "finishReason": "Motivo de finalización", "usage": "Uso de tokens", "reasoning": "Caracteres de razonamiento", "response": "Respuesta", "done": "Prueba completada", "truncated": "La salida se cortó antes de terminar el JSON; aumente el presupuesto de salida", "invalidTranslation": "La respuesta no es el array JSON de traducciones esperado", "translations": "Traducciones analizadas", "identifiersChanged": "El modelo cambió números o identificadores"}},
    shortcut: {
      nav: 'Ubicaciones rápidas', country: 'País o región', customized: 'Personalizado', defaults: 'Usando valores predeterminados', specialTitle: 'Título de zonas especiales',
      adminAreas: 'Áreas administrativas populares', cities: 'Ciudades populares', specialAreas: 'Zonas especiales', type: 'Tipo', region: 'Región', city: 'Ciudad', postcode: 'Código postal',
      choose: 'Buscar y seleccionar', selected: '{count} seleccionados', loading: 'Cargando', noOptions: 'Sin coincidencias', available: '{count} direcciones',
      save: 'Guardar configuración', reset: 'Restablecer valores predeterminados', saved: 'Ubicaciones rápidas guardadas', resetDone: 'Configuración predeterminada restablecida',
      moveUp: 'Subir', moveDown: 'Bajar', remove: 'Eliminar', confirmReset: '¿Restablecer las ubicaciones rápidas predeterminadas de este país?'
    },
    history: {
      nav: 'Historial de sincronización', title: 'Historial de sincronización', schedulerActive: 'Planificador activo', schedulerIdle: 'Planificador inactivo',
      lastHeartbeat: 'Última señal', country: 'País o región', allCountries: 'Todos los países', status: 'Estado', source: 'Fuente',
      period: 'Periodo', duration: 'Duración', growth: 'Crecimiento de direcciones', trigger: 'Disparador', details: 'Resultado',
      empty: 'Sin historial de sincronización', queued: 'En cola', running: 'En curso', succeeded: 'Completado', failed: 'Fallido',
      paused_quota: 'En pausa por cuota', needs_review: 'Requiere revisión', cancelled: 'No ejecutado', previous: 'Anterior', next: 'Siguiente',
      candidates: 'Candidatos', qualityPassed: 'Calidad superada', rejected: 'Rechazados', coveredNodes: 'Nodos cubiertos', qualifiedNodes: 'Nodos que cumplen', interrupted: 'Interrumpido', keptRows: 'Se conservaron {count} direcciones validadas',
      inProgress: 'En curso', chinaProviders: 'Servicios de mapas de China',
      phases: { discover: 'Descubrimiento de la fuente', download: 'Descarga', materialize: 'Preparación de datos', import: 'Importación', coverage: 'Estadísticas de cobertura', postcode: 'Inferencia de códigos postales', publish: 'Publicación' },
      errors: { interrupted: 'Interrumpido por un reinicio o despliegue; reencolado automáticamente', timeout: 'Se superó el tiempo máximo de procesamiento', stuck: 'El proceso no se detuvo a tiempo tras la cancelación', databaseTimeout: 'Se agotó el tiempo de la consulta a la base de datos', databaseLock: 'Se agotó la espera de bloqueo de la base de datos', database: 'Error de base de datos', quality: 'No superó los controles de calidad', partial: 'Completado parcialmente; progreso guardado', credential: 'Clave o cupo no disponible', source: 'Fuente no disponible o datos no válidos', failed: 'Error de sincronización ({code})' }
    }
  },
  pt: {
    ui: {
      operationDone: 'Operação concluída', busy: 'A ação anterior ainda está em andamento.', testing: 'Testando…', confirmTitle: 'Confirmar ação', confirm: 'Confirmar',
      mapError: 'Não foi possível carregar o mapa. A lista de dados continua disponível.', expandMap: 'Ampliar mapa',
      levelFirst: 'Nível 1', levelSecond: 'Nível 2', levelThird: 'Nível 3',
      defaultPasswordWarning: 'A senha de administrador padrão está ativa. Altere-a antes de continuar.',
      passwordChangeRequired: 'Altere a senha padrão antes de usar outras funções de administração.',
      addressTotal: 'Endereços válidos', residentialShare: '{count} residenciais', todayGrowth: 'Crescimento líquido hoje',
      schedulerStale: 'Agendador sem sinal', databaseDown: 'Banco de dados indisponível',
      filterAll: 'Todos', filterAttention: 'Requer ação', filterActive: 'Em andamento', filterWaiting: 'Aguardando', filterDone: 'Meta atingida', filterLimited: 'Limite da fonte',
      sortLabel: 'Ordenar países', sortDeficit: 'Maior lacuna primeiro', sortName: 'Nome do país', sortCoverage: 'Menor cobertura primeiro',
      queueStale: 'O instantâneo da fila de sincronização está desatualizado (gerado {time}).', queueFresh: 'Instantâneo da fila {time}', nextRunPending: 'Aguardando o agendador',
      rulesColumn: 'Regras de conclusão', unlimitedQuota: 'Ilimitado', coverageNodes: '{covered} / {total} nós com endereços', minimumNodes: '{count} nós com ≥{min}', ruleTotal: 'Total', ruleCoverage: 'Cobertura', ruleMinimum: 'Mínimos', backToList: 'Voltar à lista',
      tabOverview: 'Visão geral', tabTargets: 'Metas', tabNodes: 'Metas por nó', tabSources: 'Fontes', tabHistory: 'Histórico', tabChina: 'Cobertura de distritos',
      currentState: 'Estado atual', stateReason: 'Detalhes', notFound: 'Este país não está configurado.',
      keyCount: '{count} chaves', keyCountOne: '1 chave', eta: 'Estimativa', untilRetry: 'nova tentativa em {time}', listSeparator: ', ',
      seconds: '{s} s', minutes: '{m} min {s} s', hours: '{h} h {m} min', quotaWaitFor: 'Aguardando a redefinição da cota de {provider}'
    },
    model: {
      format: 'Formato da solicitação', formatOpenAI: 'OpenAI Chat Completions', formatIndex: 'Index-Translate', formatHint: 'O Index-Translate envia uma única mensagem user com o prompt do Index e desativa o raciocínio; para modelos bilibili Index-Translate e seus proxies. Apenas inglês e chinês simplificado como destino.', httpWarning: 'Este endpoint usa HTTP sem criptografia: a chave de API e os endereços trafegam sem criptografia.',
      all: 'Mostrar todos os modelos', empty: 'Nenhuma correspondência. Você pode digitar um ID de modelo diretamente.', unavailable: 'Chat Completions não suportado', count: 'modelos', blocked: 'incompatíveis',
      hint: 'Escolha na lista ou digite um ID de modelo.',
      reasoningUnknown: 'O endpoint não informa níveis de raciocínio. Este projeto envia low inicialmente; ajuste conforme a documentação do provedor. Este não é o padrão do provedor.',
      reasoningKnown: 'As sugestões vêm dos metadados da API deste modelo. O valor informado é enviado com as requisições.',
      endpointHint: "Informe o prefixo do provedor (por exemplo https://api.example.com ou …/v1) ou a URL completa de /chat/completions. Para um prefixo sem segmento de versão, o servidor detecta o caminho da API ao salvar (normalmente /v1). Apenas o formato Chat Completions é suportado."
    },
    queueStates: { retry_wait: 'Aguardando nova tentativa', scheduled_wait: 'Aguardando a próxima verificação', suspended: 'Novas tentativas suspensas', no_source: 'Nenhuma fonte executável' },
    reasons: {
      missingKey: 'Chave de API ausente: {name}', missingChinaKeys: 'Configure ao menos uma chave de API de mapas da China: {name}',
      keyUnavailable: 'Chave de API indisponível; verifique em Chaves de mapa: {name}', keyExpired: 'Chave de API expirada; atualize em Chaves de mapa: {name}',
      importingKey: 'Importando a chave de API do ambiente: {name}', missingSource: 'Configuração de fonte ausente: {name}',
      source_limited_cache: 'Todas as fontes foram importadas na versão atual; não há novos dados extraíveis.', source_version_checked: 'Versão da fonte verificada; sem atualizações.', source_growth_step: 'Importação por passos; o próximo passo começa em breve.',
      retry_suspended: 'Novas tentativas automáticas suspensas após falhas repetidas.', retry_backoff: 'Aguardando após uma falha antes de tentar novamente.', shared_failure_circuit: 'Pausado porque fontes relacionadas apresentaram a mesma falha.',
      source_partial_checkpoint: 'Processando a fonte em lotes; aguardando o próximo lote.', source_partial_stalled: 'O processamento em lotes não avança; pausado.',
      no_source_shard: 'Nenhuma fonte utilizável configurada.', cooldown: "Credenciais em espera", coverage_sources_exhausted: "Meta de quantidade atingida; as fontes disponíveis não melhoram mais a cobertura", validated_sources_exhausted: "Todas as fontes validadas foram usadas; não há novos dados elegíveis", credential_broker_unavailable: "Serviço de credenciais indisponível", unconfigured: "Nenhuma chave de API de mapas configurada", china_worker: 'Tratado pelo processo de sincronização da China.', quota: 'Aguardando a redefinição da cota'
    },
    googleQuota: {
      budget: 'Orçamento mensal de sincronização', baseline: 'Uso antes da configuração', hint: 'Informe o uso de Geocoding já gerado neste mês na mesma conta de faturamento do Google.',
      official: 'Uso gratuito do Google: 10.000 eventos mensais por conta de faturamento; a sincronização automática usa no máximo 9.000 por padrão.'
    },
    translationCost: {
      google: 'Cache primeiro; os serviços online seguem as prioridades configuradas abaixo. O uso compatível com OpenAI segue o faturamento do seu provedor; o Google usa a interface web sem chave (não a API paga Cloud Translation) e pode ser limitado ou ficar indisponível.',
      youdao: 'O Youdao é cobrado por uso e pode gerar cobranças após o fim dos créditos de teste, inclusive em testes e tradução automática. Os limites do projeto não garantem créditos gratuitos. Não adicione nem ative credenciais se não aceitar as cobranças.'
    },
    deepl: {
      notice: 'Apenas DeepL API Free; nunca muda para Pro. Vale o menor entre a franquia da conta e o limite do projeto. Cada chave mantém seu próprio registro de caracteres. O botão de teste consulta o uso sem traduzir.',
      budget: 'Limite de caracteres (período atual)', characters: 'caracteres', provider: 'Conta usada / limite', observed: 'Uso consultado', unknown: 'Uso não consultado',
      reset: 'O DeepL Free não informa a data de redefinição; a contagem recomeça quando o DeepL informa um uso menor e as chaves esgotadas são verificadas a cada hora.', add: 'Adicionar chave DeepL'
    },
    test: {"title": "Testar conexão", "mode": "Modo de teste", "modeChat": "Conectividade (enviar \"hi\")", "modeTranslate": "Tradução de endereços", "start": "Testando a credencial", "running": "Aguardando o provedor…", "passed": "Teste aprovado", "failed": "Teste falhou", "retry": "Tentar novamente", "model": "Modelo", "prompt": "Prompt", "addressSample": "amostra de endereço", "endpointProbe": "detectado ao salvar", "endpointPreview": "URL da requisição", "restoreDefaultPrompt": "Restaurar prompt padrão", "steps": {"invalidConfig": "A configuração salva é inválida", "endpoint": "Endpoint", "model": "Modelo", "parameters": "Parâmetros", "sendTranslation": "Enviando amostra de endereço", "sendChat": "Enviando mensagem de teste", "timeout": "Tempo esgotado", "network": "Erro de rede", "status": "Conectado", "providerError": "Erro do provedor", "invalidJson": "A resposta não é JSON", "respondedModel": "Modelo que respondeu", "finishReason": "Motivo de término", "usage": "Uso de tokens", "reasoning": "Caracteres de raciocínio", "response": "Resposta", "done": "Teste concluído", "truncated": "A saída foi cortada antes do fim do JSON; aumente o orçamento de saída", "invalidTranslation": "A resposta não é o array JSON de traduções esperado", "translations": "Traduções analisadas", "identifiersChanged": "O modelo alterou números ou identificadores"}},
    shortcut: {
      nav: 'Locais rápidos', country: 'País ou região', customized: 'Personalizado', defaults: 'Usando padrões', specialTitle: 'Título das áreas especiais',
      adminAreas: 'Áreas administrativas populares', cities: 'Cidades populares', specialAreas: 'Áreas especiais', type: 'Tipo', region: 'Região', city: 'Cidade', postcode: 'Código postal',
      choose: 'Pesquisar e selecionar', selected: '{count} selecionados', loading: 'Carregando', noOptions: 'Nenhuma correspondência', available: '{count} endereços',
      save: 'Salvar configuração', reset: 'Restaurar padrões', saved: 'Locais rápidos salvos', resetDone: 'Configuração padrão restaurada',
      moveUp: 'Mover para cima', moveDown: 'Mover para baixo', remove: 'Excluir', confirmReset: 'Restaurar os locais rápidos padrão deste país?'
    },
    history: {
      nav: 'Histórico de sincronização', title: 'Histórico de sincronização', schedulerActive: 'Agendador ativo', schedulerIdle: 'Agendador ocioso',
      lastHeartbeat: 'Último sinal', country: 'País ou região', allCountries: 'Todos os países', status: 'Estado', source: 'Fonte',
      period: 'Período', duration: 'Duração', growth: 'Crescimento de endereços', trigger: 'Gatilho', details: 'Resultado',
      empty: 'Sem histórico de sincronização', queued: 'Na fila', running: 'Em execução', succeeded: 'Concluído', failed: 'Falhou',
      paused_quota: 'Pausado por cota', needs_review: 'Requer revisão', cancelled: 'Não executado', previous: 'Anterior', next: 'Próximo',
      candidates: 'Candidatos', qualityPassed: 'Qualidade aprovada', rejected: 'Rejeitados', coveredNodes: 'Nós cobertos', qualifiedNodes: 'Nós qualificados', interrupted: 'Interrompido', keptRows: '{count} endereços validados mantidos',
      inProgress: 'Em andamento', chinaProviders: 'Serviços de mapas da China',
      phases: { discover: 'Descoberta da fonte', download: 'Download', materialize: 'Preparação dos dados', import: 'Importação', coverage: 'Estatísticas de cobertura', postcode: 'Inferência de CEP', publish: 'Publicação' },
      errors: { interrupted: 'Interrompido por reinício ou implantação; recolocado na fila automaticamente', timeout: 'Tempo máximo de processamento excedido', stuck: 'O processo não parou a tempo após o cancelamento', databaseTimeout: 'Tempo da consulta ao banco de dados esgotado', databaseLock: 'Tempo de espera de bloqueio do banco de dados esgotado', database: 'Erro de banco de dados', quality: 'Não passou nos controles de qualidade', partial: 'Concluído parcialmente; progresso salvo', credential: 'Chave ou cota indisponível', source: 'Fonte indisponível ou dados inválidos', failed: 'Falha na sincronização ({code})' }
    }
  }
};
