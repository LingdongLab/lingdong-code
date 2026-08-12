import * as vscode from "vscode";
import {
  PERMISSION_RULE_KIND_LABEL,
  SETTING_KEYS,
  SETTING_SPECS,
  permissionRuleId,
  type PermissionRuleKind,
  type PermissionRuleView,
  type PrivacySectionView,
  type SettingKey,
  type SettingValue,
  type SettingsConfigView,
  type SettingsHostMessage,
  type SettingsOwnWebviewMessage,
} from "../settings-messages";
import type { PrivacyStatusInput } from "../privacy/privacy-status";

/**
 * 设置页里「不属于模型段、也不属于能力段」的那部分：
 * `lingdongAgent.*` 取值读写、已记住的权限规则、隐私画像。
 *
 * 取值一律写到 Global 作用域。设置页是全局入口，写进工作区会造成
 * 「换个仓库开关就变了」这种没人预期的行为；真要按仓库区分，
 * VS Code 原生设置页仍然改得动同一批键。
 */

export interface PermissionRulesPort {
  list(): readonly { kind: string; value: string; label: string }[];
  remove(kind: string, value: string): Promise<boolean>;
  clear(): Promise<void>;
  readonly size: number;
}

export interface SettingsServiceDeps {
  /** 确保存储已就绪；权限规则要等它读完才有内容。 */
  ensureStorage(): Promise<void>;
  permissionRules(): PermissionRulesPort | undefined;
  /** 清空/删除规则后同步在跑的 Runtime，否则本轮仍按旧规则放行。 */
  clearRuntimeSessionRules(): void;
  privacyInput(): Promise<PrivacyStatusInput>;
  memoryDirectory(): string;
  log(line: string): void;
}

type Poster = (message: SettingsHostMessage) => void;

export class SettingsService {
  private poster: Poster | undefined;

  constructor(private readonly deps: SettingsServiceDeps) {}

  setPoster(poster: Poster | undefined): void {
    this.poster = poster;
  }

  async handle(message: SettingsOwnWebviewMessage): Promise<void> {
    switch (message.type) {
      case "updateSetting":
        await this.update(message.key, message.value);
        return;
      case "resetSetting":
        await this.update(message.key, undefined);
        return;
      case "pickGrokExecutable":
        await this.pickExecutable();
        return;
      case "removePermissionRule":
        await this.removeRule(message.id);
        return;
      case "clearPermissionRules":
        await this.clearRules();
        return;
      case "openDiagnostics":
        await vscode.commands.executeCommand("lingdongAgent.showAgentDiagnostics");
        return;
    }
  }

  /** 三段推送里属于本服务的那部分。 */
  async publish(): Promise<void> {
    this.post({ type: "config", config: readConfig() });
    this.post({ type: "memoryDirectory", directory: this.deps.memoryDirectory() });
    await this.publishPermissionRules();
    await this.publishPrivacy();
  }

  async publishPermissionRules(): Promise<void> {
    await this.deps.ensureStorage();
    const port = this.deps.permissionRules();
    const rules: PermissionRuleView[] = (port?.list() ?? [])
      .filter((rule): rule is { kind: PermissionRuleKind; value: string; label: string } =>
        Object.hasOwn(PERMISSION_RULE_KIND_LABEL, rule.kind))
      .map((rule) => ({
        id: permissionRuleId(rule.kind, rule.value),
        kind: rule.kind,
        kindLabel: PERMISSION_RULE_KIND_LABEL[rule.kind],
        value: rule.value,
        label: rule.label,
      }));
    this.post({ type: "permissionRules", rules });
  }

  async publishPrivacy(): Promise<void> {
    const input = await this.deps.privacyInput();
    this.post({ type: "privacy", sections: privacySections(input) });
  }

  private async update(key: SettingKey, value: SettingValue | undefined): Promise<void> {
    const config = vscode.workspace.getConfiguration("lingdongAgent");
    // stringList 是只读数组，update 需要可变副本。
    const payload = Array.isArray(value) ? [...value] : value;
    await config.update(key, payload, vscode.ConfigurationTarget.Global);
    this.deps.log(`[settings] ${key} = ${describe(payload)}`);
    this.post({ type: "config", config: readConfig() });
  }

  private async pickExecutable(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "选择 Grok 可执行文件",
      // 只有 Windows 有稳定的可执行后缀可筛；别的平台给了反而会把无后缀的二进制挡在外面。
      ...(process.platform === "win32" ? { filters: { "可执行文件": ["exe"] } } : {}),
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    await this.update("grokExecutable", file);
    this.post({
      type: "notice",
      level: "info",
      message: "已更新可执行文件路径，重连后生效。",
    });
  }

  private async removeRule(id: string): Promise<void> {
    await this.deps.ensureStorage();
    const port = this.deps.permissionRules();
    if (!port) return;
    const separator = id.indexOf("\u0000");
    const kind = id.slice(0, separator);
    const value = id.slice(separator + 1);
    const removed = await port.remove(kind, value);
    if (!removed) {
      await this.publishPermissionRules();
      return;
    }
    // 内存里的会话规则是判定链的真相，磁盘删了不同步等于没删。
    this.deps.clearRuntimeSessionRules();
    this.post({ type: "notice", level: "info", message: "已删除该规则，下次会重新询问。" });
    await this.publishPermissionRules();
  }

  private async clearRules(): Promise<void> {
    await this.deps.ensureStorage();
    const port = this.deps.permissionRules();
    if (!port || port.size === 0) {
      this.post({ type: "notice", level: "info", message: "当前工作区没有已记住的权限规则。" });
      return;
    }
    const count = port.size;
    await port.clear();
    this.deps.clearRuntimeSessionRules();
    this.post({ type: "notice", level: "info", message: `已清空 ${count} 条权限规则，下次会重新询问。` });
    await this.publishPermissionRules();
  }

  private post(message: SettingsHostMessage): void {
    this.poster?.(message);
  }
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return String(value);
}

/** 读一份当前取值；缺项交给界面回落到 spec.fallback，不在这里补默认值。 */
export function readConfig(): SettingsConfigView {
  const config = vscode.workspace.getConfiguration("lingdongAgent");
  const view: SettingsConfigView = {};
  for (const key of SETTING_KEYS) {
    const spec = SETTING_SPECS[key];
    const value = config.get<unknown>(key);
    if (value === undefined) continue;
    switch (spec.kind) {
      case "boolean":
        if (typeof value === "boolean") view[key] = value;
        break;
      case "number":
        if (typeof value === "number" && Number.isFinite(value)) view[key] = value;
        break;
      case "text":
      case "select":
        if (typeof value === "string") view[key] = value;
        break;
      case "stringList":
        if (Array.isArray(value)) {
          view[key] = value.filter((entry): entry is string => typeof entry === "string");
        }
        break;
    }
  }
  return view;
}

function onOff(enabled: boolean): string {
  return enabled ? "已开启" : "已关闭";
}

/** 关掉才是我们想要的通道：开着就标 warn，让它在界面上显眼。 */
function offIsGood(enabled: boolean) {
  return { value: onOff(enabled), tone: enabled ? ("warn" as const) : ("ok" as const) };
}

/**
 * 隐私画像的结构化版本。
 *
 * 与 renderPrivacyStatus 的 Markdown 文档同源同措辞：那份文档仍然保留
 * （可复制、可贴进工单），这里只是把同样的事实摆进设置页，省掉一次跳转。
 */
export function privacySections(input: PrivacyStatusInput): PrivacySectionView[] {
  const sections: PrivacySectionView[] = [];
  const profile = input.profile;

  sections.push({
    title: "当前模型",
    rows: profile
      ? [
        { label: "服务商", value: profile.providerName },
        { label: "模型", value: `${profile.modelName}（${profile.modelId}）` },
        { label: "请求域名", value: profile.baseUrlHost },
        { label: "请求协议", value: profile.protocol },
        { label: "凭据环境变量", value: `${profile.envKeyName}（值不显示）` },
        { label: "连接时间", value: new Date(profile.startedAt).toLocaleString() },
      ]
      : [],
    ...(profile
      ? {}
      : { note: "尚未连接 Grok，本次会话还没有产生真实的运行画像。下面的通道状态要连上以后才反映实际配置。" }),
  });

  const channelRows: PrivacySectionView["rows"] = [];
  if (profile) {
    const channels = profile.channels;
    channelRows.push(
      { label: "遥测", ...offIsGood(channels.telemetry) },
      { label: "Trace 上传", ...offIsGood(channels.traceUpload) },
      { label: "Mixpanel", ...offIsGood(channels.mixpanel) },
      { label: "外部 OTEL", ...offIsGood(channels.externalOtel) },
      { label: "Feedback", ...offIsGood(channels.feedback) },
      { label: "自动更新", ...offIsGood(channels.autoUpdate) },
      { label: "远程目录抓取", ...offIsGood(channels.remoteFetch) },
      { label: "Grok 自带 web_fetch", ...offIsGood(channels.webFetch) },
    );
  } else {
    channelRows.push({ label: "运行状态", value: "未连接，无法读取实际通道状态", tone: "unknown" });
  }
  if (input.managedHome) {
    channelRows.push(
      { label: "内置 backend Web Search", value: "已关闭（deny WebSearch；第三方模型不支持）", tone: "ok" },
      { label: "宿主侧 Web Search", value: "已开启（MCP lingdong_web → DuckDuckGo）", tone: "ok" },
      { label: "宿主侧 Web Fetch", value: "已开启（MCP lingdong_web，读正文走宿主）", tone: "ok" },
    );
  } else {
    channelRows.push({ label: "Web Search", value: "状态未知（托管目录已关闭）", tone: "unknown" });
  }
  sections.push({
    title: "网络通道",
    rows: channelRows,
    note: "宿主侧搜索与抓取都在本机发起，查询不经过对话模型的服务商。",
  });

  sections.push({
    title: "凭据",
    rows: [
      {
        label: "API Key",
        value: input.keyConfigured ? "已配置" : "未配置",
        tone: input.keyConfigured ? "ok" : "unknown",
      },
      { label: "保存位置", value: "VS Code SecretStorage（系统凭据库）" },
      { label: "不写入", value: "settings.json、config.toml、会话记录、时间线、日志与报告" },
      ...(input.strippedCredentials.length > 0
        ? [{
          label: "已从子进程环境剥离",
          value: input.strippedCredentials.join("、"),
          tone: "ok" as const,
        }]
        : []),
    ],
  });

  sections.push({
    title: "配置来源",
    rows: [
      {
        label: "托管 GROK_HOME",
        value: onOff(input.managedHome),
        tone: input.managedHome ? "ok" : "warn",
      },
      ...(profile?.grokHome ? [{ label: "GROK_HOME", value: profile.grokHome }] : []),
      ...(profile?.configFile ? [{ label: "config.toml", value: profile.configFile }] : []),
    ],
    ...(input.managedHome
      ? {}
      : {
        note: "托管目录已关闭，config.toml 不由扩展生成，"
          + "上面的 remote_fetch、telemetry、auto_update 等开关无法保证。",
      }),
  });

  sections.push({
    title: "强制写入的环境变量",
    rows: Object.entries(input.privacyEnv).map(([name, value]) => ({
      label: name,
      value,
      tone: "ok" as const,
    })),
    note: "以上状态来自本次启动实际生成的配置与实际构造的子进程环境，不是固定文案。"
      + "网络行为仍建议用 TCPView、资源监视器或代理抓包验收 grok.exe 的实际连接目标。",
  });

  return sections;
}
