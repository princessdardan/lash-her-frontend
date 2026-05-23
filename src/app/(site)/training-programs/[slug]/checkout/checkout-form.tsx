"use client";

import { useState } from "react";
import { TrainingHelcimPayButton } from "@/components/commerce/training-helcim-pay-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CheckoutFormProps {
  programSlug: string;
  clientPrice: number;
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
}

export function CheckoutForm({
  programSlug,
  clientPrice,
  subtotal,
  tax,
  total,
  currency,
}: CheckoutFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const isValid = name.trim().length > 0 && email.includes("@") && acknowledged;

  return (
    <div className="space-y-8">
      <div className="border-t border-b border-lh-neutral/20 py-6">
        <div className="space-y-3 mb-4">
          <div className="flex justify-between items-center text-lh-shadow/80">
            <span>Subtotal</span>
            <span>${subtotal.toFixed(2)} {currency}</span>
          </div>
          <div className="flex justify-between items-center text-lh-shadow/80">
            <span>Ontario HST (13%)</span>
            <span>${tax.toFixed(2)} {currency}</span>
          </div>
          <div className="flex justify-between items-center font-medium text-lg pt-3 border-t border-lh-neutral/10">
            <span>Total</span>
            <span>${total.toFixed(2)} {currency}</span>
          </div>
        </div>
        <p className="text-sm text-lh-shadow/70 text-right">Taxes calculated at checkout</p>
      </div>

      <div className="space-y-4">
        <h3 className="section-subheading text-lg md:text-lg lg:text-lg">Your Details</h3>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Full Name</Label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              required
              className="bg-white"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email Address</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              required
              className="bg-white"
            />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="section-subheading text-lg md:text-lg lg:text-lg">What happens next?</h3>
        <ul className="space-y-3 text-lh-shadow/80">
          <li className="flex items-start gap-3">
            <span className="text-lh-shadow mt-1">•</span>
            <span>Complete your secure payment.</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-lh-shadow mt-1">•</span>
            <span>Receive an email with a 14-day link to schedule your training call.</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-lh-shadow mt-1">•</span>
            <span>Any training dates or program details after that call are coordinated manually.</span>
          </li>
        </ul>
      </div>

      <div className="space-y-6">
        <div className="flex items-start space-x-3">
          <input
            type="checkbox"
            id="terms"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-lh-neutral/30 text-brand-red focus:ring-brand-red"
          />
          <div className="grid gap-1.5 leading-none">
            <Label
              htmlFor="terms"
              className="text-sm font-medium leading-snug peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              I acknowledge the terms
            </Label>
            <p className="text-sm text-lh-shadow/70">
              I understand that this payment is non-refundable and secures my enrollment in the training program.
            </p>
          </div>
        </div>

        <TrainingHelcimPayButton
          disabled={!isValid}
          programSlug={programSlug}
          clientPrice={clientPrice}
          customer={{ name, email }}
          onPaid={() => {}}
        />
      </div>
    </div>
  );
}
