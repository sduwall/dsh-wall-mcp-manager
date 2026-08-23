/**
 * 纯函数层测试：配置校验、mcp-client 配置翻译、挂载计划、返回 schema 拆包、工具归组。
 *
 * 这一层的每条规则都对应一个真实故障：
 * 联合分支多带字段会被 mcp-client 拒绝、指纹算错会让每次保存都重连 MCP、
 * 前缀归组错会把工具挂到别的服务器名下。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MCP_PACKAGE,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  fiberStateLabel,
  toolPrefix,
  validateServer,
  toMcpConfig,
  planServers,
  unwrapOutputSchema,
  groupTools,
  describeTool,
} from '../src/inventory.js'

test('MCP_PACKAGE 指向运行时挂载的 mcp-client 包', () => {
  assert.equal(MCP_PACKAGE, '@deepseek-ai/dsh-mcp-client')
})

test('fiberStateLabel 覆盖 FiberState 全部取值与非法输入', () => {
  assert.equal(fiberStateLabel(0), '待启动')
  assert.equal(fiberStateLabel(1), '启动中')
  assert.equal(fiberStateLabel(2), '运行中')
  assert.equal(fiberStateLabel(3), '启动失败')
  assert.equal(fiberStateLabel(4), '已释放')
  assert.equal(fiberStateLabel(5), '卸载中')
  assert.equal(fiberStateLabel(9), '未知(9)')
  assert.equal(fiberStateLabel(undefined), '未挂载')
})

test('toolPrefix 与 mcp-client 的公开工具名规则一致', () => {
  assert.equal(toolPrefix('filesystem'), 'mcp__filesystem__')
})

test('validateServer 拒绝非法名称、非法 transport 与缺字段', () => {
  assert.equal(validateServer('ok_name-1', { transport: 'stdio', command: 'npx' }).ok, true)
  assert.equal(validateServer('bad name', { command: 'npx' }).ok, false, '空格不合法')
  assert.equal(validateServer('a'.repeat(33), { command: 'npx' }).ok, false, '超过 32 位不合法')
  assert.equal(validateServer('x', null).ok, false)
  assert.equal(validateServer('x', { transport: 'sse', url: 'http://a' }).ok, false, 'sse 不在支持列表')
  // stdio 缺 command / streamable-http 缺 url
  assert.match(validateServer('x', { transport: 'stdio', command: '   ' }).reason, /command/)
  assert.match(validateServer('x', { transport: 'streamable-http', url: '' }).reason, /url/)
})

test('validateServer 默认 transport 为 stdio', () => {
  assert.equal(validateServer('x', { command: 'npx' }).ok, true)
  assert.equal(validateServer('x', {}).ok, false)
})

test('toMcpConfig 的 stdio 分支只输出该分支字段，并合并 secretEnv', () => {
  const config = toMcpConfig('fs', {
    transport: 'stdio',
    command: '  npx  ',
    args: ['-y', 'server-filesystem', 42],
    env: { LANG: 'zh_CN', TOKEN: '明文会被凭据覆盖' },
    secretEnv: { TOKEN: 's3cr3t' },
    cwd: '/tmp',
    toolCallTimeoutMs: 15000,
    // 别分支字段：必须不出现在输出里，否则 z.union 直接拒绝
    url: 'http://should-not-appear',
    headers: { 'X-A': '1' },
    description: '不属于 mcp-client 配置',
  })
  assert.deepEqual(config, {
    serverName: 'fs',
    toolCallTimeoutMs: 15000,
    failOnStartupError: false,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server-filesystem'],
    env: { LANG: 'zh_CN', TOKEN: 's3cr3t' },
    cwd: '/tmp',
  })
})

test('toMcpConfig 的 streamable-http 分支只输出该分支字段，并合并 secretHeaders', () => {
  const config = toMcpConfig('weather', {
    transport: 'streamable-http',
    url: ' https://mcp.example.com/mcp ',
    headers: { 'X-Trace': 'on', Authorization: '明文会被凭据覆盖' },
    secretHeaders: { Authorization: 'Bearer abc' },
    failOnStartupError: true,
    // 别分支字段
    command: 'npx',
    args: ['-y'],
    env: { A: '1' },
    cwd: '/tmp',
  })
  assert.deepEqual(config, {
    serverName: 'weather',
    toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: true,
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: { 'X-Trace': 'on', Authorization: 'Bearer abc' },
  })
})

test('toMcpConfig 丢掉非字符串的 env / headers / args 元素', () => {
  const config = toMcpConfig('x', {
    command: 'node',
    args: ['a', 1, null, 'b'],
    env: { OK: 'v', BAD: 3, NESTED: { a: 1 } },
  })
  assert.deepEqual(config.args, ['a', 'b'])
  assert.deepEqual(config.env, { OK: 'v' })
})

test('planServers 跳过停用与半成品，并给出可展示的原因', () => {
  const { desired, skipped } = planServers({
    good: { command: 'npx', args: ['-y'] },
    off: { enabled: false, command: 'npx' },
    half: { transport: 'stdio', command: '' },
    'bad name': { command: 'npx' },
  })
  assert.deepEqual([...desired.keys()], ['good'])
  assert.deepEqual(
    skipped.map((item) => item.name),
    ['off', 'half', 'bad name'],
  )
  assert.equal(skipped[0].reason, '已停用')
  assert.match(skipped[1].reason, /command/)
})

test('planServers 的指纹只随 mcp-client 配置变化，与 description 无关', () => {
  const base = { command: 'npx', args: ['-y'], description: '原描述' }
  const before = planServers({ fs: base }).desired.get('fs').key
  const sameConfig = planServers({ fs: { ...base, description: '改了描述' } }).desired.get('fs').key
  const changed = planServers({ fs: { ...base, args: ['-y', '--ro'] } }).desired.get('fs').key
  assert.equal(before, sameConfig, '只改描述不该触发 MCP 重连')
  assert.notEqual(before, changed, '改启动参数必须触发热更新')
})

test('planServers 容忍非对象输入', () => {
  assert.equal(planServers(undefined).desired.size, 0)
  assert.equal(planServers([]).desired.size, 0)
})

test('unwrapOutputSchema 区分结构化返回、纯文本返回与非包装 schema', () => {
  const structured = unwrapOutputSchema({
    type: 'object',
    properties: {
      content: { type: 'array', items: {} },
      structuredContent: { type: 'object', properties: { total: { type: 'number' } } },
    },
    required: ['content', 'structuredContent'],
    additionalProperties: false,
  })
  assert.equal(structured.kind, 'structured')
  assert.deepEqual(structured.structured.properties.total, { type: 'number' })
  assert.deepEqual(structured.required, ['content', 'structuredContent'])

  const text = unwrapOutputSchema({
    type: 'object',
    properties: { content: { type: 'array', items: {} }, structuredContent: {} },
    required: ['content'],
  })
  assert.equal(text.kind, 'text', 'structuredContent 为空对象说明工具没声明 outputSchema')
  assert.equal(text.structured, undefined)

  for (const raw of [undefined, { type: 'string' }, { properties: { a: {} } }]) {
    assert.equal(unwrapOutputSchema(raw).kind, 'raw')
  }
})

/** 最小 ctx.tools 桩 */
function fakeTools(tools) {
  return {
    schemas: () => tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    get: (name) => tools.find((tool) => tool.name === name),
  }
}

test('groupTools 按最长前缀归组，非 MCP 工具被忽略', () => {
  const runtime = fakeTools([
    { name: 'mcp__fs__read', parameters: { type: 'object' }, output: { schema: {} } },
    { name: 'mcp__fs_ro__read', parameters: { type: 'object' }, output: { schema: {} } },
    { name: 'shell_exec', parameters: {} },
  ])
  const { groups, orphans } = groupTools(runtime, ['fs', 'fs_ro'])
  const byServer = new Map(groups.map((group) => [group.server, group.tools.map((tool) => tool.name)]))
  assert.deepEqual(byServer.get('fs'), ['mcp__fs__read'], 'fs_ro 的工具不能落到 fs 名下')
  assert.deepEqual(byServer.get('fs_ro'), ['mcp__fs_ro__read'])
  assert.equal(orphans.length, 0)
})

test('groupTools 把别处挂载的 MCP 工具单列为 orphans', () => {
  const runtime = fakeTools([
    { name: 'mcp__other__ping', parameters: {}, output: { schema: {} } },
  ])
  const { groups, orphans } = groupTools(runtime, ['fs'])
  assert.deepEqual(groups, [{ server: 'fs', tools: [] }], '已配置但未注册工具的服务器仍要出现在清单里')
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].server, undefined)
  assert.equal(orphans[0].rawName, undefined, '不属于已配置服务器时不猜 rawName')
})

test('groupTools 容忍缺失的 tools 服务', () => {
  assert.deepEqual(groupTools(undefined, ['fs']), { groups: [{ server: 'fs', tools: [] }], orphans: [] })
})

test('describeTool 输出参数、rawName 与拆包后的返回契约', () => {
  const runtime = fakeTools([
    {
      name: 'mcp__fs__read_file',
      description: '读取文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array', items: {} },
            structuredContent: { type: 'object', properties: { text: { type: 'string' } } },
          },
        },
      },
    },
  ])
  const view = describeTool(runtime, runtime.schemas()[0], 'fs')
  assert.equal(view.name, 'mcp__fs__read_file')
  assert.equal(view.rawName, 'read_file')
  assert.equal(view.server, 'fs')
  assert.equal(view.description, '读取文件')
  assert.deepEqual(view.parameters.required, ['path'])
  assert.equal(view.output.kind, 'structured')
})
