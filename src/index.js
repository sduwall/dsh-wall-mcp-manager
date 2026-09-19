import Schema from '@deepseek-ai/schemastery'
import { registerBridgeRoutes } from './mcp-bridge.js'
import {
  MCP_PACKAGE,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  fiberStateLabel,
  groupTools,
  planServers,
} from './inventory.js'

export const name = 'dsh-wall-mcp-manager'

/**
 * 硬依赖两个服务：
 * - `loader`：本插件的全部功能建立在「运行时把每个 MCP 服务挂成一个
 *   `@deepseek-ai/dsh-mcp-client` 实例」之上，没有 loader 就无从挂载；
 * - `tools`：工具清单与参数/返回 schema 都读自 `ctx.tools`，而且 mcp-client
 *   自身就 `inject: ['tools']`——宿主没有 tools 时实例根本起不来，
 *   把它列成硬依赖比运行到一半再失败更诚实。
 *
 * `settings` 与 `webServer` 都是**可选**依赖：前者经由注入的 `ctx.settings`
 * 服务（`SettingsProvider`）按需接入设置面板——仅 DSH ≥ 0.1.2-alpha 提供该服务，
 * 旧版 DSH 因已移除 `installSettingsSection` 而不兼容本插件；后者只影响界面能否
 * 读写配置，headless 宿主里插件照常挂载 MCP。
 */
export const inject = ['loader', 'tools']

/**
 * 运行时挂载 mcp-client 实例时引用的包名是一个字符串，静态配置检查
 * （`verify-cordis-config`）看不见它。导出这个常量，让组合本插件的应用
 * 能把它声明为依赖——与 `dsh-host-directory-picker-auto` 的做法一致。
 */
export { MCP_PACKAGE }

/** 用户可配置的 settings 命名空间（对应 settings.yaml 中的 `dsh-wall-mcp-manager:` 段）。
 * 自 DSH 0.1.2-alpha 起 dsh-settings 移除了顶层 settingsNamespace，命名空间改为
 * 直接传字面量小写连字符字符串（须匹配 /^[a-z][a-z0-9-]*$/）。 */
const SETTINGS_NAMESPACE = 'dsh-wall-mcp-manager'

/**
 * 单个 MCP 服务的配置。
 *
 * 这里**故意不照抄** mcp-client 自身的 `z.union([stdio, streamable-http])`：
 * settings 的 `redactSecrets` 只穿透 object / dict / array 三种容器，
 * 遇到 union 会原样返回整棵子树（其源码注释明确「a secret buried inside a
 * union branch is not reachable and must not be modeled that way」）。
 * 若按 union 建模，`secretEnv` / `secretHeaders` 里的凭据就会随 `/describe`
 * 原文出网。所以这里用扁平 object + `transport` 判别字段，
 * 由 `toMcpConfig` 在挂载时按分支重新组装出合法的实例配置。
 *
 * env / headers 拆成两半也是同一个原因：普通项要能在界面上查看与编辑，
 * 凭据项必须只写不读，两者需要不同的 role，只能是两个字段。
 */
const Server = Schema.object({
  // 是否启动该 MCP：默认 false（不启动），勾选界面「启动」才挂载。
  // 0.2.0 起由旧语义「停用（true 才挂载）」反转为 opt-in 启动，避免安装即拉起所有服务。
  enabled: Schema.boolean().default(false),
  transport: Schema.union(['stdio', 'streamable-http']).default('stdio'),
  description: Schema.string().default(''),
  // stdio 分支
  command: Schema.string().default(''),
  args: Schema.array(String).default([]),
  env: Schema.dict(String).default({}),
  // 凭据字段必须显式 `.default(undefined)`：`redactSecrets` 按
  // `value !== undefined` 判定 `secrets[].set`，而 schemastery 会给
  // 每个 dict / object 无条件塞上 `meta.default = {}`，于是未填过的槽位
  // 也会被解析成 `{}` 并报 `set: true`，界面就分不清「还没填」和
  // 「已填但不回传」。压回 undefined 才能让 `set` 如实反映有无凭据。
  secretEnv: Schema.dict(String).role('secret').default(undefined),
  cwd: Schema.string().default(''),
  // streamable-http 分支
  url: Schema.string().default(''),
  headers: Schema.dict(String).default({}),
  secretHeaders: Schema.dict(String).role('secret').default(undefined),
  // 两分支共有
  toolCallTimeoutMs: Schema.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS).min(1000),
  failOnStartupError: Schema.boolean().default(false),
})

/**
 * 插件配置。
 *
 * `servers` 的键即 MCP 的 serverName，也就是工具名 `mcp__<serverName>__<tool>`
 * 里的命名空间段；用字典而不是数组，是为了让「重名」在数据结构层面就不可能，
 * 而 serverName 在所有活动 mcp-client 实例之间必须唯一。
 *
 * @typedef {object} Config
 * @property {Record<string, object>} servers MCP 服务清单
 */
export const Config = Schema.object({
  servers: Schema.dict(Server).default({}),
})

/**
 * Cordis 插件主体。
 *
 * 职责边界：本插件自己不实现任何 MCP 协议，只做两件事——
 * 1. 把 settings 里的服务清单**对账**成一组 mcp-client loader 实例
 *    （新增则 create、改了则 update、删了则 remove、没变则一动不动）；
 * 2. 通过 loopback 桥把「配置 + 挂载状态 + 工具契约」交给浏览器界面。
 *
 * 为什么要对账而不是「全拆重建」：重建会让所有 MCP 重连一次，
 * 用户改一个服务的描述文字不该把另外五个的 stdio 子进程全杀掉重启。
 */
export async function apply(ctx, config) {
  /** 当前生效的配置读取器；settings 服务缺失时退回组合层配置 */
  let source = () => config

  /** serverName → { entryId, key }，key 是实例配置指纹，用于判断是否需要 update */
  const mounted = new Map()

  /** 最近一次对账的结果，供界面展示「为什么这个没挂上」 */
  let lastPlan = { skipped: [], failures: [] }

  /** 串行化对账，避免连续保存导致 create/remove 交叉 */
  let queue = Promise.resolve()

  /** 卸载中标记：卸载时不再响应配置变更 */
  let closed = false

  /**
   * 把一个服务挂载成 loader entry。
   *
   * entry 的 id 交给 loader 自己生成（`create` 返回值），不自己拼——
   * 拼出来的 id 一旦与组合层已有条目撞车，冲突面比省下的一次记账大得多。
   */
  async function mount(serverName, plan) {
    const entryId = await ctx.loader.create({
      name: MCP_PACKAGE,
      config: plan.config,
    })
    mounted.set(serverName, { entryId, key: plan.key })
    ctx.logger.info(`[dsh-wall-mcp-manager] 已挂载 MCP 服务 ${serverName}`)
  }

  /** 卸载一个服务；entry 可能已被组合层移走，故先探 store 再 remove */
  async function unmount(serverName) {
    const record = mounted.get(serverName)
    mounted.delete(serverName)
    if (record === undefined) return
    if (ctx.loader.store[record.entryId] === undefined) return
    await ctx.loader.remove(record.entryId)
    ctx.logger.info(`[dsh-wall-mcp-manager] 已卸载 MCP 服务 ${serverName}`)
  }

  /**
   * 对账一次：让实际挂载的实例集合收敛到配置描述的集合。
   *
   * 单个服务挂载失败（命令不存在、serverName 撞车、远端不可达且
   * failOnStartupError=true）只记进 `failures` 交给界面显示，绝不外溢——
   * 一个配错的服务不该让插件整体卸载，也不该拖垮其他服务。
   */
  async function reconcile() {
    const { desired, skipped } = planServers(source().servers)
    const failures = []

    // 先退再进：先释放不再需要的 serverName，避免「改名」时新旧实例
    // 在 mcp-client 的 serverName 唯一性检查上撞车。
    for (const serverName of [...mounted.keys()]) {
      if (desired.has(serverName)) continue
      try {
        await unmount(serverName)
      } catch (error) {
        failures.push({ name: serverName, reason: `卸载失败：${errorText(error)}` })
      }
    }

    for (const [serverName, plan] of desired) {
      const record = mounted.get(serverName)
      try {
        if (record === undefined) {
          await mount(serverName, plan)
          continue
        }
        if (record.key === plan.key) continue
        // 配置真变了才动 loader：update 会重启该 entry 的 fiber（即 MCP 重连）
        await ctx.loader.update(record.entryId, { config: plan.config })
        record.key = plan.key
        ctx.logger.info(`[dsh-wall-mcp-manager] 已更新 MCP 服务 ${serverName} 的配置`)
      } catch (error) {
        failures.push({ name: serverName, reason: errorText(error) })
        // 挂载失败的实例不留在账上，否则下次保存会被当成「已挂载、无需重试」
        try {
          await unmount(serverName)
        } catch {
          // 回滚本身失败只能忽略：原始失败原因才是用户要看的
        }
        ctx.logger.warn(
          `[dsh-wall-mcp-manager] MCP 服务 ${serverName} 挂载失败：${errorText(error)}`,
        )
      }
    }

    lastPlan = { skipped, failures }
  }

  function onChange() {
    queue = queue
      .then(() => {
        if (closed) return
        return reconcile()
      })
      .catch((error) => {
        ctx.logger.warn(`[dsh-wall-mcp-manager] 应用配置变更失败：${errorText(error)}`)
      })
    // 返回 queue，调用方（apply 里的首轮对账）可 await，确保回调已串行进入队列
    return queue
  }

  /**
   * 汇总界面需要的服务视图：配置里有什么、实际挂上了没有、fiber 处于哪一相。
   *
   * fiber 相位读自 loader 的 entry（`entry.fiber?.state`）：这是唯一能区分
   * 「运行中」与「启动失败」的信号——mcp-client 没有暴露连接状态服务。
   *
   * 「未启动 / 跳过原因」不再依赖 `lastPlan` 里那次对账的结果：reconcile 是排队的，
   * 切换 enabled 后到它真正跑完挂载之间会有数秒窗口（尤其是 stdio 子进程被
   * 杀掉再拉起很慢），这期间 `lastPlan` 还停留在上一轮、且 `mounted` 已被清空，
   * 若直接用它就会把「已启用、正等待挂载」错显示成「未挂载 / 未启动」。这里改用
   * 当前配置实时推导：enabled 为 false 才是真未启动；已启用但尚未挂载则报「启动中」。
   */
  function describeServers() {
    const current = source().servers ?? {}
    // 实时判断每个服务是否被 planServers 跳过（配置不完整 / 未启用），不取陈旧 lastPlan
    const { skipped } = planServers(current)
    const skipReasons = new Map(skipped.map((item) => [item.name, item.reason]))
    const servers = Object.keys(current).map((serverName) => {
      const record = mounted.get(serverName)
      const entry = record === undefined ? undefined : ctx.loader.store[record.entryId]
      const enabled = current[serverName]?.enabled === true
      const failure = lastPlan.failures.find((item) => item.name === serverName)
      const liveSkip = skipReasons.get(serverName)
      let state
      if (failure !== undefined) {
        // 最近一次挂载确实失败（命令不存在、serverName 撞车等），如实报红
        state = '启动失败'
      } else if (!enabled) {
        state = '未启动'
      } else if (record !== undefined) {
        // 已挂载：fiber 相位说话
        state = fiberStateLabel(entry?.fiber?.state)
      } else {
        // 配置已启用但 reconcile 还没把它挂上：可能正排在上一轮卸载之后，或子进程启动中
        state = liveSkip !== undefined ? liveSkip : '启动中'
      }
      return {
        name: serverName,
        enabled,
        mounted: record !== undefined,
        entryId: record?.entryId,
        state,
        skipReason: liveSkip,
        error: failure?.reason,
      }
    })
    return { servers }
  }

  /** 工具清单：按已配置的服务归组，另外单列不属于任何配置项的 mcp 工具 */
  function describeTools() {
    return groupTools(ctx.tools, Object.keys(source().servers ?? {}))
  }

  // 接入 settings：等 settings 服务就绪（DSH ≥ 0.1.2-alpha 提供）后再注册面板，
  // 缺失时（headless / CLI）这段不执行，下面的 onChange() 兜底对账一次。
  // 新接口用注入的 settings 服务的 installSection（旧顶层 installSettingsSection 已移除）。
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(sctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (current) => {
        source = current
      },
      onChange,
    })
  })

  // 桥路由：webServer 缺失时（headless / CLI）不注册，MCP 挂载不受影响
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => registerBridgeRoutes(wctx, { describeServers, describeTools }))
  })

  // 没有 settings 服务时上面不会触发，这里兜底对账一次。
  // 用 await 等首轮对账完成：保证 apply 返回时 MCP 已挂载，
  // 避免「加载完成 → 首次异步对账」之间出现挂载空窗。
  await onChange()

  // 卸载回调：排在队列尾部，保证不与正在进行的对账交叉。
  // 逆序拆除，让后挂的实例先走，尽量贴近挂载顺序的反向。
  return async () => {
    closed = true
    queue = queue.then(async () => {
      for (const serverName of [...mounted.keys()].reverse()) {
        try {
          await unmount(serverName)
        } catch (error) {
          ctx.logger.warn(
            `[dsh-wall-mcp-manager] 卸载 MCP 服务 ${serverName} 失败：${errorText(error)}`,
          )
        }
      }
    })
    await queue
  }
}

/** 统一把未知抛出物转成可读文本（loader 会把插件内的任意抛出原样带上来） */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
