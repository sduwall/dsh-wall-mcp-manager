// 验证插件依赖的 @deepseek-ai/dsh-settings 在「所有已发布且 >= 本插件下限」的版本上，
// 设置 API 表面保持一致：即旧导出 installSettingsSection / settingsNamespace 已移除，
// 新接口 ctx.settings.installSection(owner, ns, schema, entry, hooks) 与
// ctx.settings.register(ns, schema, options) 的签名不变。
//
// 目的：DSH 在 0.1.2-alpha 起删掉了顶层导出 installSettingsSection，改由注入的
// settings 服务方法承载。我们担心它在「中间某个已发布版本」又悄悄改了方法名或参数，
// 导致插件在某个 DSH 版本上加载即崩。本脚本把每个已发布版本都拉下来核对一遍，
// 任一版本不符即非零退出，可作为发布前 / CI 的守护。
//
// 运行：node scripts/verify-dsh-versions.mjs   （需能访问 registry.npmjs.org 与 unpkg.com）
// 退出码：0 = 全部一致；1 = 有版本不一致；2 = 无法获取版本列表（如离线）

const PKG = '@deepseek-ai/dsh-settings'
// 本插件支持的最低 dsh-settings 版本：移除 installSettingsSection 的首个已发布版本。
const FLOOR = '0.1.2-alpha.2'

// ---- 最小 semver 比较，仅覆盖本场景（0.1.x 预发布） ----
function parse(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) throw new Error('无法解析版本: ' + v)
  const pre = m[4]
    ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
    : null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre }
}
function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const n = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < n; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else if (typeof x === 'number') return -1
    else if (typeof y === 'number') return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
const gte = (v, floor) => cmp(parse(v), parse(floor)) >= 0

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function main() {
  let versions
  try {
    const reg = JSON.parse(await fetchText(`https://registry.npmjs.org/${PKG}`))
    versions = Object.keys(reg.versions)
  } catch (e) {
    console.error(`无法获取 ${PKG} 的已发布版本列表（可能离线）：${e.message}`)
    process.exit(2)
  }

  const targets = versions.filter((v) => gte(v, FLOOR)).sort((a, b) => cmp(parse(a), parse(b)))
  if (targets.length === 0) {
    console.error(`未找到 >= ${FLOOR} 的已发布版本。`)
    process.exit(2)
  }

  console.log(`核对 ${PKG} 在 >= ${FLOOR} 的全部 ${targets.length} 个已发布版本上的设置 API 表面\n`)

  const rows = []
  let failures = 0
  for (const v of targets) {
    let src
    try {
      src = await fetchText(`https://unpkg.com/${PKG}@${v}/lib/index.js`)
    } catch (e) {
      rows.push({ v, ok: false, reason: `拉取失败: ${e.message}` })
      failures++
      continue
    }

    const removedOld = !/installSettingsSection/.test(src)
    const nsRemoved = !/settingsNamespace/.test(src)
    const hasInstallSection = /installSection\s*\(/.test(src)
    const sigMatch = /installSection\s*\(\s*owner\s*,\s*ns\s*,\s*schema\s*,\s*entry\s*,\s*hooks\s*\)/.test(src)
    const hasRegister = /register\s*\(\s*ns\s*,\s*schema\s*,\s*options\s*\)/.test(src)

    const ok = removedOld && nsRemoved && hasInstallSection && sigMatch && hasRegister
    if (!ok) failures++
    rows.push({ v, ok, removedOld, nsRemoved, hasInstallSection, sigMatch, hasRegister })
  }

  console.log(
    'version'.padEnd(22),
    'oldRemoved',
    'nsRemoved',
    'installSection',
    'sigMatch',
    'register',
    'verdict',
  )
  for (const r of rows) {
    console.log(
      r.v.padEnd(22),
      String(r.removedOld).padEnd(10),
      String(r.nsRemoved).padEnd(9),
      String(r.hasInstallSection).padEnd(14),
      String(r.sigMatch).padEnd(8),
      String(r.hasRegister).padEnd(8),
      r.ok ? 'OK' : 'FAIL',
    )
  }

  if (failures > 0) {
    console.error(
      `\n✗ ${failures} 个版本不匹配预期。DSH 可能在中间版本改过设置 API，需升级插件或收窄版本上限后再发版。`,
    )
    process.exit(1)
  }
  console.log(
    `\n✓ 全部 ${rows.length} 个已发布版本一致：旧导出已移除、installSection(owner, ns, schema, entry, hooks) 与 register(ns, schema, options) 签名稳定。`,
  )
  console.log(`本插件可安全声明 peerDependencies 支持 ${PKG} >= ${FLOOR}。`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
