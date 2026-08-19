export const runtime = "nodejs";

import {
  getSquareCommerceConfig,
  type SquareCommerceConfig,
} from "@/lib/env/private-checkout";

interface SquareCommerceConfigDependencies {
  getConfig: () => SquareCommerceConfig | null;
}

const defaultDependencies: SquareCommerceConfigDependencies = {
  getConfig: getSquareCommerceConfig,
};

export const GET = createSquareCommerceConfigGetHandler(defaultDependencies);

export function createSquareCommerceConfigGetHandler(
  dependencies: SquareCommerceConfigDependencies,
): (req: Request) => Promise<Response> {
  return async function squareCommerceConfigGetHandler(): Promise<Response> {
    const config = dependencies.getConfig();

    if (config === null) {
      return Response.json(
        { error: "Square commerce checkout is not enabled" },
        { status: 404 },
      );
    }

    return Response.json({
      applicationId: config.applicationId,
      environment: config.environment,
      locationId: config.locationId,
      locale: config.locale,
      scriptUrl: getSquareWebPaymentsScriptUrl(config.environment),
    });
  };
}

function getSquareWebPaymentsScriptUrl(
  environment: "sandbox" | "production",
): string {
  return environment === "production"
    ? "https://web.squarecdn.com/v1/square.js"
    : "https://sandbox.web.squarecdn.com/v1/square.js";
}
