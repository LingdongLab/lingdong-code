export interface WriteIntent {
  matched: boolean;
  /** 命中的原因文案，直接展示在提示卡片里。 */
  reason?: string;
  keyword?: string;
}

interface IntentRule {
  pattern: RegExp;
  reason: string;
}

// 否定从句会被整段剔除，避免「不要修改任何文件」被误判为修改意图。
const NEGATION = /(不要|不需要|无需|不用|别|请勿|禁止|不许|切勿)[^，。；、！？\n]*/g;

const RULES: readonly IntentRule[] = [
  { pattern: /(改成|改为|修改|更改|变更|调整代码|替换|重构|重命名|改名)/, reason: "请求修改现有文件内容" },
  { pattern: /(创建|新建|新增文件|生成文件|写入文件|写一个文件|建一个)/, reason: "请求创建或写入文件" },
  { pattern: /(删除|移除|清空|清理掉)/, reason: "请求删除内容" },
  { pattern: /(安装|卸载|添加依赖|升级依赖|install )/i, reason: "请求安装或调整依赖" },
  { pattern: /(提交代码|git commit|推送到|git push)/i, reason: "请求提交或推送代码" },
  { pattern: /(执行命令|运行命令|跑一下命令|run the command|执行脚本)/i, reason: "请求执行命令" },
  { pattern: /(实现这个功能|帮我实现|帮我写代码|直接动手|开始改)/, reason: "请求直接动手实现" },
  { pattern: /(修复|fix )/i, reason: "请求修复代码" },
];

/**
 * 检测 Ask 模式下的写入意图。命中不会静默切换模式，
 * 只用于提示用户切换到 Plan / Agent / Auto 或明确只做分析。
 */
export function detectWriteIntent(text: string): WriteIntent {
  if (typeof text !== "string" || text.trim() === "") return { matched: false };
  const cleaned = text.replace(NEGATION, " ");
  for (const rule of RULES) {
    const hit = rule.pattern.exec(cleaned);
    if (hit) return { matched: true, reason: rule.reason, keyword: hit[0].trim() };
  }
  return { matched: false };
}
