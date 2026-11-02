# Database adapter engineering

WO-5 is in progress. No public database endpoint or final identity/post schema exists.

## Pinned type compatibility

The accepted stack remains Effect 3.22.4, pg 8.23.1, Drizzle ORM 0.45.4 and
drizzle-kit 0.31.11. Drizzle 1.0.0-rc.5 was investigated outside the repository but
rejected because its Effect >=4 peer contract conflicts with this application.
Do not disable peer checks or introduce a second Effect runtime to conceal that conflict.

The stable package's published declarations fail full strict checking, including
when only node-postgres is imported. `patches/drizzle-orm@0.45.4.patch` repairs
the declaration packaging against the package's shipped JavaScript and original
TypeScript embedded in its source maps. It changes **no runtime files**:

- Restore real `getSQL` methods and role fields removed by upstream's `@internal`
  declaration stripping, although public interfaces still require them.
- Describe the optional role/policy config values actually accepted and stored by
  the constructors, including present `undefined` values. This is a third-party
  boundary correction, not a change to application/domain optionality rules.
- Remove private `session`/`config` names from public set-operator exclusion unions;
  retain the `keyof` constraints and every real public method exclusion.
- Restore SingleStore's real inherited generated-column method. Its enum override
  always throws, so its honest return type is `never`, not a fictional working builder.

Both ESM and CJS declaration files are patched. No compiler flag, diagnostic,
peer constraint or test is disabled. The exact patch hash is in the frozen lockfile.
`test/drizzle-contract.test.ts` checks actual shipped methods and PostgreSQL query
construction in workerd, as well as compiling both module-resolution branches.
These pure construction tests do **not** establish database or Hyperdrive behavior.

`gel` and `mysql2` are genuine, dev-only SDKs needed by cross-dialect declarations
reachable through Drizzle's SQL types. They do not configure or provision another
runtime database. The legacy drizzle-kit loader's esbuild dependency is scoped to
0.25.12 to fix GHSA-67mh-4wv8-2f99; its actual transform APIs were inspected.
Retest real migration generation/application when changing this override.

When upgrading, first try the unpatched published declarations under the existing
strict settings, then run adapter/runtime/migration and affected-consumer gates.
Remove the patch when upstream resolves these defects; never replace it with
`skipLibCheck`, ambient fake declarations or unsafe type escapes.
