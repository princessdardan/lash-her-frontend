import { registerHooks } from "node:module";

// The DB unit tests run under `--conditions=react-server` so the `server-only`
// import guard resolves to its no-op stub (server-only exposes an `empty.js`
// only on that condition). The same condition, however, forces React 18's
// `react-server` export (`react.shared-subset.js`), whose entry throws
// "This entry point is not yet supported outside of experimental channels" the
// moment a module under test transitively imports React at runtime (e.g. the
// `@/lib/shipping/readiness` -> `@/lib/commerce/*` chain). These are server
// business-logic tests that never render, so re-resolve the React packages with
// the `react-server` condition removed: they fall back to their normal `default`
// entry and load cleanly, while `server-only` stays stubbed by the condition.
//
// Registered via NODE_OPTIONS by scripts/run-source-unit-tests.mjs so it reaches
// both the `node --test` process and the per-test `execFileSync` subprocesses
// (which inherit the parent env), without editing every *.db.test.ts file.
const REACT_PACKAGE = /^(react|react-dom)(\/.*)?$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (REACT_PACKAGE.test(specifier)) {
      const conditions = (context.conditions ?? []).filter(
        (condition) => condition !== "react-server",
      );
      return nextResolve(specifier, { ...context, conditions });
    }

    return nextResolve(specifier, context);
  },
});
