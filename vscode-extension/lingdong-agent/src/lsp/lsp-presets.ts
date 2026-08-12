/**
 * `lsp.json` 的预置 language server 目录与渲染（纯逻辑）。
 *
 * 字段名与语义取自 Grok 的 `LspServerConfig`（xai-grok-tools/src/implementations/lsp/config.rs）：
 * 文件本身是「服务器名 → 配置」的扁平 map，没有外层包装键；`extensions` 是
 * 「带点的扩展名 → languageId」的 map（Grok 解析文件归属时查的是 `.ts` 这种带点形式），
 * 传数组会让 serde 整份文件解析失败而静默退化成「没有配置任何 LSP」。
 *
 * 只有配合 `[features] lsp_tools = true` 才会暴露 `lsp` 工具；那一项已经在
 * grok-config-writer 里默认打开。
 */

export interface LspPreset {
  /** lsp.json 里的服务器名，也是禁用列表的键。 */
  id: string;
  label: string;
  /** 一句话说明装什么、给什么语言用。 */
  hint: string;
  /**
   * 可执行文件候选名，按优先级排列（不含扩展名）。
   * Windows 上还会依次尝试 PATHEXT 里的后缀与 node_modules/.bin 下的 .cmd。
   */
  binaryNames: readonly string[];
  args: readonly string[];
  /** 带点的扩展名 → languageId。 */
  extensions: Readonly<Record<string, string>>;
  /** 装这个 server 的常用命令，检测不到时提示用户。 */
  install: string;
}

export const LSP_PRESETS: readonly LspPreset[] = [
  {
    id: "typescript",
    label: "TypeScript / JavaScript",
    hint: "typescript-language-server，覆盖 .ts/.tsx/.js/.jsx",
    binaryNames: ["typescript-language-server"],
    args: ["--stdio"],
    extensions: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    install: "npm i -g typescript typescript-language-server",
  },
  {
    id: "python",
    label: "Python",
    hint: "pyright-langserver，覆盖 .py/.pyi",
    binaryNames: ["pyright-langserver"],
    args: ["--stdio"],
    extensions: { ".py": "python", ".pyi": "python" },
    install: "npm i -g pyright",
  },
  {
    id: "rust",
    label: "Rust",
    hint: "rust-analyzer，覆盖 .rs",
    binaryNames: ["rust-analyzer"],
    args: [],
    extensions: { ".rs": "rust" },
    install: "rustup component add rust-analyzer",
  },
  {
    id: "go",
    label: "Go",
    hint: "gopls，覆盖 .go",
    binaryNames: ["gopls"],
    args: [],
    extensions: { ".go": "go" },
    install: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "json",
    label: "JSON",
    hint: "vscode-json-language-server，覆盖 .json/.jsonc",
    binaryNames: ["vscode-json-language-server"],
    args: ["--stdio"],
    extensions: { ".json": "json", ".jsonc": "jsonc" },
    install: "npm i -g vscode-langservers-extracted",
  },
] as const;

export function findPreset(id: string): LspPreset | undefined {
  return LSP_PRESETS.find((preset) => preset.id === id);
}

/** 一条写进 lsp.json 的服务器配置；字段名与 Grok 的 serde 别名一致。 */
export interface LspServerEntry {
  command: string;
  args: string[];
  extensions: Record<string, string>;
}

/**
 * 把「预置 + 解析出的可执行文件路径」拼成一条 lsp.json 条目。
 *
 * Windows 上 `.cmd` / `.bat` 必须由 cmd.exe 代跑：CreateProcess 不认批处理文件，
 * 而 npm 全局安装出来的 language server 恰恰都是 `.cmd` 垫片。直接写垫片路径会
 * 让 Grok 启动 server 时报 `%1 不是有效的 Win32 应用程序`，且只出现在它的内部日志里。
 */
export function composeLspEntry(preset: LspPreset, resolvedCommand: string): LspServerEntry {
  const isBatch = /\.(cmd|bat)$/i.test(resolvedCommand);
  return {
    command: isBatch ? "cmd" : resolvedCommand,
    args: isBatch ? ["/c", resolvedCommand, ...preset.args] : [...preset.args],
    extensions: { ...preset.extensions },
  };
}

/**
 * 渲染整份 lsp.json；没有任何条目时返回 undefined，调用方据此删除文件。
 * 留一个空 `{}` 也能用，但删掉更干净：诊断里「没有 lsp.json」比「有但是空的」更好读。
 */
export function renderLspJson(entries: Readonly<Record<string, LspServerEntry>>): string | undefined {
  const names = Object.keys(entries).sort();
  if (names.length === 0) return undefined;
  const ordered: Record<string, LspServerEntry> = {};
  for (const name of names) {
    const entry = entries[name];
    if (entry) ordered[name] = entry;
  }
  return `${JSON.stringify(ordered, undefined, 2)}\n`;
}
