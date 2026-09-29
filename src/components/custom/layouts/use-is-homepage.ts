"use client";

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

const subscribe = () => () => {};
const getServerSnapshot = () => false;

export function useIsHomepage() {
  const pathname = usePathname();

  // Keep server markup and the first hydration render identical even when
  // routing resolves a different pathname in the browser. Both the header and
  // main spacing switch to the homepage treatment after hydration.
  return useSyncExternalStore(
    subscribe,
    () => pathname === "/",
    getServerSnapshot,
  );
}
