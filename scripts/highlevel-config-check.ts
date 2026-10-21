import { highlevel } from "../src/lib/highlevel/client";
import { fieldIds, locationId, workflowId } from "../src/lib/highlevel/config";
import { closePrivateDbPool } from "../src/lib/private-db/client";
import { HighLevelError, type Journey } from "../src/lib/highlevel/contract";

async function main() {
  try {
    const location = locationId();
    const [fields, workflows, pipelines] = await Promise.all([
      highlevel<{ customFields: { id: string }[] }>(
        `/locations/${encodeURIComponent(location)}/customFields`,
      ),
      highlevel<{ workflows: { id: string; status: string }[] }>(
        `/workflows/?locationId=${encodeURIComponent(location)}`,
      ),
      highlevel<{ pipelines: { id: string; stages: { id: string }[] }[] }>(
        `/opportunities/pipelines?locationId=${encodeURIComponent(location)}`,
      ),
    ]);
    if (
      !Array.isArray(fields.customFields) ||
      !Array.isArray(workflows.workflows) ||
      !Array.isArray(pipelines.pipelines)
    )
      throw new HighLevelError("invalid_configuration_response");
    const configuredFields = new Set(
      fields.customFields.map((field) => field.id),
    );
    const missingFields = Object.entries(fieldIds())
      .filter(([, id]) => !configuredFields.has(id))
      .map(([key]) => key);
    const workflowStatus = Object.fromEntries(
      (
        [
          "welcome",
          "inquiry",
          "training",
          "course",
          "purchase",
          "reactivation",
        ] satisfies Journey[]
      ).map((journey) => [
        journey,
        workflows.workflows.find(
          (workflow) => workflow.id === workflowId(journey),
        )?.status ?? "missing",
      ]),
    );
    const missingPipelines = ["MARKETING", "TRAINING"].filter(
      (kind) =>
        !pipelines.pipelines
          .find(
            (pipeline) =>
              pipeline.id === process.env[`HIGHLEVEL_${kind}_PIPELINE_ID`],
          )
          ?.stages.some(
            (stage) => stage.id === process.env[`HIGHLEVEL_${kind}_STAGE_ID`],
          ),
    );
    console.info(
      JSON.stringify(
        {
          location,
          missingFields,
          missingPipelines,
          workflowStatus,
          senderAndCadenceVerification:
            "Requires account-side review and test delivery",
        },
        null,
        2,
      ),
    );
    if (
      missingFields.length ||
      missingPipelines.length ||
      Object.values(workflowStatus).includes("missing")
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof HighLevelError
        ? error.code
        : "highlevel_configuration_check_failed",
    );
    process.exitCode = 1;
  } finally {
    await closePrivateDbPool();
  }
}

void main();
