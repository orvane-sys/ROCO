// A Python expression evaluator for xacro's `${}` and `$(eval)`: the Python 3 expressions xacro files use, with Python's own
// rules (int and float arithmetic, str() and repr(), floor division, chained comparisons, comprehensions, lambdas). It is
// written by hand and never uses JS eval or Function. The input is untrusted: names starting with `__` are refused as xacro
// refuses them, nesting is bounded, and every string, list and integer is size-checked before it is made.
import { LIMITS, refuse } from './importLimits'

// --- values --------------------------------------------------------------------------------------------------------------

/** None, bool, int (bigint), float (number), str, list (array), tuple, dict, a function, or an object with attributes. */
export type PyVal = null | boolean | bigint | number | string | PyVal[] | PyTuple | PyDict | PyFunc | PyObject

export class PyTuple {
  readonly items: PyVal[]
  constructor(items: PyVal[]) {
    this.items = items
  }
}

/** A dict. `dotted` is a dict loaded from yaml, whose keys can also be read as attributes (`cfg.mass`). */
export class PyDict {
  readonly m = new Map<string, [PyVal, PyVal]>()
  dotted: boolean
  constructor(dotted = false) {
    this.dotted = dotted
  }
  get(k: PyVal): PyVal | undefined {
    return this.m.get(hkey(k))?.[1]
  }
  set(k: PyVal, v: PyVal): void {
    this.m.set(hkey(k), [k, v])
  }
  keys(): PyVal[] {
    return Array.from(this.m.values(), (e) => e[0])
  }
}

export type PyCall = (args: PyVal[], kw: Map<string, PyVal>) => PyVal

export class PyFunc {
  readonly name: string
  readonly fn: PyCall
  constructor(name: string, fn: PyCall) {
    this.name = name
    this.fn = fn
  }
}

/** Something with attributes: a module (`math.`, `xacro.`) or a xacro namespace. */
export abstract class PyObject {
  abstract readonly pyType: string
  abstract attr(name: string): PyVal | undefined
  item?(key: PyVal): PyVal
  contains?(key: PyVal): boolean
}

/** A Python exception: `type` is its class name, e.g. NameError. */
export class PyError extends Error {
  readonly type: string
  constructor(type: string, message: string) {
    super(`${type}: ${message}`)
    this.type = type
    this.name = 'PyError'
  }
}

const err = (type: string, msg: string) => new PyError(type, msg)

/** Where names are looked up. `get` throws a NameError for a name it does not know. */
export interface PyScope {
  get(name: string): PyVal
}

/** Names in a dict, then `parent`. */
export class MapScope implements PyScope {
  readonly vars: Map<string, PyVal>
  readonly parent?: PyScope
  constructor(vars: Map<string, PyVal>, parent?: PyScope) {
    this.vars = vars
    this.parent = parent
  }
  get(name: string): PyVal {
    const v = this.vars.get(name)
    if (v !== undefined) return v
    if (this.parent) return this.parent.get(name)
    throw err('NameError', `name '${name}' is not defined`)
  }
}

/** A module: a fixed set of attributes. */
export class PyModule extends PyObject {
  readonly pyType = 'module'
  readonly name: string
  readonly members: Map<string, PyVal>
  constructor(name: string, members: Map<string, PyVal>) {
    super()
    this.name = name
    this.members = members
  }
  attr(name: string): PyVal | undefined {
    return this.members.get(name)
  }
}

// --- limits --------------------------------------------------------------------------------------------------------------

/** A string an expression makes may be this long (the same cap as an expression's value). */
const MAX_STR = LIMITS.exprChars
/** A list an expression makes may hold this many items. */
const MAX_ITEMS = 100_000
/** An int an expression makes may have this many bits (about 10 000 decimal digits). */
const MAX_BITS = 34_000
/** Brackets, unary operators and powers may nest this deep. */
const MAX_NEST = 100
/** Lambdas may call each other this deep. */
const MAX_CALLS = 100

const short = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}…` : t)

const checkStr = (s: string): string => {
  if (s.length > MAX_STR) throw refuse('expression', `a value of ${s.length} characters`)
  return s
}
const checkLen = (n: number, what = 'a string'): void => {
  if (n > MAX_STR) throw refuse('expression', `${what} of ${n} characters`)
}
const checkItems = (n: number): void => {
  if (n > MAX_ITEMS) throw refuse('expression', `a list of ${n} items`)
}
const bits = (n: bigint): number => (n < 0n ? -n : n).toString(2).length
const checkInt = (n: bigint): bigint => {
  if (bits(n) > MAX_BITS) throw refuse('expression', 'an integer over 10,000 digits')
  return n
}

// --- types ---------------------------------------------------------------------------------------------------------------

export function typeName(v: PyVal): string {
  if (v === null) return 'NoneType'
  switch (typeof v) {
    case 'boolean': return 'bool'
    case 'bigint': return 'int'
    case 'number': return 'float'
    case 'string': return 'str'
  }
  if (Array.isArray(v)) return 'list'
  if (v instanceof PyTuple) return 'tuple'
  if (v instanceof PyDict) return 'dict'
  if (v instanceof PyFunc) return 'function'
  return (v as PyObject).pyType
}

const isInt = (v: PyVal): v is bigint | boolean => typeof v === 'bigint' || typeof v === 'boolean'
const isNum = (v: PyVal): v is bigint | boolean | number => isInt(v) || typeof v === 'number'
const toBig = (v: bigint | boolean): bigint => (typeof v === 'boolean' ? (v ? 1n : 0n) : v)
const toFloat = (v: bigint | boolean | number): number => {
  if (typeof v === 'number') return v
  const f = Number(toBig(v))
  if (!Number.isFinite(f)) throw err('OverflowError', 'int too large to convert to float')
  return f
}

export function truthy(v: PyVal): boolean {
  if (v === null) return false
  switch (typeof v) {
    case 'boolean': return v
    case 'bigint': return v !== 0n
    case 'number': return v !== 0
    case 'string': return v !== ''
  }
  if (Array.isArray(v)) return v.length > 0
  if (v instanceof PyTuple) return v.items.length > 0
  if (v instanceof PyDict) return v.m.size > 0
  return true
}

/** A dict key: equal numbers (True, 1, 1.0) share one. */
export function hkey(v: PyVal): string {
  if (v === null) return 'N'
  switch (typeof v) {
    case 'boolean': return v ? 'i1' : 'i0'
    case 'bigint': return `i${v}`
    case 'number': return Number.isInteger(v) ? `i${BigInt(v)}` : `f${floatRepr(v)}`
    case 'string': return `s${v}`
  }
  if (v instanceof PyTuple) return `t(${v.items.map(hkey).join(',')})`
  if (v instanceof PyFunc || v instanceof PyObject) throw err('TypeError', `unhashable type: '${typeName(v)}'`)
  throw err('TypeError', `unhashable type: '${typeName(v)}'`)
}

// --- str() and repr() ----------------------------------------------------------------------------------------------------

/** repr() of a float: the shortest digits that read back the same, in Python's layout. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (x === Infinity) return 'inf'
  if (x === -Infinity) return '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const [m, e] = x.toExponential().split('e')
  const exp = Number(e)
  const neg = m.startsWith('-')
  const digits = m.replace('-', '').replace('.', '')
  let s: string
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const intPart = digits.length > exp + 1 ? digits.slice(0, exp + 1) : digits.padEnd(exp + 1, '0')
      s = `${intPart}.${digits.slice(exp + 1) || '0'}`
    } else {
      s = `0.${'0'.repeat(-exp - 1)}${digits}`
    }
  } else {
    s = `${digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  return neg ? `-${s}` : s
}

function strRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = quote
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += `\\${quote}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0xad) out += `\\x${c.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return out + quote
}

/** Python's repr(), refused once it would pass MAX_STR. */
export function pyRepr(v: PyVal): string {
  const parts: string[] = []
  let len = 0
  const put = (s: string) => {
    len += s.length
    checkLen(len, 'a value')
    parts.push(s)
  }
  const walk = (x: PyVal, depth: number): void => {
    if (depth > 200) throw err('RecursionError', 'maximum recursion depth exceeded while getting the repr of an object')
    if (x === null) return put('None')
    switch (typeof x) {
      case 'boolean': return put(x ? 'True' : 'False')
      case 'bigint': return put(x.toString())
      case 'number': return put(floatRepr(x))
      case 'string': return put(strRepr(x))
    }
    const seq = (open: string, items: PyVal[], close: string) => {
      put(open)
      items.forEach((it, i) => {
        if (i) put(', ')
        walk(it, depth + 1)
      })
      put(close)
    }
    if (Array.isArray(x)) return seq('[', x, ']')
    if (x instanceof PyTuple) return x.items.length === 1 ? (put('('), walk(x.items[0], depth + 1), put(',)')) : seq('(', x.items, ')')
    if (x instanceof PyDict) {
      put('{')
      let i = 0
      for (const [k, val] of x.m.values()) {
        if (i++) put(', ')
        walk(k, depth + 1)
        put(': ')
        walk(val, depth + 1)
      }
      return put('}')
    }
    if (x instanceof PyFunc) return put(x.name === '<lambda>' ? '<function <lambda>>' : `<built-in function ${x.name}>`)
    put(`<${(x as PyObject).pyType} object>`)
  }
  walk(v, 0)
  return parts.join('')
}

/** Python's str(). */
export function pyStr(v: PyVal): string {
  return typeof v === 'string' ? v : pyRepr(v)
}

// --- exact decimal formatting (%f, %e, %g, round) --------------------------------------------------------------------------

/** |x| as digits / 10^scale, exactly (a double is a binary fraction, so it always has a finite decimal expansion). */
function exactDecimal(x: number): [bigint, number] {
  x = Math.abs(x)
  if (x === 0) return [0n, 0]
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, x)
  const hi = dv.getUint32(0)
  const lo = dv.getUint32(4)
  const expBits = (hi >>> 20) & 0x7ff
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  let e: number
  if (expBits === 0) e = -1074
  else {
    mant |= 1n << 52n
    e = expBits - 1075
  }
  if (e >= 0) return [mant << BigInt(e), 0]
  return [mant * 5n ** BigInt(-e), -e]
}

/** n / d rounded to the nearest integer, ties to even (n, d > 0). */
function divHalfEven(n: bigint, d: bigint): bigint {
  const q = n / d
  const r2 = (n % d) * 2n
  if (r2 > d || (r2 === d && q % 2n === 1n)) return q + 1n
  return q
}

const P10 = (n: number) => 10n ** BigInt(n)

function fixedDigits(x: number, prec: number): string {
  const [d, s] = exactDecimal(x)
  const q = prec >= s ? d * P10(prec - s) : divHalfEven(d, P10(s - prec))
  const str = q.toString().padStart(prec + 1, '0')
  return prec ? `${str.slice(0, -prec)}.${str.slice(-prec)}` : str
}

/** The first `sig` significant digits of |x|, rounded half-even, and the decimal exponent of the first. */
function sigDigits(x: number, sig: number): [string, number] {
  const [d, s] = exactDecimal(x)
  if (d === 0n) return ['0'.repeat(sig), 0]
  const n = d.toString().length
  let exp = n - 1 - s
  let q = n > sig ? divHalfEven(d, P10(n - sig)) : d * P10(sig - n)
  if (q.toString().length > sig) {
    q /= 10n
    exp++
  }
  return [q.toString(), exp]
}

const expSuffix = (exp: number, upper: boolean) => `${upper ? 'E' : 'e'}${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`

function formatExp(x: number, prec: number, upper: boolean, alt: boolean): string {
  const [dg, exp] = sigDigits(x, prec + 1)
  const mant = prec ? `${dg[0]}.${dg.slice(1)}` : alt ? `${dg}.` : dg
  return mant + expSuffix(exp, upper)
}

function formatGeneral(x: number, prec: number, upper: boolean, alt: boolean): string {
  const p = prec === 0 ? 1 : prec
  const [, exp] = sigDigits(x, p)
  let s: string
  if (exp >= -4 && exp < p) {
    s = fixedDigits(x, p - 1 - exp)
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '')
  } else {
    const [dg] = sigDigits(x, p)
    let mant = p > 1 ? `${dg[0]}.${dg.slice(1)}` : dg
    if (!alt && mant.includes('.')) mant = mant.replace(/\.?0+$/, '')
    s = mant + expSuffix(exp, upper)
  }
  return s
}

/** Python's round(x, n) for a float, n given: the exact value rounded half-even, read back as a float. */
function roundFloat(x: number, n: number): number {
  if (!Number.isFinite(x) || x === 0) return x
  const [d, s] = exactDecimal(x)
  const sign = x < 0 ? '-' : ''
  if (n >= s) return x
  if (n >= 0) return Number(`${sign}${fixedDigits(x, n)}`)
  const q = divHalfEven(d, P10(s - n))
  return Number(`${sign}${q}e${-n}`)
}

function roundHalfEvenToInt(x: number): bigint {
  if (!Number.isFinite(x)) throw err(Number.isNaN(x) ? 'ValueError' : 'OverflowError', `cannot convert float ${floatRepr(x)} to integer`)
  const [d, s] = exactDecimal(x)
  const q = divHalfEven(d, P10(s))
  return x < 0 ? -q : q
}

// --- format() and % -------------------------------------------------------------------------------------------------------

const SPEC = /^(?:([\s\S])?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([_,])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/

function group(intPart: string, sep: string, every: number): string {
  let out = ''
  for (let i = 0; i < intPart.length; i++) {
    if (i && (intPart.length - i) % every === 0) out += sep
    out += intPart[i]
  }
  return out
}

/** format(value, spec): Python's format-spec mini-language for str, int and float. */
export function formatValue(v: PyVal, spec: string): string {
  if (spec === '') return pyStr(v)
  const m = SPEC.exec(spec)
  if (!m) throw err('ValueError', `Invalid format specifier '${spec}' for object of type '${typeName(v)}'`)
  let [, fill, align] = m
  const [, , , signOpt, alt, zero, widthS, grouping, precS, typeS] = m
  const width = widthS ? Number(widthS) : 0
  checkLen(width, 'a format width')
  const prec = precS !== undefined ? Number(precS) : undefined
  if (prec !== undefined) checkLen(prec, 'a format precision')
  if (zero && !align) {
    fill = '0'
    align = '='
  }
  fill ??= ' '
  let type = typeS
  let body: string
  let sign = ''
  let prefix = ''
  if (typeof v === 'string') {
    if (type && type !== 's') throw err('ValueError', `Unknown format code '${type}' for object of type 'str'`)
    body = prec !== undefined ? v.slice(0, prec) : v
    align ??= '<'
  } else if (isNum(v) && !(type && 'eEfFgGn%'.includes(type) && type !== 'n') && typeof v !== 'number') {
    // int (and bool) with an integer presentation
    const n = toBig(v)
    if (prec !== undefined) throw err('ValueError', 'Precision not allowed in integer format specifier')
    type ??= 'd'
    const a = n < 0n ? -n : n
    if (n < 0n) sign = '-'
    else if (signOpt === '+') sign = '+'
    else if (signOpt === ' ') sign = ' '
    switch (type) {
      case 'd':
      case 'n': body = grouping ? group(a.toString(), grouping, 3) : a.toString(); break
      case 'b': body = a.toString(2); if (alt) prefix = '0b'; break
      case 'o': body = a.toString(8); if (alt) prefix = '0o'; break
      case 'x': body = a.toString(16); if (alt) prefix = '0x'; break
      case 'X': body = a.toString(16).toUpperCase(); if (alt) prefix = '0X'; break
      case 'c': body = String.fromCodePoint(Number(n)); sign = ''; break
      default: throw err('ValueError', `Unknown format code '${type}' for object of type 'int'`)
    }
    if (grouping && type !== 'd' && type !== 'n') body = group(body, '_', 4)
    align ??= '>'
  } else if (isNum(v)) {
    let x = toFloat(v)
    if (type && !'eEfFgG%n'.includes(type)) throw err('ValueError', `Unknown format code '${type}' for object of type 'float'`)
    if (x < 0 || Object.is(x, -0)) sign = '-'
    else if (signOpt === '+') sign = '+'
    else if (signOpt === ' ') sign = ' '
    const ax = Math.abs(x)
    const upper = type !== undefined && 'EFG'.includes(type)
    if (!Number.isFinite(ax)) {
      body = Number.isNaN(ax) ? 'nan' : 'inf'
      if (upper) body = body.toUpperCase()
      if (type === '%') body += '%'
    } else {
      switch (type) {
        case 'e': case 'E': body = formatExp(ax, prec ?? 6, upper, !!alt); break
        case 'f': case 'F': body = fixedDigits(ax, prec ?? 6); if (alt && !body.includes('.')) body += '.'; break
        case 'g': case 'G': case 'n': body = formatGeneral(ax, prec ?? 6, upper, !!alt); break
        case '%': x = ax * 100; body = `${fixedDigits(x, prec ?? 6)}%`; break
        default:
          if (prec === undefined) body = floatRepr(ax)
          else {
            body = formatGeneral(ax, prec, false, !!alt)
            if (!/[.e]/.test(body)) body += '.0'
          }
      }
      if (grouping) {
        const [ip, ...rest] = body.split(/(?=[.eE%])/)
        if (/^\d+$/.test(ip)) body = group(ip, grouping, 3) + rest.join('')
      }
    }
    align ??= '>'
  } else {
    throw err('TypeError', `unsupported format string passed to ${typeName(v)}.__format__`)
  }
  const core = sign + prefix + body
  const pad = Math.max(0, width - core.length)
  if (!pad) return core
  switch (align) {
    case '<': return core + fill.repeat(pad)
    case '^': return fill.repeat(pad >> 1) + core + fill.repeat(pad - (pad >> 1))
    case '=': return sign + prefix + fill.repeat(pad) + body
    default: return fill.repeat(pad) + core
  }
}

/** 'fmt' % args. */
function printf(fmt: string, args: PyVal): string {
  const list = args instanceof PyTuple ? args.items : [args]
  const map = args instanceof PyDict ? args : undefined
  let ai = 0
  let usedMap = false
  const next = (): PyVal => {
    if (ai >= list.length) throw err('TypeError', 'not enough arguments for format string')
    return list[ai++]
  }
  let out = ''
  const re = /%(?:\(([^)]*)\))?([-+ #0]*)(\d+|\*)?(?:\.(\d+|\*))?[hlL]?([diouxXeEfFgGcrsa%])/g
  let last = 0
  for (let m = re.exec(fmt); m; m = re.exec(fmt)) {
    out += fmt.slice(last, m.index)
    last = re.lastIndex
    const [, key, flags, widthS, precS, conv] = m
    if (conv === '%') {
      out += '%'
      continue
    }
    let value: PyVal
    if (key !== undefined) {
      if (!map) throw err('TypeError', 'format requires a mapping')
      const got = map.get(key)
      if (got === undefined) throw err('KeyError', strRepr(key))
      value = got
      usedMap = true
    } else value = next()
    const width = widthS === '*' ? Number(next()) : widthS ? Number(widthS) : undefined
    const prec = precS === '*' ? Number(next()) : precS ? Number(precS) : undefined
    let spec = ''
    if (flags.includes('-')) spec += '<'
    else if (flags.includes('0') && 'diouxXeEfFgG'.includes(conv)) spec += '0='
    else spec += '>'
    if (flags.includes('+')) spec += '+'
    else if (flags.includes(' ')) spec += ' '
    if (flags.includes('#') && conv !== 'o') spec += '#'
    if (width !== undefined) spec += String(width)
    let s: string
    switch (conv) {
      case 's': s = formatValue(prec !== undefined ? pyStr(value).slice(0, prec) : pyStr(value), spec); break
      case 'r': case 'a': s = formatValue(prec !== undefined ? pyRepr(value).slice(0, prec) : pyRepr(value), spec); break
      case 'c': s = formatValue(typeof value === 'string' ? value : String.fromCodePoint(Number(intOf(value))), spec); break
      case 'd': case 'i': case 'u':
        if (!isNum(value)) throw err('TypeError', `%${conv} format: a real number is required, not ${typeName(value)}`)
        s = formatValue(typeof value === 'number' ? truncToInt(value) : value, `${spec}d`); break
      case 'o': {
        s = formatValue(intOf(value), `${spec}o`)
        if (flags.includes('#')) s = s.replace(/^(\s*[-+ ]?)/, '$10o')
        break
      }
      case 'x': case 'X':
        s = formatValue(intOf(value), `${spec}${conv}`); break
      default:
        if (!isNum(value)) throw err('TypeError', `must be real number, not ${typeName(value)}`)
        s = formatValue(toFloat(value), `${spec}${prec !== undefined ? `.${prec}` : '.6'}${conv}`)
    }
    out += s
    checkLen(out.length)
  }
  out += fmt.slice(last)
  if (!usedMap && !map && ai < list.length) throw err('TypeError', 'not all arguments converted during string formatting')
  return checkStr(out)
}

function intOf(v: PyVal): bigint {
  if (isInt(v)) return toBig(v)
  throw err('TypeError', `an integer is required, not ${typeName(v)}`)
}
function truncToInt(x: number): bigint {
  if (!Number.isFinite(x)) throw err(Number.isNaN(x) ? 'ValueError' : 'OverflowError', `cannot convert float ${floatRepr(x)} to integer`)
  return BigInt(Math.trunc(x))
}

/** 'fmt'.format(*args, **kw). */
function strFormat(fmt: string, args: PyVal[], kw: Map<string, PyVal>, depth = 0): string {
  if (depth > 2) throw err('ValueError', 'Max string recursion exceeded')
  let out = ''
  let auto = 0
  let i = 0
  while (i < fmt.length) {
    const c = fmt[i]
    if (c === '{') {
      if (fmt[i + 1] === '{') {
        out += '{'
        i += 2
        continue
      }
      // the field runs to its matching '}', and may hold one level of nested {} in its spec
      let j = i + 1
      let level = 1
      while (j < fmt.length && level) {
        if (fmt[j] === '{') level++
        else if (fmt[j] === '}') level--
        if (level) j++
      }
      if (level) throw err('ValueError', "Single '{' encountered in format string")
      const field = fmt.slice(i + 1, j)
      i = j + 1
      const fm = /^([^.[!:]*)((?:\.[^.[!:]+|\[[^\]]*\])*)(?:!([rsa]))?(?::([\s\S]*))?$/.exec(field)
      if (!fm) throw err('ValueError', `bad format field '${field}'`)
      const [, name, chain, conv, specRaw] = fm
      let v: PyVal
      if (name === '') {
        v = args[auto++]
        if (v === undefined) throw err('IndexError', 'Replacement index out of range for positional args tuple')
      } else if (/^\d+$/.test(name)) {
        v = args[Number(name)]
        if (v === undefined) throw err('IndexError', `Replacement index ${name} out of range for positional args tuple`)
      } else {
        const got = kw.get(name)
        if (got === undefined) throw err('KeyError', strRepr(name))
        v = got
      }
      for (const part of chain.match(/\.[^.[]+|\[[^\]]*\]/g) ?? []) {
        if (part[0] === '.') v = getAttr(v, part.slice(1))
        else {
          const k = part.slice(1, -1)
          v = getItem(v, /^\d+$/.test(k) ? BigInt(k) : k)
        }
      }
      if (conv === 'r' || conv === 'a') v = pyRepr(v)
      else if (conv === 's') v = pyStr(v)
      const spec = specRaw ? strFormat(specRaw, args.slice(auto), kw, depth + 1) : ''
      out += formatValue(v, spec)
    } else if (c === '}') {
      if (fmt[i + 1] !== '}') throw err('ValueError', "Single '}' encountered in format string")
      out += '}'
      i += 2
    } else {
      const next = fmt.slice(i).search(/[{}]/)
      const end = next < 0 ? fmt.length : i + next
      out += fmt.slice(i, end)
      i = end
    }
    checkLen(out.length)
  }
  return out
}

// --- operators -----------------------------------------------------------------------------------------------------------

export function pyEq(a: PyVal, b: PyVal): boolean {
  if (isNum(a) && isNum(b)) {
    if (typeof a === 'number' || typeof b === 'number') return toFloatLoose(a) === toFloatLoose(b)
    return toBig(a) === toBig(b)
  }
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if (a === null || b === null) return a === b
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]))
  if (a instanceof PyTuple && b instanceof PyTuple) return a.items.length === b.items.length && a.items.every((x, i) => pyEq(x, b.items[i]))
  if (a instanceof PyDict && b instanceof PyDict) {
    if (a.m.size !== b.m.size) return false
    for (const [k, [, v]] of a.m) {
      const o = b.m.get(k)
      if (!o || !pyEq(v, o[1])) return false
    }
    return true
  }
  return a === b
}
// exact comparison of an int with a float: a bigint compares with a number by value in JS
const toFloatLoose = (v: bigint | boolean | number): number | bigint => (typeof v === 'boolean' ? (v ? 1 : 0) : v)

/** a < b (and the other orderings, through it). */
function pyLt(a: PyVal, b: PyVal, op: string): boolean {
  if (isNum(a) && isNum(b)) {
    const x = toFloatLoose(a)
    const y = toFloatLoose(b)
    return x < y
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b
  const seqA = Array.isArray(a) ? a : a instanceof PyTuple ? a.items : undefined
  const seqB = Array.isArray(b) ? b : b instanceof PyTuple ? b.items : undefined
  if (seqA && seqB && Array.isArray(a) === Array.isArray(b)) {
    for (let i = 0; i < Math.min(seqA.length, seqB.length); i++) {
      if (!pyEq(seqA[i], seqB[i])) return pyLt(seqA[i], seqB[i], op)
    }
    return seqA.length < seqB.length
  }
  throw err('TypeError', `'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`)
}

function compare(op: string, a: PyVal, b: PyVal): boolean {
  switch (op) {
    case '==': return pyEq(a, b)
    case '!=': return !pyEq(a, b)
    case '<': return pyLt(a, b, op)
    case '>': return pyLt(b, a, op)
    case '<=': return pyLt(a, b, op) || pyEq(a, b)
    case '>=': return pyLt(b, a, op) || pyEq(a, b)
    case 'in': return contains(b, a)
    case 'not in': return !contains(b, a)
    case 'is': return a === b || (isInt(a) && isInt(b) && typeof a === typeof b && a === b)
    case 'is not': return !(a === b)
  }
  throw err('SyntaxError', `unknown comparison ${op}`)
}

function contains(container: PyVal, x: PyVal): boolean {
  if (typeof container === 'string') {
    if (typeof x !== 'string') throw err('TypeError', `'in <string>' requires string as left operand, not ${typeName(x)}`)
    return container.includes(x)
  }
  if (Array.isArray(container)) return container.some((e) => pyEq(e, x))
  if (container instanceof PyTuple) return container.items.some((e) => pyEq(e, x))
  if (container instanceof PyDict) return container.m.has(hkey(x))
  if (container instanceof PyObject && container.contains) return container.contains(x)
  throw err('TypeError', `argument of type '${typeName(container)}' is not iterable`)
}

const opErr = (op: string, a: PyVal, b: PyVal) =>
  err('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`)

function repeat<T>(items: T[], n: bigint | boolean, total: (k: number) => void): T[] {
  const k = Number(toBig(n))
  if (k <= 0) return []
  total(items.length * k)
  const out: T[] = []
  for (let i = 0; i < k; i++) out.push(...items)
  return out
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q
}
function floorMod(a: bigint, b: bigint): bigint {
  const r = a % b
  return r !== 0n && ((r < 0n) !== (b < 0n)) ? r + b : r
}
function floatMod(a: number, b: number): number {
  const r = a % b
  return r !== 0 && ((r < 0) !== (b < 0)) ? r + b : r === 0 ? (b < 0 ? -0 : 0) : r
}

function binop(op: string, a: PyVal, b: PyVal): PyVal {
  if (isNum(a) && isNum(b)) {
    const ints = isInt(a) && isInt(b)
    if (ints && (op === '&' || op === '|' || op === '^') && typeof a === 'boolean' && typeof b === 'boolean') {
      return op === '&' ? a && b : op === '|' ? a || b : a !== b
    }
    if (ints) {
      const x = toBig(a)
      const y = toBig(b)
      switch (op) {
        case '+': return x + y
        case '-': return x - y
        case '*':
          if (bits(x) + bits(y) > MAX_BITS) throw refuse('expression', 'an integer over 10,000 digits')
          return x * y
        case '/':
          if (y === 0n) throw err('ZeroDivisionError', 'division by zero')
          return toFloat(x) / toFloat(y)
        case '//':
          if (y === 0n) throw err('ZeroDivisionError', 'integer division or modulo by zero')
          return floorDiv(x, y)
        case '%':
          if (y === 0n) throw err('ZeroDivisionError', 'integer division or modulo by zero')
          return floorMod(x, y)
        case '**':
          if (y < 0n) {
            if (x === 0n) throw err('ZeroDivisionError', '0.0 cannot be raised to a negative power')
            return toFloat(x) ** toFloat(y)
          }
          if (x !== 0n && x !== 1n && x !== -1n && bits(x) * Number(y) > MAX_BITS) throw refuse('expression', 'an integer over 10,000 digits')
          return x ** y
        case '<<':
          if (y < 0n) throw err('ValueError', 'negative shift count')
          if (x !== 0n && bits(x) + Number(y) > MAX_BITS) throw refuse('expression', 'an integer over 10,000 digits')
          return x << y
        case '>>':
          if (y < 0n) throw err('ValueError', 'negative shift count')
          return x >> y
        case '&': return x & y
        case '|': return x | y
        case '^': return x ^ y
      }
    } else {
      const x = toFloat(a)
      const y = toFloat(b)
      switch (op) {
        case '+': return x + y
        case '-': return x - y
        case '*': return x * y
        case '/':
          if (y === 0) throw err('ZeroDivisionError', 'float division by zero')
          return x / y
        case '//':
          if (y === 0) throw err('ZeroDivisionError', 'float floor division by zero')
          return Math.floor(x / y)
        case '%':
          if (y === 0) throw err('ZeroDivisionError', 'float modulo')
          return floatMod(x, y)
        case '**': {
          if (x === 0 && y < 0) throw err('ZeroDivisionError', '0.0 cannot be raised to a negative power')
          if (x < 0 && !Number.isInteger(y)) throw err('ValueError', 'a negative number to a fractional power gives a complex number, which xacro here does not support')
          const r = x ** y
          if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) throw err('OverflowError', 'Numerical result out of range')
          return r
        }
      }
    }
    throw opErr(op, a, b)
  }
  switch (op) {
    case '+':
      if (typeof a === 'string' && typeof b === 'string') {
        checkLen(a.length + b.length)
        return a + b
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        checkItems(a.length + b.length)
        return [...a, ...b]
      }
      if (a instanceof PyTuple && b instanceof PyTuple) {
        checkItems(a.items.length + b.items.length)
        return new PyTuple([...a.items, ...b.items])
      }
      break
    case '*': {
      const [s, n] = isInt(b) ? [a, b] : isInt(a) ? [b, a] : [undefined, undefined]
      if (n !== undefined) {
        if (typeof s === 'string') {
          const k = Number(toBig(n))
          if (k <= 0) return ''
          checkLen(s.length * k)
          return s.repeat(k)
        }
        if (Array.isArray(s)) return repeat(s, n, checkItems)
        if (s instanceof PyTuple) return new PyTuple(repeat(s.items, n, checkItems))
      }
      break
    }
    case '%':
      if (typeof a === 'string') return printf(a, b)
      break
    case '|':
      if (a instanceof PyDict && b instanceof PyDict) {
        const d = new PyDict(a.dotted)
        for (const [k, v] of a.m.values()) d.set(k, v)
        for (const [k, v] of b.m.values()) d.set(k, v)
        return d
      }
      break
  }
  throw opErr(op, a, b)
}

function unop(op: string, v: PyVal): PyVal {
  if (op === 'not') return !truthy(v)
  if (isInt(v)) {
    const n = toBig(v)
    if (op === '-') return -n
    if (op === '+') return n
    if (op === '~') return ~n
  } else if (typeof v === 'number') {
    if (op === '-') return -v
    if (op === '+') return v
  }
  throw err('TypeError', `bad operand type for unary ${op}: '${typeName(v)}'`)
}

// --- items and attributes ------------------------------------------------------------------------------------------------

function index(v: PyVal, len: number, what: string): number {
  if (!isInt(v)) throw err('TypeError', `${what} indices must be integers or slices, not ${typeName(v)}`)
  let i = Number(toBig(v))
  if (i < 0) i += len
  if (i < 0 || i >= len) throw err('IndexError', `${what} index out of range`)
  return i
}

export class PySlice {
  readonly lo: PyVal
  readonly hi: PyVal
  readonly step: PyVal
  constructor(lo: PyVal, hi: PyVal, step: PyVal) {
    this.lo = lo
    this.hi = hi
    this.step = step
  }
}

function sliceIndices(s: PySlice, len: number): number[] {
  const num = (v: PyVal): number | undefined => {
    if (v === null) return undefined
    if (!isInt(v)) throw err('TypeError', 'slice indices must be integers or None')
    return Number(toBig(v))
  }
  const step = num(s.step) ?? 1
  if (step === 0) throw err('ValueError', 'slice step cannot be zero')
  const adj = (v: number | undefined, dflt: number, lo: number, hi: number) => {
    if (v === undefined) return dflt
    if (v < 0) v = Math.max(v + len, lo)
    return Math.min(v, hi)
  }
  const start = step > 0 ? adj(num(s.lo), 0, 0, len) : adj(num(s.lo), len - 1, -1, len - 1)
  const stop = step > 0 ? adj(num(s.hi), len, 0, len) : adj(num(s.hi), -1, -1, len - 1)
  const out: number[] = []
  if (step > 0) for (let i = start; i < stop; i += step) out.push(i)
  else for (let i = start; i > stop; i += step) out.push(i)
  return out
}

export function getItem(v: PyVal, k: PyVal | PySlice): PyVal {
  if (k instanceof PySlice) {
    if (typeof v === 'string') return sliceIndices(k, v.length).map((i) => v[i]).join('')
    if (Array.isArray(v)) return sliceIndices(k, v.length).map((i) => v[i])
    if (v instanceof PyTuple) return new PyTuple(sliceIndices(k, v.items.length).map((i) => v.items[i]))
    throw err('TypeError', `'${typeName(v)}' object is not subscriptable`)
  }
  if (typeof v === 'string') return v[index(k, v.length, 'string')]
  if (Array.isArray(v)) return v[index(k, v.length, 'list')]
  if (v instanceof PyTuple) return v.items[index(k, v.items.length, 'tuple')]
  if (v instanceof PyDict) {
    const got = v.get(k)
    if (got === undefined) {
      if (v.dotted) throw err('AttributeError', `The yaml dictionary has no key '${pyStr(k)}'`)
      throw err('KeyError', pyRepr(k))
    }
    return got
  }
  if (v instanceof PyObject && v.item) return v.item(k)
  throw err('TypeError', `'${typeName(v)}' object is not subscriptable`)
}

/** Iterates a str, list, tuple or dict (its keys). */
export function iterate(v: PyVal): PyVal[] {
  if (typeof v === 'string') return Array.from(v)
  if (Array.isArray(v)) return v
  if (v instanceof PyTuple) return v.items
  if (v instanceof PyDict) return v.keys()
  throw err('TypeError', `'${typeName(v)}' object is not iterable`)
}

const fn = (name: string, f: PyCall) => new PyFunc(name, f)
const noKw = (name: string, kw: Map<string, PyVal>) => {
  if (kw.size) throw err('TypeError', `${name}() takes no keyword arguments`)
}
const nArgs = (name: string, args: PyVal[], lo: number, hi = lo) => {
  if (args.length < lo || args.length > hi) {
    throw err('TypeError', `${name}() takes ${lo === hi ? lo : `from ${lo} to ${hi}`} positional argument${hi === 1 ? '' : 's'} but ${args.length} were given`)
  }
}
const needStr = (v: PyVal, what: string): string => {
  if (typeof v !== 'string') throw err('TypeError', `${what} must be str, not ${typeName(v)}`)
  return v
}
const optInt = (v: PyVal | undefined, dflt: number): number => (v === undefined || v === null ? dflt : Number(intOf(v)))

/** str[start:end] bounds for find, count, startswith and the like. */
const bounds = (s: string, args: PyVal[], from: number): [number, number] => {
  const sl = sliceIndices(new PySlice(args[from] ?? null, args[from + 1] ?? null, null), s.length)
  return sl.length ? [sl[0], sl[sl.length - 1] + 1] : [0, 0]
}

function splitWs(s: string, max: number, fromRight: boolean): string[] {
  const parts = s.trim() === '' ? [] : s.trim().split(/\s+/)
  if (max < 0 || parts.length <= max + 1) return parts
  if (!fromRight) {
    const out: string[] = []
    let rest = s.replace(/^\s+/, '')
    for (let i = 0; i < max; i++) {
      const m = /\s+/.exec(rest)!
      out.push(rest.slice(0, m.index))
      rest = rest.slice(m.index + m[0].length)
    }
    out.push(rest)
    return out
  }
  const out: string[] = []
  let rest = s.replace(/\s+$/, '')
  for (let i = 0; i < max; i++) {
    const m = /\s+(?=\S*$)/.exec(rest)!
    out.unshift(rest.slice(m.index + m[0].length))
    rest = rest.slice(0, m.index)
  }
  out.unshift(rest)
  return out
}

function stripChars(s: string, chars: PyVal | undefined, left: boolean, right: boolean): string {
  if (chars === undefined || chars === null) {
    if (left) s = s.replace(/^\s+/, '')
    if (right) s = s.replace(/\s+$/, '')
    return s
  }
  const set = needStr(chars, 'strip arg')
  let a = 0
  let b = s.length
  if (left) while (a < b && set.includes(s[a])) a++
  if (right) while (b > a && set.includes(s[b - 1])) b--
  return s.slice(a, b)
}

function strMethod(s: string, name: string): PyFunc | undefined {
  const m = (f: (args: PyVal[], kw: Map<string, PyVal>) => PyVal) => fn(name, f)
  switch (name) {
    case 'upper': return m(() => s.toUpperCase())
    case 'lower': return m(() => s.toLowerCase())
    case 'swapcase': return m(() => Array.from(s, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''))
    case 'title': return m(() => s.toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase()))
    case 'capitalize': return m(() => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    case 'strip': return m((a) => stripChars(s, a[0], true, true))
    case 'lstrip': return m((a) => stripChars(s, a[0], true, false))
    case 'rstrip': return m((a) => stripChars(s, a[0], false, true))
    case 'split':
    case 'rsplit':
      return m((a, kw) => {
        const sep = kw.get('sep') ?? a[0] ?? null
        const max = optInt(kw.get('maxsplit') ?? a[1], -1)
        if (sep === null) return splitWs(s, max, name === 'rsplit')
        const sp = needStr(sep, 'sep')
        if (sp === '') throw err('ValueError', 'empty separator')
        const all = s.split(sp)
        if (max < 0 || all.length <= max + 1) return all
        return name === 'split' ? [...all.slice(0, max), all.slice(max).join(sp)] : [all.slice(0, all.length - max).join(sp), ...all.slice(all.length - max)]
      })
    case 'splitlines': return m(() => (s === '' ? [] : s.replace(/\r\n|\r|\n$/g, (x) => (x.endsWith('\n') && x.length === 1 ? '' : '\n')).split('\n')))
    case 'partition':
    case 'rpartition':
      return m((a) => {
        const sep = needStr(a[0], 'sep')
        const i = name === 'partition' ? s.indexOf(sep) : s.lastIndexOf(sep)
        if (i < 0) return new PyTuple(name === 'partition' ? [s, '', ''] : ['', '', s])
        return new PyTuple([s.slice(0, i), sep, s.slice(i + sep.length)])
      })
    case 'join':
      return m((a) => {
        nArgs('join', a, 1)
        const items = iterate(a[0])
        let len = 0
        for (const it of items) {
          if (typeof it !== 'string') throw err('TypeError', `sequence item: expected str instance, ${typeName(it)} found`)
          len += it.length + s.length
        }
        checkLen(len)
        return (items as string[]).join(s)
      })
    case 'replace':
      return m((a) => {
        const old = needStr(a[0], 'replace() argument 1')
        const nw = needStr(a[1], 'replace() argument 2')
        const count = optInt(a[2], -1)
        let out = ''
        let i = 0
        let n = 0
        if (old === '') {
          const chars = Array.from(s)
          const parts: string[] = []
          for (const c of chars) {
            if (count < 0 || n < count) {
              parts.push(nw)
              n++
            }
            parts.push(c)
          }
          if (count < 0 || n < count) parts.push(nw)
          return checkStr(parts.join(''))
        }
        for (let j = s.indexOf(old); j >= 0 && (count < 0 || n < count); j = s.indexOf(old, i)) {
          out += s.slice(i, j) + nw
          checkLen(out.length)
          i = j + old.length
          n++
        }
        return checkStr(out + s.slice(i))
      })
    case 'startswith':
    case 'endswith':
      return m((a) => {
        const [lo, hi] = bounds(s, a, 1)
        const sub = s.slice(lo, hi)
        const opts = a[0] instanceof PyTuple ? a[0].items : [a[0]]
        return opts.some((o) => (name === 'startswith' ? sub.startsWith(needStr(o, name)) : sub.endsWith(needStr(o, name))))
      })
    case 'find':
    case 'rfind':
    case 'index':
    case 'rindex':
      return m((a) => {
        const sub = needStr(a[0], name)
        const [lo, hi] = bounds(s, a, 1)
        const part = s.slice(lo, hi)
        const i = name === 'find' || name === 'index' ? part.indexOf(sub) : part.lastIndexOf(sub)
        if (i < 0 && name.endsWith('index')) throw err('ValueError', 'substring not found')
        return BigInt(i < 0 ? -1 : i + lo)
      })
    case 'count':
      return m((a) => {
        const sub = needStr(a[0], 'count')
        const [lo, hi] = bounds(s, a, 1)
        const part = s.slice(lo, hi)
        if (sub === '') return BigInt(part.length + 1)
        return BigInt(part.split(sub).length - 1)
      })
    case 'zfill':
      return m((a) => {
        const w = optInt(a[0], 0)
        checkLen(w)
        if (s.length >= w) return s
        const sign = s[0] === '-' || s[0] === '+' ? s[0] : ''
        return sign + '0'.repeat(w - s.length) + s.slice(sign.length)
      })
    case 'center':
    case 'ljust':
    case 'rjust':
      return m((a) => {
        const w = optInt(a[0], 0)
        checkLen(w)
        const f = a[1] === undefined ? ' ' : needStr(a[1], 'fill character')
        const pad = Math.max(0, w - s.length)
        if (name === 'ljust') return s + f.repeat(pad)
        if (name === 'rjust') return f.repeat(pad) + s
        const left = (pad >> 1) + (pad & w & 1)
        return f.repeat(left) + s + f.repeat(pad - left)
      })
    case 'isdigit':
    case 'isdecimal':
    case 'isnumeric': return m(() => /^\d+$/.test(s))
    case 'isalpha': return m(() => /^\p{L}+$/u.test(s))
    case 'isalnum': return m(() => /^[\p{L}\d]+$/u.test(s))
    case 'isspace': return m(() => /^\s+$/.test(s))
    case 'isupper': return m(() => /\p{Lu}/u.test(s) && s === s.toUpperCase())
    case 'islower': return m(() => /\p{Ll}/u.test(s) && s === s.toLowerCase())
    case 'isidentifier': return m(() => /^[A-Za-z_]\w*$/.test(s))
    case 'format': return m((a, kw) => strFormat(s, a, kw))
  }
  return undefined
}

function seqMethod(items: PyVal[], name: string): PyFunc | undefined {
  switch (name) {
    case 'index':
      return fn(name, (a) => {
        const i = items.findIndex((x) => pyEq(x, a[0]))
        if (i < 0) throw err('ValueError', `${pyRepr(a[0])} is not in list`)
        return BigInt(i)
      })
    case 'count': return fn(name, (a) => BigInt(items.filter((x) => pyEq(x, a[0])).length))
  }
  return undefined
}

function dictMethod(d: PyDict, name: string): PyFunc | undefined {
  const wrap = (v: PyVal) => (d.dotted && v instanceof PyDict && !v.dotted ? dotify(v) : v)
  switch (name) {
    case 'get': return fn(name, (a) => wrap(d.get(a[0]) ?? a[1] ?? null))
    case 'keys': return fn(name, () => d.keys())
    case 'values': return fn(name, () => Array.from(d.m.values(), (e) => wrap(e[1])))
    case 'items': return fn(name, () => Array.from(d.m.values(), (e) => new PyTuple([e[0], wrap(e[1])])))
    case 'copy': return fn(name, () => {
      const c = new PyDict(d.dotted)
      for (const [k, v] of d.m.values()) c.set(k, v)
      return c
    })
  }
  return undefined
}

export function dotify(d: PyDict): PyDict {
  const c = new PyDict(true)
  for (const [k, v] of d.m.values()) c.set(k, v)
  return c
}

export function getAttr(v: PyVal, name: string): PyVal {
  let got: PyVal | undefined
  if (typeof v === 'string') got = strMethod(v, name)
  else if (Array.isArray(v)) got = seqMethod(v, name)
  else if (v instanceof PyTuple) got = seqMethod(v.items, name)
  else if (v instanceof PyDict) {
    got = dictMethod(v, name)
    if (got === undefined && v.dotted) {
      got = v.get(name)
      if (got === undefined) throw err('AttributeError', `The yaml dictionary has no key '${name}'`)
    }
  } else if (typeof v === 'number') {
    if (name === 'is_integer') got = fn(name, () => Number.isInteger(v))
    else if (name === 'real') got = v
    else if (name === 'imag') got = 0
  } else if (isInt(v)) {
    if (name === 'real' || name === 'numerator') got = toBig(v)
    else if (name === 'imag') got = 0n
    else if (name === 'denominator') got = 1n
    else if (name === 'bit_length') got = fn(name, () => BigInt(toBig(v) === 0n ? 0 : bits(toBig(v))))
  } else if (v instanceof PyObject) got = v.attr(name)
  if (got === undefined) throw err('AttributeError', `'${typeName(v)}' object has no attribute '${name}'`)
  return got
}

// --- the parser ----------------------------------------------------------------------------------------------------------

type Tok =
  | { t: 'num'; v: bigint | number }
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'kw'; v: string }
  | { t: 'op'; v: string }
  | { t: 'end'; v: '' }

const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield'])
const OPS3 = ['**=', '//=', '>>=', '<<=', '...']
const OPS2 = ['**', '//', '==', '!=', '<=', '>=', '<<', '>>', ':=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=']
const OPS1 = '+-*/%<>()[]{},:.=~&|^@;'

const syntax = (msg: string) => err('SyntaxError', msg)

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++
      continue
    }
    if (c === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')) {
      i += 2
      continue
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    // strings, with any prefix
    const pm = /^([rRuUbBfF]{0,2})(['"])/.exec(src.slice(i, i + 3))
    if (pm && (pm[1] === '' || /^(?:[rRuUbBfF]|[rR][bBfF]|[bBfF][rR])$/.test(pm[1]))) {
      const prefix = pm[1].toLowerCase()
      if (prefix.includes('f')) throw syntax('f-strings are not supported in xacro expressions here')
      if (prefix.includes('b')) throw syntax('bytes literals are not supported in xacro expressions here')
      const raw = prefix.includes('r')
      i += pm[1].length
      const q = src[i]
      const triple = src.startsWith(q.repeat(3), i)
      const end = triple ? q.repeat(3) : q
      i += end.length
      let s = ''
      for (;;) {
        if (i >= n) throw syntax('unterminated string literal')
        if (src.startsWith(end, i)) {
          i += end.length
          break
        }
        const ch = src[i]
        if (!triple && ch === '\n') throw syntax('unterminated string literal')
        if (ch === '\\') {
          const e = src[i + 1]
          if (raw) {
            s += ch + (e ?? '')
            i += 2
            continue
          }
          i += 2
          switch (e) {
            case '\n': break
            case '\\': s += '\\'; break
            case "'": s += "'"; break
            case '"': s += '"'; break
            case 'n': s += '\n'; break
            case 't': s += '\t'; break
            case 'r': s += '\r'; break
            case 'a': s += '\x07'; break
            case 'b': s += '\b'; break
            case 'f': s += '\f'; break
            case 'v': s += '\v'; break
            case 'x': case 'u': case 'U': {
              const len = e === 'x' ? 2 : e === 'u' ? 4 : 8
              const hex = src.slice(i, i + len)
              if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) throw syntax(`truncated \\${e} escape`)
              const cp = parseInt(hex, 16)
              if (cp > 0x10ffff) throw syntax('illegal Unicode character')
              s += String.fromCodePoint(cp)
              i += len
              break
            }
            default:
              if (e !== undefined && e >= '0' && e <= '7') {
                let oct = e
                while (oct.length < 3 && src[i] >= '0' && src[i] <= '7') oct += src[i++]
                s += String.fromCodePoint(parseInt(oct, 8))
              } else s += `\\${e ?? ''}`
          }
          continue
        }
        s += ch
        i++
      }
      checkLen(s.length)
      out.push({ t: 'str', v: s })
      continue
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const rest = src.slice(i, i + MAX_STR + 2)
      const based = /^0([xXoObB])([0-9a-fA-F_]+)/.exec(rest)
      if (based) {
        const digits = based[2].replace(/_/g, '')
        const base = { x: 16, o: 8, b: 2 }[based[1].toLowerCase() as 'x' | 'o' | 'b']
        const valid = base === 16 ? /^[0-9a-fA-F]+$/ : base === 8 ? /^[0-7]+$/ : /^[01]+$/
        if (!valid.test(digits)) throw syntax('invalid digit in number')
        out.push({ t: 'num', v: checkInt(BigInt(`0${based[1].toLowerCase()}${digits}`)) })
        i += based[0].length
        continue
      }
      const m = /^(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest)!
      const text = m[0]
      i += text.length
      if (src[i] === 'j' || src[i] === 'J') throw syntax('complex numbers are not supported in xacro expressions here')
      const clean = text.replace(/_/g, '')
      if (/[.eE]/.test(clean)) out.push({ t: 'num', v: Number(clean) })
      else {
        if (clean.length > 1 && clean[0] === '0' && /[1-9]/.test(clean)) throw syntax('leading zeros in decimal integer literals are not permitted')
        out.push({ t: 'num', v: checkInt(BigInt(clean)) })
      }
      continue
    }
    if (/[A-Za-z_À-￿]/.test(c)) {
      let j = i + 1
      while (j < n && /[\wÀ-￿]/.test(src[j])) j++
      const word = src.slice(i, j)
      out.push(KEYWORDS.has(word) ? { t: 'kw', v: word } : { t: 'name', v: word })
      i = j
      continue
    }
    const op3 = OPS3.find((o) => src.startsWith(o, i))
    const op2 = op3 ?? OPS2.find((o) => src.startsWith(o, i))
    if (op2) {
      out.push({ t: 'op', v: op2 })
      i += op2.length
      continue
    }
    if (OPS1.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    throw syntax(`invalid character '${c}'`)
  }
  out.push({ t: 'end', v: '' })
  return out
}

type Target = { k: 'name'; id: string } | { k: 'tuple'; items: Target[] }
type Gen = { target: Target; iter: Node; ifs: Node[] }
type Arg = { star?: 1 | 2; name?: string; e: Node }
type Param = { name: string; def?: Node }
type Node =
  | { k: 'const'; v: PyVal }
  | { k: 'name'; id: string }
  | { k: 'chain'; first: Node; rest: [string, Node][] }
  | { k: 'bool'; op: 'and' | 'or'; items: Node[] }
  | { k: 'cmp'; first: Node; rest: [string, Node][] }
  | { k: 'unary'; op: string; e: Node }
  | { k: 'pow'; base: Node; exp: Node }
  | { k: 'ifexp'; cond: Node; a: Node; b: Node }
  | { k: 'lambda'; params: Param[]; body: Node }
  | { k: 'call'; f: Node; args: Arg[] }
  | { k: 'index'; e: Node; i: Node }
  | { k: 'slice'; lo?: Node; hi?: Node; step?: Node }
  | { k: 'attr'; e: Node; name: string }
  | { k: 'list' | 'tuple' | 'set'; items: Node[]; star: boolean[] }
  | { k: 'dict'; items: [Node, Node][] }
  | { k: 'comp'; kind: 'list' | 'set' | 'gen' | 'dict'; elt: Node; val?: Node; gens: Gen[] }

class Parser {
  private i = 0
  private nest = 0
  /** Names and attributes used, so `__` ones can be refused as xacro does. */
  readonly names = new Set<string>()
  private readonly toks: Tok[]
  constructor(toks: Tok[]) {
    this.toks = toks
  }

  private get tok(): Tok {
    return this.toks[this.i]
  }
  private isOp(v: string): boolean {
    const t = this.tok
    return t.t === 'op' && t.v === v
  }
  private isKw(v: string): boolean {
    const t = this.tok
    return t.t === 'kw' && t.v === v
  }
  private eat(v: string): boolean {
    if (this.isOp(v) || this.isKw(v)) {
      this.i++
      return true
    }
    return false
  }
  private expect(v: string): void {
    if (!this.eat(v)) throw syntax(`expected '${v}' but found ${this.describe()}`)
  }
  private describe(): string {
    const t = this.tok
    return t.t === 'end' ? 'the end of the expression' : `'${t.t === 'num' ? String(t.v) : t.v}'`
  }
  private enter(): void {
    if (++this.nest > MAX_NEST) throw syntax('the expression nests too deeply')
  }
  private leave(): void {
    this.nest--
  }

  parse(): Node {
    const n = this.exprList(false)
    if (this.tok.t !== 'end') throw syntax(`unexpected ${this.describe()}`)
    return n
  }

  /** a, b, c → a tuple; a single item without a comma is itself. */
  private exprList(starOk: boolean): Node {
    const first = this.testOrStar(starOk)
    if (!this.isOp(',')) {
      if (first.star) throw syntax("can't use starred expression here")
      return first.e
    }
    const items = [first.e]
    const star = [first.star]
    while (this.eat(',')) {
      if (this.atExprEnd()) break
      const nx = this.testOrStar(starOk)
      items.push(nx.e)
      star.push(nx.star)
    }
    return { k: 'tuple', items, star }
  }
  private atExprEnd(): boolean {
    const t = this.tok
    return t.t === 'end' || (t.t === 'op' && [')', ']', '}', ':', '='].includes(t.v)) || (t.t === 'kw' && ['for', 'in'].includes(t.v))
  }
  private testOrStar(starOk: boolean): { e: Node; star: boolean } {
    if (starOk && this.isOp('*')) {
      this.i++
      return { e: this.orTest(), star: true }
    }
    return { e: this.test(), star: false }
  }

  test(): Node {
    if (this.isKw('lambda')) return this.lambda()
    const e = this.orTest()
    if (this.eat('if')) {
      const cond = this.orTest()
      this.expect('else')
      const b = this.test()
      return { k: 'ifexp', cond, a: e, b }
    }
    return e
  }
  private testNoCond(): Node {
    return this.isKw('lambda') ? this.lambda(true) : this.orTest()
  }
  private lambda(noCond = false): Node {
    this.expect('lambda')
    const params: Param[] = []
    while (!this.isOp(':')) {
      const t = this.tok
      if (t.t !== 'name') throw syntax(`unexpected ${this.describe()} in lambda parameters`)
      this.i++
      this.names.add(t.v)
      const p: Param = { name: t.v }
      if (this.eat('=')) p.def = this.test()
      params.push(p)
      if (!this.eat(',')) break
    }
    this.expect(':')
    this.enter()
    const body = noCond ? this.testNoCond() : this.test()
    this.leave()
    return { k: 'lambda', params, body }
  }
  private orTest(): Node {
    const first = this.andTest()
    if (!this.isKw('or')) return first
    const items = [first]
    while (this.eat('or')) items.push(this.andTest())
    return { k: 'bool', op: 'or', items }
  }
  private andTest(): Node {
    const first = this.notTest()
    if (!this.isKw('and')) return first
    const items = [first]
    while (this.eat('and')) items.push(this.notTest())
    return { k: 'bool', op: 'and', items }
  }
  private notTest(): Node {
    if (this.isKw('not')) {
      this.i++
      this.enter()
      const e = this.notTest()
      this.leave()
      return { k: 'unary', op: 'not', e }
    }
    return this.comparison()
  }
  private compOp(): string | undefined {
    const t = this.tok
    if (t.t === 'op' && ['<', '>', '==', '>=', '<=', '!='].includes(t.v)) {
      this.i++
      return t.v
    }
    if (t.t === 'kw') {
      if (t.v === 'in') {
        this.i++
        return 'in'
      }
      if (t.v === 'not' && this.toks[this.i + 1].t === 'kw' && this.toks[this.i + 1].v === 'in') {
        this.i += 2
        return 'not in'
      }
      if (t.v === 'is') {
        this.i++
        return this.eat('not') ? 'is not' : 'is'
      }
    }
    return undefined
  }
  private comparison(): Node {
    const first = this.binary(0)
    const rest: [string, Node][] = []
    for (let op = this.compOp(); op; op = this.compOp()) rest.push([op, this.binary(0)])
    return rest.length ? { k: 'cmp', first, rest } : first
  }
  private static LEVELS = [['|'], ['^'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '//', '%', '@']]
  /** One precedence level of left-associative binary operators, parsed as a flat chain (no recursion per operand). */
  private binary(level: number): Node {
    if (level === Parser.LEVELS.length) return this.factor()
    const ops = Parser.LEVELS[level]
    const first = this.binary(level + 1)
    const rest: [string, Node][] = []
    for (;;) {
      const t = this.tok
      if (t.t !== 'op' || !ops.includes(t.v)) break
      if (t.v === '@') throw syntax("the '@' operator is not supported")
      this.i++
      rest.push([t.v, this.binary(level + 1)])
    }
    return rest.length ? { k: 'chain', first, rest } : first
  }
  private factor(): Node {
    const t = this.tok
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) {
      this.i++
      this.enter()
      const e = this.factor()
      this.leave()
      // fold a signed number literal, as Python's compiler does
      if (e.k === 'const' && (typeof e.v === 'bigint' || typeof e.v === 'number') && t.v !== '~') {
        return { k: 'const', v: t.v === '-' ? (typeof e.v === 'bigint' ? -e.v : -e.v) : e.v }
      }
      return { k: 'unary', op: t.v, e }
    }
    return this.power()
  }
  private power(): Node {
    const base = this.atomExpr()
    if (this.eat('**')) {
      this.enter()
      const exp = this.factor()
      this.leave()
      return { k: 'pow', base, exp }
    }
    return base
  }
  private atomExpr(): Node {
    let e = this.atom()
    for (;;) {
      if (this.isOp('(')) {
        this.i++
        this.enter()
        e = { k: 'call', f: e, args: this.callArgs() }
        this.leave()
        this.expect(')')
      } else if (this.isOp('[')) {
        this.i++
        this.enter()
        e = { k: 'index', e, i: this.subscripts() }
        this.leave()
        this.expect(']')
      } else if (this.isOp('.')) {
        this.i++
        const t = this.tok
        if (t.t !== 'name') throw syntax(`expected a name after '.' but found ${this.describe()}`)
        this.i++
        this.names.add(t.v)
        e = { k: 'attr', e, name: t.v }
      } else return e
    }
  }
  private callArgs(): Arg[] {
    const args: Arg[] = []
    while (!this.isOp(')')) {
      if (this.eat('**')) args.push({ star: 2, e: this.test() })
      else if (this.eat('*')) args.push({ star: 1, e: this.test() })
      else {
        const t = this.tok
        const nx = this.toks[this.i + 1]
        if (t.t === 'name' && nx.t === 'op' && nx.v === '=') {
          this.i += 2
          args.push({ name: t.v, e: this.test() })
        } else {
          const e = this.test()
          if (this.isKw('for')) {
            args.push({ e: { k: 'comp', kind: 'gen', elt: e, gens: this.compFor() } })
          } else args.push({ e })
        }
      }
      if (!this.eat(',')) break
    }
    return args
  }
  private subscripts(): Node {
    const one = (): Node => {
      let lo: Node | undefined
      if (!this.isOp(':')) {
        lo = this.test()
        if (!this.isOp(':')) return lo
      }
      this.expect(':')
      const s: Node = { k: 'slice', lo }
      if (!this.isOp(']') && !this.isOp(',') && !this.isOp(':')) s.hi = this.test()
      if (this.eat(':') && !this.isOp(']') && !this.isOp(',')) s.step = this.test()
      return s
    }
    const first = one()
    if (!this.isOp(',')) return first
    const items = [first]
    while (this.eat(',') && !this.isOp(']')) items.push(one())
    return { k: 'tuple', items, star: items.map(() => false) }
  }
  private target(): Target {
    const one = (): Target => {
      if (this.eat('(')) {
        const t = this.targetList()
        this.expect(')')
        return t
      }
      if (this.eat('[')) {
        const t = this.targetList()
        this.expect(']')
        return t
      }
      const t = this.tok
      if (t.t !== 'name') throw syntax(`cannot assign to ${this.describe()}`)
      this.i++
      this.names.add(t.v)
      return { k: 'name', id: t.v }
    }
    const first = one()
    if (!this.isOp(',')) return first
    const items = [first]
    while (this.eat(',') && !this.isKw('in')) items.push(one())
    return { k: 'tuple', items }
  }
  private targetList(): Target {
    const t = this.target()
    return t.k === 'tuple' ? t : { k: 'tuple', items: [t] }
  }
  private compFor(): Gen[] {
    const gens: Gen[] = []
    while (this.eat('for')) {
      const target = this.target()
      this.expect('in')
      const iter = this.orTest()
      const ifs: Node[] = []
      while (this.eat('if')) ifs.push(this.testNoCond())
      gens.push({ target, iter, ifs })
    }
    return gens
  }
  private atom(): Node {
    const t = this.tok
    switch (t.t) {
      case 'num':
        this.i++
        return { k: 'const', v: t.v }
      case 'str': {
        this.i++
        let s = t.v
        while (this.tok.t === 'str') {
          s += (this.tok as { v: string }).v
          checkLen(s.length)
          this.i++
        }
        return { k: 'const', v: s }
      }
      case 'name':
        this.i++
        this.names.add(t.v)
        return { k: 'name', id: t.v }
      case 'kw':
        if (t.v === 'None' || t.v === 'True' || t.v === 'False') {
          this.i++
          return { k: 'const', v: t.v === 'None' ? null : t.v === 'True' }
        }
        throw syntax(`unexpected '${t.v}'`)
      case 'op':
        if (t.v === '(' || t.v === '[' || t.v === '{') {
          this.i++
          this.enter()
          const e = t.v === '{' ? this.braces() : this.brackets(t.v === '(' ? ')' : ']')
          this.leave()
          return e
        }
        if (t.v === '...') {
          this.i++
          return { k: 'const', v: null }
        }
    }
    throw syntax(`unexpected ${this.describe()}`)
  }
  private brackets(close: ')' | ']'): Node {
    const kind = close === ')' ? 'tuple' : 'list'
    if (this.eat(close)) return { k: kind, items: [], star: [] }
    const first = this.testOrStar(true)
    if (this.isKw('for')) {
      if (first.star) throw syntax('iterable unpacking cannot be used in comprehension')
      const gens = this.compFor()
      this.expect(close)
      return { k: 'comp', kind: kind === 'tuple' ? 'gen' : 'list', elt: first.e, gens }
    }
    if (close === ')' && !this.isOp(',')) {
      if (first.star) throw syntax("can't use starred expression here")
      this.expect(')')
      return first.e
    }
    const items = [first.e]
    const star = [first.star]
    while (this.eat(',')) {
      if (this.isOp(close)) break
      const nx = this.testOrStar(true)
      items.push(nx.e)
      star.push(nx.star)
    }
    this.expect(close)
    return { k: kind, items, star }
  }
  private braces(): Node {
    if (this.eat('}')) return { k: 'dict', items: [] }
    if (this.isOp('**')) throw syntax('dict unpacking is not supported')
    const first = this.testOrStar(true)
    if (!first.star && this.eat(':')) {
      const val = this.test()
      if (this.isKw('for')) {
        const gens = this.compFor()
        this.expect('}')
        return { k: 'comp', kind: 'dict', elt: first.e, val, gens }
      }
      const items: [Node, Node][] = [[first.e, val]]
      while (this.eat(',')) {
        if (this.isOp('}')) break
        const k = this.test()
        this.expect(':')
        items.push([k, this.test()])
      }
      this.expect('}')
      return { k: 'dict', items }
    }
    if (this.isKw('for')) {
      const gens = this.compFor()
      this.expect('}')
      return { k: 'comp', kind: 'set', elt: first.e, gens }
    }
    const items = [first.e]
    const star = [first.star]
    while (this.eat(',')) {
      if (this.isOp('}')) break
      const nx = this.testOrStar(true)
      items.push(nx.e)
      star.push(nx.star)
    }
    this.expect('}')
    return { k: 'set', items, star }
  }
}

/** Parses one expression. Throws PyError (SyntaxError), or for a `__` name the error xacro gives. */
export function parseExpr(src: string): Node {
  const p = new Parser(lex(src.trim()))
  const node = p.parse()
  const bad = [...p.names].filter((n) => n.startsWith('__'))
  if (bad.length) throw err('XacroException', `Use of invalid name(s): ${bad.join(', ')}`)
  return node
}

// --- evaluation ----------------------------------------------------------------------------------------------------------

export interface EvalOptions {
  /** Called every few hundred steps; throws to stop (the import's deadline). */
  check?: () => void
}

let callDepth = 0

/** A set: a list without repeats, in first-seen order (sets have no order in Python; xacro files do not rely on one). */
function uniq(items: PyVal[]): PyVal[] {
  const seen = new Set<string>()
  const out: PyVal[] = []
  for (const it of items) {
    const k = hkey(it)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(it)
    }
  }
  return out
}

class Evaluator {
  private steps = 0
  private readonly opts: EvalOptions
  constructor(opts: EvalOptions) {
    this.opts = opts
  }

  private tick(): void {
    if (++this.steps % 256 === 0) this.opts.check?.()
  }

  ev(n: Node, sc: PyScope): PyVal {
    this.tick()
    switch (n.k) {
      case 'const': return n.v
      case 'name': return sc.get(n.id)
      case 'chain': {
        let v = this.ev(n.first, sc)
        for (const [op, e] of n.rest) {
          v = binop(op, v, this.ev(e, sc))
          this.tick()
        }
        return v
      }
      case 'bool': {
        let v: PyVal = null
        for (const e of n.items) {
          v = this.ev(e, sc)
          if (n.op === 'or' ? truthy(v) : !truthy(v)) return v
        }
        return v
      }
      case 'cmp': {
        let left = this.ev(n.first, sc)
        for (const [op, e] of n.rest) {
          const right = this.ev(e, sc)
          if (!compare(op, left, right)) return false
          left = right
        }
        return true
      }
      case 'unary': return unop(n.op, this.ev(n.e, sc))
      case 'pow': return binop('**', this.ev(n.base, sc), this.ev(n.exp, sc))
      case 'ifexp': return truthy(this.ev(n.cond, sc)) ? this.ev(n.a, sc) : this.ev(n.b, sc)
      case 'lambda': return this.lambda(n, sc)
      case 'call': return this.call(n, sc)
      case 'index': {
        const v = this.ev(n.e, sc)
        return getItem(v, n.i.k === 'slice' ? this.slice(n.i, sc) : this.ev(n.i, sc))
      }
      case 'slice': throw syntax('a slice is only allowed inside []')
      case 'attr': return getAttr(this.ev(n.e, sc), n.name)
      case 'list':
      case 'tuple':
      case 'set': {
        const items: PyVal[] = []
        n.items.forEach((e, i) => {
          const v = this.ev(e, sc)
          if (n.star[i]) items.push(...iterate(v))
          else items.push(v)
          checkItems(items.length)
        })
        return n.k === 'list' ? items : n.k === 'tuple' ? new PyTuple(items) : uniq(items)
      }
      case 'dict': {
        const d = new PyDict()
        for (const [k, v] of n.items) d.set(this.ev(k, sc), this.ev(v, sc))
        return d
      }
      case 'comp': return this.comp(n, sc)
    }
  }

  private slice(n: Extract<Node, { k: 'slice' }>, sc: PyScope): PySlice {
    const v = (e?: Node) => (e ? this.ev(e, sc) : null)
    return new PySlice(v(n.lo), v(n.hi), v(n.step))
  }

  private lambda(n: Extract<Node, { k: 'lambda' }>, sc: PyScope): PyFunc {
    const defs = n.params.map((p) => (p.def ? this.ev(p.def, sc) : undefined))
    return new PyFunc('<lambda>', (args, kw) => {
      if (args.length > n.params.length) throw err('TypeError', `<lambda>() takes ${n.params.length} positional arguments but ${args.length} were given`)
      const vars = new Map<string, PyVal>()
      n.params.forEach((p, i) => {
        const v = i < args.length ? args[i] : kw.has(p.name) ? kw.get(p.name)! : defs[i]
        if (i < args.length && kw.has(p.name)) throw err('TypeError', `<lambda>() got multiple values for argument '${p.name}'`)
        if (v === undefined) throw err('TypeError', `<lambda>() missing 1 required positional argument: '${p.name}'`)
        vars.set(p.name, v)
      })
      for (const k of kw.keys()) if (!n.params.some((p) => p.name === k)) throw err('TypeError', `<lambda>() got an unexpected keyword argument '${k}'`)
      if (++callDepth > MAX_CALLS) {
        callDepth--
        throw err('RecursionError', 'maximum recursion depth exceeded')
      }
      try {
        return this.ev(n.body, new MapScope(vars, sc))
      } finally {
        callDepth--
      }
    })
  }

  private call(n: Extract<Node, { k: 'call' }>, sc: PyScope): PyVal {
    const f = this.ev(n.f, sc)
    const args: PyVal[] = []
    const kw = new Map<string, PyVal>()
    for (const a of n.args) {
      const v = this.ev(a.e, sc)
      if (a.star === 1) args.push(...iterate(v))
      else if (a.star === 2) {
        if (!(v instanceof PyDict)) throw err('TypeError', `argument after ** must be a mapping, not ${typeName(v)}`)
        for (const [k, val] of v.m.values()) kw.set(needStr(k, 'keywords'), val)
      } else if (a.name !== undefined) {
        if (kw.has(a.name)) throw syntax(`keyword argument repeated: ${a.name}`)
        kw.set(a.name, v)
      } else args.push(v)
      checkItems(args.length)
    }
    if (!(f instanceof PyFunc)) throw err('TypeError', `'${typeName(f)}' object is not callable`)
    return f.fn(args, kw)
  }

  private comp(n: Extract<Node, { k: 'comp' }>, sc: PyScope): PyVal {
    const vars = new Map<string, PyVal>()
    const local = new MapScope(vars, sc)
    const out: PyVal[] = []
    const dict = n.kind === 'dict' ? new PyDict() : undefined
    const bind = (t: Target, v: PyVal) => {
      if (t.k === 'name') return void vars.set(t.id, v)
      const items = iterate(v)
      if (items.length !== t.items.length) {
        throw err('ValueError', items.length < t.items.length ? `not enough values to unpack (expected ${t.items.length}, got ${items.length})` : `too many values to unpack (expected ${t.items.length})`)
      }
      t.items.forEach((s, i) => bind(s, items[i]))
    }
    const loop = (g: number) => {
      if (g === n.gens.length) {
        if (dict) dict.set(this.ev(n.elt, local), this.ev(n.val!, local))
        else {
          out.push(this.ev(n.elt, local))
          checkItems(out.length)
        }
        return
      }
      const gen = n.gens[g]
      // the first iterable is evaluated in the enclosing scope, the others in the comprehension's own
      for (const v of iterate(this.ev(gen.iter, g === 0 ? sc : local))) {
        this.tick()
        bind(gen.target, v)
        if (gen.ifs.every((c) => truthy(this.ev(c, local)))) loop(g + 1)
      }
    }
    loop(0)
    if (dict) return dict
    return n.kind === 'set' ? uniq(out) : out
  }
}

/** Evaluates a parsed expression. */
export function evalNode(node: Node, scope: PyScope, opts: EvalOptions = {}): PyVal {
  return new Evaluator(opts).ev(node, scope)
}

/** Parses and evaluates one expression. */
export function evalExpr(src: string, scope: PyScope, opts: EvalOptions = {}): PyVal {
  return evalNode(parseExpr(src), scope, opts)
}

// --- builtins ------------------------------------------------------------------------------------------------------------

function toIntValue(v: PyVal, base?: PyVal): bigint {
  if (base !== undefined && typeof v !== 'string') throw err('TypeError', "int() can't convert non-string with explicit base")
  if (typeof v === 'string') {
    const b = base === undefined ? 10 : Number(intOf(base))
    let s = v.trim()
    let neg = false
    if (s[0] === '-' || s[0] === '+') {
      neg = s[0] === '-'
      s = s.slice(1)
    }
    let radix = b
    const pre = /^0([xob])/i.exec(s)
    if (pre && (b === 0 || b === { x: 16, o: 8, b: 2 }[pre[1].toLowerCase() as 'x' | 'o' | 'b'])) {
      radix = { x: 16, o: 8, b: 2 }[pre[1].toLowerCase() as 'x' | 'o' | 'b']
      s = s.slice(2).replace(/^_/, '')
    } else if (b === 0) radix = 10
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix)
    if (!s || !new RegExp(`^[${digits}](?:_?[${digits}])*$`, 'i').test(s) || (b === 0 && radix === 10 && /^0+[1-9]/.test(s))) {
      throw err('ValueError', `invalid literal for int() with base ${b}: ${strRepr(v)}`)
    }
    checkLen(s.length, 'an integer literal')
    let n = 0n
    const R = BigInt(radix)
    for (const ch of s.replace(/_/g, '').toLowerCase()) n = n * R + BigInt(digits.indexOf(ch))
    return checkInt(neg ? -n : n)
  }
  if (isInt(v)) return toBig(v)
  if (typeof v === 'number') return truncToInt(v)
  throw err('TypeError', `int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`)
}

/** Python's float(str). */
export function parseFloatStr(s: string): number | undefined {
  const t = s.trim().replace(/(\d)_(?=\d)/g, '$1')
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t)
  if (m) return m[2].toLowerCase() === 'nan' ? NaN : m[1] === '-' ? -Infinity : Infinity
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return undefined
  return Number(t)
}

function toFloatValue(v: PyVal): number {
  if (typeof v === 'string') {
    const f = parseFloatStr(v)
    if (f === undefined) throw err('ValueError', `could not convert string to float: ${strRepr(v)}`)
    return f
  }
  if (isNum(v)) return toFloat(v)
  throw err('TypeError', `float() argument must be a string or a real number, not '${typeName(v)}'`)
}

function minmax(name: 'min' | 'max', args: PyVal[], kw: Map<string, PyVal>): PyVal {
  const key = kw.get('key') ?? null
  const items = args.length === 1 ? iterate(args[0]) : args
  if (!items.length) {
    if (kw.has('default')) return kw.get('default')!
    throw err('ValueError', `${name}() arg is an empty sequence`)
  }
  const k = (v: PyVal) => (key instanceof PyFunc ? key.fn([v], new Map()) : v)
  let best = items[0]
  let bestK = k(best)
  for (const it of items.slice(1)) {
    const ik = k(it)
    if (name === 'min' ? pyLt(ik, bestK, '<') : pyLt(bestK, ik, '<')) {
      best = it
      bestK = ik
    }
  }
  return best
}

const callable = (f: PyVal, what: string): PyFunc => {
  if (f instanceof PyFunc) return f
  throw err('TypeError', `'${typeName(f)}' object is not callable (${what})`)
}

function sortItems(items: PyVal[], key: PyVal, reverse: boolean): PyVal[] {
  const keyed = items.map((v, i) => ({ v, i, k: key instanceof PyFunc ? key.fn([v], new Map()) : v }))
  keyed.sort((a, b) => {
    if (pyLt(a.k, b.k, '<')) return reverse ? 1 : -1
    if (pyLt(b.k, a.k, '<')) return reverse ? -1 : 1
    return a.i - b.i
  })
  return keyed.map((x) => x.v)
}

function rangeOf(args: PyVal[]): PyVal[] {
  nArgs('range', args, 1, 3)
  const [a, b, c] = args.map((x) => intOf(x))
  const [start, stop, step] = args.length === 1 ? [0n, a, 1n] : [a, b, c ?? 1n]
  if (step === 0n) throw err('ValueError', 'range() arg 3 must not be zero')
  const count = step > 0n ? (stop > start ? (stop - start + step - 1n) / step : 0n) : start > stop ? (start - stop - step - 1n) / -step : 0n
  checkItems(Number(count))
  const out: PyVal[] = []
  for (let i = 0n; i < count; i++) out.push(start + i * step)
  return out
}

function toDict(args: PyVal[], kw: Map<string, PyVal>): PyDict {
  const d = new PyDict()
  if (args.length > 1) throw err('TypeError', `dict expected at most 1 argument, got ${args.length}`)
  if (args.length) {
    const src = args[0]
    if (src instanceof PyDict) for (const [k, v] of src.m.values()) d.set(k, v)
    else {
      for (const pair of iterate(src)) {
        const kv = iterate(pair)
        if (kv.length !== 2) throw err('ValueError', `dictionary update sequence element has length ${kv.length}; 2 is required`)
        d.set(kv[0], kv[1])
      }
    }
  }
  for (const [k, v] of kw) d.set(k, v)
  return d
}

function pyRound(args: PyVal[], kw: Map<string, PyVal>): PyVal {
  const x = args[0] ?? kw.get('number')
  const nd = args[1] ?? kw.get('ndigits') ?? null
  if (x === undefined) throw err('TypeError', "round() missing required argument 'number' (pos 1)")
  if (isInt(x)) {
    const n = toBig(x)
    if (nd === null) return n
    const k = intOf(nd)
    if (k >= 0n) return n
    const p = 10n ** -k
    const q = divHalfEven(n < 0n ? -n : n, p) * p
    return n < 0n ? -q : q
  }
  if (typeof x !== 'number') throw err('TypeError', `type ${typeName(x)} doesn't define __round__ method`)
  if (nd === null) return roundHalfEvenToInt(x)
  return roundFloat(x, Number(intOf(nd)))
}

const mathErr = (name: string, args: number[], r: number): number => {
  if (Number.isNaN(r) && !args.some(Number.isNaN)) throw err('ValueError', 'math domain error')
  if (!Number.isFinite(r) && !Number.isNaN(r) && args.every(Number.isFinite)) {
    if (/^(log|log10|log2|log1p|atanh|acosh|gamma)$/.test(name) || (name === 'pow' && args[0] === 0)) throw err('ValueError', 'math domain error')
    throw err('OverflowError', 'math range error')
  }
  return r
}

const numArg = (v: PyVal | undefined, name: string): number => {
  if (v === undefined) throw err('TypeError', `${name}() missing a required argument`)
  if (!isNum(v)) throw err('TypeError', `must be real number, not ${typeName(v)}`)
  return toFloat(v)
}

function mathModule(): Map<string, PyVal> {
  const m = new Map<string, PyVal>()
  const f1 = (name: string, f: (x: number) => number) =>
    m.set(name, fn(name, (a, kw) => {
      noKw(name, kw)
      nArgs(name, a, 1)
      const x = numArg(a[0], name)
      return mathErr(name, [x], f(x))
    }))
  const f2 = (name: string, f: (x: number, y: number) => number) =>
    m.set(name, fn(name, (a, kw) => {
      noKw(name, kw)
      nArgs(name, a, 2)
      const x = numArg(a[0], name)
      const y = numArg(a[1], name)
      return mathErr(name, [x, y], f(x, y))
    }))
  f1('acos', Math.acos); f1('acosh', Math.acosh); f1('asin', Math.asin); f1('asinh', Math.asinh); f1('atan', Math.atan)
  f1('atanh', Math.atanh); f1('cos', Math.cos); f1('cosh', Math.cosh); f1('sin', Math.sin); f1('sinh', Math.sinh)
  f1('tan', Math.tan); f1('tanh', Math.tanh); f1('exp', Math.exp); f1('expm1', Math.expm1); f1('fabs', Math.abs)
  f1('sqrt', Math.sqrt); f1('log10', Math.log10); f1('log2', Math.log2); f1('log1p', Math.log1p)
  f1('degrees', (x) => (x * 180) / Math.PI); f1('radians', (x) => (x * Math.PI) / 180)
  f2('atan2', Math.atan2); f2('copysign', (x, y) => Math.abs(x) * (y < 0 || Object.is(y, -0) ? -1 : 1))
  f2('fmod', (x, y) => {
    if (y === 0 || !Number.isFinite(x)) return NaN
    return x % y
  })
  f2('pow', (x, y) => (x === 1 || y === 0 ? 1 : x ** y))
  f2('remainder', (x, y) => {
    if (y === 0 || !Number.isFinite(x)) return NaN
    const n = x / y
    const r = Math.round(n)
    const near = Math.abs(n - Math.trunc(n)) === 0.5 ? 2 * Math.round(n / 2) : r
    return x - near * y
  })
  m.set('log', fn('log', (a) => {
    nArgs('log', a, 1, 2)
    const x = numArg(a[0], 'log')
    if (isInt(a[0]) && toBig(a[0]) > 0n && !Number.isFinite(x)) throw err('OverflowError', 'int too large to convert to float')
    const r = a.length === 2 ? Math.log(x) / Math.log(numArg(a[1], 'log')) : Math.log(x)
    return mathErr('log', [x], r)
  }))
  const toIntFn = (name: string, f: (x: number) => number) =>
    m.set(name, fn(name, (a) => {
      nArgs(name, a, 1)
      if (isInt(a[0])) return toBig(a[0])
      const x = numArg(a[0], name)
      if (!Number.isFinite(x)) throw err(Number.isNaN(x) ? 'ValueError' : 'OverflowError', `cannot convert float ${floatRepr(x)} to integer`)
      return BigInt(f(x))
    }))
  toIntFn('ceil', Math.ceil); toIntFn('floor', Math.floor); toIntFn('trunc', Math.trunc)
  m.set('isfinite', fn('isfinite', (a) => Number.isFinite(numArg(a[0], 'isfinite'))))
  m.set('isinf', fn('isinf', (a) => { const x = numArg(a[0], 'isinf'); return !Number.isFinite(x) && !Number.isNaN(x) }))
  m.set('isnan', fn('isnan', (a) => Number.isNaN(numArg(a[0], 'isnan'))))
  m.set('isclose', fn('isclose', (a, kw) => {
    const x = numArg(a[0], 'isclose')
    const y = numArg(a[1], 'isclose')
    const rel = kw.has('rel_tol') ? numArg(kw.get('rel_tol'), 'isclose') : 1e-9
    const abs = kw.has('abs_tol') ? numArg(kw.get('abs_tol'), 'isclose') : 0
    if (x === y) return true
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    const d = Math.abs(x - y)
    return d <= Math.abs(rel * y) || d <= Math.abs(rel * x) || d <= abs
  }))
  m.set('hypot', fn('hypot', (a) => Math.hypot(...a.map((v) => numArg(v, 'hypot')))))
  m.set('dist', fn('dist', (a) => {
    const p = iterate(a[0]).map((v) => numArg(v, 'dist'))
    const q = iterate(a[1]).map((v) => numArg(v, 'dist'))
    if (p.length !== q.length) throw err('ValueError', 'both points must have the same number of dimensions')
    return Math.hypot(...p.map((x, i) => x - q[i]))
  }))
  m.set('factorial', fn('factorial', (a) => {
    const n = intOf(a[0])
    if (n < 0n) throw err('ValueError', 'factorial() not defined for negative values')
    if (n > 3000n) throw refuse('expression', 'an integer over 10,000 digits')
    let r = 1n
    for (let i = 2n; i <= n; i++) r *= i
    return r
  }))
  const gcd = (x: bigint, y: bigint): bigint => {
    x = x < 0n ? -x : x
    y = y < 0n ? -y : y
    while (y) [x, y] = [y, x % y]
    return x
  }
  m.set('gcd', fn('gcd', (a) => a.map(intOf).reduce(gcd, 0n)))
  m.set('lcm', fn('lcm', (a) => a.map(intOf).reduce((x, y) => (x === 0n || y === 0n ? 0n : checkInt(((x < 0n ? -x : x) / gcd(x, y)) * (y < 0n ? -y : y))), 1n)))
  m.set('isqrt', fn('isqrt', (a) => {
    const n = intOf(a[0])
    if (n < 0n) throw err('ValueError', 'isqrt() argument must be nonnegative')
    if (n < 2n) return n
    let x = BigInt(Math.floor(Math.sqrt(Number(n))))
    while (x * x > n) x--
    while ((x + 1n) * (x + 1n) <= n) x++
    return x
  }))
  m.set('prod', fn('prod', (a, kw) => iterate(a[0]).reduce((acc: PyVal, v) => binop('*', acc, v), kw.get('start') ?? 1n)))
  m.set('fsum', fn('fsum', (a) => iterate(a[0]).reduce((acc: number, v) => acc + numArg(v, 'fsum'), 0)))
  m.set('pi', Math.PI)
  m.set('e', Math.E)
  m.set('tau', 2 * Math.PI)
  m.set('inf', Infinity)
  m.set('nan', NaN)
  return m
}

/** math's members, xacro's direct builtins, and the `python.` and `math.` namespaces: `create_global_symbols` in xacro 2.1.1. */
export function pythonBuiltins(): { direct: Map<string, PyVal>; python: Map<string, PyVal>; math: Map<string, PyVal> } {
  const b = new Map<string, PyVal>()
  b.set('list', fn('list', (a) => (a.length ? [...iterate(a[0])] : [])))
  b.set('tuple', fn('tuple', (a) => new PyTuple(a.length ? [...iterate(a[0])] : [])))
  b.set('dict', fn('dict', toDict))
  b.set('set', fn('set', (a) => (a.length ? uniq(iterate(a[0])) : [])))
  b.set('str', fn('str', (a) => (a.length ? checkStr(pyStr(a[0])) : '')))
  b.set('repr', fn('repr', (a) => { nArgs('repr', a, 1); return pyRepr(a[0]) }))
  b.set('int', fn('int', (a, kw) => (a.length ? toIntValue(a[0], a[1] ?? kw.get('base')) : 0n)))
  b.set('float', fn('float', (a) => (a.length ? toFloatValue(a[0]) : 0)))
  b.set('bool', fn('bool', (a) => (a.length ? truthy(a[0]) : false)))
  b.set('len', fn('len', (a) => {
    nArgs('len', a, 1)
    const v = a[0]
    if (typeof v === 'string' || Array.isArray(v)) return BigInt(v.length)
    if (v instanceof PyTuple) return BigInt(v.items.length)
    if (v instanceof PyDict) return BigInt(v.m.size)
    throw err('TypeError', `object of type '${typeName(v)}' has no len()`)
  }))
  b.set('min', fn('min', (a, kw) => minmax('min', a, kw)))
  b.set('max', fn('max', (a, kw) => minmax('max', a, kw)))
  b.set('round', fn('round', pyRound))
  b.set('map', fn('map', (a) => {
    if (a.length < 2) throw err('TypeError', 'map() must have at least two arguments.')
    const f = callable(a[0], 'map')
    const its = a.slice(1).map(iterate)
    const n = Math.min(...its.map((x) => x.length))
    return Array.from({ length: n }, (_, i) => f.fn(its.map((x) => x[i]), new Map()))
  }))
  b.set('True', true)
  b.set('False', false)
  b.set('None', null)
  const python = new Map(b)
  python.set('abs', fn('abs', (a) => {
    nArgs('abs', a, 1)
    const v = a[0]
    if (isInt(v)) { const n = toBig(v); return n < 0n ? -n : n }
    if (typeof v === 'number') return Math.abs(v)
    throw err('TypeError', `bad operand type for abs(): '${typeName(v)}'`)
  }))
  python.set('all', fn('all', (a) => iterate(a[0]).every(truthy)))
  python.set('any', fn('any', (a) => iterate(a[0]).some(truthy)))
  python.set('divmod', fn('divmod', (a) => new PyTuple([binop('//', a[0], a[1]), binop('%', a[0], a[1])])))
  python.set('enumerate', fn('enumerate', (a, kw) => {
    const start = intOf(a[1] ?? kw.get('start') ?? 0n)
    return iterate(a[0]).map((v, i) => new PyTuple([start + BigInt(i), v]))
  }))
  python.set('filter', fn('filter', (a) => {
    nArgs('filter', a, 2)
    const f = a[0]
    return iterate(a[1]).filter((v) => truthy(f === null ? v : callable(f, 'filter').fn([v], new Map())))
  }))
  python.set('ord', fn('ord', (a) => {
    const s = needStr(a[0], 'ord() argument')
    if (Array.from(s).length !== 1) throw err('TypeError', `ord() expected a character, but string of length ${s.length} found`)
    return BigInt(s.codePointAt(0)!)
  }))
  python.set('reversed', fn('reversed', (a) => [...iterate(a[0])].reverse()))
  python.set('sorted', fn('sorted', (a, kw) => sortItems([...iterate(a[0])], kw.get('key') ?? null, truthy(kw.get('reverse') ?? false))))
  python.set('sum', fn('sum', (a, kw) => {
    let acc: PyVal = a[1] ?? kw.get('start') ?? 0n
    if (typeof acc === 'string') throw err('TypeError', "sum() can't sum strings [use ''.join(seq) instead]")
    for (const v of iterate(a[0])) acc = binop('+', acc, v)
    return acc
  }))
  python.set('zip', fn('zip', (a) => {
    const its = a.map(iterate)
    const n = its.length ? Math.min(...its.map((x) => x.length)) : 0
    return Array.from({ length: n }, (_, i) => new PyTuple(its.map((x) => x[i])))
  }))
  python.set('range', fn('range', rangeOf))
  for (const name of ['complex', 'frozenset', 'hash', 'isinstance', 'issubclass', 'slice', 'type', 'vars']) {
    python.set(name, fn(name, () => { throw err('NotImplementedError', `${name}() is not supported in xacro expressions here`) }))
  }
  const math = mathModule()
  const direct = new Map(b)
  for (const [k, v] of math) direct.set(k, v)
  direct.set('sorted', python.get('sorted')!)
  direct.set('range', python.get('range')!)
  return { direct, python, math }
}

/** `xacro.tokenize(s, sep=',; ', skip_empty=True)`. */
export function tokenize(args: PyVal[], kw: Map<string, PyVal>): PyVal {
  const s = needStr(args[0] ?? kw.get('s') ?? null, 'tokenize() argument')
  const sep = needStr(args[1] ?? kw.get('sep') ?? ',; ', 'sep')
  const skip = truthy(args[2] ?? kw.get('skip_empty') ?? true)
  const parts: string[] = []
  let cur = ''
  for (const c of s) {
    if (sep.includes(c)) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  return skip ? parts.filter((p) => p !== '') : parts
}

export { short as shortText }
