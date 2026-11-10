import "server-only";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";

export async function readLearningPage<T>(read: () => Promise<T>): Promise<{ data: T; error: null } | { data: null; error: IntegrationServiceError }> {
  try { return { data: await read(), error: null }; }
  catch (error) { return { data: null, error: error instanceof IntegrationServiceError ? error : new IntegrationServiceError("service_unavailable", 503) }; }
}
