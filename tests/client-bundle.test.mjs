/**
 * 浏览器端 bundle（lib/client.js）契约测试。
 *
 * 它不在 React 运行时里渲染，而是复刻 DSH 客户端 loader 的握手：
 * 1. bundle 顶部通过 `window.__ModuleLoader__.load({ id, factory })` 注册自己；
 * 2. loader 用模块表绑定的 require 调用 factory，得到 bundle 的导出；
 * 3. cordis `registry.plugin` 从导出里读 `inject`（服务名）与 `apply`。
 *
 * 除握手外，这里还钉住表单值互转与 `draftToOps`：那是「界面改动」翻成
 * settings mutate 操作的唯一出口，一旦它多写一个 `secretEnv`，
 * 宿主侧再怎么脱敏也救不回来——凭据会被界面上的空框抹掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT_BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/**
 * 在 VM 沙箱里执行浏览器 bundle：提供假的 `window.__ModuleLoader__`
 * 捕获握手，随后用桩 require 调用 factory 得到导出。
 */
function loadBundle() {
  const handoffs = []
  const sandbox = {
    console,
    window: { __ModuleLoader__: { load: (handoff) => handoffs.push(handoff) } },
  }
  sandbox.window.window = sandbox.window
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT_BUNDLE, 'utf8'), sandbox)

  assert.equal(handoffs.length, 1, 'bundle 应恰好注册一次握手')
  const handoff = handoffs[0]

  const exports = handoff.factory((specifier) => {
    if (specifier === 'react') {
      // 渲染期才用到 createElement / useState；契约测试只调用 apply 与纯函数
      return { createElement: () => { throw new Error('test: 不应在 apply 阶段渲染') } }
    }
    throw new Error(`bundle 不应 require 模块表之外的模块：${specifier}`)
  })
  return { handoff, exports }
}

/**
 * 把 VM 域里的数据结构搬回宿主域。
 *
 * bundle 在 `vm.createContext` 里执行，它造出的对象/数组的原型来自 VM 域，
 * 与宿主的 `Object.prototype` / `Array.prototype` 不同一。`node:assert/strict`
 * 的 `deepEqual` 会比较原型，于是结构完全一致的值也会被判「same structure
 * but not reference-equal」。这里按纯数据重建一遍，只比较值。
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('bundle 以插件包名注册 __ModuleLoader__ 握手', () => {
  const { handoff } = loadBundle()
  assert.equal(handoff.id, 'dsh-wall-mcp-manager')
  assert.equal(typeof handoff.factory, 'function')
})

test('bundle 导出 inject=slots，供 cordis fiber 注入（apply 读 ctx.slots）', () => {
  const { exports } = loadBundle()
  // 展开成宿主数组再断言：VM 域数组的原型与宿主不同，deepStrictEqual 会误报
  assert.deepEqual([...exports.inject], ['slots'], '必须声明 slots，否则 apply 访问 ctx.slots 被 Guard 拒绝')
})

test('bundle 的桥前缀与宿主侧路由一致', () => {
  const { exports } = loadBundle()
  // 前缀写错等于界面拿不到任何数据，而且只在真实部署里才暴露
  assert.equal(exports.BRIDGE_PREFIX, '/api/dsh-wall-mcp-manager')
})

test('apply 通过 slots.inject 注册 settings.section（等待壳声明，不裸注册）', () => {
  const { exports } = loadBundle()
  const injected = []
  const entries = []

  /** 复刻 SlotRegistry 的最小行为：inject 等待声明后才执行注册回调 */
  const slots = {
    inject: (key, register) => {
      injected.push({ key, register })
      return () => {}
    },
    register: (options, component) => {
      entries.push({ options, component })
      return () => {}
    },
  }

  // apply 无返回值：slots.inject 的注册随 fiber 生命周期自动回收
  exports.apply({ slots })
  assert.equal(injected.length, 1)
  assert.equal(injected[0].key, 'settings.section')

  // 声明到达后执行注册回调：条目 id/order/文案与宿主侧保持一致
  injected[0].register()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].options.name, 'settings.section')
  assert.equal(entries[0].options.id, 'dsh-wall-mcp-manager')
  assert.equal(entries[0].options.order, 270)
  assert.equal(entries[0].options.label(), 'MCP 服务器')
  assert.equal(entries[0].component, exports.McpManagerSection)
})

test('parseDict 解析 KEY=value，容忍空行、缺等号与值内等号', () => {
  const { exports } = loadBundle()
  // 缺等号的整行（BAD）直接丢弃；值里的 `=` 保留，只按第一个等号切分
  assert.deepEqual(plain(exports.parseDict('A=1\n\n B = 2 \nBAD\nURL=http://a?x=1')), {
    A: '1',
    B: '2',
    URL: 'http://a?x=1',
  })
  // `=` 开头的行没有键名，必须丢掉而不是产生空键
  assert.deepEqual(plain(exports.parseDict('=novalue')), {})
  assert.deepEqual(plain(exports.parseDict(undefined)), {})
})

test('formatDict 与 parseDict 互为逆运算', () => {
  const { exports } = loadBundle()
  const dict = { LANG: 'zh_CN', TOKEN: 'abc' }
  assert.deepEqual(plain(exports.parseDict(exports.formatDict(dict))), dict)
  assert.equal(exports.formatDict(undefined), '')
})

test('parseLines 每行一个参数，不按空格拆分', () => {
  const { exports } = loadBundle()
  assert.deepEqual(plain(exports.parseLines('-y\n@scope/pkg\nD:/my dir\n\n')), [
    '-y',
    '@scope/pkg',
    // 含空格的路径必须整体保留，否则 MCP 子进程会收到两个参数
    'D:/my dir',
  ])
})

test('isSecretSet 按完整 path 判断，不做前缀匹配', () => {
  const { exports } = loadBundle()
  const secrets = [
    { path: ['servers', 'fs', 'secretEnv'], set: true },
    { path: ['servers', 'fs', 'secretHeaders'], set: false },
  ]
  assert.equal(exports.isSecretSet(secrets, ['servers', 'fs', 'secretEnv']), true)
  assert.equal(exports.isSecretSet(secrets, ['servers', 'fs', 'secretHeaders']), false)
  assert.equal(exports.isSecretSet(secrets, ['servers', 'other', 'secretEnv']), false)
  assert.equal(exports.isSecretSet(undefined, ['servers', 'fs', 'secretEnv']), false)
})

test('draftToOps 校验名称与超时，拒绝缺 command / url 的草稿', () => {
  const { exports } = loadBundle()
  const stdio = { transport: 'stdio', description: '', command: 'npx', args: '', env: '', cwd: '', secretEnv: '', toolCallTimeoutMs: '60000' }
  assert.equal(exports.draftToOps('bad name', stdio, true).ok, false)
  assert.equal(exports.draftToOps('a'.repeat(33), stdio, true).ok, false)
  assert.equal(exports.draftToOps('fs', { ...stdio, toolCallTimeoutMs: '10' }, true).ok, false)
  assert.equal(exports.draftToOps('fs', { ...stdio, toolCallTimeoutMs: '' }, true).ok, false)
  assert.equal(exports.draftToOps('fs', { ...stdio, command: '   ' }, true).ok, false)
  assert.equal(
    exports.draftToOps('w', { ...stdio, transport: 'streamable-http', url: '', headers: '', secretHeaders: '' }, true).ok,
    false,
  )
})

test('draftToOps 的 stdio 草稿只写 stdio 字段，新建时落 enabled', () => {
  const { exports } = loadBundle()
  const verdict = exports.draftToOps(
    'fs',
    {
      transport: 'stdio',
      description: '本地文件',
      command: ' npx ',
      args: '-y\nserver-filesystem',
      env: 'LANG=zh_CN',
      cwd: ' D:/ws ',
      secretEnv: '',
      toolCallTimeoutMs: '15000',
    },
    true,
  )
  assert.equal(verdict.ok, true)
  const byField = new Map(verdict.ops.map((op) => [op.path.join('.'), op]))
  assert.equal(byField.get('servers.fs.enabled').value, true, '新建必须落 enabled，否则整台服务器不成形')
  assert.equal(byField.get('servers.fs.command').value, 'npx')
  assert.deepEqual(plain(byField.get('servers.fs.args').value), ['-y', 'server-filesystem'])
  assert.deepEqual(plain(byField.get('servers.fs.env').value), { LANG: 'zh_CN' })
  assert.equal(byField.get('servers.fs.cwd').value, 'D:/ws')
  assert.equal(byField.get('servers.fs.toolCallTimeoutMs').value, 15000, '超时必须写成数字，字符串会被 Schema 拒绝')
  // 别分支字段一律不写，避免把 stdio 服务器写成半个 http 服务器
  assert.equal(byField.has('servers.fs.url'), false)
  assert.equal(byField.has('servers.fs.headers'), false)
})

test('draftToOps 凭据框留空时不写凭据字段（留空 = 保持不变）', () => {
  const { exports } = loadBundle()
  const base = {
    transport: 'stdio',
    description: '',
    command: 'npx',
    args: '',
    env: '',
    cwd: '',
    secretEnv: '   ',
    toolCallTimeoutMs: '60000',
  }
  const keep = exports.draftToOps('fs', base, false)
  assert.equal(
    keep.ops.some((op) => op.path.includes('secretEnv')),
    false,
    '留空绝不能写 secretEnv，否则已配置的凭据会被空字典覆盖',
  )

  const write = exports.draftToOps('fs', { ...base, secretEnv: 'TOKEN=abc' }, false)
  const op = write.ops.find((item) => item.path.includes('secretEnv'))
  assert.deepEqual(plain(op.value), { TOKEN: 'abc' })
})

test('draftToOps 的 streamable-http 草稿只写该分支字段', () => {
  const { exports } = loadBundle()
  const verdict = exports.draftToOps(
    'weather',
    {
      transport: 'streamable-http',
      description: '',
      url: ' https://mcp.example.com/mcp ',
      headers: 'X-Trace=on',
      secretHeaders: 'Authorization=Bearer abc',
      command: 'npx',
      args: '-y',
      env: 'A=1',
      cwd: '/tmp',
      secretEnv: 'LEAK=1',
      toolCallTimeoutMs: '60000',
    },
    false,
  )
  assert.equal(verdict.ok, true)
  const byField = new Map(verdict.ops.map((op) => [op.path.join('.'), op]))
  assert.equal(byField.get('servers.weather.url').value, 'https://mcp.example.com/mcp')
  assert.deepEqual(plain(byField.get('servers.weather.headers').value), { 'X-Trace': 'on' })
  assert.deepEqual(plain(byField.get('servers.weather.secretHeaders').value), { Authorization: 'Bearer abc' })
  for (const field of ['command', 'args', 'env', 'cwd', 'secretEnv']) {
    assert.equal(byField.has(`servers.weather.${field}`), false, `${field} 不属于 streamable-http 分支`)
  }
})

test('typeText 用短文本概括 JSON Schema 类型，未知形态不编造', () => {
  const { exports } = loadBundle()
  assert.equal(exports.typeText({ type: 'string' }), 'string')
  assert.equal(exports.typeText({ type: 'array', items: { type: 'number' } }), 'array<number>')
  assert.equal(exports.typeText({ enum: ['a', 'b'] }), 'enum("a" | "b")')
  assert.equal(exports.typeText({ type: ['string', 'null'] }), 'string | null')
  assert.equal(exports.typeText({ properties: {} }), 'object')
  assert.equal(exports.typeText({ anyOf: [] }), 'union')
  assert.equal(exports.typeText(undefined), 'any')
})

test('settleVerdict：fiber「运行中」但没有工具时不算连上，仍需继续等', () => {
  const { exports } = loadBundle()
  const verdict = exports.settleVerdict('weather', {
    servers: [{ name: 'weather', mounted: true, state: '运行中' }],
    groups: [],
  })
  // 这是本次修复的核心：mcp-client 在 failOnStartupError=false 下
  // 握手失败也不会让 fiber 失败，所以「运行中」不能当作连接成功。
  assert.equal(verdict.done, false)
  assert.equal(verdict.kind, 'info')
})

test('settleVerdict：注册出工具才判定为已连接', () => {
  const { exports } = loadBundle()
  const verdict = exports.settleVerdict('weather', {
    servers: [{ name: 'weather', mounted: true, state: '运行中' }],
    groups: [{ server: 'weather', tools: [{ name: 'mcp__weather__now' }] }],
  })
  assert.equal(verdict.done, true)
  assert.equal(verdict.kind, 'success')
  assert.match(verdict.text, /已连接/)
})

test('settleVerdict：跳过原因、启动失败与失踪都立刻收敛成错误', () => {
  const { exports } = loadBundle()
  const skipped = exports.settleVerdict('weather', {
    servers: [{ name: 'weather', mounted: false, state: '未挂载', skipReason: '缺少 URL' }],
    groups: [],
  })
  assert.equal(skipped.done, true)
  assert.equal(skipped.kind, 'error')
  assert.match(skipped.text, /缺少 URL/)

  const failed = exports.settleVerdict('weather', {
    servers: [{ name: 'weather', mounted: true, state: '启动失败', error: '命令不存在' }],
    groups: [],
  })
  assert.equal(failed.done, true)
  assert.equal(failed.kind, 'error')

  const missing = exports.settleVerdict('weather', { servers: [], groups: [] })
  assert.equal(missing.done, true)
  assert.equal(missing.kind, 'error')
})

test('upsertNotice：同一台服务器的连续提示原地归并，不堆积', () => {
  const { exports } = loadBundle()
  // watchServer 每 500ms 改写一次文案，追加的话 8 秒能堆出十几条同源消息
  let list = exports.upsertNotice([], {
    channel: 'weather',
    kind: 'success',
    text: '已保存 weather，正在重连…',
    pending: true,
  }, 1, 1000)
  list = exports.upsertNotice(list, {
    channel: 'weather',
    kind: 'info',
    text: 'weather 正在连接…',
    pending: true,
  }, 2, 1500)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 1, '归并要保留原身份，否则销毁计时会被文案变化重置')
  assert.equal(list[0].text, 'weather 正在连接…')
})

test('upsertNotice：pending 期间不记计时起点，拿到定论才开始计时', () => {
  const { exports } = loadBundle()
  let list = exports.upsertNotice([], {
    channel: 'weather',
    kind: 'success',
    text: '已保存 weather，正在重连…',
    pending: true,
  }, 1, 1000)
  // 这是本次修复的要点：握手可能很慢，从点保存起算会让提示在结果出来前就消失
  assert.equal(list[0].settledAt, undefined)

  list = exports.upsertNotice(list, {
    channel: 'weather',
    kind: 'success',
    text: 'weather 已连接，注册 3 个工具',
    pending: false,
  }, 2, 9000)
  assert.equal(list[0].settledAt, 9000)
  assert.match(list[0].text, /注册 3 个工具/)
})

test('upsertNotice：已开始计时的提示不因后续更新而续命', () => {
  const { exports } = loadBundle()
  let list = exports.upsertNotice([], {
    channel: 'weather',
    kind: 'success',
    text: 'weather 已连接，注册 3 个工具',
  }, 1, 1000)
  assert.equal(list[0].settledAt, 1000)

  list = exports.upsertNotice(list, {
    channel: 'weather',
    kind: 'error',
    text: 'weather 启动失败',
  }, 2, 5000)
  assert.equal(list[0].settledAt, 1000, '同 channel 的后续终态不应重置计时起点')
})

test('upsertNotice：不同 channel 各自排队共存', () => {
  const { exports } = loadBundle()
  let list = exports.upsertNotice([], { channel: 'weather', kind: 'success', text: 'A' }, 1, 1000)
  list = exports.upsertNotice(list, { channel: 'mysql', kind: 'success', text: 'B' }, 2, 1200)
  // 不用 deepStrictEqual：沙箱里造出的数组原型属于另一个 realm，会误判不等
  assert.equal(list.length, 2)
  assert.equal(list[0].channel, 'weather')
  assert.equal(list[0].id, 1)
  assert.equal(list[1].channel, 'mysql')
  assert.equal(list[1].id, 2)
})

test('NOTICE_TTL_MS：提示存活 10 秒', () => {
  const { exports } = loadBundle()
  assert.equal(exports.NOTICE_TTL_MS, 10000)
})
