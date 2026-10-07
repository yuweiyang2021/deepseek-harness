/**
 * The deterministic packing contract for `pnpm pack`: a repository-owned
 * pnpmfile canonicalizes the three publish dependency maps, and the release
 * pack step binds that pnpmfile to every invocation.
 *
 * pnpm 11.7.0 builds the publish manifest through `makePublishDependencies()`,
 * which fills `peerDependencies`, `dependencies` and `devDependencies` from
 * concurrently resolved promises. Property insertion order follows completion
 * order, so two packs of one commit emit different bytes. The repair is a
 * `hooks.beforePacking` hook that reorders only those three maps, plus the
 * explicit `--config.pnpmfile` binding that makes pnpm run it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Repository-owned pnpmfile that canonicalizes the publish dependency maps. */
const PNPMFILE_NAME = 'deterministic-pack.pnpmfile.cjs'

/** Absolute path of the pnpmfile under test. */
const PNPMFILE = resolve(import.meta.dirname, PNPMFILE_NAME)

/** Absolute path of the release pack entry point that must bind the pnpmfile. */
const PACK_SOURCE = resolve(import.meta.dirname, 'pack.ts')

/** The three maps pnpm rebuilds while producing a publish manifest. */
const DEPENDENCY_MAPS: readonly string[] = ['peerDependencies', 'dependencies', 'devDependencies']

/**
 * Keys chosen so code-unit order and locale order disagree: `Babel-runtime`
 * (U+0042) precedes `ajv` (U+0061) by code unit, while a locale collator ranks
 * the letters case-insensitively and puts `ajv` first. The two `@`-scoped names
 * sort on U+0040, ahead of every letter.
 */
const KEYS: readonly string[] = [
  'zod',
  '@deepseek-ai/dsh-core',
  'JSON-stream',
  'ajv',
  '@AWS/sdk',
  'Babel-runtime',
  'typescript',
]

/** `KEYS` in ECMAScript default string order. */
const CANONICAL_ORDER: readonly string[] = [
  '@AWS/sdk',
  '@deepseek-ai/dsh-core',
  'Babel-runtime',
  'JSON-stream',
  'ajv',
  'typescript',
  'zod',
]

/** JSON-shaped manifest data. */
type JsonObject = Record<string, unknown>

/** One dependency map. */
type DependencyMap = Record<string, string>

/** The subset of pnpm's pnpmfile interface this contract depends on. */
interface PnpmfileHooks {
  beforePacking?(manifest: unknown, dir: string, context: unknown): unknown
}

/** What the repository-owned pnpmfile must export. */
interface PnpmfileModule {
  hooks?: PnpmfileHooks
}

/** A fixed version per key, so a swapped value is visible rather than equal. */
const VERSIONS: DependencyMap = Object.fromEntries(KEYS.map((key, index) => [key, `${String(index)}.0.0`]))

const requirePnpmfile = createRequire(import.meta.url)

/**
 * Load the repository-owned pnpmfile through a runtime-resolved absolute path, so
 * an absent implementation reports a module-resolution failure when a test calls
 * it rather than a collection-time import error.
 * @returns The pnpmfile module namespace.
 */
function loadPnpmfile(): PnpmfileModule {
  return requirePnpmfile(PNPMFILE) as PnpmfileModule
}

/**
 * Run the pnpmfile's `beforePacking` hook the way pnpm does: await it, and fall
 * back to the manifest it was handed when the hook returns nothing.
 * @param manifest - publish manifest handed to the hook.
 * @returns The manifest pnpm would publish.
 */
async function canonicalize(manifest: JsonObject): Promise<JsonObject> {
  const { hooks } = loadPnpmfile()
  if (hooks === undefined || typeof hooks.beforePacking !== 'function') {
    throw new TypeError(`${PNPMFILE_NAME} must export hooks.beforePacking; pnpm rejects every other shape`)
  }
  const returned = await hooks.beforePacking(manifest, 'F:\\repo\\packages\\core\\example', { log: () => undefined })
  return (returned ?? manifest) as JsonObject
}

/**
 * One dependency map whose entries are inserted in the given order.
 * @param keys - dependency names in insertion order.
 * @returns A fresh map.
 */
function dependencyMap(keys: readonly string[]): DependencyMap {
  return Object.fromEntries(keys.map(key => [key, VERSIONS[key] ?? '0.0.0']))
}

/**
 * A manifest carrying the same key/value sets in one chosen insertion order.
 * @param keys - dependency names in insertion order.
 * @returns A fresh manifest.
 */
function manifestWith(keys: readonly string[]): JsonObject {
  return {
    name: '@deepseek-ai/dsh-example',
    version: '1.2.3',
    peerDependencies: dependencyMap(keys),
    dependencies: dependencyMap(keys),
    devDependencies: dependencyMap(keys),
  }
}

/**
 * Every rotation of a key list, which is a distinct insertion order of one set.
 * @param keys - the key list to rotate.
 * @returns One order per rotation offset.
 */
function rotations(keys: readonly string[]): string[][] {
  return keys.map((_, offset) => keys.map((__, index) => keys[(index + offset) % keys.length] ?? ''))
}

/**
 * A manifest without its dependency maps, keeping the remaining fields in order.
 * @param manifest - manifest to strip.
 * @returns The non-dependency fields.
 */
function withoutDependencyMaps(manifest: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => !DEPENDENCY_MAPS.includes(key)))
}

describe('deterministic pack pnpmfile', () => {
  it('exports the hook shape pnpm validates', () => {
    const { hooks } = loadPnpmfile()

    expect(hooks).toBeTypeOf('object')
    expect(hooks?.beforePacking).toBeTypeOf('function')
  })

  it('canonicalizes all three dependency maps', async () => {
    const canonical = await canonicalize(manifestWith([...KEYS].reverse()))

    for (const name of DEPENDENCY_MAPS) {
      expect(Object.keys(canonical[name] as DependencyMap)).toEqual(CANONICAL_ORDER)
    }
  })

  it('yields byte-equivalent maps for different input insertion orders', async () => {
    // The rotations already include KEYS itself, so only the reversal is added.
    const orders = [...rotations(KEYS), [...KEYS].reverse()]
    // A vacuous pass would compare one order against itself.
    expect(new Set(orders.map(order => order.join('\u0000'))).size).toBe(orders.length)

    const serialized = new Set<string>()
    for (const order of orders) serialized.add(JSON.stringify(await canonicalize(manifestWith(order))))

    expect(serialized.size).toBe(1)
  })

  it('neither adds, removes nor changes a dependency key or value', async () => {
    const manifest = manifestWith([...KEYS].reverse())
    const canonical = await canonicalize(manifest)

    for (const name of DEPENDENCY_MAPS) {
      const before = manifest[name] as DependencyMap
      const after = canonical[name] as DependencyMap
      const keys = Object.keys(after).sort()

      expect(keys).toEqual(Object.keys(before).sort())
      expect(keys).toHaveLength(KEYS.length)
      for (const key of keys) expect(after[key]).toBe(before[key])
    }
  })

  it('keeps an absent dependency map absent and a present empty map present', async () => {
    const absent = await canonicalize({ name: 'x', version: '1.0.0', dependencies: dependencyMap(KEYS) })

    expect(Object.keys(absent)).toEqual(['name', 'version', 'dependencies'])
    expect(Object.hasOwn(absent, 'peerDependencies')).toBe(false)
    expect(Object.hasOwn(absent, 'devDependencies')).toBe(false)

    const empty = await canonicalize({ name: 'x', version: '1.0.0', devDependencies: {} })

    expect(Object.keys(empty)).toEqual(['name', 'version', 'devDependencies'])
    expect(empty.devDependencies).toEqual({})
    expect(Object.hasOwn(empty, 'peerDependencies')).toBe(false)
  })

  it('leaves every non-dependency field, and the field order, untouched', async () => {
    const manifest: JsonObject = {
      name: '@deepseek-ai/dsh-example',
      version: '1.2.3',
      type: 'module',
      description: 'release fixture',
      dsh: { capabilities: { schemaVersion: 1, continuation: true, providers: ['codex', 'claude'] } },
      exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } },
      files: ['lib', 'README.md'],
      engines: { node: '>=22' },
      scripts: { build: 'tsc -b' },
      publishConfig: { access: 'public' },
      ...manifestWith(KEYS),
    }
    const canonical = await canonicalize(manifest)

    expect(canonical).toEqual(manifest)
    expect(Object.keys(canonical)).toEqual(Object.keys(manifest))
    // package.json is published as JSON text, so surviving field order is bytes.
    expect(JSON.stringify(withoutDependencyMaps(canonical))).toBe(JSON.stringify(withoutDependencyMaps(manifest)))
    expect(JSON.stringify(canonical.dsh)).toBe(JSON.stringify(manifest.dsh))
    expect(JSON.stringify(canonical.exports)).toBe(JSON.stringify(manifest.exports))
  })

  it('orders by ECMAScript default string comparison rather than the machine locale', async () => {
    const canonical = await canonicalize(manifestWith(KEYS))

    expect(Object.keys(canonical.dependencies as DependencyMap)).toEqual(CANONICAL_ORDER)
    // Scoped names sort on their literal '@' (U+0040), ahead of every letter.
    expect(CANONICAL_ORDER.slice(0, 2)).toEqual(['@AWS/sdk', '@deepseek-ai/dsh-core'])
    // U+0042 precedes U+0061, so `Babel-runtime` comes first; the collator that
    // ranks letters case-insensitively reverses the pair. An implementation that
    // sorted with `localeCompare` therefore cannot produce CANONICAL_ORDER.
    expect([...['Babel-runtime', 'ajv']].sort()).toEqual(['Babel-runtime', 'ajv'])
    expect(['Babel-runtime', 'ajv'].sort((left, right) => left.localeCompare(right))).toEqual(['ajv', 'Babel-runtime'])
    expect([...KEYS].sort((left, right) => left.localeCompare(right))).not.toEqual(CANONICAL_ORDER)
  })
})

describe('release pack pnpmfile binding', () => {
  it('binds the repository-owned pnpmfile to the pack invocation', () => {
    const source = readFileSync(PACK_SOURCE, 'utf8')

    // pnpm runs the hook only when it is told where the pnpmfile is, and the
    // binding travels as a config value.
    expect(source).toContain('--config.pnpmfile=')
    expect(source).toContain(PNPMFILE_NAME)
    // An absolute repository-owned path, resolved from pack.ts's own directory
    // rather than a workspace-relative guess each member directory reinterprets.
    expect(source).toMatch(/resolve\(\s*import\.meta\.dirname\s*,/u)
  })

  it('resolves that binding to an existing absolute file inside the repository', () => {
    expect(isAbsolute(PNPMFILE)).toBe(true)
    expect(PNPMFILE.startsWith(resolve(import.meta.dirname, '..', '..'))).toBe(true)
    expect(existsSync(PNPMFILE)).toBe(true)
  })
})
