import * as THREE from 'three'

/** Shared by every converter: collects non-fatal problems so the UI can show them instead of hiding them. */
export interface ParseContext {
  warnings?: string[]
  /**
   * Resolves an `xacro:include` filename (after `$(find pkg)` substitution, e.g. `package://pkg/urdf/a.xacro`)
   * to its text. Browsers cannot fetch it themselves, so the importer supplies the dropped files.
   */
  resolveInclude?: (filename: string) => string | undefined
}

const XACRO_NS = 'http://www.ros.org/wiki/xacro'
const MAX_MACRO_DEPTH = 16
const MAX_INCLUDE_DEPTH = 8

// -----------------------------------------------------------------------------
// Xacro expression evaluator (hand-written; never uses eval)
// -----------------------------------------------------------------------------
type XVal = number | string | boolean

class XacroScope {
  private vars = new Map<string, string>()
  readonly parent?: XacroScope
  constructor(parent?: XacroScope) {
    this.parent = parent
  }
  get(name: string): string | undefined {
    return this.vars.get(name) ?? this.parent?.get(name)
  }
  set(name: string, value: string): void {
    this.vars.set(name, value)
  }
}

function coerce(raw: string): XVal {
  const t = raw.trim()
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  if (t === 'true' || t === 'True') return true
  if (t === 'false' || t === 'False') return false
  return raw
}

function formatXVal(v: XVal): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v)
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(9)))
  }
  return v
}

const XACRO_FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, atan2: Math.atan2, sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor,
  ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max, pow: Math.pow,
  log: Math.log, exp: Math.exp,
  radians: (d) => (d * Math.PI) / 180,
  degrees: (r) => (r * 180) / Math.PI,
}

const TOKEN_RE =
  /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\*\*|==|!=|<=|>=|[-+*/%<>(),!]))/y

type Tok = { k: 'num' | 'id' | 'str' | 'op'; v: string }

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = []
  TOKEN_RE.lastIndex = 0
  let pos = 0
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break
    TOKEN_RE.lastIndex = pos
    const m = TOKEN_RE.exec(src)
    if (!m) return null
    pos = TOKEN_RE.lastIndex
    if (m[1] !== undefined) out.push({ k: 'num', v: m[1] })
    else if (m[2] !== undefined) out.push({ k: 'id', v: m[2] })
    else if (m[3] !== undefined) out.push({ k: 'str', v: m[3].slice(1, -1) })
    else out.push({ k: 'op', v: m[4] })
  }
  return out
}

/** Evaluates one `${...}` body. Unknown names and syntax errors add a warning and degrade gracefully. */
function evaluateExpression(expr: string, scope: XacroScope, ctx: ParseContext): XVal {
  const toks = tokenize(expr)
  if (!toks) {
    ctx.warnings?.push(`Unsupported xacro expression: \${${expr}}`)
    return expr
  }
  let i = 0
  const peekOp = (...ops: string[]) => toks[i]?.k === 'op' && ops.includes(toks[i].v)
  const peekId = (...ids: string[]) => toks[i]?.k === 'id' && ids.includes(toks[i].v)
  const num = (v: XVal): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number(v))
  const truthy = (v: XVal) => (typeof v === 'string' ? v !== '' && v !== 'false' : Boolean(v))

  const parseOr = (): XVal => {
    let l = parseAnd()
    while (peekId('or')) { i++; const r = parseAnd(); l = truthy(l) || truthy(r) }
    return l
  }
  const parseAnd = (): XVal => {
    let l = parseNot()
    while (peekId('and')) { i++; const r = parseNot(); l = truthy(l) && truthy(r) }
    return l
  }
  const parseNot = (): XVal => {
    if (peekId('not') || peekOp('!')) { i++; return !truthy(parseNot()) }
    return parseCmp()
  }
  const parseCmp = (): XVal => {
    const l = parseAdd()
    if (peekOp('==', '!=', '<', '>', '<=', '>=')) {
      const op = toks[i++].v
      const r = parseAdd()
      const bothNum = typeof l !== 'string' && typeof r !== 'string'
      const a: XVal = bothNum ? num(l) : String(l)
      const b: XVal = bothNum ? num(r) : String(r)
      switch (op) {
        case '==': return a === b
        case '!=': return a !== b
        case '<': return a < b
        case '>': return a > b
        case '<=': return a <= b
        default: return a >= b
      }
    }
    return l
  }
  const parseAdd = (): XVal => {
    let l = parseMul()
    while (peekOp('+', '-')) {
      const op = toks[i++].v
      const r = parseMul()
      if (op === '+' && (typeof l === 'string' || typeof r === 'string')) l = String(l) + String(r)
      else l = op === '+' ? num(l) + num(r) : num(l) - num(r)
    }
    return l
  }
  const parseMul = (): XVal => {
    let l = parseUnary()
    while (peekOp('*', '/', '%')) {
      const op = toks[i++].v
      const r = num(parseUnary())
      const a = num(l)
      l = op === '*' ? a * r : op === '/' ? a / r : a % r
    }
    return l
  }
  const parseUnary = (): XVal => {
    if (peekOp('-')) { i++; return -num(parseUnary()) }
    if (peekOp('+')) { i++; return num(parseUnary()) }
    return parsePow()
  }
  const parsePow = (): XVal => {
    const base = parsePrimary()
    if (peekOp('**')) { i++; return Math.pow(num(base), num(parseUnary())) }
    return base
  }
  const parsePrimary = (): XVal => {
    const t = toks[i++]
    if (!t) throw new Error('unexpected end')
    if (t.k === 'num') return Number(t.v)
    if (t.k === 'str') return t.v
    if (t.k === 'op' && t.v === '(') {
      const v = parseOr()
      if (!peekOp(')')) throw new Error('missing )')
      i++
      return v
    }
    if (t.k === 'id') {
      if (peekOp('(')) {
        i++
        const args: number[] = []
        while (!peekOp(')')) {
          args.push(num(parseOr()))
          if (peekOp(',')) i++
          else break
        }
        if (!peekOp(')')) throw new Error('missing )')
        i++
        const fn = XACRO_FUNCS[t.v]
        if (!fn) throw new Error(`unknown function ${t.v}`)
        return fn(...args)
      }
      const fromScope = scope.get(t.v)
      if (fromScope !== undefined) return coerce(fromScope)
      if (t.v === 'pi') return Math.PI
      if (t.v === 'True' || t.v === 'true') return true
      if (t.v === 'False' || t.v === 'false') return false
      ctx.warnings?.push(`Undefined xacro variable '${t.v}'`)
      return t.v
    }
    throw new Error(`unexpected '${t.v}'`)
  }

  try {
    const v = parseOr()
    if (i < toks.length) throw new Error(`unexpected '${toks[i].v}'`)
    return v
  } catch (e) {
    ctx.warnings?.push(`Could not evaluate xacro expression \${${expr}}: ${(e as Error).message}`)
    return expr
  }
}

const SUBST_RE = /\$\{([^}]*)\}|\$\(([^)]*)\)/g

/** Replaces `${expr}` and `$(arg|find|env|optenv|eval ...)` occurrences in a string. */
function substitute(text: string, scope: XacroScope, args: Map<string, string>, ctx: ParseContext): string {
  if (!text.includes('$')) return text
  return text.replace(SUBST_RE, (_m, expr: string | undefined, cmd: string | undefined) => {
    if (expr !== undefined) return formatXVal(evaluateExpression(expr, scope, ctx))
    const parts = (cmd ?? '').trim().split(/\s+/)
    const [fn, a1, ...rest] = parts
    switch (fn) {
      case 'arg':
        if (args.has(a1)) return args.get(a1)!
        ctx.warnings?.push(`xacro argument '${a1}' has no value`)
        return ''
      case 'find':
        return `package://${a1}`
      case 'optenv':
        return rest.join(' ')
      case 'env':
        return ''
      case 'eval':
        return formatXVal(evaluateExpression(parts.slice(1).join(' '), scope, ctx))
      default:
        ctx.warnings?.push(`Unsupported xacro substitution $(${cmd})`)
        return ''
    }
  })
}

function parseXml(text: string): Document | null {
  const parse = (t: string) => new DOMParser().parseFromString(t, 'text/xml')
  let doc = parse(text)
  if (doc.querySelector('parsererror') && /<xacro:/.test(text) && !/xmlns:xacro/.test(text)) {
    // Many hand-written xacro snippets forget the namespace declaration; add it to the root element.
    doc = parse(text.replace(/<(robot|[A-Za-z_][\w.-]*)(\s|>)/, `<$1 xmlns:xacro="${XACRO_NS}"$2`))
  }
  return doc.querySelector('parsererror') ? null : doc
}

const isXacroEl = (n: Node, local?: string): n is Element =>
  n.nodeType === 1 && (n as Element).tagName.startsWith('xacro:') &&
  (local === undefined || (n as Element).tagName === `xacro:${local}`)

interface MacroDef {
  params: { name: string; def?: string; block: boolean; inherit: boolean }[]
  body: Element
}

/**
 * Browser xacro preprocessor. Supports properties (with scopes), `${}` expressions (arithmetic,
 * comparison, boolean logic, math functions), `xacro:arg`, `xacro:macro` calls with default / `^`
 * parameters and `*block` parameters (including nested macros), `xacro:if` / `xacro:unless`, and
 * `xacro:include` resolved from the files supplied by the caller. Anything else is reported in
 * `ctx.warnings` instead of being dropped silently.
 */
export function preprocessXacro(xacroText: string, ctx: ParseContext = {}): string {
  const doc = parseXml(xacroText)
  if (!doc) {
    ctx.warnings?.push('Xacro file is not well-formed XML; using it unchanged.')
    return xacroText
  }

  const macros = new Map<string, MacroDef>()
  const args = new Map<string, string>()
  const globalScope = new XacroScope()
  globalScope.set('pi', String(Math.PI))
  const includeStack: string[] = []

  const readParams = (raw: string): MacroDef['params'] =>
    raw.split(/\s+/).filter(Boolean).map((p) => {
      if (p.startsWith('*')) return { name: p.slice(1), block: true, inherit: false }
      const idx = p.indexOf(':=')
      if (idx < 0) return { name: p, block: false, inherit: false }
      let def = p.slice(idx + 2)
      const inherit = def.startsWith('^')
      if (inherit) def = def.slice(1).replace(/^\|/, '')
      return { name: p.slice(0, idx), def, block: false, inherit }
    })

  const truthyAttr = (el: Element, scope: XacroScope): boolean => {
    const raw = substitute(el.getAttribute('value') ?? '', scope, args, ctx).trim()
    if (raw === 'true' || raw === 'True' || raw === '1') return true
    if (raw === 'false' || raw === 'False' || raw === '0' || raw === '') return false
    const n = Number(raw)
    if (!Number.isNaN(n)) return n !== 0
    ctx.warnings?.push(`xacro:${el.tagName.slice(6)} value '${raw}' is not a boolean; treating as false`)
    return false
  }

  /** Expand `container`'s children in place, then return them for splicing into the real tree. */
  const expandInto = (container: Element, scope: XacroScope, depth: number): void => {
    let node: Node | null = container.firstChild
    while (node) {
      const next: Node | null = node.nextSibling
      if (node.nodeType === 3 || node.nodeType === 4) {
        node.nodeValue = substitute(node.nodeValue ?? '', scope, args, ctx)
      } else if (node.nodeType === 1) {
        handleElement(node as Element, scope, depth)
      }
      node = next
    }
  }

  const splice = (target: Element, from: Element) => {
    const parent = target.parentNode!
    while (from.firstChild) parent.insertBefore(from.firstChild, target)
    parent.removeChild(target)
  }

  const handleElement = (el: Element, scope: XacroScope, depth: number): void => {
    const tag = el.tagName

    if (tag === 'xacro:property') {
      const name = el.getAttribute('name')
      if (name) {
        const value = el.hasAttribute('value')
          ? substitute(el.getAttribute('value')!, scope, args, ctx)
          : (el.textContent ?? '').trim()
        scope.set(name, value)
      }
      el.parentNode?.removeChild(el)
      return
    }
    if (tag === 'xacro:arg') {
      const name = el.getAttribute('name')
      if (name && !args.has(name)) args.set(name, substitute(el.getAttribute('default') ?? '', scope, args, ctx))
      el.parentNode?.removeChild(el)
      return
    }
    if (tag === 'xacro:macro') {
      const name = el.getAttribute('name')
      if (name) macros.set(name, { params: readParams(el.getAttribute('params') ?? ''), body: el.cloneNode(true) as Element })
      el.parentNode?.removeChild(el)
      return
    }
    if (tag === 'xacro:if' || tag === 'xacro:unless') {
      const keep = truthyAttr(el, scope) === (tag === 'xacro:if')
      if (keep) {
        expandInto(el, scope, depth)
        splice(el, el)
      } else {
        el.parentNode?.removeChild(el)
      }
      return
    }
    if (tag === 'xacro:include') {
      const filename = substitute(el.getAttribute('filename') ?? '', scope, args, ctx)
      const text = ctx.resolveInclude?.(filename)
      if (text === undefined) {
        ctx.warnings?.push(`xacro:include '${filename}' was not among the imported files, so its contents are missing.`)
      } else if (includeStack.includes(filename) || includeStack.length >= MAX_INCLUDE_DEPTH) {
        ctx.warnings?.push(`xacro:include '${filename}' skipped (circular or too deeply nested).`)
      } else {
        const incDoc = parseXml(text)
        if (!incDoc) {
          ctx.warnings?.push(`xacro:include '${filename}' is not well-formed XML.`)
        } else {
          const holder = doc.createElement('include_holder')
          for (const child of Array.from(incDoc.documentElement.childNodes)) holder.appendChild(doc.importNode(child, true))
          includeStack.push(filename)
          expandInto(holder, scope, depth)
          includeStack.pop()
          el.parentNode!.insertBefore(doc.createComment(` included ${filename} `), el)
          splice(el, holder)
          return
        }
      }
      el.parentNode?.removeChild(el)
      return
    }
    if (tag === 'xacro:insert_block') {
      const name = el.getAttribute('name') ?? ''
      const blockHolder = blocksStack[blocksStack.length - 1]?.get(name)
      if (blockHolder) {
        const clone = blockHolder.cloneNode(true) as Element
        splice(el, clone)
      } else {
        ctx.warnings?.push(`xacro:insert_block '${name}' has no matching block parameter.`)
        el.parentNode?.removeChild(el)
      }
      return
    }
    if (tag.startsWith('xacro:')) {
      const macro = macros.get(tag.slice(6))
      if (!macro) {
        ctx.warnings?.push(`Unsupported or undefined xacro element <${tag}> was removed.`)
        el.parentNode?.removeChild(el)
        return
      }
      if (depth >= MAX_MACRO_DEPTH) {
        ctx.warnings?.push(`xacro:${tag.slice(6)} exceeded the macro nesting limit (${MAX_MACRO_DEPTH}); skipped.`)
        el.parentNode?.removeChild(el)
        return
      }

      const local = new XacroScope(scope)
      const blocks = new Map<string, Element>()
      const blockParams = macro.params.filter((p) => p.block)
      const callChildren = Array.from(el.children)
      blockParams.forEach((p, idx) => {
        const src = callChildren[idx]
        if (src) {
          // Block content is expanded in the caller's scope.
          const holder = doc.createElement('block_holder')
          holder.appendChild(src.cloneNode(true))
          expandInto(holder, scope, depth)
          const wrapper = doc.createElement('block_content')
          while (holder.firstChild) wrapper.appendChild(holder.firstChild)
          blocks.set(p.name, wrapper)
        }
      })
      for (const p of macro.params) {
        if (p.block) continue
        const attr = el.getAttribute(p.name)
        if (attr !== null) local.set(p.name, substitute(attr, scope, args, ctx))
        else if (p.inherit && scope.get(p.name) !== undefined) local.set(p.name, scope.get(p.name)!)
        else if (p.def !== undefined) local.set(p.name, substitute(p.def, scope, args, ctx))
        else ctx.warnings?.push(`xacro:${tag.slice(6)} is missing required parameter '${p.name}'.`)
      }

      const holder = doc.createElement('macro_holder')
      for (const child of Array.from(macro.body.childNodes)) holder.appendChild(child.cloneNode(true))
      blocksStack.push(blocks)
      expandInto(holder, local, depth + 1)
      blocksStack.pop()
      splice(el, holder)
      return
    }

    // Plain element: substitute attributes, then descend.
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes('$')) attr.value = substitute(attr.value, scope, args, ctx)
    }
    expandInto(el, scope, depth)
  }
  const blocksStack: Map<string, Element>[] = []

  const root = doc.documentElement
  root.removeAttribute('xmlns:xacro')
  expandInto(root, globalScope, 0)

  // Defensive: nothing in the xacro namespace should survive expansion.
  for (const leftover of Array.from(doc.getElementsByTagName('*'))) {
    if (isXacroEl(leftover)) {
      ctx.warnings?.push(`Leftover <${leftover.tagName}> was removed.`)
      leftover.parentNode?.removeChild(leftover)
    }
  }

  return new XMLSerializer().serializeToString(doc)
}

/**
 * Converts MuJoCo quat (w, x, y, z) into Euler angles (roll, pitch, yaw in radians).
 */
function mujocoQuatToRpy(quatStr?: string | null): string {
  if (!quatStr) return '0 0 0'
  const parts = quatStr.trim().split(/\s+/).map(Number)
  if (parts.length < 4) return '0 0 0'
  const [w, x, y, z] = parts
  const q = new THREE.Quaternion(x, y, z, w)
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
  return `${e.x.toFixed(6)} ${e.y.toFixed(6)} ${e.z.toFixed(6)}`
}

/**
 * Converts a MuJoCo MJCF (.xml) file into an equivalent URDF XML string.
 * Maps <asset><mesh>, nested <worldbody> <body> trees, <joint>, and <geom> meshes.
 */
export function convertMjcfToUrdf(mjcfText: string, modelName = 'mujoco_robot', ctx: ParseContext = {}): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(mjcfText, 'text/xml')

  const mujocoRoot = doc.querySelector('mujoco')
  if (!mujocoRoot) {
    return mjcfText
  }

  const robotName = mujocoRoot.getAttribute('model') || modelName

  // 1. Compiler options
  const compiler = doc.querySelector('compiler')
  let meshDir = compiler?.getAttribute('meshdir') || ''
  if (meshDir && !meshDir.endsWith('/')) meshDir += '/'
  // MJCF angles default to degrees; URDF is always radians.
  const jointRangeScale = (compiler?.getAttribute('angle') ?? 'degree').toLowerCase() === 'radian' ? 1 : Math.PI / 180

  // Surface everything this best-effort converter does not model, instead of dropping it silently.
  const unsupported: [string, string][] = [
    ['include', '<include> files are not followed'],
    ['tendon', '<tendon> elements are ignored'],
    ['equality', '<equality> constraints are ignored'],
    ['composite', '<composite> bodies are ignored'],
    ['flexcomp', '<flexcomp> bodies are ignored'],
    ['replicate', '<replicate> is not expanded'],
    ['frame', '<frame> transforms are not applied'],
  ]
  for (const [tagName, note] of unsupported) {
    if (doc.getElementsByTagName(tagName).length > 0) ctx.warnings?.push(`MJCF: ${note}.`)
  }
  if (doc.querySelector('default > default, default > geom, default > joint')) {
    ctx.warnings?.push('MJCF: <default> classes are not applied; per-class geom/joint settings (ranges, colours) may be missing.')
  }
  if (doc.querySelector('[euler], [axisangle], [xyaxes], [zaxis]')) {
    ctx.warnings?.push('MJCF: only quat orientations are converted; euler/axisangle/xyaxes/zaxis are treated as identity.')
  }
  if (doc.querySelector('geom[fromto]')) {
    ctx.warnings?.push('MJCF: geoms placed with fromto are not converted.')
  }

  // 2. Asset meshes & materials
  const meshMap = new Map<string, { file: string; scale: string }>()
  const meshNodes = Array.from(doc.querySelectorAll('asset > mesh'))
  for (const m of meshNodes) {
    const name = m.getAttribute('name')
    const file = m.getAttribute('file')
    const scale = m.getAttribute('scale') || '1 1 1'
    if (file) {
      const fullPath = meshDir + file
      if (name) meshMap.set(name, { file: fullPath, scale })
      meshMap.set(file, { file: fullPath, scale })
    }
  }

  const links: string[] = []
  const joints: string[] = []

  const worldbody = doc.querySelector('worldbody')
  if (!worldbody) {
    return `<robot name="${robotName}"><link name="base_link"/></robot>`
  }

  // Root base link
  links.push(`  <link name="base_link"/>`)

  let jointCount = 0

  const traverseBody = (bodyEl: Element, parentLink: string) => {
    const bodyName = bodyEl.getAttribute('name') || `body_${links.length}`
    const bodyPos = bodyEl.getAttribute('pos') || '0 0 0'
    const bodyQuat = bodyEl.getAttribute('quat')
    const bodyRpy = mujocoQuatToRpy(bodyQuat)

    // Visual geoms inside this body
    const visualXmls: string[] = []
    const geoms = Array.from(bodyEl.querySelectorAll(':scope > geom'))

    for (const geom of geoms) {
      const type = geom.getAttribute('type') || 'mesh'
      const rgba = geom.getAttribute('rgba') || '0.75 0.75 0.75 1.0'
      const geomPos = geom.getAttribute('pos') || '0 0 0'
      const geomQuat = geom.getAttribute('quat')
      const geomRpy = mujocoQuatToRpy(geomQuat)

      let geomXml = ''
      if (type === 'mesh') {
        const meshAttr = geom.getAttribute('mesh')
        if (meshAttr) {
          const entry = meshMap.get(meshAttr) || { file: meshDir + meshAttr, scale: '1 1 1' }
          geomXml = `<mesh filename="${entry.file}" scale="${entry.scale}"/>`
        }
      } else if (type === 'box') {
        const sizeParts = (geom.getAttribute('size') || '0.1 0.1 0.1').trim().split(/\s+/).map(Number)
        // MuJoCo uses half-extents for boxes; URDF uses full sizes
        const fullSize = sizeParts.map((s) => (s * 2).toFixed(4)).join(' ')
        geomXml = `<box size="${fullSize}"/>`
      } else if (type === 'cylinder') {
        const [r, halfH] = (geom.getAttribute('size') || '0.05 0.1').trim().split(/\s+/).map(Number)
        geomXml = `<cylinder radius="${r || 0.05}" length="${((halfH || 0.1) * 2).toFixed(4)}"/>`
      } else if (type === 'sphere') {
        const r = geom.getAttribute('size') || '0.05'
        geomXml = `<sphere radius="${r}"/>`
      }

      if (geomXml) {
        visualXmls.push(`    <visual>
      <origin xyz="${geomPos}" rpy="${geomRpy}"/>
      <geometry>${geomXml}</geometry>
      <material><color rgba="${rgba}"/></material>
    </visual>`)
      }
    }

    links.push(`  <link name="${bodyName}">
${visualXmls.join('\n')}
  </link>`)

    // Joint connecting parentLink to bodyName
    const jointEls = Array.from(bodyEl.querySelectorAll(':scope > joint'))
    if (jointEls.length > 1) {
      ctx.warnings?.push(`MJCF: body '${bodyName}' has ${jointEls.length} joints; only the first is kept (URDF allows one joint per link).`)
    }
    if (jointEls.length > 0) {
      for (const j of jointEls.slice(0, 1)) {
        const jName = j.getAttribute('name') || `joint_${++jointCount}`
        const jType = j.getAttribute('type') || 'revolute'
        if (jType === 'free') {
          // Free floating joint connects base_link to floating pelvis
          joints.push(`  <joint name="${jName}" type="floating">
    <parent link="${parentLink}"/>
    <child link="${bodyName}"/>
    <origin xyz="${bodyPos}" rpy="${bodyRpy}"/>
  </joint>`)
          continue
        }

        const axis = j.getAttribute('axis') || '0 0 1'
        const rangeParts = j.getAttribute('range')?.trim().split(/\s+/)
        // Hinge ranges are in the compiler's angle unit; slide joints are metres.
        const unit = jType === 'slide' ? 1 : jointRangeScale
        const lower = rangeParts ? String(Number(rangeParts[0]) * unit) : String(-Math.PI)
        const upper = rangeParts ? String(Number(rangeParts[1]) * unit) : String(Math.PI)
        const urdfType = jType === 'slide' ? 'prismatic' : rangeParts ? 'revolute' : 'continuous'

        joints.push(`  <joint name="${jName}" type="${urdfType}">
    <parent link="${parentLink}"/>
    <child link="${bodyName}"/>
    <origin xyz="${bodyPos}" rpy="${bodyRpy}"/>
    <axis xyz="${axis}"/>
    <limit lower="${lower}" upper="${upper}" effort="100" velocity="10"/>
  </joint>`)
      }
    } else {
      // Fixed joint
      const fixedName = `${parentLink}_to_${bodyName}`
      joints.push(`  <joint name="${fixedName}" type="fixed">
    <parent link="${parentLink}"/>
    <child link="${bodyName}"/>
    <origin xyz="${bodyPos}" rpy="${bodyRpy}"/>
  </joint>`)
    }

    // Recurse child bodies
    const childBodies = Array.from(bodyEl.querySelectorAll(':scope > body'))
    for (const cb of childBodies) {
      traverseBody(cb, bodyName)
    }
  }

  const topBodies = Array.from(worldbody.querySelectorAll(':scope > body'))
  for (const tb of topBodies) {
    traverseBody(tb, 'base_link')
  }

  return `<?xml version="1.0"?>
<robot name="${robotName}">
${links.join('\n\n')}

${joints.join('\n\n')}
</robot>`
}

/**
 * Checks if the content is a MuJoCo MJCF XML document.
 */
export function isMuJoCoModel(text: string): boolean {
  // Match the ROOT element only. Unitree/ROS URDFs embed a `<mujoco><compiler meshdir=.../></mujoco>`
  // extension block inside `<robot>`, which must not be mistaken for an MJCF document.
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<mujoco[\s>]/i.test(
    text
  )
}

/**
 * Checks if the content is a ROS Xacro document.
 */
export function isXacroModel(text: string): boolean {
  return /xmlns:xacro|<xacro:/i.test(text)
}

/**
 * Parses and converts any robot description format (.urdf, .xacro, .xml/MJCF)
 * into a standard, fully resolved URDF XML string ready for URDFLoader.
 */
export function parseRobotDescription(rawText: string, filenameOrUrl = '', ctx: ParseContext = {}): string {
  if (isMuJoCoModel(rawText)) {
    const modelName = filenameOrUrl.split('/').pop()?.replace(/\.[^.]+$/, '') || 'mujoco_robot'
    return convertMjcfToUrdf(rawText, modelName, ctx)
  }

  if (isXacroModel(rawText) || /\.xacro$/i.test(filenameOrUrl)) {
    return preprocessXacro(rawText, ctx)
  }

  return rawText
}
