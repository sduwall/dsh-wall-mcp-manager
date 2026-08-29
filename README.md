# dsh-wall-mcp-manager

DSH（DeepSeek Harness）插件：集中管理 MCP 服务器配置，并展示每台服务器提供的工具、
调用参数与返回契约。

- **插件类型**：Cordis Bundle（npm 包）
- **依赖**：`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-loader`、
  `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-tools`
  （peer，由 DSH 运行时提供）、`@deepseek-ai/schemastery`
- **运行环境**：Node.js ≥ 20（DSH 内置 Node ≥ 22）
- **硬依赖服务**：`loader`、`tools`（`inject: ['loader', 'tools']`）
- **可选服务**：`settings`（运行时改配置并热生效；缺失时按组合层配置工作）、
  `webServer`（设置界面的配置桥；缺失时仍照常挂载 MCP，只是没有界面）

## 它做什么

本插件**自己不实现 MCP 协议**，只做两件事：

1. **对账**：把配置里的服务器清单收敛成一组 `@deepseek-ai/dsh-mcp-client` 实例
   （一个实例 = 一台 MCP 服务器）——新增则挂载、改了则更新、删了则卸载、没变则一动不动；
2. **呈现**：通过回环配置桥把「配置 + 挂载状态 + 工具契约」交给设置界面。

为什么是对账而不是「全拆重建」：重建会让所有 MCP 重连一次。用户改一台服务器的
备注文字，不该把另外五台的 stdio 子进程全杀掉重启。判定依据是**实例配置指纹**
（`toMcpConfig` 的输出序列化），因此只改 `description` 这类非 mcp-client 字段不触发重连。

## 工具命名与 serverName

MCP 工具在 DSH 里的公开名是 `mcp__<serverName>__<原始工具名>`。因此：

- `servers` 用**字典**而非数组，键即 `serverName`，让「重名」在数据结构上就不可能
  （`serverName` 在所有活动 mcp-client 实例之间必须唯一，重复会在挂载阶段抛错）；
- `serverName` 受 `[A-Za-z0-9_-]{1,32}` 约束（与 mcp-client 内部常量一致），
  非法名称在插件侧就被拦下并在界面显示原因，而不是只留一行日志；
- **改名等于换一台服务器**：工具名会整体变化，模型侧的引用也随之改变。
  对账时先卸载不再需要的 `serverName`、再挂载新的，避免改名瞬间在唯一性检查上撞车。

界面按 `mcp__<serverName>__` **前缀**归组工具（最长前缀优先，正确区分 `fs` 与 `fs_ro`），
不反解析工具名——`publicToolName` 在需要字符替换或截断时会追加哈希，其源码明确
"the public name is never parsed to recover it"，但 `serverName` 段不会被改写。

## 配置

配置命名空间为 `dsh-wall-mcp-manager`，形如：

```yaml
dsh-wall-mcp-manager:
  servers:
    filesystem:
      enabled: true
      transport: stdio
      description: 本地文件访问
      command: npx
      args:
        - -y
        - '@modelcontextprotocol/server-filesystem'
        - D:/workspace
      env:
        LANG: zh_CN
      secretEnv:             # 凭据类环境变量；没有凭据就整段省略，不要写成 {}
        API_TOKEN: xxx
      cwd: ''
      toolCallTimeoutMs: 60000
      failOnStartupError: false
    weather:
      transport: streamable-http
      url: https://mcp.example.com/mcp
      headers:
        X-Trace: 'on'
      secretHeaders:         # 凭据类请求头
        Authorization: Bearer xxx
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 停用则不挂载该服务器（保留配置） |
| `transport` | `stdio` | `stdio`（本地子进程）或 `streamable-http`（远程 HTTP） |
| `description` | `''` | 备注，仅本界面展示，不传给 mcp-client |
| `command` | `''` | **stdio 必填**：启动命令 |
| `args` | `[]` | stdio：命令参数，**逐项填写**（不会按空格拆分） |
| `env` | `{}` | stdio：环境变量（明文，可在界面查看） |
| `secretEnv` | 无 | stdio：凭据类环境变量，`role('secret')`，**永不出网** |
| `cwd` | `''` | stdio：工作目录，留空继承 DSH 进程 |
| `url` | `''` | **streamable-http 必填**：服务地址 |
| `headers` | `{}` | streamable-http：请求头（明文，可在界面查看） |
| `secretHeaders` | 无 | streamable-http：凭据类请求头，`role('secret')`，**永不出网** |
| `toolCallTimeoutMs` | `60000` | 工具调用超时（毫秒，≥1000） |
| `failOnStartupError` | `false` | 启动失败是否让该实例整体失败 |

`secretEnv` / `secretHeaders` 在挂载时被合并进 `env` / `headers`（同名以凭据为准）——
对 mcp-client 而言它们和普通环境变量、普通请求头没有区别，拆成两个字段只是因为
明文项要能在界面查看编辑，而凭据项必须只写不读，两者需要不同的 role。

两个凭据字段**没有默认值**（显式 `.default(undefined)`）：界面判断「已配置 / 未配置」
依据的是脱敏视图里的 `set` 标记，而它按「值是否为 `undefined`」判定；schemastery 会给
每个 dict 无条件补上 `{}` 默认值，若不压回 `undefined`，从没填过的凭据槽位也会显示
「已配置」。因此手写 yaml 时**不要**写 `secretEnv: {}`，没有凭据就整段省略。

### 为什么不照抄 mcp-client 的 Schema

mcp-client 自身的 `Config` 是 `z.union([stdio, streamable-http])`，但 settings 的
`redactSecrets` 只穿透 object / dict / array 三种容器，遇到 union 会**原样返回整棵子树**
（其源码注释明确 "a secret buried inside a union branch is not reachable and must not be
modeled that way"）。若按 union 建模，凭据就会随 `describe` 原文出网。

因此这里用**扁平 object + `transport` 判别字段**，挂载时再由 `toMcpConfig` 按分支重新
组装出合法的实例配置——只输出该分支该有的字段，多带一个别分支字段会被 union 直接拒绝。

### 半成品不影响其他服务器

「填了一半的服务器」在配置界面里是常态。校验失败（缺 `command`、名称非法、
`transport` 不支持）只让该台被跳过并在界面标出原因，不会让整份配置或其他服务器失效。
单台挂载失败（命令不存在、远端不可达）同样只记为该台的失败，绝不外溢成插件整体卸载。

## 设置界面

插件注册了 `settings.section` 一级页面「MCP 服务器」。界面由浏览器端 bundle
（`lib/client.js`）渲染，通过宿主自建的回环配置桥读写：

| 路由（均为 POST） | 用途 |
| --- | --- |
| `/api/dsh-wall-mcp-manager/describe` | 脱敏配置视图（含 `revision` 与 schema） |
| `/api/dsh-wall-mcp-manager/mutate` | 按 `{ ops, expectedRevision }` 精确改字段 |
| `/api/dsh-wall-mcp-manager/servers` | 每台服务器的挂载状态（fiber 相位 / 跳过原因 / 失败原因） |
| `/api/dsh-wall-mcp-manager/tools` | 按服务器归组的工具清单，含参数与拆包后的返回 schema |

- **只接受本机回环来源**（`127.0.0.1` / `::1` / `::ffff:127.*`）。该桥能写入 MCP 的
  启动命令与凭据，权限等价于「在宿主上执行任意进程」；DSH 的 webserver 允许绑定
  `0.0.0.0`，那种部署下不做来源校验等于把远程命令执行接口暴露到整个网段。
- **凭据永不出网**：`describe` 走 `redactSecrets: true`，整字典标 secret 后连键名都不返回，
  界面只能显示「已配置 / 未配置」。凭据框**留空保存表示不修改**，这是既支持修改又不
  回传原文的唯一语义；要清除请点「清除凭据」。
- **删除需二次确认**：点「删除」只置位待确认，界面就地展开确认条，说明将断开的连接、
  移除的工具数，以及凭据会被一并清除且无法恢复；再点「确认删除」才真正写入 `unset`。
  凭据从不回显，误删一次只能重新去拿密钥，这类不可逆操作不能一键完成。
- 写入按字段 `set` / `unset`（不整体替换），带 `revision` 乐观锁。整体替换会把浏览器
  从未见过的 `secretEnv` / `secretHeaders` 一并抹掉；乐观锁则保证手改 yaml 与界面并发
  修改不会互相覆盖。校验失败与修订冲突返回 `ok:false`，界面保留草稿供修正。
- `/servers` 与 `/tools` 读的是运行时事实，**不依赖 settings 服务**，headless 之外的
  只读展示也可用。未提供数据源钩子时这两条路由干脆不注册（宁可 404 也不回假数据）。
- 工具卡片展示调用参数与返回契约。mcp-client 给每个工具的返回 schema 套了固定包装
  `{ content, structuredContent }`，界面会拆包：声明了 `outputSchema` 的工具展示其真实
  结构化字段，只返回文本块的工具明确说明。无法逐字段展开的形态（union / `$ref`）一律
  回落到「查看原始 Schema」，不猜、不编造字段。
- 「其他来源的 MCP 工具」区块列出带 `mcp__` 前缀但不属于本插件配置的工具（例如部署
  配置里直接挂载的 mcp-client 实例），只能查看契约，不能在此修改其配置。

> 限制：界面依赖本机浏览器访问 DSH 的 Web 服务（回环校验）。通过远程地址访问 GUI 时
> 无法读写配置，请改用 `$DSH_HOME/settings.yaml`。
>
> DSH 官方「插件配置」页只渲染 `dsh-host-apiproxy` 中 `WEB_SETTINGS_NAMESPACES` 白名单
> 内的命名空间，该白名单是包内硬编码常量，仓库外插件无法挂进去；本插件因此走自建
> 路由桥接，并在设置页里完成同样的 Schema 校验与热生效。

## 热生效

保存配置后立即对账，无需重启 DSH：新增即时连接、修改重连该服务器、删除断开连接。
连续保存被串行化处理，避免 create / remove 交叉。

注意**配置与运行时的时序不同**：配置是保存即定，而 MCP 连接与工具注册要等子进程或
远端握手完成。保存后界面会短轮询运行状态（约 8 秒），把提示从「正在连接…」推进到
「已连接，注册 N 个工具」或具体失败原因，不需要手动刷新。

提示到达终态后 10 秒自动消失，**计时从拿到连接结果那一刻起算**，不是从点保存起算——
握手可能耗时数秒，从点击起算会让提示在结果出来之前就消失。进行中的提示不计时也不
可关闭，否则这次连接的结论就再也看不到了。多条提示按「服务器 / 操作」归并排队共存：
同一台服务器的轮询文案原地改写（不会 8 秒堆出十几条），不同来源的提示各占一行。

状态徽章分两级，因为 **fiber 的「运行中」不等于 MCP 已连上**：mcp-client 在
`failOnStartupError: false`（本插件默认）下，握手失败也不会让实例失败，而是在后台按
指数退避重连。所以徽章只在**该服务器注册出工具**时才显示「已连接」，实例活着但握手
未成时显示「未连接」。此时反复点「刷新状态」会一直得到同样的结果——那不是刷新失效，
而是连接确实没建立，失败原因见 DSH 日志。

配置分三层解析（后者覆盖前者）：Schema 默认值 → cordis 组合层（`cordis.patch.yml`）→
`settings.yaml` 用户层。组合层适合部署级默认值，用户层适合随时可能变动的服务器与凭据。

## 安装

```bash
dsh plugin --profile <profile> add ./dsh-wall-mcp-manager
```

出厂默认 `servers` 为空，此时插件正常加载但不挂载任何 MCP，因此安装本身不会启动任何
子进程或对外请求。

部署级默认值请写在 profile 自己的 `cordis.patch.yml`
（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`），而不是本包内的
`cordis.patch.yml`（后者属于 npm 包，升级会被覆盖）：

```yaml
- id: dsh-wall-mcp-manager
  config:
    servers:
      filesystem:
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/workspace']
```

> 注意：patch 会**整体替换**被命中行的 `config`，覆盖时要把需要的键全部写出。

运行时挂载 mcp-client 时引用的包名是一个字符串，静态配置检查（`verify-cordis-config`）
看不见它。插件因此导出 `MCP_PACKAGE` 常量，便于组合方把它声明为依赖。

## 开发与测试

```bash
npm test
# 等价于
node tests/inventory.test.mjs && node tests/mcp-bridge.test.mjs \
  && node tests/client-bundle.test.mjs
```

测试直接运行文件（避免 `node --test` 在受限沙箱下的子进程限制）。
本地需让 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`
可解析（可将 `node_modules/@deepseek-ai` 目录联结到 DSH 安装自带的运行时）。

测试的意图：

- **纯函数测试**（`inventory.test.mjs`）：配置校验、mcp-client 配置翻译（联合分支多带
  字段会被拒绝）、挂载计划与指纹（算错会让每次保存都重连 MCP）、返回 schema 拆包、
  工具前缀归组（错了会把工具挂到别的服务器名下）。
- **配置桥测试**（`mcp-bridge.test.mjs`）：凭据原文与键名都不出网、逐字段写入不抹掉
  界面从未见过的凭据、回环来源限制、多级 path、修订冲突拒绝、只读存储与 Schema 约束
  在桥上同样生效、settings 缺失时只读路由照常工作。用真实 settings 实现 + 内存路由表
  驱动，不绑定端口（被测对象是路由逻辑，`listen` 只会引入沙箱网络权限依赖）。
- **客户端 bundle 测试**（`client-bundle.test.mjs`）：在 VM 沙箱里执行浏览器 bundle，
  验证 `__ModuleLoader__` 握手 id、`inject`（缺了 `slots`，bundle 会在真实运行时 FAILED）、
  槽位注册，以及 `draftToOps` —— 那是界面改动翻成 mutate 操作的唯一出口，一旦它在
  凭据框留空时多写一个 `secretEnv`，宿主侧再怎么脱敏也救不回来。

## 目录结构

```
dsh-wall-mcp-manager/
├── package.json          # 插件包声明（dsh.bundle.patch → cordis.patch.yml，dsh.client → 浏览器 bundle）
├── cordis.patch.yml      # Bundle 配置入口（插件条目与默认配置，出厂 servers 为空）
├── lib/
│   └── client.js         # 浏览器端 bundle：设置界面「MCP 服务器」页面（settings.section）
├── src/
│   ├── index.js          # Cordis 插件入口：Config Schema + 服务器清单对账（挂载/更新/卸载）
│   ├── inventory.js      # 纯函数层：配置校验与翻译、挂载计划与指纹、返回 schema 拆包、工具归组
│   └── mcp-bridge.js     # 回环配置桥路由：describe / mutate / servers / tools
└── tests/                # 纯函数测试 + 配置桥测试（真实 settings）+ 客户端 bundle 契约测试
```
