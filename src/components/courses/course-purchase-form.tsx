"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Button } from "@/components/ui/button";
import {
  SquareCommerceCardForm,
  type SquareCommerceCardFormHandle,
  type SquareCommerceTokenResult,
} from "@/components/commerce/square-commerce-card-form";
import type { publicCourseOrder } from "@/lib/course-purchases/checkout";
import type { CourseBilling } from "@/lib/course-purchases/schema";
const academyCourseHref = (courseId: string) => `/academy/courses/${courseId}`;

type Purchase = ReturnType<typeof publicCourseOrder>;
const path = "/api/checkout/course";
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;
const money = (amount: number) =>
  Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    currencyDisplay: "code",
  }).format(amount / 100);

async function requestCourseOrder(
  body?: object,
  id?: string,
): Promise<Purchase> {
  const response = await fetch(id ? `${path}?orderId=${id}` : path, {
    cache: "no-store",
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json", "x-lash-csrf": "1" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = (await response.json()) as {
    order?: Purchase;
    error?: { message?: string };
  };
  if (!response.ok || !result.order)
    throw new Error(
      result.error?.message ?? "Course checkout is temporarily unavailable.",
    );
  return result.order;
}

export function CoursePurchaseForm({
  title,
  courseId,
  email,
  prefilledName,
  initialOrder,
  salesOpen,
}: {
  title: string;
  courseId: string;
  email: string;
  prefilledName: string;
  initialOrder?: Purchase;
  salesOpen: boolean;
}) {
  const [order, setOrder] = useState(initialOrder);
  const [billing, setBilling] = useState<CourseBilling>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [acceptedTermsOrderId, setAcceptedTermsOrderId] = useState<string>();
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  );
  const billingHeading = useRef<HTMLHeadingElement>(null);
  const summaryHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterBillingChange = useRef(false);
  const card = useRef<SquareCommerceCardFormHandle>(null);
  const pendingToken = useRef<SquareCommerceTokenResult | null>(null);
  const showError = useCallback((message: string) => setError(message), []);

  async function quote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const field = (name: string) => String(fields.get(name) ?? "").trim();
    const contact = {
      name: field("name"),
      line1: field("line1"),
      city: field("city"),
      region: field("region").toUpperCase(),
      postalCode: field("postalCode"),
      country: field("country").toUpperCase(),
    };
    setBusy(true);
    setError(undefined);
    try {
      const next = await requestCourseOrder({
        operation: "quote",
        courseId,
        billing: contact,
      });
      focusAfterBillingChange.current = true;
      setBilling(contact);
      setOrder(next);
      window.history.replaceState(null, "", `?order=${next.id}`);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The total could not be calculated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function charge(token: SquareCommerceTokenResult) {
    if (!order) return;
    pendingToken.current = token;
    try {
      const next = await requestCourseOrder({
        operation: "charge",
        orderId: order.id,
        acceptedTermsVersion: acceptedTermsOrderId === order.id ? order.purchaseTerms?.version : undefined,
        ...token,
      });
      setOrder(next);
      if (next.status !== "charging") pendingToken.current = null;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The payment result is unavailable.",
      );
      // Status must be checked before another card can be used on this order.
      setChecking(true);
    }
  }

  async function refresh() {
    if (!order) return;
    setBusy(true);
    setError(undefined);
    try {
      setOrder(await requestCourseOrder(undefined, order.id));
      setChecking(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Payment status cannot be checked yet.",
      );
    } finally {
      setBusy(false);
    }
  }

  const quoteForm =
    salesOpen &&
    (!order ||
      order.status === "failed" ||
      (order.status === "quoted" && !billing));

  useEffect(() => {
    if (!focusAfterBillingChange.current) return;
    focusAfterBillingChange.current = false;
    (quoteForm ? billingHeading : summaryHeading).current?.focus();
  }, [quoteForm]);

  return (
    <section className="mx-auto max-w-2xl space-y-6 px-6 py-14">
      <h1 className="font-heading text-4xl">{title} checkout</h1>
      {error && <p role="alert">{error}</p>}
      {order?.status === "failed" && (
        <p role="status">
          The payment was declined. Recalculate the total to try again.
        </p>
      )}
      {quoteForm && (
        <form method="post" onSubmit={quote} className="space-y-4">
          <h2 ref={billingHeading} tabIndex={-1} className="font-heading text-2xl">
            Billing address
          </h2>
          <fieldset
            disabled={busy || !hydrated}
            className="grid gap-4 sm:grid-cols-2"
          >
            {[
              ["name", "Full name", "name", prefilledName],
              ["line1", "Street address", "address-line1", ""],
              ["city", "City", "address-level2", ""],
              ["region", "Province or state code", "address-level1", ""],
              ["postalCode", "Postal code", "postal-code", ""],
              ["country", "Country code", "country", ""],
            ].map(([name, label, autocomplete, initial]) => (
              <label key={name} className="grid gap-1">
                <span>{label}</span>
                <input
                  required
                  name={name}
                  defaultValue={initial}
                  autoComplete={autocomplete}
                  className="rounded-md border px-3 py-2"
                />
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={busy || !hydrated}>
            Calculate total
          </Button>
        </form>
      )}
      {order && order.status !== "failed" && (
        <div className="space-y-4 rounded-md border p-5">
          <h2 ref={summaryHeading} tabIndex={-1} className="font-heading text-2xl">
            Order summary
          </h2>
          <dl className="space-y-2">
            <div className="flex justify-between">
              <dt>Course</dt>
              <dd>{money(order.priceCents)}</dd>
            </div>
            {order.taxComponents?.length ? (
              order.taxComponents.map(({ taxCode, label, amount }) => (
                <div key={taxCode} className="flex justify-between">
                  <dt>{label}</dt>
                  <dd>{money(amount)}</dd>
                </div>
              ))
            ) : (
              <div className="flex justify-between">
                <dt>{order.taxBehavior === "inclusive" ? "Tax included" : "Tax"}</dt>
                <dd>{money(order.taxCents)}</dd>
              </div>
            )}
            <div className="flex justify-between font-semibold">
              <dt>Total</dt>
              <dd>{money(order.totalCents)}</dd>
            </div>
            {order.refundedCents > 0 && (
              <div className="flex justify-between">
                <dt>Refunded</dt>
                <dd>{money(order.refundedCents)}</dd>
              </div>
            )}
          </dl>
          <p className="break-all text-sm">Order reference: {order.id}</p>
          <p>{order.disclosure}</p>
          {salesOpen && order.status === "quoted" && billing && !checking && (
            <>
              {order.purchaseTerms && (
                <section aria-labelledby="course-purchase-terms" className="space-y-3">
                  <dl>
                    <dt className="font-medium">Billing details</dt>
                    <dd>{billing.name}</dd>
                    <dd>{billing.line1}</dd>
                    <dd>{billing.city}, {billing.region} {billing.postalCode}, {billing.country}</dd>
                    <dd>{email}</dd>
                  </dl>
                  <h3 id="course-purchase-terms" className="font-heading text-xl">Course Purchase Terms</h3>
                  {order.seller && (
                    <p>
                      {order.seller.name} · {order.seller.address} · {order.seller.email}
                      {order.seller.phone ? ` · ${order.seller.phone}` : ""}
                    </p>
                  )}
                  <p className="whitespace-pre-line">{order.purchaseTerms.text}</p>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      aria-required="true"
                      className="mt-1"
                      checked={acceptedTermsOrderId === order.id}
                      disabled={busy}
                      onChange={(event) => setAcceptedTermsOrderId(event.target.checked ? order.id : undefined)}
                    />
                    I agree to the Course Purchase Terms.
                  </label>
                </section>
              )}
              <SquareCommerceCardForm
                key={order.id}
                configUrl={`${path}?config=square`}
                ref={card}
                buyer={{
                  fullName: billing.name,
                  email,
                  amountCents: order.totalCents,
                  ...billing,
                }}
                disabled={false}
                onError={showError}
                onReadyChange={setReady}
                onTokenized={charge}
              />
              <Button
                type="button"
                disabled={busy || !ready || Boolean(order.purchaseTerms && acceptedTermsOrderId !== order.id)}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    if (pendingToken.current)
                      await charge(pendingToken.current);
                    else await card.current?.tokenize();
                  } catch {
                    setError(
                      "The card could not be prepared. Check the payment details.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Pay {money(order.totalCents)}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  pendingToken.current = null;
                  focusAfterBillingChange.current = true;
                  setBilling(undefined);
                  setReady(false);
                }}
              >
                Edit billing address
              </Button>
            </>
          )}
          {order.status === "charging" && (
            <p role="status">Payment is awaiting confirmation.</p>
          )}
          {order.status === "paid" && order.access !== "active" && (
            <p role="status">
              {order.access === "revoked"
                ? "Course access has been removed."
                : order.access === "revocation_pending"
                  ? "Course access removal is pending."
                  : "Payment received. Course access is being prepared."}
            </p>
          )}
          {order.status === "paid" && order.access === "active" && (
            <Button asChild>
              <Link href={academyCourseHref(order.courseId)}>
                Open course in Academy
              </Link>
            </Button>
          )}
          {order.status === "refunded" && (
            <p role="status">
              {order.access === "revocation_pending"
                ? "Refund confirmed. Access removal is pending."
                : "This purchase was refunded."}
            </p>
          )}
          {(checking ||
            order.status === "charging" ||
            order.status === "paid" ||
            order.status === "refunded") && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !hydrated}
              onClick={refresh}
            >
              Check order status
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
