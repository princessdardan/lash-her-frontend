export const runtime = "nodejs";

import {
  getSquareCardOnFileServiceBookingConfig,
  type SquareCardOnFileServiceBookingConfig,
} from "@/lib/env/private-checkout";

interface SquareConfigDependencies {
  getConfig: () => SquareCardOnFileServiceBookingConfig | null;
}

const defaultDependencies: SquareConfigDependencies = {
  getConfig: getSquareCardOnFileServiceBookingConfig,
};

export const GET = createSquareConfigGetHandler(defaultDependencies);

export function createSquareConfigGetHandler(
  dependencies: SquareConfigDependencies,
): (req: Request) => Promise<Response> {
  return async function squareConfigGetHandler(): Promise<Response> {
    const config = dependencies.getConfig();

    if (config === null) {
      return Response.json(
        { error: "Square card-on-file booking is not enabled" },
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
