// Limits for files the user imports. They are untrusted, so none of them may crash or hang the tab: each limit ends the
// import with a named reason instead. The numbers are in docs/import-formats.md.

const MiB = 2 ** 20

export const LIMITS = {
  zipFile: 512 * MiB,
  zipTotal: 512 * MiB,
  zipEntries: 10_000,
  /** An entry above `zipRatioFloor` may be at most this many times its compressed size. */
  zipRatio: 200,
  zipRatioFloor: MiB,
  textFile: 32 * MiB,
  meshFile: 256 * MiB,
  /** The zip worker is stopped after this long. */
  zipMs: 60_000,
  /** Elements a xacro may expand to, counted before each copy is made. */
  xacroElements: 2_000_000,
  macroDepth: 16,
  includeDepth: 8,
  /** Characters in one `${}` expression, and in the value it gives. */
  exprChars: 10_000,
  /** The whole import after unzipping, checked by every converter loop (cooperative). */
  importMs: 30_000,
  /** Above these the import warns that the robot may draw slowly. */
  trianglesTotal: 2_000_000,
  trianglesMesh: 500_000,
} as const

/** Description files, read as text: the 32 MiB cap. Every other file (meshes, textures) has the mesh cap. */
export const TEXT_FILE = /\.(urdf|xacro|xml|sdf|ya?ml)$/i

export const sizeLimitFor = (name: string): number => (TEXT_FILE.test(name) ? LIMITS.textFile : LIMITS.meshFile)

export type RefusalReason =
  | 'not a zip'
  | 'entries'
  | 'name'
  | 'symlink'
  | 'duplicate'
  | 'encrypted'
  | 'method'
  | 'total'
  | 'ratio'
  | 'crc'
  | 'too big'
  | 'time'
  | 'entity'
  | 'xml'
  | 'elements'
  | 'depth'
  | 'expression'
  | 'timeout'

/** An import stopped by a limit. `reason` is stable (tests match on it); `message` is for the user. */
export class ImportRefused extends Error {
  readonly reason: RefusalReason
  readonly detail: string
  constructor(reason: RefusalReason, detail: string, message: string) {
    super(message)
    this.name = 'ImportRefused'
    this.reason = reason
    this.detail = detail
  }
}

const mib = (n: number) => `${Math.round(n / MiB)} MiB`

/** The user-facing sentence for each reason. */
export function refusalMessage(reason: RefusalReason, detail: string): string {
  switch (reason) {
    case 'not a zip':
      return `The zip file is damaged or is not a zip (${detail}).`
    case 'entries':
      return `The zip holds too many files (${detail}); the limit is ${LIMITS.zipEntries}.`
    case 'name':
      return `The zip was refused: a file name in it points outside its folder (${detail}).`
    case 'symlink':
      return `The zip was refused: it holds a symbolic link (${detail}).`
    case 'duplicate':
      return `The zip was refused: it holds the same file name twice (${detail}).`
    case 'encrypted':
      return `The zip was refused: it is password-protected (${detail}).`
    case 'method':
      return `The zip uses a compression method other than stored or deflate (${detail}).`
    case 'total':
      return `The zip unpacks to more than ${mib(LIMITS.zipTotal)} (${detail}).`
    case 'ratio':
      return `The zip was refused: a file in it is compressed more than ${LIMITS.zipRatio}:1, like a zip bomb (${detail}).`
    case 'crc':
      return `The zip was refused: a file in it does not match its recorded size or checksum (${detail}).`
    case 'too big':
      return `A file is over its size limit (${detail}); description files may be ${mib(LIMITS.textFile)}, meshes ${mib(LIMITS.meshFile)}.`
    case 'time':
      return `Unpacking the zip took longer than ${LIMITS.zipMs / 1000} s, so it was stopped.`
    case 'entity':
      return `${detail} declares an XML entity. Robot description files never need one, so it was refused.`
    case 'xml':
      return `A description file is not well-formed XML (${detail}).`
    case 'elements':
      return `The description expands to more than ${LIMITS.xacroElements.toLocaleString('en-US')} elements, so it was stopped (${detail}).`
    case 'depth':
      return `The description nests too deeply (${detail}); xacro macros may nest ${LIMITS.macroDepth} deep and includes ${LIMITS.includeDepth} deep.`
    case 'expression':
      return `A xacro expression or its value is over ${LIMITS.exprChars.toLocaleString('en-US')} characters (${detail}).`
    case 'timeout':
      return `The import took longer than ${LIMITS.importMs / 1000} s, so it was stopped (${detail}).`
  }
}

export const refuse = (reason: RefusalReason, detail: string): ImportRefused =>
  new ImportRefused(reason, detail, refusalMessage(reason, detail))
