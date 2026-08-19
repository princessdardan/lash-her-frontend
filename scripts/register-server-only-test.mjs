import { registerHooks } from "node:module";

const serverOnlyStubUrl = new URL(
  "../node_modules/server-only/empty.js",
  import.meta.url,
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: serverOnlyStubUrl };
    }

    return nextResolve(specifier, context);
  },
});
