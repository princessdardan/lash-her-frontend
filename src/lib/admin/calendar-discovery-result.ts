import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { AdminAuthError } from "./types";

export type CalendarDiscoveryResult<T> =
  | { calendars: T[]; kind: "ready" }
  | { kind: "error" };

export async function loadCalendarDiscoveryResult<T>(
  load: () => Promise<T[]>,
): Promise<CalendarDiscoveryResult<T>> {
  try {
    return { calendars: await load(), kind: "ready" };
  } catch (error) {
    // A denial is not an empty/failed provider observation. Preserve its known
    // authorization result or admission refusal for the enclosing page.
    if (error instanceof AdminAuthError || error instanceof WriterAdmissionError) {
      throw error;
    }
    markWriterOperationUncertain();
    return { kind: "error" };
  }
}
