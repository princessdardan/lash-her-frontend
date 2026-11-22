"use client";

import { useEffect, useState } from "react";
import { communityFetch, CommunityRequestError } from "@/lib/community/client";

export function useCommunityResource<T>(url: string, recheck: boolean | number = false) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    data?: T;
    error?: CommunityRequestError;
  }>();

  useEffect(() => {
    let pending: AbortController | undefined;
    const load = async () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const data = await communityFetch<T>(url, undefined, controller.signal);
        if (!controller.signal.aborted) setResult({ url, data });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            url,
            error:
              error instanceof CommunityRequestError
                ? error
                : new CommunityRequestError(503, "service_unavailable"),
          });
      }
    };
    void load();
    const verify = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = recheck ? window.setInterval(verify, typeof recheck === "number" ? recheck : 30_000) : undefined;
    if (recheck) window.addEventListener("focus", verify);
    return () => {
      pending?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", verify);
    };
  }, [url, attempt, recheck]);

  return {
    ...(result?.url === url ? result : undefined),
    refresh: () => setAttempt((count) => count + 1),
  };
}
