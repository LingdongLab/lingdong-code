/**
 * 拖入文件的解析逻辑（纯函数，宿主与 Webview 共用）。
 *
 * 背景：从系统资源管理器拖文件进 webview，浏览器安全模型拿不到文件的真实路径
 * （Electron 高版本已移除 File.path），只能拿到文件名和内容。
 * 所以宿主要靠「文件名在仓库里找、同名多个再按内容比对」来还原它是仓库里的哪个文件。
 * 找不到就明确拒绝——上下文只能来自当前仓库，这条边界不为拖放开口子。
 */

/** 比对前的归一化：去 BOM、统一换行。Windows 下磁盘常是 CRLF，拖进来的读出来可能是 LF。 */
export function normalizeDropText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n/g, "\n");
}

/**
 * 文本读出来像不像二进制。
 * NUL 是硬信号；解码失败的替换符（U+FFFD）偶尔一两个可能只是编码问题，密集出现就是二进制。
 */
export function looksBinaryText(text: string): boolean {
  if (text.includes("\u0000")) return true;
  if (text.length === 0) return false;
  let bad = 0;
  const sample = text.slice(0, 8_000);
  for (const ch of sample) {
    if (ch === "\uFFFD") bad += 1;
  }
  return bad / Math.min(text.length, 8_000) > 0.02;
}

/**
 * 在仓库文件清单里按文件名找候选。
 * Windows 文件系统不区分大小写，这里也不区分；路径分隔统一按 "/" 处理。
 */
export function matchDroppedName(files: readonly string[], name: string): string[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  return files.filter((relative) => {
    const base = relative.slice(relative.lastIndexOf("/") + 1);
    return base.toLowerCase() === needle;
  });
}

/** 从 text/uri-list 文本里取出 file:// 的行；# 开头是注释（RFC 2483）。 */
export function parseFileUriList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && /^file:\/\//i.test(line));
}
