/**
 * 模型中心服务的测试台。
 *
 * 用真实的 ProviderService / ProviderRegistry / ProviderSecretStore（落盘到临时目录），
 * 只把 HTTP 传输与会话查询换成替身——被测的正是「设置页动作如何落到这几个真实组件上」，
 * 把它们也 mock 掉就什么都没验证到了。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createNodeFileSystem } from "../../src/file-system-port";
import type { HostToWebviewMessage } from "../../src/messages";
import type { ModelSettingsHostMessage, ModelSettingsWebviewMessage } from "../../src/model-settings-messages";
import { CatalogCache } from "../../src/models/providers/catalog-cache";
import type { HttpRequest, HttpResponse } from "../../src/models/providers/provider-http-client";
import { ProviderService } from "../../src/services/provider-service";
import { ModelSettingsService } from "../../src/services/model-settings-service";
import type { SessionRecord } from "../../src/storage/session-repository";
import { __test as vscodeHarness } from "./vscode-stub";

export interface SettingsHarness {
  service: ModelSettingsService;
  providers: ProviderService;
  /** 目录缓存；测试直接读它确认缓存写了什么、有没有被删。 */
  catalog: CatalogCache;
  /** 设置页收到的全部出站消息。 */
  posted: ModelSettingsHostMessage[];
  /** 宿主发出的全部 HTTP 请求。 */
  requests: HttpRequest[];
  logLines: string[];
  storageRoot: string;
  /** 会话按 modelId 的引用，供删除确认路径使用。 */
  sessions: Map<string, SessionRecord[]>;
  /** 记录 onProvidersChanged 被调用了几次。 */
  reprojections: number;
  send(message: ModelSettingsWebviewMessage): Promise<void>;
  messagesOfType<T extends ModelSettingsHostMessage["type"]>(
    type: T,
  ): Array<Extract<ModelSettingsHostMessage, { type: T }>>;
  latestProviders(): Extract<ModelSettingsHostMessage, { type: "providers" }> | undefined;
}

export interface SettingsHarnessOptions {
  /** 按 URL 后缀给响应；未命中的请求返回 404。 */
  routes?: Record<string, Partial<HttpResponse>>;
  transport?: (request: HttpRequest) => Promise<HttpResponse>;
  now?: () => number;
}

export async function createSettingsHarness(
  options: SettingsHarnessOptions = {},
): Promise<SettingsHarness> {
  vscodeHarness.reset();
  const storageRoot = await mkdtemp(path.join(tmpdir(), "lingdong-settings-"));

  const logLines: string[] = [];
  const posted: ModelSettingsHostMessage[] = [];
  const requests: HttpRequest[] = [];
  const sessions = new Map<string, SessionRecord[]>();

  const providers = new ProviderService({
    post: (message: HostToWebviewMessage) => { void message; },
    log: (line) => logLines.push(line),
    fs: createNodeFileSystem(),
    storageRoot: () => storageRoot,
    secrets: vscodeHarness.createSecretStorage(),
    index: {
      get: () => vscodeHarness.state.globalState.get("lingdongAgent.providerKeyIndex") as string[] ?? [],
      set: (ids) => {
        vscodeHarness.state.globalState.set("lingdongAgent.providerKeyIndex", [...ids]);
        return Promise.resolve();
      },
    },
    ...(options.now ? { now: options.now } : {}),
  });

  const transport = options.transport ?? ((request: HttpRequest) => {
    const routes = options.routes ?? {};
    const pathname = new URL(request.url).pathname;
    const hit = Object.entries(routes).find(([suffix]) => pathname.endsWith(suffix));
    return Promise.resolve({ status: 404, headers: {}, body: "{}", ...(hit ? hit[1] : {}) });
  });

  const catalog = new CatalogCache({
    fs: createNodeFileSystem(),
    storageRoot,
    log: (line) => logLines.push(line),
  });

  const harness: SettingsHarness = {
    service: undefined as unknown as ModelSettingsService,
    providers,
    catalog,
    posted,
    requests,
    logLines,
    storageRoot,
    sessions,
    reprojections: 0,
    send: async (message) => { await harness.service.handle(message); },
    messagesOfType: (type) => posted.filter(
      (message): message is Extract<ModelSettingsHostMessage, { type: typeof type }> =>
        message.type === type,
    ) as never,
    latestProviders: () => [...posted]
      .reverse()
      .find((message): message is Extract<ModelSettingsHostMessage, { type: "providers" }> =>
        message.type === "providers"),
  };

  harness.service = new ModelSettingsService({
    providers,
    catalog,
    log: (line) => logLines.push(line),
    onProvidersChanged: () => {
      harness.reprojections += 1;
      return Promise.resolve();
    },
    onCredentialChanged: () => Promise.resolve(),
    activeModelId: () => undefined,
    sessionsUsingModel: (modelId) => Promise.resolve(sessions.get(modelId) ?? []),
    transport: (request) => {
      requests.push(request);
      return transport(request);
    },
    ...(options.now ? { now: options.now } : {}),
  });

  harness.service.setPoster((message) => posted.push(message));
  await providers.load();
  return harness;
}

/** 一个成功的 Chat Completions 回复。 */
export const CHAT_OK = {
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
};

/** 一个带正确工具调用的能力检测回复。 */
export const PROBE_OK = {
  status: 200,
  body: JSON.stringify({
    choices: [{
      message: {
        tool_calls: [{
          function: { name: "lingdong_capability_probe", arguments: "{\"value\":\"ok\"}" },
        }],
      },
    }],
  }),
};

/**
 * 三步依次给出的响应：连接 → 流式 → 能力检测。
 * 用调用序号而不是路径区分，因为三步打的是同一个端点。
 */
export function threeStepTransport(steps: {
  connection?: Partial<HttpResponse>;
  streaming?: Partial<HttpResponse>;
  probe?: Partial<HttpResponse>;
}): (request: HttpRequest) => Promise<HttpResponse> {
  let call = 0;
  return () => {
    call += 1;
    const step = call === 1 ? steps.connection : call === 2 ? steps.streaming : steps.probe;
    return Promise.resolve({ status: 200, headers: {}, body: "{}", ...(step ?? {}) });
  };
}

export const STREAM_OK = {
  status: 200,
  body: "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n",
};

export function fakeSession(id: string, modelId: string): SessionRecord {
  return {
    id,
    workspaceId: "ws",
    title: "会话",
    createdAt: 1,
    updatedAt: 1,
    mode: "agent",
    modelId,
    // 删除规则只看 id 与 modelId，其余字段补齐只会让断言噪音变大。
  } as unknown as SessionRecord;
}
