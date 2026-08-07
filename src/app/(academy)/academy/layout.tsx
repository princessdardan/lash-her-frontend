import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AcademyShell } from "@/components/academy/academy-shell";

export const metadata: Metadata = {
  title: "Student Academy",
  description: "Secure Lash Her student learning space.",
  robots: { follow: false, index: false },
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function AcademyLayout({ children }: { children: ReactNode }) {
  return <AcademyShell>{children}</AcademyShell>;
}
