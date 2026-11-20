import type { Deadline } from './safeXml'
import type { ImportReport } from './importReport'
import { convertMjcfToUrdf } from './mjcfConverter'
import { convertSdfToUrdf } from './sdfConverter'
import { preprocessXacro } from './xacro'

export { convertMjcfToUrdf, convertSdfToUrdf, preprocessXacro }

/** Shared by every converter: collects non-fatal problems so the UI can show them instead of hiding them. */
export interface ParseContext {
  warnings?: string[]
  /**
   * Resolves an included file's name (a `xacro:include` after `$(find pkg)` substitution, e.g. `package://pkg/urdf/a.xacro`,
   * an MJCF `<include file>` or an SDF `model://` file) to its text and imported path. `from` is the file the include is
   * written in. Browsers cannot fetch it themselves, so the importer supplies the dropped files. `exact` takes only the file
   * the name means, never one matched by name elsewhere (nothing is then reported).
   */
  resolveInclude?: (filename: string, from?: string, options?: { exact?: boolean }) => { text: string; path: string } | undefined
  /** Where converters record what they changed, approximated or could not use (the import dialog lists it). */
  report?: ImportReport
  /** The import's time limit, checked by every converter loop. */
  deadline?: Deadline
  /** The file being converted, for messages. */
  fileName?: string
  /** Values for the xacro's `$(arg name)`, given in the import dialog; unset ones fall back to `xacro:arg` defaults. */
  xacroArgs?: Record<string, string>
  /** Filled by the xacro with each argument it declares or reads, in order, and its value then (undefined: needed, none given). */
  xacroArgsUsed?: Map<string, string | undefined>
  /** Filled by the MJCF converter: the compiler settings MuJoCo applies to masses and inertias, for the model check. */
  mjcfInertia?: MjcfInertiaContext
  /** Filled by the SDF converter: links whose inertia Gazebo computes from their collision shapes (`auto="true"`). */
  sdfAutoInertia?: string[]
  /** Filled by the SDF converter: links it added that are not in the file (the world link, joint helpers). */
  sdfHelperLinks?: string[]
}

/** MJCF `<compiler>` settings that change masses and inertias (MuJoCo 3.17 user_objects.cc, mjCBody::Compile). */
export interface MjcfInertiaContext {
  /** `true`: every body's inertia comes from its geoms; `auto`: only a body with no `<inertial>`; `false`: never. */
  inertiafromgeom: 'false' | 'true' | 'auto'
  /** A principal inertia that breaks A + B >= C is replaced by the mean of the three instead of refused. */
  balanceinertia: boolean
  /** Lower bounds applied to each body's mass and principal inertias before they are checked. */
  boundmass: number
  boundinertia: number
  /** Static bodies are merged into their parents before the final compile (MJCF default off). */
  fusestatic: boolean
  /** Every body, in document order, as MuJoCo's moving-body check sees it (user_model.cc CheckBodyMassInertia). */
  bodies: MjcfBody[]
}

/** One MJCF body and the URDF link that carries its `<inertial>`. */
export interface MjcfBody {
  link: string
  /** The parent body's link; '' for a child of the worldbody. */
  parent: string
  /** Whether the body has any joint (free and ball included). */
  moving: boolean
  /** Whether it has a geom whose group is inside `<compiler inertiagrouprange>` (default 0 5), so MuJoCo can infer its inertia. */
  geoms: boolean
  /** Whether its inertial is a `fullinertia` (MuJoCo then refuses any eigenvalue below mjEPS). */
  fullinertia: boolean
}

/** The prolog parts rootIs skips, sticky (`y`): each matches only where the scan stands. */
const PROLOG = {
  space: /\s*/y,
  decl: /<\?xml[^>]*\?>/iy,
  comment: /<!--[\s\S]*?-->/y,
  doctype: /<!DOCTYPE[^>]*>/iy,
}

/**
 * Checks if the content is a MuJoCo MJCF XML document.
 */
export function isMuJoCoModel(text: string): boolean {
  // Match the ROOT element only. Unitree/ROS URDFs embed a `<mujoco><compiler meshdir=.../></mujoco>`
  // extension block inside `<robot>`, which must not be mistaken for an MJCF document.
  return rootIs(text, /<mujoco[\s>]/iy)
}

/**
 * Checks if the content is an SDFormat document (root `<sdf>`).
 */
export function isSdfModel(text: string): boolean {
  return rootIs(text, /<sdf[\s>]/iy)
}

/** Whether the document's root element, after its prolog, matches the sticky `root`. */
function rootIs(text: string, root: RegExp): boolean {
  // A forward scan over the prolog (declaration, comments, DOCTYPE), each part taken once and never backtracked into: one
  // regular expression for the whole prolog backtracked exponentially on a header of many comments (CodeQL js/redos, the tab
  // froze on import), and its lazy comment could run on past a `-->` to a `<mujoco>` block deep inside a `<robot>`.
  let i = 0
  const eat = (re: RegExp): boolean => {
    re.lastIndex = i
    if (!re.test(text)) return false
    PROLOG.space.lastIndex = re.lastIndex
    PROLOG.space.test(text)
    i = PROLOG.space.lastIndex
    return true
  }
  eat(PROLOG.space)
  eat(PROLOG.decl)
  while (eat(PROLOG.comment));
  eat(PROLOG.doctype)
  while (eat(PROLOG.comment));
  root.lastIndex = i
  return root.test(text)
}

/**
 * Checks if the content is a ROS Xacro document.
 */
export function isXacroModel(text: string): boolean {
  return /xmlns:xacro|<xacro:/i.test(text)
}

/**
 * Parses and converts any robot description format (.urdf, .xacro, .xml/MJCF, .sdf)
 * into a standard, fully resolved URDF XML string ready for URDFLoader.
 */
export function parseRobotDescription(rawText: string, filenameOrUrl = '', ctx: ParseContext = {}): string {
  if (isMuJoCoModel(rawText)) {
    const modelName = filenameOrUrl.split('/').pop()?.replace(/\.[^.]+$/, '') || 'mujoco_robot'
    return convertMjcfToUrdf(rawText, modelName, ctx)
  }

  if (isSdfModel(rawText)) {
    const modelName = filenameOrUrl.split('/').pop()?.replace(/\.[^.]+$/, '') || 'sdf_robot'
    return convertSdfToUrdf(rawText, modelName, ctx)
  }

  if (isXacroModel(rawText) || /\.xacro$/i.test(filenameOrUrl)) {
    return preprocessXacro(rawText, ctx)
  }

  return rawText
}
