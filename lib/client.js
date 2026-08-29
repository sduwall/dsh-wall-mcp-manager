window.__ModuleLoader__.load({
  id: 'dsh-wall-mcp-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /**
     * 配置桥前缀，与宿主侧 src/mcp-bridge.js 保持一致。
     * 走自建路由的原因：DSH 官方 settings RPC 的命名空间白名单
     * （dsh-host-apiproxy 的 WEB_SETTINGS_NAMESPACES）是硬编码的，
     * 第三方插件命名空间一律被拒（settings-not-exposed）；
     * 而 MCP 的挂载状态与工具 schema 在官方通道里根本不存在。
     */
    const BRIDGE_PREFIX = '/api/dsh-wall-mcp-manager'

    /** serverName 的合法形态，与宿主侧、mcp-client 三处保持一致 */
    const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

    /** 调用桥路由；网络/解析失败统一转成 { ok:false } 而不抛出 */
    async function callBridge(path, body) {
      try {
        const response = await fetch(`${BRIDGE_PREFIX}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        if (!response.ok) {
          return { ok: false, code: 'http-error', message: `HTTP ${response.status}` }
        }
        return await response.json()
      } catch (error) {
        return {
          ok: false,
          code: 'unreachable',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }

    /** 保存后等待连接结果的轮询节奏：500ms × 16 ≈ 8 秒 */
    const SETTLE_POLL_INTERVAL_MS = 500
    const SETTLE_POLL_ATTEMPTS = 16

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /**
     * 提示自动消失的存活时长。
     *
     * 计时的起点是**后端给出连接定论的那一刻**，不是点保存的那一刻：MCP 握手
     * 可能耗时数秒，从点击开始计时会让提示在结果出来之前就消失。所以进行中的
     * 提示标记为 `pending` 不计时，只在转入终态后才排队销毁。
     */
    const NOTICE_TTL_MS = 10000

    /**
     * 把一条提示并入队列。
     *
     * 用 `channel` 归并而不是无脑追加：`watchServer` 每轮轮询都会改写同一台
     * 服务器的提示文案（正在连接… → 已连接），追加的话 8 秒内就能堆出十几条
     * 同源消息。同 channel 原地更新且保留原 `id`，销毁计时的身份才不会被
     * 文案变化重置；不同 channel（不同服务器、不同操作）则各自排队共存。
     *
     * `settledAt` 是销毁计时的起点，只在提示首次进入终态时写入，之后不再变动，
     * 这样后续渲染重建定时器时能算出**剩余**时长而不是重新计满 10 秒。
     *
     * @param {object[]} list 现有队列
     * @param {{ channel: string, kind: string, text: string, pending?: boolean }} entry
     * @param {number} nextId 追加时使用的新身份
     * @param {number} now 当前时刻（毫秒）
     */
    function upsertNotice(list, entry, nextId, now) {
      const settledAt = entry.pending === true ? undefined : now
      const index = list.findIndex((item) => item.channel === entry.channel)
      if (index === -1) return [...list, { id: nextId, settledAt, ...entry }]
      const next = list.slice()
      const previous = next[index]
      next[index] = {
        ...previous,
        ...entry,
        // 已经开始计时的提示不因文案更新而续命
        settledAt: previous.settledAt ?? settledAt,
      }
      return next
    }

    /**
     * 判定一台服务器的连接是否已有定论。
     *
     * 关键事实：fiber 的「运行中」**不等于 MCP 已连接**。mcp-client 在
     * `failOnStartupError: false`（本插件默认）下，远端握手失败也不会让 fiber
     * 失败，而是在后台按指数退避重连；所以 fiber 相位只能证明「实例活着」。
     * 真正能证明连上的证据只有一个：该服务器注册出了工具。
     *
     * @param {string} serverName
     * @param {{ servers: object[], groups: object[] }} snapshot 一次运行时快照
     * @returns {{ done: boolean, kind: 'success'|'error'|'info', text: string }}
     */
    function settleVerdict(serverName, snapshot) {
      const status = (snapshot.servers ?? []).find((item) => item.name === serverName)
      const tools =
        (snapshot.groups ?? []).find((group) => group.server === serverName)?.tools ?? []
      if (status === undefined) {
        return { done: true, kind: 'error', text: `${serverName} 未出现在运行时清单中` }
      }
      if (status.skipReason !== undefined) {
        return { done: true, kind: 'error', text: `${serverName} 未挂载：${status.skipReason}` }
      }
      if (status.error !== undefined) {
        return { done: true, kind: 'error', text: `${serverName} 启动失败：${status.error}` }
      }
      if (status.state === '启动失败') {
        return { done: true, kind: 'error', text: `${serverName} 启动失败` }
      }
      if (tools.length > 0) {
        return {
          done: true,
          kind: 'success',
          text: `${serverName} 已连接，注册 ${tools.length} 个工具`,
        }
      }
      return { done: false, kind: 'info', text: `${serverName} 正在连接…（${status.state}）` }
    }

    // ---------------------------------------------------------------- 样式

    const border = '1px solid var(--dsh-color-border, rgba(128,128,128,0.35))'
    const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      borderRadius: 6,
      border,
      background: 'var(--dsh-color-bg-input, transparent)',
      color: 'inherit',
      fontSize: 13,
      fontFamily: 'inherit',
    }
    const monoStyle = { ...inputStyle, fontFamily: 'var(--dsh-font-mono, monospace)', minHeight: 64 }
    // <select> 与 <option> 需要显式的背景/前景色：展开后的下拉列表由操作系统绘制，
    // 若背景为 transparent 会回退到系统白底，而 color: inherit 在深色主题下是浅色文字，
    // 二者叠加就出现「浅色字压在白底上」的低对比度问题。
    const selectStyle = {
      ...inputStyle,
      background: 'var(--dsh-color-bg-input, var(--dsh-color-bg-elevated, #1e1e1e))',
      color: 'var(--dsh-color-text, inherit)',
      appearance: 'none',
      backgroundImage:
        "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5L6 8l3.5-3.5' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'right 9px center',
      backgroundSize: '12px 12px',
      paddingRight: 28,
      cursor: 'pointer',
    }
    const optionStyle = {
      background: 'var(--dsh-color-bg-elevated, var(--dsh-color-bg, #1e1e1e))',
      color: 'var(--dsh-color-text, #e8e8e8)',
    }
    const hintStyle = { margin: '5px 0 0', fontSize: 12, opacity: 0.65, lineHeight: 1.5 }
    const rowStyle = { marginBottom: 14 }
    const codeStyle = {
      fontFamily: 'var(--dsh-font-mono, monospace)',
      fontSize: 12,
      background: 'var(--dsh-color-bg-code, rgba(128,128,128,0.12))',
      padding: '1px 5px',
      borderRadius: 4,
    }

    function button(text, options) {
      const disabled = options.disabled === true
      const primary = options.primary === true
      return h(
        'button',
        {
          type: 'button',
          key: options.key,
          disabled,
          onClick: options.onClick,
          style: {
            padding: primary ? '7px 16px' : '5px 12px',
            borderRadius: 6,
            border: primary ? 'none' : border,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            background: primary ? 'var(--dsh-color-accent, #2f6fed)' : 'transparent',
            color: primary ? '#fff' : 'inherit',
            fontSize: 13,
            fontWeight: primary ? 600 : 500,
            fontFamily: 'inherit',
          },
        },
        text,
      )
    }

    function badge(text, tone) {
      return h(
        'span',
        {
          style: {
            fontSize: 11,
            fontWeight: 500,
            padding: '1px 6px',
            borderRadius: 4,
            border: '1px solid currentColor',
            opacity: 0.75,
            color:
              tone === 'error'
                ? 'var(--dsh-color-danger, #d64545)'
                : tone === 'success'
                  ? 'var(--dsh-color-success, #2e8b57)'
                  : 'inherit',
          },
        },
        text,
      )
    }

    // ------------------------------------------------------- 表单值互转

    /** `KEY=value` 多行文本 → 字典；空行与缺少 `=` 的行忽略 */
    function parseDict(text) {
      const result = {}
      for (const line of String(text ?? '').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        const at = trimmed.indexOf('=')
        if (at <= 0) continue
        result[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
      }
      return result
    }

    /** 字典 → `KEY=value` 多行文本 */
    function formatDict(dict) {
      if (dict === null || typeof dict !== 'object') return ''
      return Object.entries(dict)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    }

    /** 多行文本 → 字符串数组（每行一个参数，空行忽略） */
    function parseLines(text) {
      return String(text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    }

    /**
     * 判断某个 secret 位置是否已配置。
     *
     * `secretEnv` / `secretHeaders` 整个字典被标成 secret，所以桥回来的
     * `secrets` 只告诉我们「这台服务器有没有凭据」，不含任何键名——
     * 这正是我们要的：连键名都不出网。
     */
    function isSecretSet(secrets, path) {
      const target = path.join('\u0000')
      const hit = (secrets ?? []).find(
        (item) => Array.isArray(item?.path) && item.path.join('\u0000') === target,
      )
      return hit?.set === true
    }

    /** 一台服务器的表单初值（缺字段回落到 schema 默认） */
    function toDraft(server) {
      const value = server ?? {}
      return {
        transport: value.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        description: value.description ?? '',
        command: value.command ?? '',
        args: Array.isArray(value.args) ? value.args.join('\n') : '',
        env: formatDict(value.env),
        cwd: value.cwd ?? '',
        url: value.url ?? '',
        headers: formatDict(value.headers),
        secretEnv: '',
        secretHeaders: '',
        toolCallTimeoutMs: String(value.toolCallTimeoutMs ?? 60000),
      }
    }

    /**
     * 把表单草稿翻成 mutate 操作序列。
     *
     * 逐字段寻址（`servers.<name>.<field>`）而不是整体替换该服务器：
     * 浏览器手里的视图是脱敏的，整体写回会把它从未见过的
     * `secretEnv` / `secretHeaders` 一起抹掉。
     *
     * 凭据框留空表示「保持不变」——这是唯一能既支持修改又不回传原文的语义。
     *
     * @param {string} name serverName
     * @param {object} draft 表单草稿
     * @param {boolean} isNew 是否新建（新建时需要先落一个 enabled 字段）
     * @returns {{ ok: true, ops: object[] } | { ok: false, message: string }}
     */
    function draftToOps(name, draft, isNew) {
      if (!SERVER_NAME_PATTERN.test(name)) {
        return { ok: false, message: '服务器名称需为 1-32 位的字母、数字、下划线或连字符' }
      }
      const timeout = Number(draft.toolCallTimeoutMs)
      if (!Number.isFinite(timeout) || timeout < 1000) {
        return { ok: false, message: '工具调用超时需为不小于 1000 的数字（毫秒）' }
      }
      const at = (field) => ['servers', name, field]
      const ops = []
      if (isNew) ops.push({ op: 'set', path: at('enabled'), value: true })
      ops.push({ op: 'set', path: at('transport'), value: draft.transport })
      ops.push({ op: 'set', path: at('description'), value: draft.description })
      ops.push({ op: 'set', path: at('toolCallTimeoutMs'), value: timeout })
      if (draft.transport === 'streamable-http') {
        if (draft.url.trim() === '') return { ok: false, message: 'streamable-http 需要填写 URL' }
        ops.push({ op: 'set', path: at('url'), value: draft.url.trim() })
        ops.push({ op: 'set', path: at('headers'), value: parseDict(draft.headers) })
        if (draft.secretHeaders.trim() !== '') {
          ops.push({ op: 'set', path: at('secretHeaders'), value: parseDict(draft.secretHeaders) })
        }
      } else {
        if (draft.command.trim() === '') return { ok: false, message: 'stdio 需要填写启动命令' }
        ops.push({ op: 'set', path: at('command'), value: draft.command.trim() })
        ops.push({ op: 'set', path: at('args'), value: parseLines(draft.args) })
        ops.push({ op: 'set', path: at('env'), value: parseDict(draft.env) })
        ops.push({ op: 'set', path: at('cwd'), value: draft.cwd.trim() })
        if (draft.secretEnv.trim() !== '') {
          ops.push({ op: 'set', path: at('secretEnv'), value: parseDict(draft.secretEnv) })
        }
      }
      return { ok: true, ops }
    }

    // ------------------------------------------------------- schema 渲染

    /** JSON Schema 的类型描述文本（尽量短，长形态交给原始 JSON） */
    function typeText(node) {
      if (node === null || typeof node !== 'object') return 'any'
      if (Array.isArray(node.enum)) return `enum(${node.enum.map((item) => JSON.stringify(item)).join(' | ')})`
      if (Array.isArray(node.type)) return node.type.join(' | ')
      if (typeof node.type === 'string') {
        if (node.type === 'array') return `array<${typeText(node.items)}>`
        return node.type
      }
      if (node.properties !== undefined) return 'object'
      if (node.anyOf !== undefined || node.oneOf !== undefined) return 'union'
      return 'any'
    }

    /**
     * 递归渲染 JSON Schema 的字段表。
     *
     * 只展开 object 与 array<object> 两种确定结构；union / $ref 等无法逐字段
     * 展开的形态一律回落到「查看原始 JSON」，不猜、不编造字段。
     */
    function SchemaFields({ node, required, depth }) {
      const level = depth ?? 0
      if (node === null || typeof node !== 'object') {
        return h('p', { style: hintStyle }, '该结构未声明具体字段。')
      }
      const properties = node.properties
      if (properties === undefined || Object.keys(properties).length === 0) {
        // object 但无 properties：常见于「接受任意对象」的工具
        return h(
          'p',
          { style: hintStyle },
          node.type === 'object' || node.type === undefined
            ? '未声明具体字段（接受任意结构）。'
            : `类型：${typeText(node)}`,
        )
      }
      const requiredKeys = Array.isArray(required)
        ? required
        : Array.isArray(node.required)
          ? node.required
          : []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        ...Object.entries(properties).map(([key, child]) =>
          h(
            'div',
            {
              key,
              style: {
                paddingLeft: level === 0 ? 0 : 12,
                borderLeft: level === 0 ? undefined : border,
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { ...codeStyle, fontWeight: 600 } }, key),
              h('span', { style: { fontSize: 12, opacity: 0.7 } }, typeText(child)),
              requiredKeys.includes(key) ? badge('必填', 'error') : badge('可选'),
            ),
            typeof child?.description === 'string' && child.description !== ''
              ? h('p', { style: hintStyle }, child.description)
              : undefined,
            child?.default === undefined
              ? undefined
              : h('p', { style: hintStyle }, `默认值：${JSON.stringify(child.default)}`),
            // 嵌套结构最多再展一层，更深的层次交给原始 JSON，避免面板被撑爆
            level < 1 && child?.properties !== undefined
              ? h(
                  'div',
                  { style: { marginTop: 6 } },
                  h(SchemaFields, { node: child, depth: level + 1 }),
                )
              : undefined,
            level < 1 && child?.type === 'array' && child.items?.properties !== undefined
              ? h(
                  'div',
                  { style: { marginTop: 6 } },
                  h('p', { style: { ...hintStyle, marginBottom: 4 } }, '数组元素结构：'),
                  h(SchemaFields, { node: child.items, depth: level + 1 }),
                )
              : undefined,
          ),
        ),
      )
    }

    /** 可折叠的原始 JSON 视图：字段表看不懂时的最终依据 */
    function RawJson({ value, label }) {
      const [open, setOpen] = react.useState(false)
      return h(
        'div',
        { style: { marginTop: 8 } },
        button(open ? `收起${label}` : `查看${label}`, { onClick: () => setOpen(!open) }),
        open
          ? h(
              'pre',
              {
                style: {
                  marginTop: 8,
                  marginBottom: 0,
                  padding: 10,
                  borderRadius: 6,
                  border,
                  overflowX: 'auto',
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontFamily: 'var(--dsh-font-mono, monospace)',
                },
              },
              JSON.stringify(value ?? null, null, 2),
            )
          : undefined,
      )
    }

    /** 单个工具卡片：名称 + 说明 + 参数 + 返回内容 */
    function ToolCard({ tool }) {
      const [open, setOpen] = react.useState(false)
      const output = tool.output ?? { kind: 'raw' }
      return h(
        'div',
        { style: { border, borderRadius: 8, padding: 12, marginBottom: 10 } },
        h(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
            onClick: () => setOpen(!open),
          },
          h('span', { style: { fontSize: 12, opacity: 0.6, width: 12 } }, open ? '▾' : '▸'),
          h('span', { style: { ...codeStyle, fontWeight: 600 } }, tool.rawName ?? tool.name),
          output.kind === 'structured' ? badge('结构化返回', 'success') : badge('文本返回'),
        ),
        tool.description === ''
          ? undefined
          : h('p', { style: { ...hintStyle, marginTop: 8 } }, tool.description),
        open
          ? h(
              'div',
              { style: { marginTop: 12 } },
              h(
                'p',
                { style: { ...hintStyle, marginTop: 0 } },
                '模型调用时使用的完整工具名：',
                h('span', { style: codeStyle }, tool.name),
              ),
              h(
                'p',
                { style: { margin: '14px 0 8px', fontSize: 13, fontWeight: 600 } },
                '调用参数',
              ),
              h(SchemaFields, { node: tool.parameters }),
              h(RawJson, { value: tool.parameters, label: '参数原始 Schema' }),
              h(
                'p',
                { style: { margin: '18px 0 8px', fontSize: 13, fontWeight: 600 } },
                '返回内容',
              ),
              output.kind === 'structured'
                ? h(
                    'div',
                    null,
                    h(
                      'p',
                      { style: { ...hintStyle, marginTop: 0 } },
                      '返回体含 ',
                      h('span', { style: codeStyle }, 'content'),
                      '（文本内容块数组，供模型阅读）与 ',
                      h('span', { style: codeStyle }, 'structuredContent'),
                      '（结构化结果，字段如下）。',
                    ),
                    h(SchemaFields, { node: output.structured }),
                  )
                : output.kind === 'text'
                  ? h(
                      'p',
                      { style: { ...hintStyle, marginTop: 0 } },
                      '该工具未声明结构化返回，只返回 ',
                      h('span', { style: codeStyle }, 'content'),
                      ' 文本内容块数组。',
                    )
                  : h('p', { style: { ...hintStyle, marginTop: 0 } }, '返回结构未声明。'),
              h(RawJson, { value: output.raw, label: '返回原始 Schema' }),
            )
          : undefined,
      )
    }

    // ------------------------------------------------------------ 表单

    /** 服务器编辑表单（新建与编辑同一套） */
    function ServerForm({ name, server, secrets, writable, onSubmit, onCancel }) {
      const isNew = name === undefined
      const [draftName, setDraftName] = react.useState(name ?? '')
      const [draft, setDraft] = react.useState(() => toDraft(server))
      const set = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })
      const secretPath = draft.transport === 'streamable-http' ? 'secretHeaders' : 'secretEnv'
      const secretConfigured =
        !isNew && isSecretSet(secrets, ['servers', name, secretPath])

      const field = (label, key, options) =>
        h(
          'div',
          { key, style: rowStyle },
          h('label', { style: labelStyle }, label),
          h(options?.multiline === true ? 'textarea' : 'input', {
            style: options?.multiline === true ? monoStyle : inputStyle,
            rows: options?.rows,
            type: options?.type ?? 'text',
            disabled: !writable,
            placeholder: options?.placeholder,
            value: draft[key],
            onChange: set(key),
          }),
          options?.hint === undefined ? undefined : h('p', { style: hintStyle }, options.hint),
        )

      return h(
        'div',
        { style: { border, borderRadius: 8, padding: 14, marginBottom: 16 } },
        h(
          'p',
          { style: { margin: '0 0 14px', fontSize: 13, fontWeight: 600 } },
          isNew ? '添加 MCP 服务器' : `编辑 ${name}`,
        ),
        isNew
          ? h(
              'div',
              { style: rowStyle },
              h('label', { style: labelStyle }, '名称'),
              h('input', {
                style: inputStyle,
                disabled: !writable,
                placeholder: 'filesystem',
                value: draftName,
                onChange: (event) => setDraftName(event.target.value),
              }),
              h(
                'p',
                { style: hintStyle },
                '1-32 位字母、数字、下划线或连字符；它会成为工具名的命名空间：',
                h('span', { style: codeStyle }, `mcp__${draftName || '<名称>'}__<工具>`),
                '。创建后不可改名（改名等于换一台服务器）。',
              ),
            )
          : undefined,
        h(
          'div',
          { style: rowStyle },
          h('label', { style: labelStyle }, '传输方式'),
          h(
            'select',
            {
              style: selectStyle,
              disabled: !writable,
              value: draft.transport,
              onChange: set('transport'),
            },
            h('option', { style: optionStyle, value: 'stdio' }, 'stdio（本地子进程）'),
            h(
              'option',
              { style: optionStyle, value: 'streamable-http' },
              'streamable-http（远程 HTTP）',
            ),
          ),
          h(
            'p',
            { style: hintStyle },
            draft.transport === 'streamable-http'
              ? 'DSH 通过网络访问已在运行的 MCP 服务，需你自己先启动它并填写地址（含路径，如 http://127.0.0.1:8000/mcp）。'
              : 'DSH 自动拉起本地命令作为子进程，通过标准输入输出通信，无需手动启动外部服务。',
          ),
        ),
        field('备注', 'description', { placeholder: '选填，仅本界面展示' }),
        ...(draft.transport === 'streamable-http'
          ? [
              field('服务地址', 'url', { placeholder: 'https://mcp.example.com/mcp' }),
              field('请求头', 'headers', {
                multiline: true,
                rows: 3,
                placeholder: 'X-Client=dsh',
                hint: '每行一条 名称=值；含凭据的请求头请填到下面的「凭据请求头」。',
              }),
              field('凭据请求头', 'secretHeaders', {
                multiline: true,
                rows: 2,
                placeholder: secretConfigured ? '留空则保持不变' : 'Authorization=Bearer xxx',
                hint: `每行一条 名称=值。${secretConfigured ? '当前状态：已配置，留空保存表示不修改。' : '当前状态：未配置。'}保存后不会再回显，界面只显示是否已配置。`,
              }),
            ]
          : [
              field('启动命令', 'command', { placeholder: 'npx' }),
              field('命令参数', 'args', {
                multiline: true,
                rows: 3,
                placeholder: '-y\n@modelcontextprotocol/server-filesystem\nD:/workspace',
                hint: '每行一个参数，不要写成一整行——参数不会按空格拆分。',
              }),
              field('工作目录', 'cwd', { placeholder: '留空则继承 DSH 进程的工作目录' }),
              field('环境变量', 'env', {
                multiline: true,
                rows: 3,
                placeholder: 'NODE_ENV=production',
                hint: '每行一条 名称=值；含凭据的变量请填到下面的「凭据环境变量」。',
              }),
              field('凭据环境变量', 'secretEnv', {
                multiline: true,
                rows: 2,
                placeholder: secretConfigured ? '留空则保持不变' : 'API_TOKEN=xxx',
                hint: `每行一条 名称=值。${secretConfigured ? '当前状态：已配置，留空保存表示不修改。' : '当前状态：未配置。'}保存后不会再回显，界面只显示是否已配置。`,
              }),
            ]),
        field('工具调用超时（毫秒）', 'toolCallTimeoutMs', { type: 'number' }),
        h(
          'div',
          { style: { display: 'flex', gap: 10, marginTop: 4 } },
          button(isNew ? '添加' : '保存', {
            primary: true,
            disabled: !writable,
            onClick: () => onSubmit(isNew ? draftName.trim() : name, draft, isNew),
          }),
          button('取消', { onClick: onCancel }),
        ),
      )
    }

    // ------------------------------------------------------------ 主面板

    /** MCP 管理面板：左侧服务器清单与编辑，下方工具清单与契约 */
    function McpManagerSection() {
      const [config, setConfig] = react.useState({ status: 'loading' })
      const [runtime, setRuntime] = react.useState({ servers: [], groups: [], orphans: [] })
      const [editing, setEditing] = react.useState(undefined)
      const [selected, setSelected] = react.useState(undefined)
      /**
       * 提示队列。每项形如
       * `{ id, channel, kind, text, pending }`，`pending` 为真表示后端还没给出
       * 连接结果，此时不启动销毁计时。
       */
      const [notices, setNotices] = react.useState([])
      /** 自增的提示身份来源；用 ref 而非 state，避免发一条提示触发两次渲染 */
      const noticeSeq = react.useRef(0)

      const pushNotice = react.useCallback((entry) => {
        noticeSeq.current += 1
        const nextId = noticeSeq.current
        setNotices((list) => upsertNotice(list, entry, nextId, Date.now()))
      }, [])

      const dismissNotice = react.useCallback((id) => {
        setNotices((list) => list.filter((item) => item.id !== id))
      }, [])

      /**
       * 到达终态的提示在存活期结束后自动移除。
       *
       * 每条各自持有一个定时器，因为它们进入终态的时刻不同，用一个全局定时器会
       * 让后到的提示被前一条的计时波及。`pending` 的提示不在此列——计时必须等
       * 连接结果回来才开始。定时器按 `settledAt` 算剩余时长，所以队列里新增一条
       * 提示导致本效果重跑时，早先那条不会被重新计满。
       */
      react.useEffect(() => {
        const expiring = notices.filter((item) => item.settledAt !== undefined)
        if (expiring.length === 0) return undefined
        const now = Date.now()
        const timers = expiring.map((item) =>
          setTimeout(
            () => dismissNotice(item.id),
            Math.max(0, item.settledAt + NOTICE_TTL_MS - now),
          ),
        )
        return () => timers.forEach(clearTimeout)
      }, [notices, dismissNotice])

      /** 刷新中标记 + 上次刷新完成时刻：让「刷新状态」在数据没变化时也有可见反馈 */
      const [refreshing, setRefreshing] = react.useState(false)
      const [refreshedAt, setRefreshedAt] = react.useState(undefined)
      /**
       * 待确认删除的 serverName。
       *
       * 删除会连带抹掉该服务器的凭据（`secretEnv` / `secretHeaders`），而凭据
       * 从不回显、界面上无从找回，误点一次就得重新去拿密钥——这类不可逆操作
       * 必须有二次确认。用行内确认而不是 `window.confirm`：后者在嵌入式
       * WebView 里可能被拦截，且会阻塞渲染线程。
       */
      const [pendingDelete, setPendingDelete] = react.useState(undefined)

      /** 拉取配置（脱敏视图） */
      const reloadConfig = react.useCallback(async () => {
        const response = await callBridge('/describe')
        if (response.ok) {
          setConfig({
            status: 'ready',
            servers: response.value.value?.servers ?? {},
            secrets: response.value.secrets ?? [],
            revision: response.value.revision,
            writable: response.writable !== false,
          })
        } else {
          setConfig({ status: 'unavailable', message: response.message, code: response.code })
        }
      }, [])

      /**
       * 拉取运行时事实：挂载状态与工具清单。
       *
       * 与配置分开拉取，因为两者的时序不同：配置是保存即定，
       * 而 MCP 连接与工具注册要等子进程/远端握手完成。
       *
       * 返回本次快照，供保存后的短轮询直接判定，避免再等一轮 React 重渲染。
       */
      const reloadRuntime = react.useCallback(async () => {
        const [servers, tools] = await Promise.all([
          callBridge('/servers'),
          callBridge('/tools'),
        ])
        const snapshot = {
          servers: servers.ok ? (servers.value.servers ?? []) : [],
          groups: tools.ok ? (tools.value.groups ?? []) : [],
          orphans: tools.ok ? (tools.value.orphans ?? []) : [],
        }
        setRuntime(snapshot)
        return snapshot
      }, [])

      /**
       * 「刷新状态」：除了重新拉数据，还要记录完成时刻。
       *
       * 后端 `/servers`、`/tools` 每次都是实时求值且 `Cache-Control: no-store`，
       * 但当 MCP 一直连不上时两次结果完全一致，界面看起来「点了没反应」。
       * 用一个刷新时间戳把「确实刷过了」这件事显式说出来。
       */
      const refreshAll = react.useCallback(async () => {
        setRefreshing(true)
        try {
          await Promise.all([reloadConfig(), reloadRuntime()])
          setRefreshedAt(new Date())
        } finally {
          setRefreshing(false)
        }
      }, [reloadConfig, reloadRuntime])

      react.useEffect(() => {
        void reloadConfig()
        void reloadRuntime()
      }, [reloadConfig, reloadRuntime])

      if (config.status === 'loading') {
        return h('div', { style: { padding: 16, opacity: 0.7 } }, '正在读取 MCP 配置…')
      }
      if (config.status === 'unavailable') {
        return h(
          'div',
          { style: { padding: 16 } },
          h('p', { style: { margin: '0 0 8px', fontWeight: 600 } }, '暂时无法读取 MCP 配置'),
          h(
            'p',
            { style: { ...hintStyle, marginTop: 0 } },
            config.message ?? '未知原因',
            h('br'),
            '本面板仅在本机（回环地址）浏览器中可用；若通过远程地址访问 GUI，请改用 $DSH_HOME/settings.yaml 编辑。',
          ),
        )
      }

      /**
       * 提交一批 mutate 操作，成功后刷新配置与运行时。
       *
       * `watchName` 有值表示调用方接下来会 `watchServer` 等连接结果：此时提示
       * 用服务器名作 channel 且标为 `pending`，好让轮询原地把「正在连接…」改写
       * 成连接结论、并由结论那一刻起算销毁计时。没有后续等待的操作（删除、清除
       * 凭据、停用）直接进入终态开始计时。
       */
      const submit = async (ops, successText, watchName) => {
        const channel = watchName ?? successText
        const response = await callBridge('/mutate', { ops, expectedRevision: config.revision })
        if (!response.ok) {
          pushNotice({
            channel,
            kind: 'error',
            text: response.message ?? '保存被拒绝',
          })
          await reloadConfig()
          return false
        }
        pushNotice({
          channel,
          kind: 'success',
          text: successText,
          pending: watchName !== undefined,
        })
        await reloadConfig()
        await reloadRuntime()
        return true
      }

      /**
       * 保存后盯着一台服务器直到连接有定论。
       *
       * 保存的返回只能证明「配置写下去了」，此时 fiber 往往还在启动中、
       * 工具尚未注册。这里短轮询运行时，把提示从「正在连接…」推进到
       * 「已连接 / 启动失败」，而不是永远停在一句过期的进行时文案。
       */
      const watchServer = async (serverName) => {
        for (let attempt = 0; attempt < SETTLE_POLL_ATTEMPTS; attempt += 1) {
          const snapshot = await reloadRuntime()
          const verdict = settleVerdict(serverName, snapshot)
          // pending 随 verdict.done 取反：拿到定论的这一刻才开始算 10 秒销毁计时
          pushNotice({
            channel: serverName,
            kind: verdict.kind,
            text: verdict.text,
            pending: !verdict.done,
          })
          if (verdict.done) return
          await delay(SETTLE_POLL_INTERVAL_MS)
        }
        pushNotice({
          channel: serverName,
          kind: 'error',
          text: `${serverName} 仍未注册任何工具。实例已启动，但与 MCP 服务器的握手尚未成功（mcp-client 会在后台继续重连）；请检查地址/命令是否正确，详情见 DSH 日志。`,
        })
      }

      const saveServer = async (serverName, draft, isNew) => {
        const verdict = draftToOps(serverName, draft, isNew)
        if (!verdict.ok) {
          pushNotice({ channel: serverName, kind: 'error', text: verdict.message })
          return
        }
        if (isNew && serverName in config.servers) {
          pushNotice({
            channel: serverName,
            kind: 'error',
            text: `名称 ${serverName} 已存在`,
          })
          return
        }
        // 停用中的服务器不会挂载，没有可等的连接结果。
        // enabled 不在表单里，改自行的复选框，所以读保存前的配置即可。
        const willWatch = isNew || config.servers[serverName]?.enabled !== false
        const ok = await submit(
          verdict.ops,
          isNew ? `已添加 ${serverName}，正在连接…` : `已保存 ${serverName}，正在重连…`,
          willWatch ? serverName : undefined,
        )
        if (!ok) return
        setEditing(undefined)
        if (willWatch) await watchServer(serverName)
      }

      /**
       * 打开编辑器（`serverName` 为 undefined 表示新建）。
       *
       * 进入编辑说明注意力已经移开，此时还挂着某一行的删除确认条只会招来误点，
       * 顺手收起。
       */
      const startEditing = (serverName) => {
        setPendingDelete(undefined)
        setEditing({ name: serverName })
      }

      const removeServer = async (serverName) => {
        setPendingDelete(undefined)
        await submit([{ op: 'unset', path: ['servers', serverName] }], `已删除 ${serverName}`)
        if (selected === serverName) setSelected(undefined)
        if (editing?.name === serverName) setEditing(undefined)
      }

      const toggleServer = async (serverName, next) => {
        const ok = await submit(
          [{ op: 'set', path: ['servers', serverName, 'enabled'], value: next }],
          next ? `已启用 ${serverName}` : `已停用 ${serverName}`,
          next ? serverName : undefined,
        )
        if (ok && next) await watchServer(serverName)
      }

      const clearSecret = async (serverName, key) => {
        await submit(
          [{ op: 'unset', path: ['servers', serverName, key] }],
          `已清除 ${serverName} 的凭据`,
        )
      }

      const names = Object.keys(config.servers)
      const statusOf = (serverName) => runtime.servers.find((item) => item.name === serverName)
      const toolsOf = (serverName) =>
        runtime.groups.find((group) => group.server === serverName)?.tools ?? []

      /** 单台服务器一行 */
      const serverRow = (serverName) => {
        const server = config.servers[serverName] ?? {}
        const status = statusOf(serverName)
        const enabled = server.enabled !== false
        const tools = toolsOf(serverName)
        const expanded = selected === serverName
        const secretKey = server.transport === 'streamable-http' ? 'secretHeaders' : 'secretEnv'
        const hasSecret = isSecretSet(config.secrets, ['servers', serverName, secretKey])
        const confirmingDelete = pendingDelete === serverName
        return h(
          'div',
          { key: serverName, style: { border, borderRadius: 8, padding: 12, marginBottom: 10 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              disabled: !config.writable,
              title: '启用 / 停用',
              onChange: (event) => void toggleServer(serverName, event.target.checked),
            }),
            h('span', { style: { fontSize: 14, fontWeight: 600 } }, serverName),
            badge(server.transport === 'streamable-http' ? 'streamable-http' : 'stdio'),
            !enabled
              ? badge('已停用')
              : status?.error !== undefined
                ? badge(`启动失败`, 'error')
                : status?.state === '运行中'
                  ? // fiber 的「运行中」只说明实例活着；工具是否注册才是
                    // 「MCP 握手成功」的唯一证据，两者必须分开呈现。
                    tools.length > 0
                    ? badge('已连接', 'success')
                    : badge('未连接')
                  : badge(status?.state ?? '未挂载'),
            enabled && status?.mounted === true
              ? badge(`${tools.length} 个工具`)
              : undefined,
            hasSecret ? badge('含凭据') : undefined,
            h(
              'span',
              { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
              button(expanded ? '收起工具' : '查看工具', {
                onClick: () => setSelected(expanded ? undefined : serverName),
              }),
              button('编辑', {
                onClick: () => startEditing(serverName),
              }),
              hasSecret
                ? button('清除凭据', {
                    disabled: !config.writable,
                    onClick: () => void clearSecret(serverName, secretKey),
                  })
                : undefined,
              button('删除', {
                disabled: !config.writable || confirmingDelete,
                onClick: () => setPendingDelete(serverName),
              }),
            ),
          ),
          confirmingDelete
            ? h(
                'div',
                {
                  style: {
                    marginTop: 10,
                    padding: '10px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--dsh-color-danger, #d64545)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  },
                },
                h(
                  'span',
                  { style: { fontSize: 13, lineHeight: 1.6 } },
                  `确认删除 ${serverName}？将立即断开连接并移除其 ${tools.length} 个工具。`,
                  // 凭据一旦删除就再也拿不回来，这一条必须说在确认里
                  hasSecret ? '已保存的凭据会一并清除且无法恢复。' : '此操作不可撤销。',
                ),
                h(
                  'span',
                  { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
                  button('确认删除', {
                    onClick: () => void removeServer(serverName),
                  }),
                  button('取消', { onClick: () => setPendingDelete(undefined) }),
                ),
              )
            : undefined,
          server.description
            ? h('p', { style: hintStyle }, server.description)
            : undefined,
          h(
            'p',
            { style: { ...hintStyle, fontFamily: 'var(--dsh-font-mono, monospace)' } },
            server.transport === 'streamable-http'
              ? server.url || '（未填写 URL）'
              : [server.command, ...(server.args ?? [])].join(' ').trim() || '（未填写命令）',
          ),
          status?.skipReason !== undefined
            ? h(
                'p',
                { style: { ...hintStyle, color: 'var(--dsh-color-danger, #d64545)' } },
                `未挂载：${status.skipReason}`,
              )
            : undefined,
          status?.error !== undefined
            ? h(
                'p',
                { style: { ...hintStyle, color: 'var(--dsh-color-danger, #d64545)' } },
                `启动失败：${status.error}`,
              )
            : undefined,
          expanded
            ? h(
                'div',
                { style: { marginTop: 12, paddingTop: 12, borderTop: border } },
                tools.length === 0
                  ? h(
                      'p',
                      { style: { ...hintStyle, marginTop: 0 } },
                      status?.mounted === true
                        ? '该服务器尚未注册任何工具：实例已启动，但与 MCP 服务器的握手未完成。可能仍在连接中（点「刷新状态」重看），也可能是地址/命令有误——mcp-client 会在后台按退避重连，失败原因只在 DSH 日志里。'
                        : '该服务器未挂载，无法列出工具。',
                    )
                  : tools.map((tool) => h(ToolCard, { key: tool.name, tool })),
              )
            : undefined,
        )
      }

      return h(
        'div',
        { style: { padding: '4px 0 16px', maxWidth: 760 } },
        h(
          'p',
          { style: { margin: '0 0 16px', fontSize: 13, opacity: 0.75, lineHeight: 1.6 } },
          '集中管理本机 DSH 连接的 MCP 服务器，并查看每台服务器提供的工具、调用参数与返回内容。',
          '配置保存后立即生效：新增会即时连接，修改会重连该服务器，删除会断开连接，均无需重启 DSH。',
        ),
        config.writable
          ? undefined
          : h(
              'p',
              { style: { ...hintStyle, opacity: 0.9 } },
              '当前配置存储为只读，界面修改无法保存。',
            ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, marginBottom: 16 } },
          button('添加服务器', {
            primary: true,
            disabled: !config.writable || editing !== undefined,
            onClick: () => startEditing(undefined),
          }),
          button(refreshing ? '刷新中…' : '刷新状态', {
            disabled: refreshing,
            onClick: () => void refreshAll(),
          }),
          refreshedAt === undefined
            ? undefined
            : h(
                'span',
                { style: { ...hintStyle, marginTop: 0, alignSelf: 'center' } },
                `上次刷新 ${refreshedAt.toLocaleTimeString()}`,
              ),
        ),
        notices.length === 0
          ? undefined
          : h(
              'div',
              { style: { margin: '0 0 14px', display: 'grid', gap: 6 } },
              ...notices.map((item) =>
                h(
                  'p',
                  {
                    key: item.id,
                    style: {
                      margin: 0,
                      fontSize: 13,
                      lineHeight: 1.6,
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      color:
                        item.kind === 'error'
                          ? 'var(--dsh-color-danger, #d64545)'
                          : item.kind === 'success'
                            ? 'var(--dsh-color-success, #2e8b57)'
                            : 'inherit',
                    },
                  },
                  h('span', undefined, item.text),
                  // 终态提示会自行消失，但用户可能想立刻清掉；进行中的不给关，
                  // 否则关掉就再也看不到这次连接的结果了
                  item.settledAt === undefined
                    ? undefined
                    : h(
                        'button',
                        {
                          type: 'button',
                          title: '关闭',
                          onClick: () => dismissNotice(item.id),
                          style: {
                            marginLeft: 'auto',
                            border: 'none',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            opacity: 0.6,
                            padding: 0,
                            fontSize: 14,
                            lineHeight: 1.2,
                          },
                        },
                        '×',
                      ),
                ),
              ),
            ),
        editing === undefined
          ? undefined
          : h(ServerForm, {
              // key 让「编辑另一台」时表单状态整体重建，而不是残留上一台的草稿
              key: editing.name ?? '__new__',
              name: editing.name,
              server: editing.name === undefined ? undefined : config.servers[editing.name],
              secrets: config.secrets,
              writable: config.writable,
              onSubmit: (serverName, draft, isNew) => void saveServer(serverName, draft, isNew),
              onCancel: () => setEditing(undefined),
            }),
        names.length === 0
          ? h(
              'p',
              { style: { ...hintStyle, marginTop: 0 } },
              '还没有配置任何 MCP 服务器。点击「添加服务器」开始，例如用 stdio 方式运行 ',
              h('span', { style: codeStyle }, 'npx -y @modelcontextprotocol/server-filesystem <目录>'),
              '。',
            )
          : names.map(serverRow),
        runtime.orphans.length === 0
          ? undefined
          : h(
              'div',
              { style: { marginTop: 20, paddingTop: 16, borderTop: border } },
              h(
                'p',
                { style: { margin: '0 0 4px', fontSize: 13, fontWeight: 600 } },
                '其他来源的 MCP 工具',
              ),
              h(
                'p',
                { style: { ...hintStyle, marginTop: 0, marginBottom: 10 } },
                '这些工具由本插件之外的 mcp-client 实例注册（例如部署配置里直接挂载的服务器）。',
                '本面板只能查看它们的契约，不能在此修改其配置。',
              ),
              runtime.orphans.map((tool) => h(ToolCard, { key: tool.name, tool })),
            ),
        h(
          'p',
          { style: { ...hintStyle, marginTop: 20 } },
          '凭据字段（凭据环境变量 / 凭据请求头）保存后不会回显，界面只显示是否已配置；',
          '普通环境变量与请求头会明文展示，请勿把密钥填在那里。',
        ),
      )
    }

    /** 客户端插件入口：注册一个一级设置 section */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-wall-mcp-manager',
            order: 270,
            label: () => 'MCP 服务器',
          },
          McpManagerSection,
        ),
      )
    }

    /**
     * 浏览器端 fiber 需要的服务注入。DSH 客户端 loader 挂载 bundle 时
     * 读取本导出（cordis `registry.plugin` 读 `plugin.inject`），而
     * package.json 的 `dsh.client.inject` 只负责包级依赖边，两者不是一回事。
     * 少了 `slots`，apply 里读 `ctx.slots` 会被 cordis Guard 直接拒绝
     * （cannot get property "slots" without inject）。
     */
    exports.inject = ['slots']

    exports.apply = apply
    exports.McpManagerSection = McpManagerSection
    exports.BRIDGE_PREFIX = BRIDGE_PREFIX
    exports.parseDict = parseDict
    exports.formatDict = formatDict
    exports.parseLines = parseLines
    exports.draftToOps = draftToOps
    exports.isSecretSet = isSecretSet
    exports.typeText = typeText
    exports.settleVerdict = settleVerdict
    exports.upsertNotice = upsertNotice
    exports.NOTICE_TTL_MS = NOTICE_TTL_MS
    return module.exports
  },
})
