const expectedDatasets = {
  production: "production",
  preview: "staging-2026-05-10",
};

const vercelEnv = process.env.VERCEL_ENV;
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET;

if (!dataset) {
  throw new Error("Missing env var: NEXT_PUBLIC_SANITY_DATASET");
}

const expectedDataset = expectedDatasets[vercelEnv];

if (expectedDataset && dataset !== expectedDataset) {
  throw new Error(
    `Invalid Sanity dataset for Vercel ${vercelEnv}: expected ${expectedDataset}, received ${dataset}`
  );
}

console.log(
  vercelEnv
    ? `[sanity-env] Vercel ${vercelEnv} uses ${dataset}`
    : `[sanity-env] Local build uses ${dataset}`
);
