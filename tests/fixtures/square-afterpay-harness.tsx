import { useState } from "react";
import { createRoot } from "react-dom/client";

import { SquareProductPayButton } from "@/components/commerce/square-product-pay-button";
import { CheckoutForm } from "@/app/(site)/training-programs/[slug]/checkout/checkout-form";
import { ServiceBookingPaymentForm } from "@/components/booking/service-booking-payment-form";

function Harness() {
  const query = new URLSearchParams(location.search);
  const kind = query.get("kind");
  const [amount, setAmount] = useState(Number(query.get("amount") ?? "17515"));
  if (kind === "training")
    return (
      <CheckoutForm
        programSlug="classic-lashes"
        clientPrice={155}
        manualDiscount={0}
        subtotal={155}
        tax={20.15}
        total={amount / 100}
        currency="CAD"
      />
    );
  if (kind === "booking")
    return (
      <ServiceBookingPaymentForm
        marketingOptInLabel="Receive updates"
        onExpired={() => {
          document.body.dataset.expired = "true";
        }}
        onSessionUpdate={() => {}}
        onSuccess={() => {
          document.body.dataset.destination = "booking-confirmed";
        }}
        session={{
          currency: "CAD",
          expiresAt: "2030-10-01T10:00:00.000Z",
          paymentSessionReference: "session-1",
          marketingOptInLabel: "Receive updates",
          serviceSlug: "lashes",
          serviceTitle: "Lash service",
          timezone: "America/Toronto",
          selectedStart: "2030-10-02T10:00:00.000Z",
          selectedEnd: "2030-10-02T11:00:00.000Z",
          pricing: {
            fullPriceCents: 15500,
            addOnPriceCents: 0,
            depositAmountCents: 5000,
            customAmountMinimumCents: 5000,
            customAmountMaximumCents: 15500,
          },
        }}
      />
    );
  return (
    <>
      <label>
        Test total{" "}
        <input
          aria-label="Test total"
          value={amount}
          onChange={(event) => setAmount(Number(event.target.value))}
        />
      </label>
      <SquareProductPayButton
        amountCents={amount}
        items={[{ productId: "product-1", quantity: 1 }]}
        customer={{
          name: "Test Buyer",
          email: "buyer@example.test",
          phone: "4165550100",
        }}
        fulfillmentMode="manual_pickup"
        disclosures={{ termsAccepted: true, cancellationPolicyAccepted: true }}
        onPaid={() => {}}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
