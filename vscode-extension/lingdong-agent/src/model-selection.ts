/**
 * 记住用户最后一次选中的模型。
 *
 * 为什么会话记录不够：还没有会话的时候——首次使用、上一个会话被删、
 * 记录损坏——用户在 Composer 里选的模型无处存放，启动时只能退回设置项
 * `lingdongAgent.model` 的默认值。表现出来就是「明明选了 Poe，却报 DeepSeek 凭据不存在」。
 *
 * 为什么不直接改 `settings.json`：那是用户自己写的配置，程序不该在背后改它。
 * 设置项继续充当初始默认值，这里存的是「用户在界面上做过的选择」，两者分开。
 *
 * 存的是 Provider 与模型这一对，而不是只存模型 id：解析启动配置时必须两者同源，
 * 否则换过 Provider 之后会拿「新 Provider + 旧模型」去查，必然失败。
 */

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/** 只依赖读写两个动作，测试里给一个内存实现即可。 */
export interface SelectionStatePort {
  get(): ModelSelection | undefined;
  set(value: ModelSelection): PromiseLike<void> | void;
}

const SELECTION_KEY = "lingdongAgent.lastModelSelection";

function isSelection(value: unknown): value is ModelSelection {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.providerId === "string" && record.providerId !== ""
    && typeof record.modelId === "string" && record.modelId !== "";
}

/**
 * 落在 workspaceState 上：不同项目可以各用各的模型，
 * 与会话记录同样按工作区隔离。
 */
export function workspaceStateSelection(state: {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}): SelectionStatePort {
  return {
    get: () => {
      const raw = state.get<unknown>(SELECTION_KEY);
      return isSelection(raw) ? raw : undefined;
    },
    set: (value) => state.update(SELECTION_KEY, value),
  };
}

/** 内存实现，测试与无状态场景使用。 */
export function memorySelection(initial?: ModelSelection): SelectionStatePort {
  let value = initial;
  return {
    get: () => value,
    set: (next) => { value = next; },
  };
}
