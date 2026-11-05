import { highlevel } from "../src/lib/highlevel/client";
import { fieldIds, locationId, workflowId } from "../src/lib/highlevel/config";
import { closePrivateDbPool } from "../src/lib/private-db/client";
import { HighLevelError, type Journey } from "../src/lib/highlevel/contract";
import { runWriterAdmission } from "../src/lib/writer-admission/runtime";

async function main() {
  try {
    await runWriterAdmission("new-work", async () => {
      const location = locationId();
      // These apparent reads may rotate the same OAuth token. Await each call so
      // no refresh/provider sibling can outlive a caught configuration failure.
      const fields = await highlevel<{ customFields: { id: string }[] }>(
        `/locations/${encodeURIComponent(location)}/customFields`,
      );
      const workflows = await highlevel<{
        workflows: { id: string; status: string }[];
      }>(`/workflows/?locationId=${encodeURIComponent(location)}`);
      const pipelines = await highlevel<{
        pipelines: { id: string; stages: { id: string }[] }[];
      }>(`/opportunities/pipelines?locationId=${encodeURIComponent(location)}`);
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
    });
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
