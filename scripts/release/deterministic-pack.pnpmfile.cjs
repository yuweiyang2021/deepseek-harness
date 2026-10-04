'use strict';

/**
 * Canonicalize the publish dependency maps that pnpm builds concurrently.
 *
 * `createExportableManifest()` fills `peerDependencies`, `dependencies` and
 * `devDependencies` through `makePublishDependencies()`, which converts every
 * entry in parallel and assigns each property into a new object as its promise
 * settles. The maps' insertion order therefore follows completion order, so two
 * packs of one commit emit different package.json bytes.
 *
 * This hook rebuilds only those three maps, in ECMAScript default string order
 * (`Array.prototype.sort()` with no comparator, i.e. UTF-16 code-unit order --
 * not `localeCompare`, which follows the machine locale). Every key and value
 * survives unchanged, a map that is absent stays absent, and every other field
 * keeps its value and its position.
 *
 * `scripts/release/pack.ts` binds this file explicitly, by absolute path, with
 * `--config.pnpmfile` on every `pnpm pack` invocation. The file is deliberately
 * not named `.pnpmfile.cjs`, so it is never picked up as a workspace default.
 */

/** The three maps pnpm rebuilds while producing a publish manifest. */
const DEPENDENCY_MAPS = ['peerDependencies', 'dependencies', 'devDependencies'];

/**
 * Whether a manifest field holds a dependency map rather than something else.
 * A non-object field is left exactly as pnpm produced it.
 * @param value - the manifest field value.
 * @returns whether the value is a plain object whose keys can be reordered.
 */
function isDependencyMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuild one dependency map in code-unit key order.
 * @param map - the dependency map pnpm produced.
 * @returns A map carrying the same entries in canonical order.
 */
function canonicalizeMap(map) {
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((key) => [key, map[key]]),
  );
}

/**
 * Reorder only the present publish dependency maps, leaving every other field
 * in place and in its original order.
 * @param manifest - the publish manifest pnpm is about to write.
 * @returns The canonical manifest; pnpm keeps the original if this returns undefined.
 */
function beforePacking(manifest) {
  const canonical = {};
  for (const [field, value] of Object.entries(manifest)) {
    canonical[field] =
      DEPENDENCY_MAPS.includes(field) && isDependencyMap(value) ? canonicalizeMap(value) : value;
  }
  return canonical;
}

module.exports = { hooks: { beforePacking } };
