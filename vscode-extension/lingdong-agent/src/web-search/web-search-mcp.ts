/**
 * 灵动 Code 宿主侧联网搜索 MCP（stdio）。
 * 由 Grok 按 config.toml [mcp_servers.lingdong_web] 拉起。
 */

import { clampSearchLimit } from "./duckduckgo-search";
import { clampMaxChars, fetchPage, formatFetchedPage, WebFetchError } from "./host-web-fetch";
import { formatSearchHits, searchWeb, WebSearchError } from "./host-web-search";
import { handleMcpMessage, startMcpStdio, type JsonRpcRequest } from "./mcp-stdio";

const SERVER_INFO = {
  name: "lingdong-web",
  version: "0.1.0",
};

const TOOLS = [
  {
    name: "WebSearch",
    description:
      "Host-side web search (DuckDuckGo/Bing). Use this for news and up-to-date info. "
      + "Do NOT use built-in web_search, and do NOT scrape search engines via shell/PowerShell. "
      + "Returns titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query in natural language or keywords.",
        },
        limit: {
          type: "number",
          description: "Max results (1-10, default 5).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "WebFetch",
    description:
      "Host-side fetch of a single web page, returned as readable text. "
      + "Use this whenever the user gives you a URL, or when a WebSearch result needs to be read in full. "
      + "Do NOT use curl, wget, Invoke-WebRequest or any shell command to read web pages — "
      + "this tool does the same thing without needing approval. "
      + "Only http/https public addresses; intranet and loopback addresses are refused.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL of the page to read.",
        },
        maxChars: {
          type: "number",
          description: "Max characters of body text (500-50000, default 20000).",
        },
      },
      required: ["url"],
    },
  },
] as const;

export async function handleWebSearchMcp(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize": {
      // Grok 发 2025-06-18；旧客户端可能发 2024-11-05。尽量回显客户端版本。
      const params = isRecord(request.params) ? request.params : {};
      const requested = typeof params.protocolVersion === "string" && params.protocolVersion
        ? params.protocolVersion
        : "2024-11-05";
      return {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case "notifications/initialized":
    case "initialized":
      return {};
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(request.params);
    default:
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  }
}

async function callTool(params: unknown): Promise<unknown> {
  if (!params || typeof params !== "object") {
    return toolError("缺少 tools/call 参数。");
  }
  const name = (params as { name?: unknown }).name;
  const args = (params as { arguments?: unknown }).arguments;
  if (name === "WebFetch") return callWebFetch(args);
  if (name !== "WebSearch") {
    return toolError(`未知工具：${String(name)}`);
  }
  const query = isRecord(args) && typeof args.query === "string" ? args.query : "";
  const limit = isRecord(args) && typeof args.limit === "number"
    ? clampSearchLimit(args.limit)
    : undefined;
  try {
    const hits = await searchWeb({ query, ...(limit !== undefined ? { limit } : {}) });
    const text = formatSearchHits(query.trim(), hits);
    return {
      content: [{ type: "text", text }],
      isError: false,
    };
  } catch (error) {
    const message = error instanceof WebSearchError
      ? error.message
      : `搜索失败：${error instanceof Error ? error.message : String(error)}`;
    return toolError(message);
  }
}

async function callWebFetch(args: unknown): Promise<unknown> {
  const url = isRecord(args) && typeof args.url === "string" ? args.url : "";
  const maxChars = isRecord(args) && typeof args.maxChars === "number"
    ? clampMaxChars(args.maxChars)
    : undefined;
  try {
    const page = await fetchPage({ url, ...(maxChars !== undefined ? { maxChars } : {}) });
    return {
      content: [{ type: "text", text: formatFetchedPage(page) }],
      isError: false,
    };
  } catch (error) {
    const message = error instanceof WebFetchError
      ? error.message
      : `抓取失败：${error instanceof Error ? error.message : String(error)}`;
    return toolError(message);
  }
}

function toolError(message: string): unknown {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 供测试复用同一条 handler。 */
export async function handleWebSearchMcpRaw(raw: string): Promise<string | undefined> {
  const response = await handleMcpMessage(raw, handleWebSearchMcp);
  return response ? JSON.stringify(response) : undefined;
}

const isMain = typeof require !== "undefined"
  && typeof module !== "undefined"
  && require.main === module;

if (isMain) {
  startMcpStdio(async (request) => {
    try {
      return await handleWebSearchMcp(request);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw error;
    }
  });
}
