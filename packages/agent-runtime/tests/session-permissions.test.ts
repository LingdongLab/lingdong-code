import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionPermissionCache,
  commandPrefix,
  deriveSessionRule,
  type DurablePermissionRules,
  type PermissionSubject,
  type SessionRule,
} from "../src/session-permissions.js";

function fakeDurable(): DurablePermissionRules & { rules: SessionRule[] } {
  const rules: SessionRule[] = [];
  return {
    rules,
    list: () => rules,
    add: (rule) => { rules.push(rule); },
  };
}

const workspace = "E:\\LingdongCode\\workspace\\grok-test";

function subject(overrides: Partial<PermissionSubject> = {}): PermissionSubject {
  return {
    operation: "write",
    risk: "low",
    workspace,
    targets: [`${workspace}\\index.html`],
    insideWorkspace: true,
    ...overrides,
  };
}

test("命令前缀取前两个非选项 token", () => {
  assert.equal(commandPrefix("npm test -- --watch=false"), "npm test");
  assert.equal(commandPrefix("git status --short"), "git status");
  assert.equal(commandPrefix("ls"), "ls");
});

test("写入规则覆盖整个工作区但不越界", () => {
  const cache = new SessionPermissionCache();
  const rule = deriveSessionRule(subject());
  assert.ok(rule);
  assert.equal(rule?.kind, "workspace-write");
  cache.allow(rule);

  assert.ok(cache.matches(subject({ targets: [`${workspace}\\src\\a.ts`] })));
  assert.equal(cache.matches(subject({ targets: ["E:\\other\\a.ts"], insideWorkspace: false })), undefined);
});

test("命令规则按前缀匹配，链式命令不复用", () => {
  const cache = new SessionPermissionCache();
  const rule = deriveSessionRule(subject({ operation: "execute", command: "npm test", targets: [] }));
  assert.equal(rule?.kind, "command-prefix");
  assert.equal(rule?.value, "npm test");
  cache.allow(rule!);

  assert.ok(cache.matches(subject({ operation: "execute", command: "npm test -- --runInBand", targets: [] })));
  assert.equal(cache.matches(subject({ operation: "execute", command: "npm install", targets: [] })), undefined);
  assert.equal(cache.matches(subject({ operation: "execute", command: "npm test && rm -rf dist", targets: [] })), undefined);
});

test("high 与 blocked 永不缓存也永不命中", () => {
  const cache = new SessionPermissionCache();
  assert.equal(deriveSessionRule(subject({ risk: "high" })), undefined);
  assert.equal(deriveSessionRule(subject({ risk: "blocked" })), undefined);

  const rule = deriveSessionRule(subject());
  cache.allow(rule!);
  assert.equal(cache.matches(subject({ risk: "high" })), undefined);
});

test("clear 会清空全部会话规则", () => {
  const cache = new SessionPermissionCache();
  cache.allow(deriveSessionRule(subject())!);
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.matches(subject()), undefined);
});

test("always 规则落到持久化存储，clear 不影响它", () => {
  const durable = fakeDurable();
  const cache = new SessionPermissionCache(durable);
  const rule = deriveSessionRule(subject(), "always");
  assert.equal(rule?.scope, "always");
  assert.match(rule!.label, /以后都允许/);
  cache.allow(rule!);

  assert.equal(durable.rules.length, 1);
  assert.ok(cache.matches(subject({ targets: [`${workspace}\\src\\a.ts`] })));
  cache.clear();
  assert.ok(cache.matches(subject()), "持久化规则不随会话清空");
});

test("持久化规则同样受 high 与越界限制", () => {
  const durable = fakeDurable();
  const cache = new SessionPermissionCache(durable);
  cache.allow(deriveSessionRule(subject(), "always")!);
  assert.equal(cache.matches(subject({ risk: "high" })), undefined);
  assert.equal(cache.matches(subject({ insideWorkspace: false })), undefined);
});
