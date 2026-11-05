import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import { createSquareReturnGetHandler, defaultDependencies } from "./handler";

export const runtime = "nodejs";

export const GET = createSquareReturnGetHandler(defaultDependencies, task =>
  runWriterAdmission("recovery", task),
);
