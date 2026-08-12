import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * 代码块语法高亮（常用语言子集，控制打包体积）。
 *
 * 只在块完成 / 终稿时调用：流式中间帧不跑高亮，避免每帧全量重算；
 * 已高亮过的块用 data 标记跳过，重复调用是幂等的。
 */

let registered = false;

function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("csharp", csharp);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("diff", diff);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("ini", ini);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("powershell", powershell);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("yaml", yaml);
  // 常见别名。
  hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
  hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
  hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
  hljs.registerAliases(["ps1", "pwsh"], { languageName: "powershell" });
  hljs.registerAliases(["html", "vue", "svg"], { languageName: "xml" });
  hljs.registerAliases(["py"], { languageName: "python" });
  hljs.registerAliases(["yml"], { languageName: "yaml" });
  hljs.registerAliases(["toml"], { languageName: "ini" });
  hljs.registerAliases(["cs"], { languageName: "csharp" });
  hljs.registerAliases(["rs"], { languageName: "rust" });
  hljs.registerAliases(["patch", "udiff"], { languageName: "diff" });
}

/** 高亮 root 下所有尚未处理的代码块；语言未注册或未标注时保持原样。 */
export function highlightCodeBlocks(root: HTMLElement): void {
  ensureRegistered();
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code"))) {
    if (code.dataset.hljs === "1") continue;
    const lang = languageOf(code);
    if (!lang || !hljs.getLanguage(lang)) continue;
    const source = code.textContent ?? "";
    try {
      const { value } = hljs.highlight(source, { language: lang, ignoreIllegals: true });
      code.innerHTML = value;
      code.classList.add("hljs");
      code.dataset.hljs = "1";
    } catch {
      // 高亮失败就保持纯文本；渲染永远不能因为高亮挂掉。
    }
  }
}

function languageOf(code: HTMLElement): string | undefined {
  const fromClass = /language-([\w+-]+)/.exec(code.className)?.[1];
  if (fromClass) return fromClass.toLowerCase();
  const pre = code.closest("pre");
  const fromData = pre?.getAttribute("data-language");
  return fromData ? fromData.toLowerCase() : undefined;
}
