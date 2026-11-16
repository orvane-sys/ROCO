// A xacro preprocessor for the browser that follows Python xacro 2.1.1 (the version ROS 2 ships), in its default in-order
// mode: properties (lazy, with scopes and blocks), `${}` Python expressions, `$(arg|find|optenv|dirname|eval)`, macros with
// defaults, `^` forwarding and `*`/`**` blocks, namespaced includes, `xacro:call`, `xacro:element`, `xacro:attribute`,
// `xacro:if`/`unless`, `load_yaml` and the `xacro.` functions. Expressions go to pyExpr's evaluator, never to JS eval.
//
// Where Python xacro stops with an error, this reports it and goes on without the element or expression, so one bad line
// does not lose the whole robot. Limits (elements, macro and include depth, expression length, time) end the import with a
// named reason instead: the files are untrusted.
import { parse as parseYaml, type ScalarTag, type Tags } from 'yaml'
import { LIMITS, ImportRefused, refuse } from './importLimits'
import { parseXmlSafe, type Deadline } from './safeXml'
import type { ReportKind } from './importReport'
import type { ParseContext } from './modelFormatParser'
import {
  MapScope, PyDict, PyError, PyFunc, PyModule, PyObject, dotify, evalNode, parseExpr, parseFloatStr, pyStr, pythonBuiltins,
  shortText, tokenize, truthy, type PyScope, type PyVal,
} from './pyExpr'

const XACRO_NS = 'http://www.ros.org/wiki/xacro'

/** A xacro error Python xacro would stop on; here it is reported and the element or expression is left out. */
class XacroError extends Error {}

/** `xacro.fatal()`: the file asked to stop, so the import stops. */
export class XacroFatal extends Error {
  constructor(message: string) {
    super(`The xacro stopped itself with xacro.fatal: ${message}`)
    this.name = 'XacroFatal'
  }
}

type Expr = ReturnType<typeof parseExpr>

/** An element kept as a value: a `*block` macro parameter or a property defined by its content (`**name`). */
class XBlock extends PyObject {
  readonly pyType = 'Element'
  readonly el: Element
  constructor(el: Element) {
    super()
    this.el = el
  }
  attr(): PyVal | undefined {
    return undefined
  }
}

/** Python xacro's `Table._eval_literal`: a property value that reads as a number or bool becomes one. */
function evalLiteral(v: PyVal): PyVal {
  if (typeof v !== 'string') return v
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1)
  if (v.includes('_')) return v
  // int() first; Python 3.10 refuses more than 4300 digits, and float() then gives inf
  if (/^\s*[+-]?\d+\s*$/.test(v) && v.trim().replace(/^[+-]/, '').length <= 4300) return BigInt(v.trim().replace(/^\+/, ''))
  const f = parseFloatStr(v)
  if (f !== undefined) return f
  if (v === 'true' || v === 'True') return true
  if (v === 'false' || v === 'False') return false
  return v
}

/** Python xacro's `get_boolean_value`. */
function boolOf(v: PyVal, cond: string): boolean {
  if (typeof v === 'string') {
    if (v === 'true' || v === 'True') return true
    if (v === 'false' || v === 'False') return false
    if (/^\s*[+-]?\d(?:_?\d)*\s*$/.test(v)) return /[1-9]/.test(v)
    throw new XacroError(`Xacro conditional "${cond}" evaluated to "${v}", which is not a boolean expression.`)
  }
  return truthy(v)
}

const KEYWORDS = new Set(
  ('False None True and as assert async await break class continue def del elif else except finally for from global if ' +
    'import in is lambda nonlocal not or pass raise return try while with yield').split(' '),
)
const isValidName = (n: string) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(n) && !KEYWORDS.has(n)

/** A symbol table (Python xacro's `Table`, or a `NameSpace` from `xacro:include ns=`). It is also a value: `ns.name`. */
class XTable extends PyObject implements PyScope {
  readonly pyType = 'NameSpace'
  private readonly vars = new Map<string, { v: PyVal; lazy: boolean }>()
  private readonly resolving: string[] = []
  readonly parent: XTable | null
  readonly isNs: boolean
  private readonly x: Xacro
  constructor(parent: XTable | null, isNs: boolean, x: Xacro) {
    super()
    this.parent = parent
    this.isNs = isNs
    this.x = x
  }
  attr(name: string): PyVal {
    return this.get(name)
  }
  lookup(name: string): PyVal | undefined {
    const e = this.vars.get(name)
    if (e) return e.lazy ? this.resolve(name, e.v as string) : e.v
    return this.parent ? this.parent.lookup(name) : this.x.globals.get(name)
  }
  get(name: string): PyVal {
    const v = this.lookup(name)
    if (v === undefined) throw new PyError('NameError', `name '${name}' is not defined`)
    return v
  }
  has(name: string): boolean {
    return this.vars.has(name) || (this.parent ? this.parent.has(name) : this.x.globals.has(name))
  }
  setItem(name: string, value: PyVal, unevaluated: boolean): void {
    const v = evalLiteral(value)
    this.vars.set(name, { v, lazy: unevaluated && typeof v === 'string' })
  }
  delete(name: string): void {
    this.vars.delete(name)
    this.parent?.delete(name)
  }
  top(): XTable {
    return this.parent ? this.parent.top() : this
  }
  private resolve(name: string, raw: string): PyVal {
    if (this.resolving.includes(name)) {
      throw new XacroError(`circular variable definition: ${[...this.resolving, name].join(' -> ')}`)
    }
    this.resolving.push(name)
    try {
      const v = evalLiteral(this.x.evalText(raw, this))
      this.vars.set(name, { v, lazy: false })
      return v
    } finally {
      this.resolving.pop()
    }
  }
}

interface Macro {
  params: string[]
  /** param → [the name it forwards with `^`, or null; its default text, or null] */
  defaults: Map<string, [string | null, string | null]>
  body: Element
  /** Elements one call copies. */
  size: number
}

/** Macros by name; a namespace from `xacro:include ns=` is a nested table. */
class MacroTable {
  readonly map = new Map<string, Macro | MacroTable>()
  readonly parent: MacroTable | null
  constructor(parent: MacroTable | null) {
    this.parent = parent
  }
  get(name: string): Macro | MacroTable | undefined {
    return this.map.get(name) ?? this.parent?.get(name)
  }
}

// One parameter spec of a macro's `params`, as Python xacro reads it (its regex, kept as written: `.` stops at a newline).
const MACRO_ARG = /^\s*([^\s:=]+?)\s*:?=\s*(\^\|?)?(\$\{.*?\}|\$\(.*?\)|(?:'.*?'|".*?"|[^\s'"]+)+|)(?:\s+|$)(.*)/

function parseMacroParams(spec: string): Pick<Macro, 'params' | 'defaults'> {
  const params: string[] = []
  const defaults = new Map<string, [string | null, string | null]>()
  let rest = spec
  while (rest) {
    const m = MACRO_ARG.exec(rest)
    if (m) {
      const [, param, forward, def, more] = m
      params.push(param)
      defaults.set(param, [forward ? param : null, def || null])
      rest = more
    } else {
      const t = rest.trimStart()
      if (!t) break
      const sp = t.search(/\s/)
      params.push(sp < 0 ? t : t.slice(0, sp))
      rest = sp < 0 ? '' : t.slice(sp).trimStart()
    }
  }
  return { params, defaults }
}

// The lexer of Python xacro's eval_text, in its order. A `${}` or `$()` body is read at most one character past the
// expression cap, so a long run with no closing bracket costs linear time.
const RE_DOLLARS = /\$\$+(\{|\()/y
const RE_EXPR = new RegExp(`\\$\\{([^}]{0,${LIMITS.exprChars + 1}})(\\}?)`, 'y')
const RE_EXT = new RegExp(`\\$\\(([^)]{0,${LIMITS.exprChars + 1}})(\\)?)`, 'y')
const RE_TEXT = /[^$]+|\$[^{($]+|\$$/y

type Piece = { k: 'text'; s: string } | { k: 'expr' | 'ext'; s: string }

/** Splits text into its pieces. Throws `refuse('expression')` for a body over the cap, XacroError where Python's lexer fails. */
function lexText(text: string): Piece[] {
  const out: Piece[] = []
  let pos = 0
  const at = (re: RegExp) => {
    re.lastIndex = pos
    return re.exec(text)
  }
  while (pos < text.length) {
    let m: RegExpExecArray | null
    if ((m = at(RE_DOLLARS))) out.push({ k: 'text', s: m[0].slice(1) })
    else if ((m = at(RE_EXPR)) && (m[2] || m[1].length > LIMITS.exprChars)) {
      if (m[1].length > LIMITS.exprChars) throw refuse('expression', shortText(m[1]))
      out.push({ k: 'expr', s: m[1] })
    } else if ((m = at(RE_EXT)) && (m[2] || m[1].length > LIMITS.exprChars)) {
      if (m[1].length > LIMITS.exprChars) throw refuse('expression', shortText(m[1]))
      out.push({ k: 'ext', s: m[1] })
    } else if ((m = at(RE_TEXT))) out.push({ k: 'text', s: m[0] })
    else throw new XacroError(`invalid expression: ${shortText(text.slice(pos))}`)
    pos += m[0].length
  }
  return out
}

// --- load_yaml -------------------------------------------------------------------------------------------------------

/** A scalar with a unit tag (`!degrees 90`): its expression, and the factor to SI units. */
class UnitValue {
  readonly expr: string
  readonly factor: number
  constructor(expr: string, factor: number) {
    this.expr = expr
    this.factor = factor
  }
}

const UNIT_TAGS: ScalarTag[] = (
  [['!radians', 1], ['!degrees', Math.PI / 180], ['!meters', 1], ['!millimeters', 0.001], ['!foot', 0.3048], ['!inches', 0.0254]] as const
).map(([tag, factor]) => ({ tag, resolve: (s: string) => new UnitValue(s, factor) }))

// PyYAML's (YAML 1.1) implicit bool, int and float, which differ from the yaml package's yaml-1.1 schema: no y/n bools,
// no `09` ints, and a float needs a dot (`1e3` is a string).
const PY_BOOL: ScalarTag = {
  tag: 'tag:yaml.org,2002:bool',
  default: true,
  test: /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  resolve: (s) => /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/.test(s),
}
const PY_INT: ScalarTag = {
  tag: 'tag:yaml.org,2002:int',
  default: true,
  test: /^[-+]?(?:0|[1-9][0-9_]*)$/,
  resolve: (s) => BigInt(s.replace(/[_+]/g, '')),
}
const PY_FLOAT: ScalarTag = {
  tag: 'tag:yaml.org,2002:float',
  default: true,
  test: /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?)$/,
  resolve: (s) => parseFloat(s.replace(/_/g, '')),
}

function pyYamlTags(tags: Tags): Tags {
  const out: Tags = []
  for (const t of tags) {
    if (typeof t === 'string' || !('tag' in t)) {
      out.push(t)
      continue
    }
    const format = (t as ScalarTag).format
    const test = String((t as ScalarTag).test ?? '')
    if (t.tag === 'tag:yaml.org,2002:bool') {
      if (!out.includes(PY_BOOL)) out.push(PY_BOOL)
    } else if (t.tag === 'tag:yaml.org,2002:int' && !format) out.push(PY_INT)
    else if (t.tag === 'tag:yaml.org,2002:float' && format === 'EXP') continue
    else if (t.tag === 'tag:yaml.org,2002:float' && !format && !test.includes('inf')) out.push(PY_FLOAT)
    else out.push(t)
  }
  return [...out, ...UNIT_TAGS]
}

// --- the preprocessor ------------------------------------------------------------------------------------------------

class Xacro {
  readonly globals = new Map<string, PyVal>()
  private readonly rootScope: PyScope
  private readonly args = new Map<string, string>()
  private readonly filestack: string[]
  private readonly macroStack: string[] = []
  private readonly exprCache = new Map<string, Expr>()
  private readonly yamlCache = new Map<string, PyVal>()
  private readonly noted = new Set<string>()
  private elements: number
  private steps = 0
  private readonly check: () => void

  readonly doc: Document
  private readonly ctx: ParseContext
  constructor(doc: Document, ctx: ParseContext) {
    this.doc = doc
    this.ctx = ctx
    this.filestack = [ctx.fileName || 'the xacro file']
    this.elements = doc.getElementsByTagName('*').length
    for (const [k, v] of Object.entries(ctx.xacroArgs ?? {})) this.args.set(k, String(v))
    const deadline: Deadline | undefined = ctx.deadline
    this.check = () => deadline?.check('expanding the xacro')

    const { direct, python, math } = pythonBuiltins()
    const f = (name: string, fn: (a: PyVal[], kw: Map<string, PyVal>) => PyVal) => new PyFunc(name, fn)
    const loadYaml = f('load_yaml', (a) => this.loadYaml(pyStr(a[0] ?? null)))
    const absFilename = f('abs_filename', (a) => pyStr(a[0] ?? null))
    const dotifyFn = f('dotify', (a) => {
      const d = a[0]
      if (!(d instanceof PyDict)) throw new PyError('TypeError', 'dotify() needs a dict')
      return dotify(d)
    })
    const silent = (name: string) => f(name, () => '')
    const xacroNs = new Map<string, PyVal>([
      ['load_yaml', loadYaml],
      ['abs_filename', absFilename],
      ['dotify', dotifyFn],
      ['arg', f('arg', (a) => {
        const name = pyStr(a[0] ?? null)
        const v = this.args.get(name)
        if (v === undefined) throw new PyError('KeyError', `'${name}'`)
        return v
      })],
      ['message', silent('message')],
      ['warning', silent('warning')],
      ['print_location', silent('print_location')],
      ['error', f('error', (a) => {
        this.note('error', 'The xacro reported an error.', a.map(pyStr).join(' '))
        return ''
      })],
      ['fatal', f('fatal', (a) => {
        throw new XacroFatal(a.map(pyStr).join(' '))
      })],
      ['tokenize', f('tokenize', tokenize)],
    ])
    for (const [k, v] of direct) this.globals.set(k, v)
    this.globals.set('load_yaml', loadYaml)
    this.globals.set('abs_filename', absFilename)
    this.globals.set('dotify', dotifyFn)
    this.globals.set('python', new PyModule('python', python))
    this.globals.set('math', new PyModule('math', math))
    this.globals.set('xacro', new PyModule('xacro', xacroNs))
    this.rootScope = new MapScope(this.globals)
  }

  private note(kind: ReportKind, message: string, where?: string): void {
    const { report, warnings } = this.ctx
    if (report) report.add(kind, message, where ? { where } : {})
    else {
      const line = `Xacro: ${message}${where ? ` (${where})` : ''}`
      if (!this.noted.has(line)) {
        this.noted.add(line)
        warnings?.push(line)
      }
    }
  }

  private tick(): void {
    if (++this.steps % 64 === 0) this.check()
  }

  /** Counts elements about to be copied, so an exponential xacro stops near the cap instead of filling memory first. */
  private grow(n: number, what: string): void {
    this.elements += n
    if (this.elements > LIMITS.xacroElements) throw refuse('elements', what)
  }

  private get file(): string {
    return this.filestack[this.filestack.length - 1]
  }

  // --- text and expressions ---

  /** Python's eval_text: one piece keeps its type, several are joined as str(). */
  evalText(text: string, sym: XTable): PyVal {
    if (!text.includes('$')) return text
    const pieces = lexText(text)
    const out: PyVal[] = []
    let grown = 0
    for (const p of pieces) {
      if (p.k === 'text') out.push(p.s)
      else {
        const v = p.k === 'expr' ? this.handleExpr(p.s, sym) : this.handleExtension(p.s, sym)
        if (typeof v === 'string') grown += v.length
        out.push(v)
      }
    }
    if (out.length === 1) return out[0]
    const joined = out.map(pyStr).join('')
    if (grown > LIMITS.exprChars) throw refuse('expression', `the value of ${shortText(text)} is ${joined.length} characters`)
    return joined
  }

  /** evalText for an attribute or text: a lexer error is reported and the text kept as written. */
  private text(text: string, sym: XTable): PyVal {
    try {
      return this.evalText(text, sym)
    } catch (e) {
      if (!(e instanceof XacroError)) throw e
      this.note('error', 'A xacro text could not be read, so it was left as written.', e.message)
      return text
    }
  }

  private compile(src: string): Expr {
    let node = this.exprCache.get(src)
    if (!node) {
      node = parseExpr(src)
      if (this.exprCache.size > 10_000) this.exprCache.clear()
      this.exprCache.set(src, node)
    }
    return node
  }

  private handleExpr(body: string, sym: XTable): PyVal {
    const whole = `\${${body}}`
    let v: PyVal
    try {
      const src = pyStr(this.evalText(body, sym))
      v = evalNode(this.compile(src), sym, { check: this.check })
    } catch (e) {
      if (!(e instanceof PyError || e instanceof XacroError)) throw e
      this.note('error', 'A xacro expression could not be evaluated, so it was left as written.', `${shortText(whole)}: ${e.message}`)
      return whole
    }
    if (typeof v === 'string' && v.length > LIMITS.exprChars) {
      throw refuse('expression', `the value of ${shortText(whole)} is ${v.length} characters`)
    }
    return v
  }

  private handleExtension(body: string, sym: XTable): PyVal {
    const whole = `$(${body})`
    try {
      const s = pyStr(this.evalText(body, sym))
      if (s === 'cwd') return '.'
      if (s.startsWith('eval ')) return this.substEval(s.slice(5))
      const parts = s.split(' ').filter(Boolean)
      const [cmd, ...a] = parts
      const one = () => {
        if (a.length !== 1) throw new XacroError(`$(${cmd}) takes one argument: ${s}`)
        return a[0]
      }
      switch (cmd) {
        case 'find':
          return `package://${one()}`
        case 'arg': {
          const name = one()
          const v = this.args.get(name)
          if (v !== undefined) return v
          this.note('error', `The xacro needs the argument '${name}', which has no value, so it was left empty.`, this.file)
          return ''
        }
        case 'optenv':
          if (!a.length) throw new XacroError(`$(optenv) needs a variable name: ${s}`)
          return a.slice(1).join(' ')
        case 'env':
          this.note('unsupported', 'The xacro reads an environment variable, which a browser does not have, so it was left empty.', one())
          return ''
        case 'dirname':
          return '.'
        default:
          throw new XacroError(`Unknown substitution command: ${shortText(s)}`)
      }
    } catch (e) {
      if (!(e instanceof PyError || e instanceof XacroError)) throw e
      this.note('error', 'A xacro substitution could not be evaluated, so it was left as written.', `${shortText(whole)}: ${e.message}`)
      return whole
    }
  }

  /** `$(eval expr)`: roslaunch's eval, with the arguments (converted to numbers or bools) and math as names. */
  private substEval(src: string): string {
    if (src.includes('__')) throw new XacroError('$(eval ...) may not contain double underscore expressions')
    const convert = (v: string): PyVal => {
      if (v.includes('.')) {
        const f = parseFloatStr(v)
        if (f !== undefined) return f
      } else if (/^\s*[+-]?\d(?:_?\d)*\s*$/.test(v)) return BigInt(v.trim().replace(/[_+]/g, ''))
      const l = v.toLowerCase()
      if (l === 'true') return true
      if (l === 'false') return false
      return v
    }
    const { python, math } = pythonBuiltins()
    const fns = new Map<string, PyVal>(math)
    const f = (name: string, fn: (a: PyVal[]) => PyVal) => fns.set(name, new PyFunc(name, (a) => fn(a)))
    f('arg', (a) => {
      const name = pyStr(a[0] ?? null)
      const v = this.args.get(name)
      if (v === undefined) throw new XacroError(`Undefined substitution argument ${name}`)
      return convert(v)
    })
    f('dirname', () => '.')
    f('find', (a) => `package://${pyStr(a[0] ?? null)}`)
    f('optenv', (a) => (a.length > 1 ? pyStr(a[1]) : ''))
    f('env', (a) => {
      throw new XacroError(`environment variable '${pyStr(a[0] ?? null)}' is not set`)
    })
    for (const [k, v] of [['true', true], ['false', false], ['True', true], ['False', false]] as const) fns.set(k, v)
    const scope: PyScope = {
      get: (name) => {
        const fv = fns.get(name)
        if (fv !== undefined) return fv
        const av = this.args.get(name)
        if (av !== undefined) return convert(av)
        const bv = python.get(name)
        if (bv !== undefined) return bv
        throw new PyError('NameError', `name '${name}' is not defined`)
      },
    }
    const v = pyStr(evalNode(this.compile(src), scope, { check: this.check }))
    if (v.length > LIMITS.exprChars) throw refuse('expression', `the value of ${shortText(`$(eval ${src})`)} is ${v.length} characters`)
    return v
  }

  // --- load_yaml ---

  private loadYaml(spec: string): PyVal {
    const hit = this.ctx.resolveInclude?.(spec, this.file)
    if (!hit) throw new XacroError(`load_yaml: '${spec}' was not among the imported files`)
    const cached = this.yamlCache.get(hit.path)
    if (cached !== undefined) return cached
    let data: unknown
    try {
      data = parseYaml(hit.text, {
        version: '1.1',
        mapAsMap: true,
        intAsBigInt: true,
        maxAliasCount: 100,
        uniqueKeys: false,
        logLevel: 'error',
        customTags: pyYamlTags,
      })
    } catch (e) {
      throw new PyError('YAMLError', `${hit.path}: ${(e as Error).message.split('\n')[0]}`)
    }
    const seen = new Set<unknown>()
    const toPy = (v: unknown): PyVal => {
      this.tick()
      if (v === null || v === undefined) return null
      if (typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'number' || typeof v === 'string') return v
      if (v instanceof UnitValue) {
        const x = evalNode(this.compile(v.expr), this.rootScope, { check: this.check })
        const n = typeof x === 'bigint' ? Number(x) : typeof x === 'number' ? x : typeof x === 'boolean' ? Number(x) : parseFloatStr(pyStr(x))
        if (n === undefined) throw new PyError('ValueError', `could not convert ${pyStr(x)} to float`)
        return n * v.factor
      }
      if (v instanceof Date) return v.toISOString()
      if (seen.has(v)) throw new PyError('RecursionError', `${hit.path} refers to itself`)
      seen.add(v)
      try {
        if (Array.isArray(v)) return v.map(toPy)
        if (v instanceof Set) return Array.from(v, toPy)
        if (v instanceof Map) {
          const d = new PyDict(true)
          for (const [k, x] of v) d.set(toPy(k), toPy(x))
          return d
        }
        if (typeof v === 'object') {
          const d = new PyDict(true)
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) d.set(k, toPy(x))
          return d
        }
        return pyStr(String(v))
      } finally {
        seen.delete(v)
      }
    }
    const out = toPy(data)
    this.yamlCache.set(hit.path, out)
    return out
  }

  // --- elements ---

  private sizeOf(el: Element): number {
    return el.getElementsByTagName('*').length + 1
  }

  /** Python's replace_node(content_only=True): `from`'s children take `target`'s place. */
  private splice(target: Element, from: Element): void {
    const parent = target.parentNode!
    while (from.firstChild) parent.insertBefore(from.firstChild, target)
    parent.removeChild(target)
  }

  /** Python's remove_previous_comments: comments right before a xacro element go with it. */
  private removePreviousComments(el: Element): void {
    let prev = el.previousSibling
    while (prev) {
      if (prev.nodeType === 3 && /^\s+$/.test(prev.nodeValue ?? '') && (prev.nodeValue ?? '').split('\n').length <= 2) prev = prev.previousSibling
      if (prev && prev.nodeType === 8) {
        const c = prev
        prev = prev.previousSibling
        c.parentNode?.removeChild(c)
      } else break
    }
  }

  private importNamespaces(parent: Node | null, from: Element): void {
    if (!parent || parent.nodeType !== 1) return
    for (const a of Array.from(from.attributes)) {
      if (a.name.startsWith('xmlns:') && a.name !== 'xmlns:xacro' && !(parent as Element).hasAttribute(a.name)) {
        ;(parent as Element).setAttribute(a.name, a.value)
      }
    }
  }

  private attrs(el: Element, required: string[], optional: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    for (const n of required) {
      const v = el.getAttribute(n)
      if (v === null) throw new XacroError(`<${el.tagName}> is missing its '${n}' attribute`)
      out[n] = v
    }
    for (const n of optional) out[n] = el.getAttribute(n)
    return out
  }

  private evalAttributes(el: Element, sym: XTable): void {
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('xacro:') || a.name === 'xmlns:xacro') el.removeAttribute(a.name)
      else if (a.value.includes('$')) el.setAttribute(a.name, pyStr(this.text(a.value, sym)))
    }
  }

  /** Python's eval_all: the element's attributes, then its children. */
  evalAll(el: Element, macros: MacroTable, sym: XTable): void {
    this.evalAttributes(el, sym)
    this.evalChildren(el, macros, sym)
  }

  private evalChildren(parent: Element, macros: MacroTable, sym: XTable): void {
    let node: Node | null = parent.firstChild
    let evalComments = false
    while (node) {
      this.tick()
      const next: Node | null = node.nextSibling
      if (node.nodeType === 1) {
        evalComments = false
        const el = node as Element
        let again: Element | null = null
        try {
          again = this.evalElement(el, macros, sym)
        } catch (e) {
          if (!(e instanceof XacroError)) throw e
          this.note('error', 'A xacro element could not be expanded, so it was left out.', `<${el.tagName}> in ${this.file}: ${e.message}`)
          el.parentNode?.removeChild(el)
        }
        if (again) {
          node = again
          continue
        }
      } else if (node.nodeType === 3) {
        const v = node.nodeValue ?? ''
        if (v.includes('$')) node.nodeValue = pyStr(this.text(v, sym))
        if ((node.nodeValue ?? '').trim()) evalComments = false
      } else if (node.nodeType === 8) {
        const v = node.nodeValue ?? ''
        if (v.includes('xacro:eval-comments')) {
          evalComments = !v.includes('xacro:eval-comments:off')
          node.parentNode?.removeChild(node)
        } else if (evalComments && v.includes('$')) node.nodeValue = pyStr(this.text(v, sym))
      }
      node = next
    }
  }

  /** Handles one child element. Returns an element to process next in its place (`xacro:element`), else null. */
  private evalElement(el: Element, macros: MacroTable, sym: XTable): Element | null {
    const tag = el.tagName
    if (!tag.startsWith('xacro:')) {
      this.evalAll(el, macros, sym)
      return null
    }
    switch (tag) {
      case 'xacro:insert_block': {
        const { name } = this.attrs(el, ['name'], [])
        const multi = sym.has(`**${name}`)
        if (!multi && !sym.has(`*${name}`)) throw new XacroError(`Undefined block "${name}"`)
        const block = sym.get(multi ? `**${name}` : `*${name}`)
        if (!(block instanceof XBlock)) throw new XacroError(`"${name}" is not a block`)
        this.grow(this.sizeOf(block.el), `xacro:insert_block '${name}'`)
        const clone = block.el.cloneNode(true) as Element
        this.evalAll(clone, macros, sym)
        if (multi) this.splice(el, clone)
        else el.parentNode!.replaceChild(clone, el)
        return null
      }
      case 'xacro:include':
        this.include(el, macros, sym)
        return null
      case 'xacro:property':
        this.property(el, sym)
        return null
      case 'xacro:macro':
        this.macro(el, macros)
        return null
      case 'xacro:arg': {
        const { name, default: def } = this.attrs(el, ['name', 'default'], [])
        if (!this.args.has(name!)) this.args.set(name!, pyStr(this.text(def!, sym)))
        this.removePreviousComments(el)
        el.parentNode?.removeChild(el)
        return null
      }
      case 'xacro:element': {
        const raw = el.getAttribute('xacro:name')
        if (raw === null) throw new XacroError("<xacro:element> is missing its 'xacro:name' attribute")
        const name = pyStr(this.text(raw, sym))
        if (!name) throw new XacroError('xacro:element: empty name')
        const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : null
        let renamed: Element
        try {
          renamed = this.doc.createElementNS(prefix === 'xacro' ? XACRO_NS : el.lookupNamespaceURI(prefix), name)
        } catch {
          throw new XacroError(`xacro:element: '${shortText(name)}' is not a valid element name`)
        }
        for (const a of Array.from(el.attributes)) if (a.name !== 'xacro:name') renamed.setAttribute(a.name, a.value)
        while (el.firstChild) renamed.appendChild(el.firstChild)
        el.parentNode!.replaceChild(renamed, el)
        return renamed
      }
      case 'xacro:attribute': {
        const { name, value } = this.attrs(el, ['name', 'value'], [])
        const n = pyStr(this.text(name!, sym))
        if (!n) throw new XacroError('xacro:attribute: empty name')
        const parent = el.parentNode as Element
        try {
          parent.setAttribute(n, pyStr(this.text(value!, sym)))
        } catch {
          throw new XacroError(`xacro:attribute: '${shortText(n)}' is not a valid attribute name`)
        }
        parent.removeChild(el)
        return null
      }
      case 'xacro:if':
      case 'xacro:unless': {
        this.removePreviousComments(el)
        const { value } = this.attrs(el, ['value'], [])
        let keep: boolean
        try {
          keep = boolOf(this.text(value!, sym), value!)
        } catch (e) {
          if (!(e instanceof XacroError)) throw e
          this.note('error', 'A xacro condition is not true or false, so its content was left out.', e.message)
          keep = tag === 'xacro:unless'
        }
        if (tag === 'xacro:unless') keep = !keep
        if (keep) {
          this.evalAll(el, macros, sym)
          this.splice(el, el)
        } else el.parentNode?.removeChild(el)
        return null
      }
      case 'xacro:call': {
        const raw = el.getAttribute('macro')
        if (!raw) throw new XacroError("xacro:call is missing the 'macro' attribute")
        el.removeAttribute('macro')
        this.callMacro(el, pyStr(this.text(raw, sym)), macros, sym)
        return null
      }
      default:
        this.callMacro(el, tag.slice(6), macros, sym)
        return null
    }
  }

  private include(el: Element, macros: MacroTable, sym: XTable): void {
    const { filename, ns, optional } = this.attrs(el, ['filename'], ['ns', 'optional'])
    let nsMacros = macros
    let nsSym = sym
    if (ns) {
      const nsName = pyStr(this.text(ns, sym))
      nsMacros = new MacroTable(null)
      nsSym = new XTable(sym, true, this)
      macros.map.set(nsName, nsMacros)
      sym.setItem(nsName, nsSym, false)
    }
    const isOptional = optional !== null && boolOf(optional, optional)
    const spec = pyStr(this.text(filename!, sym))
    if (/[*[?]/.test(spec)) {
      this.note('unsupported', 'A xacro:include with a wildcard file name is not supported, so it was left out.', spec)
      el.parentNode?.removeChild(el)
      return
    }
    const hit = this.ctx.resolveInclude?.(spec, this.file)
    if (!hit) {
      if (!isOptional) this.note('error', `xacro:include '${spec}' was not among the imported files, so its contents are missing.`, this.file)
      el.parentNode?.removeChild(el)
      return
    }
    if (this.filestack.includes(hit.path)) throw refuse('depth', `circular xacro:include of '${spec}'`)
    if (this.filestack.length > LIMITS.includeDepth) throw refuse('depth', `xacro:include '${spec}' is ${this.filestack.length} includes deep`)
    let inc: Document
    try {
      inc = parseXml(hit.text, hit.path, this.ctx.deadline)
    } catch (e) {
      if (!(e instanceof ImportRefused && e.reason === 'xml')) throw e
      this.note('error', `xacro:include '${spec}' is not well-formed XML, so its contents are missing.`, e.detail)
      el.parentNode?.removeChild(el)
      return
    }
    this.grow(this.sizeOf(inc.documentElement), `xacro:include '${spec}'`)
    const root = this.doc.importNode(inc.documentElement, true) as Element
    this.filestack.push(hit.path)
    try {
      this.evalAll(root, nsMacros, nsSym)
    } finally {
      this.filestack.pop()
    }
    this.importNamespaces(el.parentNode, root)
    this.removePreviousComments(el)
    this.splice(el, root)
  }

  private property(el: Element, sym: XTable): void {
    this.removePreviousComments(el)
    const a = this.attrs(el, ['name'], ['value', 'default', 'remove', 'scope', 'lazy_eval'])
    let name = pyStr(this.text(a.name!, sym))
    if (!isValidName(name)) throw new XacroError(`Property names must be valid python identifiers: ${shortText(name)}`)
    if (name.startsWith('__')) throw new XacroError(`Property names must not start with double underscore: ${name}`)
    const remove = boolOf(this.text(a.remove ?? 'false', sym), a.remove ?? 'false')
    if (Number(a.value !== null) + Number(a.default !== null) + Number(remove) > 1) {
      throw new XacroError(`Property attributes default, value, and remove are mutually exclusive: ${name}`)
    }
    el.parentNode?.removeChild(el)
    if (remove) {
      if (sym.has(name)) sym.delete(name)
      return
    }
    let value: PyVal | null = a.value
    if (a.default !== null) {
      if (sym.has(name)) return
      value = a.default
    }
    if (typeof value === 'string') {
      // checked now, though Python xacro would only read it when used: an over-long expression is refused either way
      try {
        lexText(value)
      } catch (e) {
        if (!(e instanceof XacroError)) throw e
      }
    }
    if (value === null) {
      name = `**${name}`
      value = new XBlock(el)
    }
    let lazy = boolOf(this.text(a.lazy_eval ?? 'true', sym), a.lazy_eval ?? 'true')
    let target = sym
    if (a.scope === 'global') {
      target = sym.top()
      lazy = false
    } else if (a.scope === 'parent') {
      if (!sym.parent) {
        this.note('error', 'A xacro property asks for the parent scope at the top level, so it was left out.', name)
        return
      }
      target = sym.parent
      lazy = false
      if (!sym.isNs) while (target.isNs && target.parent) target = target.parent
    }
    if (!lazy && typeof value === 'string') value = this.text(value, sym)
    target.setItem(name, value, lazy)
  }

  private macro(el: Element, macros: MacroTable): void {
    this.removePreviousComments(el)
    const { name: raw, params } = this.attrs(el, ['name'], ['params'])
    let name = raw!
    if (name === 'call') throw new XacroError("Invalid use of macro name 'call'")
    if (name.includes('.')) throw new XacroError(`macro names must not contain '.' (reserved for namespaces): ${name}`)
    if (name.startsWith('xacro:')) name = name.slice(6)
    el.parentNode?.removeChild(el)
    macros.map.set(name, { ...parseMacroParams(params ?? ''), body: el, size: this.sizeOf(el) })
  }

  private resolveMacro(full: string, macros: MacroTable, sym: XTable): [Macro, MacroTable, XTable] | null {
    const direct = macros.get(full)
    if (direct && !(direct instanceof MacroTable)) return [direct, macros, sym]
    const path = full.split('.')
    const name = path.pop()!
    if (!path.length) return null
    let m: MacroTable = macros
    let s: XTable = sym
    for (const ns of path) {
      const mt = m.get(ns)
      const st = s.lookup(ns)
      if (!(mt instanceof MacroTable) || !(st instanceof XTable)) return null
      m = mt
      s = st
    }
    const hit = m.get(name)
    return hit && !(hit instanceof MacroTable) ? [hit, m, s] : null
  }

  private callMacro(el: Element, name: string, macros: MacroTable, sym: XTable): void {
    const found = this.resolveMacro(name, macros, sym)
    if (!found) throw new XacroError(`unknown macro name: xacro:${name}`)
    const [m, baseMacros, baseSym] = found
    if (this.macroStack.length >= LIMITS.macroDepth) throw refuse('depth', `xacro:${name} is called ${this.macroStack.length + 1} macros deep`)
    const scoped = new XTable(baseSym, false, this)
    const scopedMacros = new MacroTable(baseMacros)
    const params = [...m.params]
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('xmlns')) continue
      const i = params.indexOf(a.name)
      if (i < 0) throw new XacroError(`Invalid parameter "${a.name}" of xacro:${name}`)
      params.splice(i, 1)
      scoped.setItem(a.name, this.text(a.value, sym), false)
      el.setAttribute(a.name, '')
    }
    // block arguments are expanded in the caller's scope
    this.evalChildren(el, macros, sym)
    let block = el.firstElementChild
    for (const p of [...params]) {
      if (p[0] !== '*') continue
      if (!block) throw new XacroError(`Not enough blocks for xacro:${name}`)
      params.splice(params.indexOf(p), 1)
      scoped.setItem(p, new XBlock(block), true)
      block = block.nextElementSibling
    }
    if (block) throw new XacroError(`Unused block "${block.tagName}" in xacro:${name}`)
    for (const p of [...params]) {
      if (p[0] === '*') continue
      const d = m.defaults.get(p)
      if (!d || (d[0] === null && d[1] === null)) continue
      const [fwd, def] = d
      let v: PyVal
      if (fwd === null) v = this.text(def!, sym)
      else if (sym.has(fwd)) v = sym.get(fwd)
      else if (def !== null) v = this.text(def, sym)
      else throw new XacroError(`Undefined property to forward: ${fwd}`)
      scoped.setItem(p, v, false)
      params.splice(params.indexOf(p), 1)
    }
    if (params.length) throw new XacroError(`Undefined parameters [${params.join(',')}] of xacro:${name}`)

    this.grow(m.size, `xacro:${name}`)
    const body = m.body.cloneNode(true) as Element
    this.macroStack.push(name)
    try {
      this.evalChildren(body, scopedMacros, scoped)
    } finally {
      this.macroStack.pop()
    }
    this.removePreviousComments(el)
    this.importNamespaces(el.parentNode, body)
    this.splice(el, body)
  }

  run(): void {
    const root = this.doc.documentElement
    try {
      this.evalAll(root, new MacroTable(null), new XTable(null, false, this))
    } catch (e) {
      if (e instanceof RangeError) throw refuse('depth', 'the xacro nests too deeply to expand')
      throw e
    }
    root.removeAttribute('xmlns:xacro')
    // nothing in the xacro namespace may survive expansion
    for (const left of Array.from(this.doc.getElementsByTagName('*'))) {
      if (left.tagName.startsWith('xacro:')) {
        this.note('error', `A <${left.tagName}> was left after expansion and was removed.`)
        left.parentNode?.removeChild(left)
      }
    }
  }
}

/** parseXmlSafe, with the xacro namespace added when a file uses `xacro:` without declaring it. */
function parseXml(text: string, name: string, deadline?: Deadline): Document {
  // Many hand-written xacro snippets forget the namespace declaration; add it to the root element before parsing, because a
  // failed parse is not free: Chrome's error element carries an inline style, which the page's CSP reports.
  if (/<xacro:/.test(text) && !/xmlns:xacro/.test(text)) {
    text = text.replace(/<(robot|[A-Za-z_][\w.-]*)(\s|>)/, `<$1 xmlns:xacro="${XACRO_NS}"$2`)
  }
  return parseXmlSafe(text, name, deadline)
}

/**
 * Expands a xacro to URDF text, as Python xacro 2.1.1 does. `ctx.xacroArgs` gives `$(arg)` values; includes and
 * `load_yaml` files come from `ctx.resolveInclude`. Problems go to `ctx.report` (or `ctx.warnings`).
 */
export function preprocessXacro(xacroText: string, ctx: ParseContext = {}): string {
  const doc = parseXml(xacroText, ctx.fileName || 'the xacro file', ctx.deadline)
  new Xacro(doc, ctx).run()
  return new XMLSerializer().serializeToString(doc)
}
