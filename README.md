# 会话导出为 Markdown（dsh-session-export）

把一次会话**连同它的整个智能体编队**导出为两份 Markdown，两份来自**同一次冻结快照**。

## 两份产物

| 文件 | 定位 | 内容 |
| --- | --- | --- |
| `*.summary.md` | 给人读 | 全局时间线叙事：谁在何时说了什么、做了哪个决定、派了谁、子代理回报了什么。每条都带 `[→ raw]` 锚点 |
| `*.raw.md` | 给复盘/审计 | 逐事件完整日志：消息原文、工具参数与结果、失败重试、状态变更、被替换的历史 |

两份文件共享同一个 `export_id`，并各自在 frontmatter 声明快照边界。

## 用法

三种入口，共用同一套导出实现。

### 作为对话里的按钮（推荐）

输入框下方的 dock 上有一个 **导出会话** 按钮（文档图标）。点击后：

1. 先弹目录选择框（Windows 原生「选择文件夹」对话框）——取消就什么都不做
2. 选好后自动执行导出，进度显示在按钮上（`选择位置…` → `导出中…`）
3. 失败原因直接显示在按钮旁边，不打断对话

### 作为工具（Agent 可调用）

```
export_session_markdown({ sessionId?: string, ... })
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `sessionId` | 当前会话 | 要导出的会话；**导出的是它的整棵编队树**（向上找到根，向下收集所有子代理）。支持 ID 前缀 |
| `includeSystemPrompt` | `false` | 是否导出 system prompt 原文 |
| `includeReasoning` | `true` | 是否导出思考链（raw 中默认折叠） |
| `redact` | `true` | key / token / 家目录路径脱敏 |
| `toolResultMaxChars` | `6000` | 超过该字符数的工具结果在 raw 中折叠（保留首尾并注明原始长度） |
| `outputDir` | 弹出选择器 | 输出目录。**省略时会先弹出系统目录选择器**让你选保存位置；给定则直接使用。可写相对工作区的路径（如 `exports`），也可写绝对路径（如 `D:\会话导出`）。目录不存在会自动创建 |
| `formats` | `["summary","raw"]` | 可只生成其中一个 |

### 作为命令

```
/md-export            # 先问保存位置，选好再导出
/md-export 归档/1029  # 不问，直接导出到工作区下的相对目录
/md-export D:\会话导出 # 不问，直接导出到绝对路径
```

> 命令名是 `md-export` 而不是 `export`：`export` 已被 DSH 内置命令占用。

**选择保存位置的三级策略（三个入口一致）**

1. **按钮**：直接调 DSH Desktop 的 `__DSH_DESKTOP_PICK_DIRECTORY__` 桥，弹真正的 Windows「选择文件夹」对话框。这个桥存在与否与 Host 侧 `directoryPicker` 后端无关，所以在 `browse` 组合下依然可用
2. **命令 / 工具**：先试 `native` 后端；不可用则改用 DSH 的**提问卡片**（`ctx.userQuestions.ask`），给出常用位置并允许直接填写绝对路径
3. 都不成立 → 回退默认 `exports`，并在回执里说明原因

指定了 `outputDir` 就完全不打扰；用户取消则**一个文件都不写**（询问发生在渲染之前）。

子代理无法回答提问（DSH 只允许 live runtime root 接收人类回答），所以由子代理触发的导出会直接走默认目录，不会挂住。

**路径解析用 `path.resolve`，不手写前缀判断**
Windows 下 `/exports` 是**盘符根**（`C:\exports`）而不是工作区子目录，`D:` 是盘符相对路径而不是绝对路径。早期手写的正则把这些都判错了，还把 `D:\会话导出` 拼成了 `<cwd>/D:会话导出`。现在统一交给 `path.resolve(cwd, raw)`。

## 产物结构

```
<工作区>/exports/
  <标题>_<会话ID前8位>_<时间戳>.summary.md
  <标题>_<会话ID前8位>_<时间戳>.raw.md
```

## 几个关键设计决定

**1. 排序用 `(time, sessionId, seq)`，不是全局序号**
DSH 的事件 `seq` 是**会话内**递增的，lead 与每个 subagent 各自从 0 开始，跨会话不可比。因此编队时间线必须按实际时间合并，同毫秒时用 `sessionId + seq` 做 tie-break。

**2. 会话 ID 有两种写法，必须归一化**
新会话是裸 UUID（`cc8a1db3-...`），而 `parentSession` 与老会话带前缀（`session-67a8d807-...`）。插件在每次查表前都做去/加前缀的双形态尝试，否则编队树会断。

**3. raw 不是"摘要的展开"，summary 也不是"raw 的删减"**
两者都从同一份快照独立投影：raw 走事件流，summary 走叙事节拍（user / assistant / tools / spawn / report / alert）。

**4. 系统注入不进叙事**
DSH 会把 harness 上下文（runtime context、技能清单、时间采样、委派提示）作为额外的 `user/message` 事件写入。raw 里保留并标注为「系统注入」，summary 里剔除——否则时间线会被注入内容淹没。

**5. 导出器自己的痕迹会被过滤**
导出工具的调用会写入 `tool/call` / `tool/result`，命令会写入 `command/run` / `command/done`。这些在 raw 中默认过滤，避免档案被污染、也避免下一次导出时递归膨胀（因此工具返回值只给路径与统计，**绝不返回正文**）。

**6. 只读**
插件从不向会话日志追加事件。

## 已知限制

- **改代码后必须重启 DSH** 才会加载新的 JS 模块代次（Host 插件没有 HMR）。安装新 bundle 可以热激活，替换已安装的包不行。
- **`exports` 必须显式暴露 `"./package.json"`**：`dsh-client-modules` 用 `require.resolve('<包名>/package.json')` 定位清单，而 `exports` 一旦声明就会封死所有未列出的子路径。漏掉这一条时解析抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，`locatePkgJson` 在 `catch` 里**静默返回 undefined**，结果是 Host 正常工作、Client 半边凭空消失且没有任何报错。修好后重新安装即可热生效，无需重启（HMR 会重扫该包）。这个坑排查成本极高，务必保留这一行。
- **`remote.commands` 是带点号的扁平服务名，不是 `remote` 的子属性**：Client 侧要写 `inject: ['slots', 'remote.commands']`，取值用 `ctx.get('remote.commands')`。写成 `ctx.get('remote').commands` 会报 `cannot get property "remote.commands" without inject`（不注入时直接属性访问同样报这个）。DSH 自己的 `dsh-client-ui-commands` / `dsh-client-ui-plan` 都是这个写法，可直接参照。
- **`locale.bind(ns)` 返回取词函数，不是字典**：形状是 `(key, params) => string`，查不到时**把 key 原样返回**。写成 `bind(ns).button` 会得到 `undefined`，按钮渲染成空白。
- **测试桩必须复刻真实语义**：以上两个 bug 都因为我的桩「比真实实现宽松」而漏过（`bind()` 返回 `undefined`、`remote.commands` 建成嵌套对象）。桩越宽松，测试越没用。`test/regression-guard.mjs` 会把已修的 bug 逐个注入回去，断言测试必须失败。
- 旧格式会话若无法重放（`migration-required`），会降级为「仅元数据」并在文件中标注，不会中断导出。
- 无法读取的子代理分支（外部/不可用）会在「导出提示」里列出，不会静默缺失。
- 超长会话的 raw 会很大（几百 turn 可能几十 MB）；可用 `formats: ["summary"]` 只出摘要。

## 文件构成

```
index.js              工具与命令注册、导出编排、落盘
client.js             Client 按钮（dock 上的「导出会话」）
lib/collect.js        定位根会话、自建编队树、逐会话冻结快照
lib/render-summary.js 叙事渲染
lib/render-raw.js     原始存档渲染
lib/redact.js         脱敏规则
lib/util.js           会话 ID 归一化、时间格式、转义、截断
test/render-test.mjs  离线渲染测试（直接读磁盘上的 v4 日志，无需安装）
test/client-test.mjs  Client 半边离线测试（桩 React / ModuleLoader / 严格 ctx）
test/host-test.mjs    路径解析表驱动测试
test/regression-guard.mjs 把已修的 bug 注入回去，断言测试必须失败
```

离线自测：

```
node test/render-test.mjs "<sessions目录>" "<输出目录>" "<根会话ID>"
node test/client-test.mjs
node test/host-test.mjs
node test/regression-guard.mjs
```
