import path from "node:path";

/**
 * Grok 把每个会话的 plan.md 放在：
 * `{GROK_HOME}/sessions/{encodeURIComponent(workspaceRoot)}/{grokSessionId}/plan.md`
 * UI 侧 PlanRecord 是另一份；用户在右侧改计划后必须回写这份文件，Agent 再读才看得到。
 */

export function encodeGrokWorkspaceKey(workspaceRoot: string): string {
  return encodeURIComponent(workspaceRoot);
}

export function grokSessionPlanPath(input: {
  grokHome: string;
  workspaceRoot: string;
  grokSessionId: string;
}): string {
  return path.join(
    input.grokHome,
    "sessions",
    encodeGrokWorkspaceKey(input.workspaceRoot),
    input.grokSessionId,
    "plan.md",
  );
}

/**
 * 在 sessions 下按 grokSessionId 找 plan.md。
 * 工作区路径大小写/斜杠不一致时，单靠 encode 会对不上，扫一层更稳。
 */
export async function findGrokSessionPlanPath(input: {
  grokHome: string;
  grokSessionId: string;
  workspaceRoot?: string;
  exists: (absolutePath: string) => Promise<boolean>;
  listEntries?: (directory: string) => Promise<Array<{ name: string; isDirectory: boolean }>>;
}): Promise<string | undefined> {
  const sessionId = input.grokSessionId.trim();
  if (!sessionId) return undefined;

  if (input.workspaceRoot?.trim()) {
    const direct = grokSessionPlanPath({
      grokHome: input.grokHome,
      workspaceRoot: input.workspaceRoot.trim(),
      grokSessionId: sessionId,
    });
    if (await input.exists(direct)) return direct;
    // Windows 下有时盘符大小写不同
    const altRoot = flipDriveCase(input.workspaceRoot.trim());
    if (altRoot) {
      const alt = grokSessionPlanPath({
        grokHome: input.grokHome,
        workspaceRoot: altRoot,
        grokSessionId: sessionId,
      });
      if (await input.exists(alt)) return alt;
    }
  }

  if (!input.listEntries) return undefined;
  const sessionsRoot = path.join(input.grokHome, "sessions");
  if (!(await input.exists(sessionsRoot))) return undefined;
  const workspaces = await input.listEntries(sessionsRoot);
  for (const entry of workspaces) {
    if (!entry.isDirectory) continue;
    const candidate = path.join(sessionsRoot, entry.name, sessionId, "plan.md");
    if (await input.exists(candidate)) return candidate;
  }
  return undefined;
}

function flipDriveCase(root: string): string | undefined {
  if (!/^[A-Za-z]:/.test(root)) return undefined;
  const drive = root[0]!;
  const flipped = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
  return `${flipped}${root.slice(1)}`;
}
