# 图片输入方案（粘贴即发送，按模型区分）

目标：对齐 Cursor 的体验——在输入框粘贴或拖入图片，出现缩略图 chip，跟着这条消息发给模型；
模型支持看图就发得出去，不支持就明确禁用并说明原因。图片**不写进用户仓库**。

## 现状与硬约束

以下事实全部经过实测，方案建立在它们之上。

**1. Grok Build 会收下 image block，然后把图片悄悄丢掉。** 这一条是实测出来的，
而且过程中差点被骗过去，值得完整记下来。

握手时它声明不支持图片（grok 0.2.118，`scripts/probe-agent-capabilities.mjs` 可复现）：

```json
"promptCapabilities": { "image": false, "audio": false, "embeddedContext": true }
```

但它的 TUI 明明支持粘贴图片（`grok/data/docs/user-guide/03-keyboard-shortcuts.md:154`
有一整节 "Image Paste & Drag-and-Drop"，还有 `[Image #N]` 图片 chip），
说明二进制内部有完整的图片管线。于是真发了一个 image content block 过去——
**它没报错**，一路走到调用上游模型。

差一点就据此下结论说"能发"。但"不报错"和"送到了"是两回事。
`scripts/probe-image-forward.mjs` 让 Grok 连一个本机假上游，把它真正发出的请求体整个抓下来
（不走外网、不花额度），结果是：

| 组合 | 文本标记 | 图片 base64 |
| --- | --- | --- |
| `responses` + 陌生模型名 | 到达 | **没有** |
| `chat_completions` + 陌生模型名 | 到达 | **没有** |
| `responses` + `grok-4.5`（它认得的视觉模型） | 到达 | **没有** |

三种组合一致：文本原样转发，图片凭空消失。请求体里唯一的 image 字段是 Grok 自带
`image_edit` 工具的 schema，与我们发的图无关。

所以 `promptCapabilities.image: false` 描述的是**真实行为**，只是它不用报错来执行这条规则，
而是静默丢弃。**这意味着后续任何实现都不能拿"没报错"当成功判据**，必须验证模型真的看见了图。

**2. Poe 目录里有按模型的模态数据，我们已经在读，但读法把它毁了。**
`poe-catalog.ts:119-129` 的 `readModalities` 把 `architecture.input_modalities`、
`output_modalities`、`modalities` 三个字段合并去重成一个数组。本地缓存的 329 个模型里
167 个含 `image`，但合并之后：

```
gpt-image-2        ["text","image"]   ← 文生图，image 在 output
claude-opus-4.8    ["text","image"]   ← 能看图，image 在 input
```

两者不可区分。所以那 167 是上界，不是"能看图"的数量。

**3. `vision` 能力位全程恒为 false。** 四个创建点全部硬编码：`model-registry.ts:32`、
`model-settings-service.ts:425,494`、`provider-types.ts:193`。目前它只用于模型列表里的
一行说明文字（`composer.ts:552`），不 gate 任何行为。

**4. 本地代理是字节级透传。** `model-proxy.ts:147-155` 请求体流式直传，从不 `JSON.parse`；
它存在的唯一理由是修响应里的 `usage: null`。文件头的约束写着"请求体与响应体都是流式对接，
不整块缓冲"。

**5. 参考实现 grok-app 也没做到。** `RongleCat/grok-app`（同样驱动 grok.exe 的 Tauri GUI）
撞的是同一堵墙。它的 `src/lib/attachments.ts` 文件头直说 "Sent to the agent as Grok Build
`@path` references"，`buildAgentPrompt`（`:39-47`）返回的是纯字符串：

```ts
const refs = attachments.map((a) => `@${a.path}`).join("\n");
return body ? `${body}\n\n${refs}` : refs;
```

而 `src-tauri/src/acp_client.rs:3128` 发的是 `"prompt": [{ "type": "text", "text": text }]`,
与我们的 `acp-client.ts:352` 一字不差。它从未尝试传图片字节。

值得借鉴的是它的降级形式：用 Grok 原生的 `@path` 语法而不是自造一句说明文字，
且引用文件原位置、不往仓库里复制。不过对图片而言 `@path` 也只是让 Grok 去读文件，
救不了看图这件事。

结论：能力数据拿得到（第 2 条可修），但图片送达必须绕开 Grok，只能在代理层做。
第三步不是可选项，是唯一通路。

## 三步

### 第一步：让 `vision` 有真实来源

按讨论结论，**只信 Poe 目录的声明**，不额外做探测，也不提供手动开关。理由是这条数据本来就
是服务商用来告诉客户端"我收什么"的，而且错了的后果是可恢复的（发出去被上游拒，报错可读）。

改动：

1. `poe-catalog.ts` —— `PoeCatalogEntry` 的 `modalities: string[]` 拆成
   `inputModalities: string[]` 与 `outputModalities: string[]`。`readModalities` 相应拆成
   两个读取函数，不再合并。裸 `modalities` 字段（没有 input/output 之分的旧写法）归入
   input，因为按 OpenRouter 系的惯例它指的是输入。
2. 同文件加一个纯函数 `supportsImageInput(entry): boolean`，判据是
   `inputModalities` 含 `image`。判据集中一处，不散落在调用方。
3. `catalog-cache.ts:46` —— 快照结构跟着改成两个数组。
   **这会让旧缓存失效**：`validateSnapshot` 认不出新形状会判 corrupt，
   然后按既有逻辑重新拉取，用户侧表现为打开模型中心时多等一次网络请求。可以接受，
   但要在 `readStringArray` 缺字段时回退成空数组，避免直接判损坏刷屏日志。
4. `model-settings-service.ts:494` —— `addModel` 里 `vision: false` 改成查目录条目。
   上一行 `:474` 已经在查同一条条目拿 protocol，顺手把 entry 拿出来复用即可。
5. `model-settings-service.ts:425` —— 手工新增服务商时没有目录可查，保持 `false`。

这一步做完的可见效果：模型中心里 `claude-opus-4.8` 显示"图片 是"，`gpt-image-2` 显示"否"，
`hasVisionModel()` 开始返回真值。图片**仍然发不出去**。

测试：`poe-catalog.test.ts` 补两条——input/output 分开保存；文生图模型不被判成能看图。
`catalog-cache` 补一条旧格式快照的迁移/回退。

### 第二步：按模型 gate UI，撤掉往仓库写文件

改动：

1. `context-service.ts:346-378` —— 删掉 `addImageAttachment` 往
   `.lingdong/attachments/` 落盘那段。图片改为存在内存里的一个会话级 store，
   键是短 id，值是 `{ mimeType, bytes, name }`。上限：单张 10MB、单会话 5 张，
   超了明确报错而不是静默截断。
   （顺带修掉现有的一个不一致：校验层写 8MB (`messages.ts:602`)，落盘却复用了
   `CONTEXT_LIMITS.fileBytes` = 200KB (`context-model.ts:34`)，实际上限比宣称的严 40 倍。）
2. `context-model.ts:9` —— `ContextItemType` 加 `"image"`。`TYPE_NAMES`
   是 `Record<ContextItemType, string>`，完备性检查会强制改到位，是个可靠的编译期锚点。
3. `composer.ts` —— `handleImageDrop` 先看当前模型的 `supportsVision`：
   为真才收下并渲染缩略图 chip；为假直接给一条 notice
   （"当前模型不支持图片输入，换一个支持的模型再试"），不再落盘也不再塞路径引用。
4. chip 渲染成小缩略图 + 文件名 + 移除按钮，复用现有 `.context-chip` 那套样式。

这一步做完：不支持的模型明确拒绝，支持的模型能看到图片进了上下文。**仍然发不出去**，
因为还没到代理层。

### 第三步：代理层注入（真正让图片送达）

思路：图片不经过 Grok。在 prompt 文本里埋一个标记，代理拦下 Grok 发往上游的请求，
把标记换成真正的图片内容块。

1. **埋标记。** `composePrompt` 在用户文本里插入 `⟦lingdong-image:<id>⟧`，
   `<id>` 是第二步那个内存 store 的键。标记用不可能自然出现的字符，且长度固定便于扫描。
2. **代理改写。** `ModelProxy` 在转发前判断三个条件：POST、`content-type` 是 JSON、
   **且当前会话的图片 store 非空**。三者同时成立才缓冲请求体，否则维持今天的流式直传。
   这样性能代价只落在真的带了图的那几轮，文件头那条"不整块缓冲"的约束在绝大多数请求上
   依然成立——注释要同步更新，说清楚例外条件。
3. **两种协议形状不同**，按模型的 protocol 分别处理：
   - `chat_completions`：`content` 字符串换成数组
     `[{type:"text",...},{type:"image_url",image_url:{url:"data:image/png;base64,..."}}]`
   - `responses`：换成 `[{type:"input_text",...},{type:"input_image",image_url:"data:..."}]`
4. **兜底：任何解析不出的标记一律删掉。** 宁可让模型少看见一张图，也不能让
   `⟦lingdong-image:ab12⟧` 这种内部字符串漏进对话——那是纯粹的困惑源。
5. **历史轮次。** Grok 每轮都会把完整对话重发一遍，所以老标记会在后续请求里反复出现。
   保持注入（对齐 Cursor 的"图片留在历史里"行为），store 随会话结束清空。

## 风险

**最大的一条：我们在改写一个不是自己拼的请求体。** Grok 换版本改了请求形状，注入就会
静默失效或者破坏请求。缓解办法是注入前校验结构（必须能找到 `messages` 数组且末条是
user），对不上就原样透传并记一条日志，绝不半改。

其次，目录声明不一定准。Poe 说支持、实际调用被拒的情况一定会有，届时错误会以上游 400
的形式冒出来——`provider-error-mapper.ts` 要能把这类错误翻译成"这个模型可能不支持图片"
而不是一串原始 JSON。

第三，缓冲请求体会让带图那一轮的首字节延迟变差。图片本身几 MB，这个代价躲不掉。

## 验收

**判据必须是模型答对，不能是"没报错"**——Grok 静默丢图那一课就在这里。

- 先跑 `scripts/probe-image-forward.mjs`（离线抓包）确认注入后的请求体里真的有图片 base64。
- 再挂一个 Poe 的视觉模型（如 `claude-opus-4.8`），粘贴一张纯色图问"这张图是什么颜色"，
  颜色答对 = 真通了。答错或说看不见 = 图没送到。
- 切到 `deepseek-v4-flash`，粘贴图片应被明确拒绝并给出原因。
- 切到 `gpt-image-2`（文生图，input 无 image），同样应被拒绝——这条专门验证
  第一步的 input/output 拆分没白做。
- 不带图的普通对话，出字节奏与改动前一致（确认流式直传没被误伤）。

## 回退

三步各自独立，都能单独回退。第三步风险最高但也最好切：代理层注入加一个开关，
关掉就退回今天的纯透传，前两步的能力显示与 UI 拦截不受影响。
