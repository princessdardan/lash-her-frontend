// Public plan/ineligibility only. Actual mutation requires the source parent.
import { readFileSync } from "node:fs";
import { prepareP2LifecycleTransportFaultPlan } from "./p2-lifecycle-transport-fault.mjs";
try {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length) throw new Error();
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (Object.keys(value).sort().join() !== ["nativePlan", "input"].sort().join()) throw new Error();
  const plan = prepareP2LifecycleTransportFaultPlan(value.nativePlan, value.input);
  process.stdout.write(JSON.stringify({ ...plan, status: "P2_TRANSPORT_FAULT_PLAN_SOURCE_PARENT_REQUIRED", networkCalled: false, mutationsPerformed: false }) + "\n");
} catch {
  process.stdout.write(JSON.stringify({ version: 1, status: "P2_TRANSPORT_FAULT_PLAN_REFUSED", standaloneActivationEligible: false,
    networkCalled: false, mutationsPerformed: false, releaseAccepted: false }) + "\n"); process.exitCode = 1;
}
