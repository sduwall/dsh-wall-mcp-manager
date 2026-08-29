/**
 * 纯函数层：把「用户配置的 MCP 服务清单」翻译成 mcp-client 实例配置，
 * 并把 `ctx.tools` 里的工具按服务归组、拆出参数与返回 schema。
 *
 * 这一层刻意不碰 cordis / http，任何一条规则都能被单元测试直接钉住。
 *
 * @module
 */

/** 运行时挂载的 MCP 客户端包名（一个实例 = 一个 MCP 服务） */
export const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * serverName 的合法形态，与 `@deepseek-ai/dsh-mcp-client` 的 `SERVER_NAME_PATTERN`
 * 保持一致。名字不合法时 mcp-client 会在挂载阶段抛错，所以在这里先挡住，
 * 让用户在界面上就看到原因，而不是去日志里翻。
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 支持的传输方式（与 mcp-client 的 Config 联合分支一一对应） */
export const TRANSPORTS = ['stdio', 'streamable-http']

/** 工具默认调用超时（毫秒），与 mcp-client 的 DEFAULT_TOOL_CALL_TIMEOUT_MS 同量级 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000

/** cordis fiber 状态码 → 中文标签（`FiberState`：0..5） */
const FIBER_STATE_LABELS = ['待启动', '启动中', '运行中', '启动失败', '已释放', '卸载中']

/** 把 fiber 状态码翻成人话；未知值原样带出，避免 UI 显示空白 */
export function fiberStateLabel(state) {
  if (typeof state !== 'number') return '未挂载'
  return FIBER_STATE_LABELS[state] ?? `未知(${state})`
}

/** 一个 MCP 工具的公开名前缀：`mcp__<serverName>__` */
export function toolPrefix(serverName) {
  return `mcp__${serverName}__`
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只保留字符串键值对，丢掉用户误填的嵌套结构（mcp-client 的 env/headers 是 dict(String)） */
function stringDict(value) {
  if (!isRecord(value)) return {}
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

/** 只保留字符串元素的数组（args 是 array(String)） */
function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string')
}

/**
 * 校验单个服务配置是否可以挂载。
 *
 * 返回 `{ ok: false, reason }` 而不是抛错：配置界面里「填一半的服务」是常态，
 * 半成品不该让整份配置或其他服务跟着失效。
 *
 * @param {string} serverName 配置里的键名，同时作为 mcp-client 的 serverName
 * @param {object} server 单个服务配置
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateServer(serverName, server) {
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    return { ok: false, reason: '名称需为 1-32 位的字母、数字、下划线或连字符' }
  }
  if (!isRecord(server)) return { ok: false, reason: '配置格式不正确' }
  const transport = server.transport ?? 'stdio'
  if (!TRANSPORTS.includes(transport)) {
    return { ok: false, reason: `不支持的 transport：${transport}` }
  }
  if (transport === 'stdio') {
    if (typeof server.command !== 'string' || server.command.trim() === '') {
      return { ok: false, reason: 'stdio 传输需要填写 command' }
    }
    return { ok: true }
  }
  if (typeof server.url !== 'string' || server.url.trim() === '') {
    return { ok: false, reason: 'streamable-http 传输需要填写 url' }
  }
  return { ok: true }
}

/**
 * 把一条服务配置翻译成 mcp-client 的实例配置。
 *
 * 只输出对应传输分支该有的字段：mcp-client 的 Config 是
 * `z.union([stdio, streamable-http])`，多带一个别分支的字段会直接被 Schema 拒绝。
 *
 * `secretEnv` / `secretHeaders` 在这里合并进 `env` / `headers`：它们在 settings
 * schema 里被标成 `role('secret')`，所以永远不会随 `/describe` 出网，但对
 * mcp-client 来说和普通环境变量、普通请求头没有区别。同名键以凭据为准。
 *
 * @param {string} serverName 服务名（作为工具名命名空间）
 * @param {object} server 单个服务配置
 * @returns {object} mcp-client 实例配置
 */
export function toMcpConfig(serverName, server) {
  const timeout =
    typeof server.toolCallTimeoutMs === 'number' && server.toolCallTimeoutMs > 0
      ? server.toolCallTimeoutMs
      : DEFAULT_TOOL_CALL_TIMEOUT_MS
  const shared = {
    serverName,
    toolCallTimeoutMs: timeout,
    failOnStartupError: server.failOnStartupError === true,
  }
  if ((server.transport ?? 'stdio') === 'streamable-http') {
    return {
      ...shared,
      transport: 'streamable-http',
      url: server.url.trim(),
      headers: { ...stringDict(server.headers), ...stringDict(server.secretHeaders) },
    }
  }
  return {
    ...shared,
    transport: 'stdio',
    command: server.command.trim(),
    args: stringList(server.args),
    env: { ...stringDict(server.env), ...stringDict(server.secretEnv) },
    cwd: typeof server.cwd === 'string' ? server.cwd : '',
  }
}

/**
 * 计算「应该挂载哪些 mcp-client 实例」。
 *
 * @param {Record<string, object>} servers 配置中的服务字典（键为 serverName）
 * @returns {{ desired: Map<string, { config: object, key: string }>, skipped: Array<{ name: string, reason: string }> }}
 *   `desired` 是待挂载集合，`key` 是配置指纹（用于判断该 update 还是保持不动）；
 *   `skipped` 说明每个被跳过的服务为什么没挂（停用 / 配置不完整）。
 */
export function planServers(servers) {
  const desired = new Map()
  const skipped = []
  if (!isRecord(servers)) return { desired, skipped }
  for (const [serverName, server] of Object.entries(servers)) {
    if (isRecord(server) && server.enabled === false) {
      skipped.push({ name: serverName, reason: '已停用' })
      continue
    }
    const verdict = validateServer(serverName, server)
    if (!verdict.ok) {
      skipped.push({ name: serverName, reason: verdict.reason })
      continue
    }
    const config = toMcpConfig(serverName, server)
    // 指纹用于热更新判定：只有配置真的变了才动 loader，避免每次保存都重连 MCP
    desired.set(serverName, { config, key: JSON.stringify(config) })
  }
  return { desired, skipped }
}

/**
 * 拆开 MCP 桥接后的返回 schema。
 *
 * mcp-client 给每个工具的 `output.schema` 套了一层固定包装：
 * `{ content: array, structuredContent: <MCP 的 outputSchema> ?? {} }`。
 * 直接把这层丢给用户看没有信息量，所以这里拆包：
 * - `structuredContent` 有内容 → 该工具声明了结构化返回，展示它的真实 schema；
 * - `structuredContent` 是 `{}` → 该工具只返回文本块，UI 应当明确说明。
 *
 * @param {unknown} schema `ctx.tools.get(name).output.schema`
 * @returns {{ kind: 'structured'|'text'|'raw', structured?: object, required: string[], raw: unknown }}
 */
export function unwrapOutputSchema(schema) {
  if (!isRecord(schema) || !isRecord(schema.properties) || !('content' in schema.properties)) {
    // 不是 MCP 桥接的包装（理论上不会出现），原样交给 UI 展示，绝不猜
    return { kind: 'raw', required: [], raw: schema }
  }
  const structured = schema.properties.structuredContent
  const hasStructured = isRecord(structured) && Object.keys(structured).length > 0
  return {
    kind: hasStructured ? 'structured' : 'text',
    structured: hasStructured ? structured : undefined,
    required: Array.isArray(schema.required) ? schema.required : [],
    raw: schema,
  }
}

/**
 * 从工具注册表里把 MCP 工具按服务归组。
 *
 * 为什么用前缀匹配而不是反解名字：`publicToolName` 在需要字符替换或截断时会
 * 追加哈希，其源码明确「the public name is never parsed to recover it」。
 * 但 `serverName` 本身受 `[A-Za-z0-9_-]{1,32}` 约束、不会被改写，
 * 所以 `mcp__<serverName>__` 这段前缀是可靠的，只有 rawName 可能被规范化。
 *
 * @param {{ schemas(): Array<object>, get(name: string): object | undefined }} runtime `ctx.tools`
 * @param {string[]} serverNames 已配置的服务名（决定归组顺序）
 * @returns {{ groups: Array<{ server: string, tools: Array<object> }>, orphans: Array<object> }}
 *   `orphans` 是带 `mcp__` 前缀但不属于任何已配置服务的工具
 *   （例如组合层 cordis.yml 里另外挂的 mcp-client 实例）。
 */
export function groupTools(runtime, serverNames) {
  const schemas = typeof runtime?.schemas === 'function' ? runtime.schemas() : []
  const buckets = new Map(serverNames.map((serverName) => [serverName, []]))
  const orphans = []

  for (const schema of schemas) {
    const toolName = schema?.name
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) continue
    // 最长前缀优先：serverName 之间可能存在前缀关系（如 `fs` 与 `fs_ro`）
    let owner
    for (const serverName of buckets.keys()) {
      if (!toolName.startsWith(toolPrefix(serverName))) continue
      if (owner === undefined || serverName.length > owner.length) owner = serverName
    }
    const view = describeTool(runtime, schema, owner)
    if (owner === undefined) orphans.push(view)
    else buckets.get(owner).push(view)
  }

  const groups = [...buckets].map(([server, tools]) => ({
    server,
    tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
  }))
  return { groups, orphans: orphans.sort((a, b) => a.name.localeCompare(b.name)) }
}

/**
 * 把单个工具整理成界面视图：模型可见的参数 + 拆包后的返回契约。
 *
 * 参数取自 `schemas()`（宿主已声明它只投影 name/description/parameters，
 * 不含任何执行或渲染回调），返回取自 `get(name).output.schema`。
 *
 * @param {object} runtime `ctx.tools`
 * @param {object} schema 来自 `schemas()` 的单条工具 schema
 * @param {string|undefined} serverName 归属服务（用于推断 rawName）
 * @returns {object} 工具视图
 */
export function describeTool(runtime, schema, serverName) {
  const definition = typeof runtime?.get === 'function' ? runtime.get(schema.name) : undefined
  const prefix = serverName === undefined ? undefined : toolPrefix(serverName)
  return {
    name: schema.name,
    // rawName 仅作展示提示：公开名可能被规范化过，不保证与服务端原名逐字相同
    rawName: prefix && schema.name.startsWith(prefix) ? schema.name.slice(prefix.length) : undefined,
    server: serverName,
    description: typeof schema.description === 'string' ? schema.description : '',
    parameters: schema.parameters,
    output: unwrapOutputSchema(definition?.output?.schema),
  }
}
