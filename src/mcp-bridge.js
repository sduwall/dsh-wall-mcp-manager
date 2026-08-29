/**
 * Loopback 配置桥：把本插件的 settings 命名空间、MCP 挂载状态与工具契约
 * 暴露给同源的浏览器界面。
 *
 * 为什么需要自建路由：DSH 官方 `/api` 的 settings 读写被
 * `dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 硬编码白名单挡住，
 * 仓库外的第三方命名空间一律返回 `settings-not-exposed`；
 * 而 MCP 的挂载状态与工具 schema 更是官方通道里完全没有的东西
 * （`pluginInventory.list()` 只给 entryId / moduleName / enabled / fiberPhase）。
 *
 * @module
 */

/** 配置桥路由前缀（同源、默认仅回环） */
export const BRIDGE_PREFIX = '/api/dsh-wall-mcp-manager'

/** 允许通过本桥读写的命名空间——只有自己，绝不代理别人的配置 */
export const BRIDGE_NAMESPACE = 'dsh-wall-mcp-manager'

/**
 * 单次请求体上限。
 *
 * 比 dsh-client-info 的 64KB 放宽到 256KB：一份服务清单要装 args 数组、
 * env 字典与请求头，条目多时体积远大于单个扁平配置段。
 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 判断请求是否来自本机回环地址。
 *
 * 该桥能写入 MCP 的启动命令与凭据（`secretEnv` / `secretHeaders`），
 * 权限等价于「在宿主上执行任意进程」，所以默认只接受回环来源：
 * DSH 的 webserver 允许绑定 `0.0.0.0`，那种部署下不做来源校验
 * 等于把远程命令执行接口暴露到整个网段。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return false
  // 兼容 IPv4、IPv6 回环，以及 IPv4-mapped IPv6（::ffff:127.0.0.1）
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('::ffff:')) return address.slice(7).startsWith('127.')
  return address.startsWith('127.')
}

/** 读取并解析 JSON 请求体；超限或非法 JSON 抛错 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 统一 JSON 响应 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
    // 配置与运行状态绝不缓存
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * 把 settings 描述符整理成浏览器可安全消费的视图。
 *
 * `secrets: [{ path, set }]` 是凭据的唯一线索：原文已被
 * `describe({ redactSecrets: true })` 剥离，界面只能显示「已配置 / 未配置」。
 *
 * @param {object} descriptor settings.describe 返回的单个命名空间描述符
 * @returns {object} 浏览器视图
 */
export function toWireView(descriptor) {
  return {
    ns: descriptor.ns,
    // 已通过 describe({ redactSecrets: true }) 脱敏
    value: descriptor.value,
    user: descriptor.user,
    base: descriptor.base,
    secrets: descriptor.secrets ?? [],
    revision: descriptor.revision,
    schema: descriptor.schema,
  }
}

/**
 * 校验一批 mutate 操作。
 *
 * 与 dsh-client-info 的桥不同，这里**允许多级 path**：本插件的配置是
 * `servers.<name>.<field>` 的两三级结构，逐个服务改字段就必须多级寻址。
 * 宿主侧 `applyPathOp` 本身完整支持多级 path（中间层不存在时会按需创建），
 * 所以放宽这一层不会带来越界写入——`settings.mutate` 只作用于本命名空间。
 *
 * @param {unknown} ops 请求体里的 ops 数组
 * @returns {{ ok: true, ops: object[] } | { ok: false, message: string }}
 */
export function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, message: 'ops 不能为空' }
  for (const op of ops) {
    if (op?.op !== 'set' && op?.op !== 'unset') {
      return { ok: false, message: `不支持的操作：${op?.op}` }
    }
    if (!Array.isArray(op.path) || op.path.length === 0) {
      return { ok: false, message: 'path 必须是非空的字段名数组' }
    }
    if (op.path.some((segment) => typeof segment !== 'string' || segment === '')) {
      return { ok: false, message: 'path 的每一段都必须是非空字符串' }
    }
  }
  return { ok: true, ops }
}

/**
 * 注册配置桥路由。
 *
 * 路由（均为 POST，读操作也走 POST 以统一处理，且避免任何 GET 缓存歧义）：
 * - `POST <prefix>/describe` → 当前命名空间的脱敏配置视图（含 revision 与 schema）
 * - `POST <prefix>/mutate`   → 按 `{ ops, expectedRevision }` 精确改字段
 * - `POST <prefix>/servers`  → 每个服务的挂载状态（fiber 相位 / 跳过原因 / 失败原因）
 * - `POST <prefix>/tools`    → 按服务归组的工具清单，含参数与拆包后的返回 schema
 *
 * 用 `mutate`（而非整体替换）是刻意的：浏览器持有的视图是**脱敏的**，
 * 整体替换会把它从未见过的 `secretEnv` / `secretHeaders` 一并抹掉。
 *
 * `/servers` 与 `/tools` 不需要 settings 服务——它们读的是运行时事实，
 * 所以走一条不含 settings 闸门的守卫，headless 之外的只读展示也能用。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（需 webServer）
 * @param {object} hooks 宿主侧数据源
 * @param {() => object} hooks.describeServers 返回各服务挂载状态
 * @param {() => object} hooks.describeTools 返回按服务归组的工具清单
 * @returns {() => void} 反注册函数
 */
export function registerBridgeRoutes(ctx, hooks = {}) {
  /** 公共前置：来源与方法校验，以及把任意抛出物收敛成业务级失败 */
  const base = (handler) => async (req, res) => {
    if (!isLoopbackRequest(req)) {
      // 该桥可写入启动命令与凭据，非回环来源直接拒绝
      return sendJson(res, 403, { ok: false, code: 'forbidden', message: '仅允许本机访问' })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: '仅支持 POST' })
    }
    try {
      await handler(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 校验失败、修订冲突等都属于「请求被拒绝」，用 200 + ok:false 表达业务结果，
      // 与 DSH 官方 settings 通道的语义保持一致，便于前端统一处理。
      sendJson(res, 200, { ok: false, code: 'rejected', message })
    }
  }

  /** 需要 settings 服务的路由再加一道闸门 */
  const guard = (handler) =>
    base(async (req, res) => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        return sendJson(res, 200, {
          ok: false,
          code: 'settings-absent',
          message: '当前部署未组合 settings 服务，无法通过界面保存配置',
        })
      }
      await handler(req, res, settings)
    })

  /** describe 的结果在 mutate 后也要回一份，抽出来避免两处走样 */
  const readDescriptor = (settings) =>
    settings.describe({ redactSecrets: true }).find((item) => item.ns === BRIDGE_NAMESPACE)

  const disposeDescribe = ctx.webServer.register({
    kind: 'exact',
    path: `${BRIDGE_PREFIX}/describe`,
    handler: guard(async (req, res, settings) => {
      // redactSecrets 必须为 true：这是凭据不出网的边界
      const descriptor = readDescriptor(settings)
      if (descriptor === undefined) {
        return sendJson(res, 200, {
          ok: false,
          code: 'namespace-unregistered',
          message: '插件尚未注册配置命名空间（可能已被 enabled=false 卸载）',
        })
      }
      sendJson(res, 200, { ok: true, value: toWireView(descriptor), writable: settings.writable })
    }),
  })

  const disposeMutate = ctx.webServer.register({
    kind: 'exact',
    path: `${BRIDGE_PREFIX}/mutate`,
    handler: guard(async (req, res, settings) => {
      const body = await readJsonBody(req)
      const verdict = validateOps(body.ops)
      if (!verdict.ok) {
        return sendJson(res, 200, { ok: false, code: 'rejected', message: verdict.message })
      }
      await settings.mutate(
        BRIDGE_NAMESPACE,
        verdict.ops,
        typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
      )
      const descriptor = readDescriptor(settings)
      sendJson(res, 200, {
        ok: true,
        value: descriptor ? toWireView(descriptor) : undefined,
        writable: settings.writable,
      })
    }),
  })

  const disposeServers =
    hooks.describeServers === undefined
      ? undefined
      : ctx.webServer.register({
          kind: 'exact',
          path: `${BRIDGE_PREFIX}/servers`,
          handler: base(async (req, res) => {
            sendJson(res, 200, { ok: true, value: hooks.describeServers() })
          }),
        })

  const disposeTools =
    hooks.describeTools === undefined
      ? undefined
      : ctx.webServer.register({
          kind: 'exact',
          path: `${BRIDGE_PREFIX}/tools`,
          handler: base(async (req, res) => {
            sendJson(res, 200, { ok: true, value: hooks.describeTools() })
          }),
        })

  return () => {
    disposeDescribe()
    disposeMutate()
    disposeServers?.()
    disposeTools?.()
  }
}
