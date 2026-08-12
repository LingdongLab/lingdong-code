/**
 * 把 Runtime 抛回来的原始错误翻译成用户能据以行动的一句话。
 *
 * 起因是一次真实故障：切到某个 Poe 模型后每一轮都失败，日志里只有
 * `ACP -32603: Internal error`，界面上更是只剩「操作未成功，详情见输出日志」。
 * 真正的原因藏在 JSON-RPC 错误的 `data` 里——Grok 解析上游响应时，
 * 一个它声明为 u32 的字段收到了 null。
 *
 * 这类错误重试没有意义：同一个模型的响应格式不会因为再发一次就变。
 * 所以提示里要说清楚「换一个模型」，而不是含糊地让用户重试。
 * 但也仅止于提示：不替用户自动换模型，那会让人以为数据发给了 A、实际发给了 B。
 */

/** 上游响应与 Grok 的期望对不上；纯格式问题，不是网络或凭据。 */
const SERIALIZATION = /serialization error:\s*(.+?)(?:\s+at line \d+ column \d+)?$/i;

function modelLabel(modelId: string | undefined): string {
  return modelId ? `模型「${modelId}」` : "当前模型";
}

export function describeRuntimeFailure(raw: string, context: { modelId?: string } = {}): string {
  const text = raw.trim();

  const serialization = SERIALIZATION.exec(text);
  if (serialization) {
    const detail = /invalid type: null, expected/i.test(serialization[1] ?? "")
      ? "有一个数值字段返回了 null"
      : serialization[1];
    return `${modelLabel(context.modelId)}返回的响应 Grok 解析不了：${detail}。`
      + "这一轮已中断，重试同一个模型还会失败，请换一个模型。";
  }

  return text;
}
