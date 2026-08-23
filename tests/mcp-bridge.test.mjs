/**
 * 配置桥路由测试：凭据脱敏、来源限制、多级 path、修订冲突，
 * 以及 `/servers` `/tools` 两条只读路由在没有 settings 时依然可用。
 *
 * 这些是「界面能改 MCP 配置」这条链路上真正容易出事的地方：
 * 凭据回传、非本机写入（该桥能写启动命令，等价于远程执行）、脏写覆盖。
 *
 * 这里用内存路由表 + 假 req/res 驱动，而不是真起 WebServer 监听端口：
 * 被测对象是路由处理逻辑本身，绑定端口只会让测试依赖沙箱的网络权限
 * （CI 与受限环境下 `listen` 可能直接失败）。settings 仍是真实实现，
 * 脱敏、Schema 校验、revision 冲突这些语义一个都没被替换掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import {
  registerBridgeRoutes,
  BRIDGE_PREFIX,
  BRIDGE_NAMESPACE,
  isLoopbackRequest,
  toWireView,
  validateOps,
} from '../src/mcp-bridge.js'

/**
 * 与插件宿主半同形的 Schema：扁平 object + transport 判别字段。
 *
 * 刻意不用嵌套 union —— `redactSecrets` 的 walk 只穿透 object/dict/array，
 * union 分支里的 secret 会被原样返回。这里保持同构，测试才有意义。
 */
const Server = Schema.object({
  enabled: Schema.boolean().default(true),
  transport: Schema.union(['stdio', 'streamable-http']).default('stdio'),
  description: Schema.string().default(''),
  command: Schema.string().default(''),
  args: Schema.array(String).default([]),
  env: Schema.dict(String).default({}),
  secretEnv: Schema.dict(String).role('secret').default(undefined),
  cwd: Schema.string().default(''),
  url: Schema.string().default(''),
  headers: Schema.dict(String).default({}),
  secretHeaders: Schema.dict(String).role('secret').default(undefined),
  toolCallTimeoutMs: Schema.number().default(60000).min(1000),
  failOnStartupError: Schema.boolean().default(false),
})

const TestConfig = Schema.object({ servers: Schema.dict(Server).default({}) })

/** 内存 settings provider */
class MemoryProvider extends SettingsProvider {
  constructor(ctx, options = {}) {
    super(ctx)
    this.doc = options.doc ?? {}
    this.readOnly = options.readOnly === true
  }

  get writable() {
    return !this.readOnly
  }

  async load() {
    return this.doc
  }

  async persist(ns, section) {
    this.doc = { ...this.doc, [ns]: section }
  }
}

/** 假 http 请求：桥只用到 socket.remoteAddress、method 与请求体流 */
function fakeRequest(body, options = {}) {
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
  return {
    method: options.method ?? 'POST',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  }
}

/** 假 http 响应：记录状态码与 JSON 体 */
function fakeResponse() {
  const captured = { status: undefined, json: undefined }
  return {
    captured,
    writeHead(status) {
      captured.status = status
    },
    end(body) {
      captured.json = body === undefined ? undefined : JSON.parse(body)
    },
  }
}

/** 起一套「真实 settings + 内存路由表 + 桥路由」的环境 */
async function startHarness(options = {}) {
  const root = new Context()
  await root.plugin(MemoryProvider, options)

  const routes = new Map()
  const bridgeCtx = {
    webServer: {
      register(route) {
        const key = `${route.kind} ${route.path}`
        if (routes.has(key)) throw new Error(`duplicate route: ${key}`)
        routes.set(key, route.handler)
        return () => routes.delete(key)
      },
    },
    get: (name) => root.get(name),
  }

  let scope
  if (options.registerNamespace !== false) {
    scope = root.get('settings').register(BRIDGE_NAMESPACE, TestConfig, { base: options.base ?? {} })
  }
  const dispose = registerBridgeRoutes(bridgeCtx, options.hooks ?? {})

  /** 直接驱动路由处理器，返回 { status, json }；路由不存在返回 status 404 */
  const call = async (path, body, init = {}) => {
    const handler = routes.get(`exact ${BRIDGE_PREFIX}${path}`)
    if (handler === undefined) return { status: 404, json: undefined }
    const res = fakeResponse()
    await handler(fakeRequest(body, init), res)
    return res.captured
  }
  return { root, call, scope, dispose, routes }
}

/** 不带 settings 的桥环境（headless / 未组合 settings 的部署） */
function startBareHarness(hooks = {}) {
  const routes = new Map()
  const bridgeCtx = {
    webServer: {
      register(route) {
        routes.set(`${route.kind} ${route.path}`, route.handler)
        return () => routes.delete(`${route.kind} ${route.path}`)
      },
    },
    get: () => undefined,
  }
  registerBridgeRoutes(bridgeCtx, hooks)
  return async (path, body) => {
    const handler = routes.get(`exact ${BRIDGE_PREFIX}${path}`)
    if (handler === undefined) return { status: 404, json: undefined }
    const res = fakeResponse()
    await handler(fakeRequest(body), res)
    return res.captured
  }
}

test('describe 返回脱敏视图：凭据原文与键名都不出网', async () => {
  const { root, call } = await startHarness({
    doc: {
      [BRIDGE_NAMESPACE]: {
        servers: {
          fs: {
            command: 'npx',
            env: { LANG: 'zh_CN' },
            secretEnv: { GITHUB_TOKEN: 'ghp_super_secret' },
          },
        },
      },
    },
  })
  try {
    const { status, json } = await call('/describe')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    const body = JSON.stringify(json)
    assert.equal(body.includes('ghp_super_secret'), false, '凭据原文绝不能出现在响应中')
    assert.equal(body.includes('GITHUB_TOKEN'), false, '整字典标 secret 时连键名都不该出网')
    assert.equal(json.value.value.servers.fs.command, 'npx', '非凭据字段应正常返回')
    assert.deepEqual(json.value.value.servers.fs.env, { LANG: 'zh_CN' })
    // secrets 只描述「这台服务器有没有配凭据」
    const slot = json.value.secrets.find((item) => item.path.join('.') === 'servers.fs.secretEnv')
    assert.equal(slot.set, true)
    const headerSlot = json.value.secrets.find(
      (item) => item.path.join('.') === 'servers.fs.secretHeaders',
    )
    assert.equal(headerSlot.set, false, '未配置的凭据应报告 set:false')
    assert.equal(typeof json.value.revision, 'number')
    assert.equal(json.writable, true)
  } finally {
    await root.fiber.dispose()
  }
})

test('mutate 支持 servers.<name>.<field> 多级 path，新增服务器立即生效', async () => {
  const { root, call } = await startHarness()
  try {
    const before = await call('/describe')
    const write = await call('/mutate', {
      ops: [
        { op: 'set', path: ['servers', 'fs', 'enabled'], value: true },
        { op: 'set', path: ['servers', 'fs', 'transport'], value: 'stdio' },
        { op: 'set', path: ['servers', 'fs', 'command'], value: 'npx' },
        { op: 'set', path: ['servers', 'fs', 'args'], value: ['-y', 'server-filesystem'] },
      ],
      expectedRevision: before.json.value.revision,
    })
    assert.equal(write.json.ok, true)
    assert.equal(write.json.value.value.servers.fs.command, 'npx')
    assert.deepEqual(write.json.value.value.servers.fs.args, ['-y', 'server-filesystem'])
    // 未填字段回落到 Schema 默认，界面不必逐个补齐
    assert.equal(write.json.value.value.servers.fs.toolCallTimeoutMs, 60000)
  } finally {
    await root.fiber.dispose()
  }
})

test('mutate 写入凭据后仍不回传原文，只报告已配置', async () => {
  const { root, call } = await startHarness({
    doc: { [BRIDGE_NAMESPACE]: { servers: { fs: { command: 'npx' } } } },
  })
  try {
    const before = await call('/describe')
    const write = await call('/mutate', {
      ops: [{ op: 'set', path: ['servers', 'fs', 'secretEnv'], value: { TOKEN: 'brand-new' } }],
      expectedRevision: before.json.value.revision,
    })
    assert.equal(write.json.ok, true)
    assert.equal(JSON.stringify(write.json).includes('brand-new'), false)
    const slot = write.json.value.secrets.find(
      (item) => item.path.join('.') === 'servers.fs.secretEnv',
    )
    assert.equal(slot.set, true)
  } finally {
    await root.fiber.dispose()
  }
})

test('逐字段写入不会抹掉界面从未见过的凭据', async () => {
  const { root, call } = await startHarness({
    doc: {
      [BRIDGE_NAMESPACE]: {
        servers: { fs: { command: 'npx', secretEnv: { TOKEN: 'keep-me' } } },
      },
    },
  })
  try {
    const before = await call('/describe')
    // 只改描述：这是界面「凭据框留空」时发出的 ops
    const write = await call('/mutate', {
      ops: [{ op: 'set', path: ['servers', 'fs', 'description'], value: '本地文件' }],
      expectedRevision: before.json.value.revision,
    })
    assert.equal(write.json.ok, true)
    const slot = write.json.value.secrets.find(
      (item) => item.path.join('.') === 'servers.fs.secretEnv',
    )
    assert.equal(slot.set, true, '改别的字段不该让凭据消失')
  } finally {
    await root.fiber.dispose()
  }
})

test('unset 可以删除整台服务器，也可以只清除凭据', async () => {
  const { root, call } = await startHarness({
    doc: {
      [BRIDGE_NAMESPACE]: {
        servers: {
          fs: { command: 'npx', secretEnv: { TOKEN: 'x' } },
          weather: { transport: 'streamable-http', url: 'https://a/mcp' },
        },
      },
    },
  })
  try {
    const current = await call('/describe')
    const clear = await call('/mutate', {
      ops: [{ op: 'unset', path: ['servers', 'fs', 'secretEnv'] }],
      expectedRevision: current.json.value.revision,
    })
    assert.equal(clear.json.ok, true)
    const slot = clear.json.value.secrets.find(
      (item) => item.path.join('.') === 'servers.fs.secretEnv',
    )
    assert.equal(slot.set, false, '清除后应报告未配置')

    const remove = await call('/mutate', {
      ops: [{ op: 'unset', path: ['servers', 'weather'] }],
      expectedRevision: clear.json.value.revision,
    })
    assert.equal(remove.json.ok, true)
    assert.equal(remove.json.value.value.servers.weather, undefined)
    assert.notEqual(remove.json.value.value.servers.fs, undefined, '删一台不该影响另一台')
  } finally {
    await root.fiber.dispose()
  }
})

test('Schema 约束在桥上同样生效（非法超时被拒绝且不落盘）', async () => {
  const { root, call } = await startHarness({
    doc: { [BRIDGE_NAMESPACE]: { servers: { fs: { command: 'npx' } } } },
  })
  try {
    const before = await call('/describe')
    const write = await call('/mutate', {
      ops: [{ op: 'set', path: ['servers', 'fs', 'toolCallTimeoutMs'], value: 10 }],
      expectedRevision: before.json.value.revision,
    })
    assert.equal(write.json.ok, false)
    assert.equal(write.json.code, 'rejected')
    const after = await call('/describe')
    assert.equal(after.json.value.value.servers.fs.toolCallTimeoutMs, 60000)
  } finally {
    await root.fiber.dispose()
  }
})

test('过期 revision 被拒绝，防止界面脏写覆盖并发修改', async () => {
  const { root, call, scope } = await startHarness()
  try {
    const stale = await call('/describe')
    // 模拟另一处（yml 编辑 / 另一个标签页）先写入，使 revision 前进
    await scope.update({ servers: { other: { command: 'node' } } })
    const write = await call('/mutate', {
      ops: [{ op: 'set', path: ['servers', 'fs', 'command'], value: 'npx' }],
      expectedRevision: stale.json.value.revision,
    })
    assert.equal(write.json.ok, false, '持有过期 revision 的写入必须被拒绝')
    const after = await call('/describe')
    assert.equal(after.json.value.value.servers.other.command, 'node', '先写入的值不应被覆盖')
    assert.equal(after.json.value.value.servers.fs, undefined)
  } finally {
    await root.fiber.dispose()
  }
})

test('只读存储下写入被拒绝，且界面被告知不可写', async () => {
  const { root, call } = await startHarness({ readOnly: true })
  try {
    const before = await call('/describe')
    assert.equal(before.json.writable, false)
    const write = await call('/mutate', {
      ops: [{ op: 'set', path: ['servers', 'fs', 'command'], value: 'npx' }],
    })
    assert.equal(write.json.ok, false)
  } finally {
    await root.fiber.dispose()
  }
})

test('非 POST 方法被拒绝（读操作也统一走 POST）', async () => {
  const { root, call } = await startHarness({
    hooks: { describeTools: () => ({ groups: [], orphans: [] }) },
  })
  try {
    assert.equal((await call('/describe', undefined, { method: 'GET' })).status, 405)
    assert.equal((await call('/tools', undefined, { method: 'GET' })).status, 405)
  } finally {
    await root.fiber.dispose()
  }
})

test('非回环来源一律 403（该桥可写入 MCP 启动命令）', async () => {
  const { root, call } = await startHarness({
    hooks: { describeTools: () => ({ groups: [], orphans: [] }) },
  })
  try {
    for (const path of ['/describe', '/mutate', '/tools']) {
      const result = await call(path, { ops: [] }, { remoteAddress: '192.168.0.106' })
      assert.equal(result.status, 403, `${path} 应拒绝非本机来源`)
      assert.equal(result.json.code, 'forbidden')
    }
  } finally {
    await root.fiber.dispose()
  }
})

test('/servers 与 /tools 原样返回宿主钩子结果', async () => {
  let serversCalled = 0
  const { root, call } = await startHarness({
    hooks: {
      describeServers: () => {
        serversCalled += 1
        return [{ name: 'fs', mounted: true, stateLabel: '运行中', toolCount: 3 }]
      },
      describeTools: () => ({
        groups: [{ server: 'fs', tools: [{ name: 'mcp__fs__read', output: { kind: 'structured' } }] }],
        orphans: [],
      }),
    },
  })
  try {
    const servers = await call('/servers')
    assert.equal(servers.json.ok, true)
    assert.equal(serversCalled, 1)
    assert.equal(servers.json.value[0].stateLabel, '运行中')

    const tools = await call('/tools')
    assert.equal(tools.json.ok, true)
    assert.equal(tools.json.value.groups[0].tools[0].name, 'mcp__fs__read')
  } finally {
    await root.fiber.dispose()
  }
})

test('未提供钩子时只读路由不注册（宁可 404 也不回假数据）', async () => {
  const { root, call } = await startHarness()
  try {
    assert.equal((await call('/servers')).status, 404)
    assert.equal((await call('/tools')).status, 404)
  } finally {
    await root.fiber.dispose()
  }
})

test('钩子抛错被收敛成业务级失败，而不是打断响应', async () => {
  const { root, call } = await startHarness({
    hooks: {
      describeServers: () => {
        throw new Error('loader 尚未就绪')
      },
    },
  })
  try {
    const result = await call('/servers')
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.code, 'rejected')
    assert.match(result.json.message, /loader/)
  } finally {
    await root.fiber.dispose()
  }
})

test('settings 服务缺失时 describe 明确报告，而只读路由照常工作', async () => {
  const post = startBareHarness({
    describeServers: () => [],
    describeTools: () => ({ groups: [], orphans: [] }),
  })
  const describe = await post('/describe')
  assert.equal(describe.json.ok, false)
  assert.equal(describe.json.code, 'settings-absent')
  // 运行时事实不依赖 settings：只读展示在 headless 组合里也该可用
  assert.equal((await post('/tools')).json.ok, true)
})

test('命名空间未注册时 describe 报告 namespace-unregistered', async () => {
  const { root, call } = await startHarness({ registerNamespace: false })
  try {
    const json = (await call('/describe')).json
    assert.equal(json.ok, false)
    assert.equal(json.code, 'namespace-unregistered')
  } finally {
    await root.fiber.dispose()
  }
})

test('validateOps 允许多级 path，拒绝未知操作与空段', () => {
  assert.equal(validateOps([{ op: 'set', path: ['servers', 'fs', 'command'], value: 'npx' }]).ok, true)
  assert.equal(validateOps([{ op: 'unset', path: ['servers', 'fs'] }]).ok, true)
  for (const ops of [
    [],
    undefined,
    [{ op: 'delete', path: ['servers'] }],
    [{ op: 'set', path: [], value: 1 }],
    [{ op: 'set', path: ['servers', ''], value: 1 }],
    [{ op: 'set', path: ['servers', 3], value: 1 }],
  ]) {
    assert.equal(validateOps(ops).ok, false, `应拒绝：${JSON.stringify(ops)}`)
  }
})

test('isLoopbackRequest 只认本机地址', () => {
  const make = (remoteAddress) => ({ socket: { remoteAddress } })
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
    assert.equal(isLoopbackRequest(make(address)), true, `应接受 ${address}`)
  }
  for (const address of ['192.168.0.106', '10.0.0.5', '::ffff:192.168.0.106', '', undefined]) {
    assert.equal(isLoopbackRequest(make(address)), false, `应拒绝 ${address}`)
  }
})

test('toWireView 保留 UI 需要的字段', () => {
  const view = toWireView({
    ns: BRIDGE_NAMESPACE,
    value: { servers: {} },
    user: {},
    base: {},
    secrets: [{ path: ['servers', 'fs', 'secretEnv'], set: true }],
    revision: 7,
    schema: { type: 'object' },
  })
  assert.equal(view.revision, 7)
  assert.equal(view.secrets[0].set, true)
  assert.deepEqual(view.value, { servers: {} })
})
