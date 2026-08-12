/**
 * 消息级操作：整条复制、重试、停止标记。
 * 与 main.ts 解耦，便于在 JSDOM 下直接测试。
 */

export type ClipboardWriter = (text: string) => Promise<boolean>;

export interface MessageActionOptions {
  getText: () => string;
  onRetry?: () => void;
  retryLabel?: string;
  /** 注入剪贴板实现，测试时可替换。 */
  copy?: ClipboardWriter;
  /** 复制反馈文案的复位延迟。 */
  resetDelayMs?: number;
}

/** 优先用异步剪贴板 API，失败再退回 execCommand。 */
export function writeClipboard(text: string): Promise<boolean> {
  const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clip?.writeText) {
    return clip.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function attachMessageActions(root: HTMLElement, options: MessageActionOptions): HTMLElement {
  const existing = root.querySelector<HTMLElement>(".msg-actions");
  if (existing) return existing;

  const copyImpl = options.copy ?? writeClipboard;
  const resetDelay = options.resetDelayMs ?? 1_200;
  const bar = document.createElement("div");
  bar.className = "msg-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "msg-action";
  copy.dataset.action = "copy";
  copy.textContent = "复制";
  copy.title = "复制整条消息";
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    void copyImpl(options.getText()).then((ok) => {
      copy.textContent = ok ? "已复制" : "复制失败";
      setTimeout(() => {
        copy.textContent = "复制";
      }, resetDelay);
    });
  });
  bar.appendChild(copy);

  const onRetry = options.onRetry;
  if (onRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "msg-action";
    retry.dataset.action = "retry";
    retry.textContent = options.retryLabel ?? "重试";
    retry.title = "重新发送这轮请求";
    retry.addEventListener("click", (event) => {
      event.stopPropagation();
      onRetry();
    });
    bar.appendChild(retry);
  }

  root.appendChild(bar);
  return bar;
}

/** 用户主动停止或模型被取消时的可见标记。 */
export function markStopped(root: HTMLElement): void {
  if (root.querySelector(".msg-stopped")) return;
  root.classList.add("stopped");
  const note = document.createElement("div");
  note.className = "msg-stopped";
  note.textContent = "已停止生成";
  root.appendChild(note);
}

export interface UserMessageHandlers {
  onResend: (text: string) => void;
  copy?: ClipboardWriter;
}

export function createUserMessage(text: string, handlers: UserMessageHandlers): HTMLElement {
  const row = document.createElement("div");
  row.className = "message user";
  const body = document.createElement("div");
  body.className = "msg-text";
  body.textContent = text;
  row.appendChild(body);
  attachMessageActions(row, {
    getText: () => text,
    onRetry: () => handlers.onResend(text),
    retryLabel: "重新发送",
    ...(handlers.copy ? { copy: handlers.copy } : {}),
  });
  return row;
}
