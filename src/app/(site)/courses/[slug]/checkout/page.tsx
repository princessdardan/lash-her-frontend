import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { readCourseCatalogDetail } from "@/components/learning/course-detail";
import { customerSignInHref } from "@/lib/learning/presentation";

const academyId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
import { getCustomerActor } from "@/lib/customer-auth/session";
import {
  courseCheckoutEnabled,
  coursePurchaseAccountEnabled,
  courseRecoveryEnabled,
} from "@/lib/course-purchases/policy";
import { publicCourseOrder } from "@/lib/course-purchases/checkout";
import { readCourseOrder } from "@/lib/course-purchases/store";
import { CoursePurchaseForm } from "@/components/courses/course-purchase-form";

export const metadata: Metadata = {
  title: "Course checkout",
  robots: { index: false, follow: false },
};

export default async function CourseCheckoutPage({
  params,
  searchParams,
}: PageProps<"/courses/[slug]/checkout">) {
  const { slug } = await params;
  const { order: orderId } = await searchParams;
  if (!coursePurchaseAccountEnabled() || !courseRecoveryEnabled()) notFound();
  if (!courseCheckoutEnabled() && !orderId) notFound();
  const actor = await getCustomerActor();
  const destination = `/courses/${slug}/checkout`;
  if (!actor) redirect(customerSignInHref(destination));
  if (orderId) {
    if (typeof orderId !== "string" || !academyId.test(orderId)) notFound();
    const order = await readCourseOrder(orderId, actor.id);
    if (!order || order.courseSlug !== slug) notFound();
    return (
      <CoursePurchaseForm
        title={order.courseTitle}
        courseId={order.courseId}
        email={actor.email}
        prefilledName={actor.name ?? ""}
        initialOrder={publicCourseOrder(order)}
        salesOpen={courseCheckoutEnabled()}
      />
    );
  }
  const result = await readCourseCatalogDetail(slug);
  if (result.course.accessMode !== "paid") notFound();
  return (
    <CoursePurchaseForm
      title={result.course.title}
      courseId={result.course.id}
      email={actor.email}
      prefilledName={actor.name ?? ""}
      salesOpen
    />
  );
}
