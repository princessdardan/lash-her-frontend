import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CourseCatalog } from "@/components/learning/course-catalog";
import { learningRoutesEnabled } from "@/lib/learning/rollout";

export const metadata: Metadata = { title: "Courses | LASH HER Academy", alternates: { canonical: "/courses" } };
export const dynamic = "force-dynamic";
export default async function CoursesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!learningRoutesEnabled()) notFound();
  const query = await searchParams;
  if (Object.keys(query).some(key => key !== "cursor") || query.cursor !== undefined && (typeof query.cursor !== "string" || query.cursor.length > 256)) notFound();
  return <CourseCatalog cursor={typeof query.cursor === "string" ? query.cursor : undefined} />;
}
