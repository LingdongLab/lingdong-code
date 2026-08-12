/**
 * 统一设置页的消息协议。
 *
 * 这一页把原先散落的三处入口合成一处：模型设置面板、Agent 能力面板、
 * 以及 VS Code 原生设置editor 里的 `lingdongAgent.*`。协议因此是三段拼起来的：
 *
 * - 模型段与能力段**原样复用**已有的两套联合类型与它们的校验函数。
 *   那两套校验管着凭据写入与外部网络请求，重写一遍只会凭空多出一份风险。
 * - 新增的配置段走一张规格表 SETTING_SPECS：宿主拿它做取值校验，
 *   界面拿它渲染标签与说明。两边同源，改一处就够。
 *
 * 出站方向仍然永远不含真实 Key —— 这条性质由复用的模型段协议本身保证。
 */

import {
  parseExtensionsMessage,
  type ExtensionsHostMessage,
  type ExtensionsWebviewMessage,
} from "./extensions-messages";
import {
  parseModelSettingsMessage,
  type ModelSettingsHostMessage,
  type ModelSettingsWebviewMessage,
} from "./model-settings-messages";

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

export const SETTINGS_CATEGORIES = [
  "general",
  "models",
  "agent",
  "capabilities",
  "rules",
  "privacy",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<SettingsCategory, string> = {
  general: "通用",
  models: "模型",
  agent: "Agent 行为",
  capabilities: "能力扩展",
  rules: "规则与记忆",
  privacy: "隐私与安全",
};

export function isSettingsCategory(value: unknown): value is SettingsCategory {
  return typeof value === "string"
    && (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 配置段：规格表
// ---------------------------------------------------------------------------

export type SettingValue = boolean | number | string | readonly string[];

interface SpecBase {
  category: SettingsCategory;
  label: string;
  /** 一句话说明，直接显示在标题下面。长背景放 detail。 */
  description: string;
  /** 需要展开才看的补充说明；界面折叠显示。 */
  detail?: string;
}

export type SettingSpec =
  | (SpecBase & { kind: "boolean"; fallback: boolean })
  | (SpecBase & { kind: "text"; fallback: string; placeholder?: string })
  | (SpecBase & {
    kind: "number";
    fallback: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
    /**
     * 展示值 = 存储值 / scale。毫秒这种单位直接摆给用户看没法读，
     * 但换算只发生在界面层，存进设置里的仍然是原单位。
     */
    scale?: number;
  })
  | (SpecBase & {
    kind: "select";
    fallback: string;
    /** 选项各自带说明时用卡片更好读；只是换个写法的用下拉。 */
    display?: "dropdown" | "cards";
    options: readonly { value: string; label: string; description?: string }[];
  })
  | (SpecBase & { kind: "stringList"; fallback: readonly string[]; placeholder?: string });

/**
 * 界面上可编辑的 `lingdongAgent.*` 设置。
 *
 * 刻意不含 `lingdongAgent.model`：当前模型由模型页的「设为当前」写入，
 * 在这里再放一个自由文本框，只会让两个入口互相覆盖。
 *
 * 先用 `as const` 拿到字面量键名，再在下面收窄成 `Record<SettingKey, SettingSpec>`：
 * 键名要精确（决定 SettingKey），取值却要按 SettingSpec 看，
 * 否则 TS 会把每条各自的字面量类型当真，`spec.detail` 这种可选字段在
 * 「刚好这一条没写」的分支上就不存在了。
 */
const SPEC_TABLE = {
  windowShape: {
    category: "general",
    kind: "select",
    fallback: "agent",
    display: "cards",
    label: "窗口形态",
    description: "决定是否保留 VS Code 的活动栏与资源管理器。",
    options: [
      { value: "agent", label: "只留对话", description: "收起活动栏与主侧边栏，主面板占满编辑区。" },
      { value: "ide", label: "完整编辑器", description: "显示活动栏与资源管理器，和普通 VS Code 一样。" },
    ],
  },
  streamEditPreview: {
    category: "general",
    kind: "select",
    fallback: "off",
    label: "编辑实时预览",
    description: "Agent 改文件时要不要自动在编辑器里打开。",
    detail: "默认关闭：Agent 一轮能改十几个文件，自动开标签会不停顶掉你正在看的东西。"
      + "改动在会话流的变更摘要卡与「变更」面板里事后看更省心。"
      + "开启后预览标签都是临时标签且不抢焦点；前后全文合计超过 512 KB 时自动退回只揭示文件。",
    options: [
      { value: "off", label: "不打开", description: "改动只在「变更」面板里事后查看。" },
      { value: "diff", label: "并排 diff", description: "一改就并排显示改前/改后，落盘后右侧切换为真实文件。" },
      { value: "reveal", label: "只揭示文件", description: "把正在改的文件揭示到编辑器，不开 diff 视图。" },
    ],
  },
  showReasoning: {
    category: "general",
    kind: "boolean",
    fallback: true,
    label: "显示推理原文",
    description: "在「思考」折叠块里给出模型的推理原文。",
    detail: "原文只从内存直达界面：不写入会话记录、不进任务时间线、不落磁盘，重开面板即消失。"
      + "关闭后只保留脱敏后的阶段文案（如「正在阅读文件内容」）。",
  },
  grokExecutable: {
    category: "general",
    kind: "text",
    fallback: "",
    label: "Grok 可执行文件",
    description: "留空则自动探测（环境变量 → PATH → 常见安装位置）。",
    placeholder: "留空自动探测",
  },
  sanitizeUpstreamResponses: {
    category: "models",
    kind: "boolean",
    fallback: true,
    label: "修补上游响应",
    description: "通过本地回环转发模型响应，修补服务商在 usage 里返回的 null 计数。",
    detail: "部分模型（如 Poe 上的 kimi-k3）会因为这个 null 让 Grok 整轮解析失败、一个字都返回不了。"
      + "转发层不持有也不注入任何凭据，Authorization 原样透传。关闭后恢复直连服务商。",
  },
  approvalPolicy: {
    category: "agent",
    kind: "select",
    fallback: "balanced",
    display: "cards",
    label: "审批力度",
    description: "Agent 模式下哪些操作可以不问就做。",
    detail: "任何力度都不会放行越界访问、凭据读取与硬性禁止的命令；"
      + "每笔文件改动仍有修改前快照，可从「变更」面板撤销。",
    options: [
      {
        value: "balanced",
        label: "均衡",
        description: "工作区内的改动、构建/测试命令与 git 提交自动放行；删除、push、装依赖、访问网络仍逐项确认。",
      },
      {
        value: "strict",
        label: "严格",
        description: "只自动放行只读操作，其余每一项都要确认。弹窗最多，但改动前一定经过你。",
      },
      {
        value: "yolo",
        label: "放行",
        description: "除硬性禁止项（提权、注册表、格式化、系统级安装、强制推送）之外全部放行。",
      },
    ],
  },
  permissionTimeoutMs: {
    category: "agent",
    kind: "number",
    fallback: 300_000,
    min: 10_000,
    max: 3_600_000,
    step: 10_000,
    scale: 1_000,
    unit: "秒",
    label: "权限卡超时",
    description: "权限卡片等人工决定的时间，超时自动拒绝并标为失效。",
  },
  verifyAfterEdit: {
    category: "agent",
    kind: "boolean",
    fallback: true,
    label: "改完自动校验",
    description: "Agent 改完文件准备收尾时，跑一次项目自己声明的校验命令。",
    detail: "跑的是 package.json 里的 typecheck / type-check / lint，或有 tsconfig.json 时的 tsc --noEmit。"
      + "失败会把错误回灌给 Agent 让它在同一轮里继续修，一轮最多拦两次。项目没有声明这些脚本时不做任何事。",
  },
  planStepGating: {
    category: "agent",
    kind: "boolean",
    fallback: true,
    label: "计划逐步下发",
    description: "批准计划后一轮只做一步，做完记上进度再发下一步。",
    detail: "中途失败或被停就停在当前步骤并把计划置为暂停。关闭后退回把整份计划一次性发给 Agent，由它自己决定节奏。",
  },
  webFetch: {
    category: "agent",
    kind: "boolean",
    fallback: false,
    label: "Grok 自带 web_fetch",
    description: "通常不需要开启：内置的 lingdong_web 已经提供 WebSearch 与 WebFetch。",
    detail: "此项开启的是 Grok 自带的 web_fetch，与内置 WebFetch 功能重叠，"
      + "开启后模型手上会多一个同类工具、用哪个变得不稳定。"
      + "真正值得开的只有一种场景：出网必须经过代理——Grok 自带版支持代理（环境变量 GROK_WEB_FETCH_PROXY），内置版不支持。",
  },
  webFetchDomains: {
    category: "agent",
    kind: "stringList",
    fallback: [],
    label: "web_fetch 域名白名单",
    description: "仅对上面的 Grok 自带 web_fetch 生效，对内置 WebFetch 没有影响。",
    detail: "域名含子域、大小写不敏感。非空时抓取只允许命中这些域名并免二次确认；留空则沿用 Grok 内置默认白名单。",
    placeholder: "例如 docs.rs",
  },
  memory: {
    category: "rules",
    kind: "boolean",
    fallback: false,
    label: "跨会话记忆",
    description: "让 Grok 把项目约定与结论写成本机文件，并在新会话首轮带回。",
    detail: "Grok 官方标为实验性。默认关闭：这会把对话里的结论长期留在磁盘上。改动在新一轮对话生效。",
  },
  managedGrokHome: {
    category: "privacy",
    kind: "boolean",
    fallback: true,
    label: "托管 GROK_HOME",
    description: "由灵动 Code 生成 config.toml，强制关闭遥测、Trace 上传、自动更新与远程目录抓取。",
    detail: "原 GROK_HOME 只读不改。关闭后沿用探测到的目录，上面那些开关将无法保证。",
  },
  grokHome: {
    category: "privacy",
    kind: "text",
    fallback: "",
    label: "GROK_HOME 目录",
    description: "填写后优先级高于托管目录；留空走自动探测。",
    placeholder: "留空自动探测",
  },
  snapshotRetentionDays: {
    category: "privacy",
    kind: "number",
    fallback: 30,
    min: 1,
    max: 365,
    step: 1,
    unit: "天",
    label: "快照保留天数",
    description: "已接受或已恢复的快照保留多久。未处理与冲突的快照永不自动删除。",
  },
  snapshotMaxTotalMb: {
    category: "privacy",
    kind: "number",
    fallback: 512,
    min: 16,
    max: 20_480,
    step: 16,
    unit: "MB",
    label: "快照总量上限",
    description: "超限时优先清理最旧的已接受/已恢复快照。",
  },
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SPEC_TABLE;

export const SETTING_SPECS: Record<SettingKey, SettingSpec> = SPEC_TABLE;

export const SETTING_KEYS = Object.keys(SPEC_TABLE) as SettingKey[];

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && Object.hasOwn(SPEC_TABLE, value);
}

/** 当前取值快照；缺键由界面回落到 spec.fallback。 */
export type SettingsConfigView = Partial<Record<SettingKey, SettingValue>>;

/**
 * 按 spec 收敛一个来自界面的取值。
 *
 * 返回 undefined 表示这条消息该整条丢弃，而不是「用默认值凑合写进去」——
 * 界面发来越界的数字多半意味着有别的地方出了错，静默改写只会把问题藏起来。
 */
export function coerceSettingValue(key: SettingKey, raw: unknown): SettingValue | undefined {
  const spec: SettingSpec = SETTING_SPECS[key];
  switch (spec.kind) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "text": {
      if (typeof raw !== "string") return undefined;
      // 控制字符会破坏路径与配置文件，直接剔掉。
      // eslint-disable-next-line no-control-regex
      const text = raw.replace(/[\u0000-\u001f]/g, "").trim();
      return text.length <= 4_096 ? text : undefined;
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      const value = Math.trunc(raw);
      return value >= spec.min && value <= spec.max ? value : undefined;
    }
    case "select":
      return spec.options.some((option) => option.value === raw) ? (raw as string) : undefined;
    case "stringList": {
      if (!Array.isArray(raw)) return undefined;
      if (raw.length > 128) return undefined;
      const items: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== "string") return undefined;
        const trimmed = entry.trim();
        if (trimmed.length === 0) continue;
        if (trimmed.length > 253) return undefined;
        if (!items.includes(trimmed)) items.push(trimmed);
      }
      return items;
    }
  }
}

// ---------------------------------------------------------------------------
// 新增段：权限规则与隐私画像
// ---------------------------------------------------------------------------

export type PermissionRuleKind = "workspace-write" | "command-prefix" | "read-path";

export const PERMISSION_RULE_KIND_LABEL: Record<PermissionRuleKind, string> = {
  "workspace-write": "写入工作区",
  "command-prefix": "执行命令",
  "read-path": "读取路径",
};

export interface PermissionRuleView {
  /** kind 与 value 合起来就是仓库里的去重键，直接拿来定位要删的那条。 */
  id: string;
  kind: PermissionRuleKind;
  kindLabel: string;
  value: string;
  label: string;
}

export function permissionRuleId(kind: string, value: string): string {
  return `${kind}\u0000${value}`;
}

export type PrivacyTone = "ok" | "warn" | "unknown";

export interface PrivacyRowView {
  label: string;
  value: string;
  tone?: PrivacyTone;
}

export interface PrivacySectionView {
  title: string;
  rows: PrivacyRowView[];
  note?: string;
}

// ---------------------------------------------------------------------------
// 出站
// ---------------------------------------------------------------------------

export type SettingsOwnHostMessage =
  | { type: "config"; config: SettingsConfigView }
  | { type: "permissionRules"; rules: PermissionRuleView[] }
  | { type: "privacy"; sections: PrivacySectionView[] }
  | { type: "memoryDirectory"; directory: string }
  /** 从「打开模型设置」这类具体入口进来时，直接落到对应分类。 */
  | { type: "navigate"; category: SettingsCategory };

export type SettingsHostMessage =
  | ModelSettingsHostMessage
  | ExtensionsHostMessage
  | SettingsOwnHostMessage;

// ---------------------------------------------------------------------------
// 入站
// ---------------------------------------------------------------------------

export type SettingsOwnWebviewMessage =
  | { type: "updateSetting"; key: SettingKey; value: SettingValue }
  | { type: "resetSetting"; key: SettingKey }
  | { type: "pickGrokExecutable" }
  | { type: "removePermissionRule"; id: string }
  | { type: "clearPermissionRules" }
  | { type: "openDiagnostics" };

export type SettingsWebviewMessage =
  | ModelSettingsWebviewMessage
  | ExtensionsWebviewMessage
  | SettingsOwnWebviewMessage;

/**
 * 三段共有的消息类型。
 *
 * `ready` / `refresh` / `backToAgent` 在两套旧协议里形状完全相同，
 * 谁先解析都一样；但**路由**必须由面板统一处理（刷新要刷三段），
 * 所以这里把它们单列出来，不让它们落进任何一段的服务里。
 */
export const SHARED_MESSAGE_TYPES = ["ready", "refresh", "backToAgent"] as const;

/** 只属于模型段的入站类型；面板据此把消息转给 ModelSettingsService。 */
export const MODEL_MESSAGE_TYPES = [
  "saveKey",
  "deleteKey",
  "setProviderEnabled",
  "deleteProvider",
  "addBuiltinProvider",
  "addCustomProvider",
  "syncCatalog",
  "checkBalance",
  "addModel",
  "testModel",
  "setModelEnabled",
  "setModelVision",
  "renameModel",
  "deleteModel",
  "openPrivacyStatus",
] as const;

/** 只属于能力段的入站类型；面板据此把消息转给 ExtensionsService。 */
export const EXTENSIONS_MESSAGE_TYPES = [
  "installSkillFromFolder",
  "installSkillFromZip",
  "removeSkill",
  "setSkillEnabled",
  "openSkillFolder",
  "upsertMcp",
  "setMcpEnabled",
  "removeMcp",
  "openRuleFile",
  "createProjectAgents",
  "createRule",
  "setLspEnabled",
  "setMemoryEnabled",
] as const;

const MODEL_TYPES: ReadonlySet<string> = new Set(MODEL_MESSAGE_TYPES);
const EXTENSIONS_TYPES: ReadonlySet<string> = new Set(EXTENSIONS_MESSAGE_TYPES);

export function isModelSettingsMessage(
  message: SettingsWebviewMessage,
): message is ModelSettingsWebviewMessage {
  return MODEL_TYPES.has(message.type);
}

export function isExtensionsMessage(
  message: SettingsWebviewMessage,
): message is ExtensionsWebviewMessage {
  return EXTENSIONS_TYPES.has(message.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验来自设置页的入站消息。
 *
 * 分段委派：模型段与能力段交回它们自己的校验函数，本文件只负责新增的配置段。
 * 委派前先按类型表分流，避免两套校验器争抢同名类型——
 * 现在只有 ready/refresh/backToAgent 同名，且它们在这里就地返回，压根到不了委派。
 */
export function parseSettingsMessage(raw: unknown): SettingsWebviewMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;

  switch (raw.type) {
    case "ready":
    case "refresh":
    case "backToAgent":
    case "pickGrokExecutable":
    case "clearPermissionRules":
    case "openDiagnostics":
      return { type: raw.type };

    case "updateSetting": {
      if (!isSettingKey(raw.key)) return undefined;
      const value = coerceSettingValue(raw.key, raw.value);
      if (value === undefined) return undefined;
      return { type: "updateSetting", key: raw.key, value };
    }

    case "resetSetting": {
      if (!isSettingKey(raw.key)) return undefined;
      return { type: "resetSetting", key: raw.key };
    }

    case "removePermissionRule": {
      if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 4_096) {
        return undefined;
      }
      // id 必须是 permissionRuleId 造出来的形状：kind\0value。
      const separator = raw.id.indexOf("\u0000");
      if (separator <= 0 || separator === raw.id.length - 1) return undefined;
      return { type: "removePermissionRule", id: raw.id };
    }

    default:
      break;
  }

  if (MODEL_TYPES.has(raw.type)) return parseModelSettingsMessage(raw);
  if (EXTENSIONS_TYPES.has(raw.type)) return parseExtensionsMessage(raw);
  return undefined;
}
