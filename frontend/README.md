This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Booking setup

The Google Calendar booking system requires these server-side environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `BOOKING_ADMIN_SETUP_SECRET`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `RESEND_API_KEY`
- `FROM_EMAIL`
- `SANITY_FORM_TOKEN`

Connect Nataliea's calendar by visiting `/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>` in production and approving Google Calendar access. The connected calendar is configured in the Sanity `bookingSettings` singleton.

Add a live-site entry point through the CMS menu or page CTAs with `/booking`, `/booking?type=training-call`, or `/booking?type=in-person-appointment` so visitors can reach the flow from the public site.

## Checkout setup

Checkout uses Sanity only for public catalog/editorial content. Sensitive checkout records must use private server-side storage; do not store transaction history, customer PII, checkout tokens, Helcim invoice or transaction identifiers, payment reconciliation records, or encrypted Helcim secret tokens in public Sanity datasets or expose them through Studio.

Required server-side checkout environment variables:

- `CHECKOUT_DATABASE_URL`
- `CHECKOUT_SECRET_ENCRYPTION_KEY`
- `HELCIM_API_TOKEN`

Required to receive Helcim webhooks:

- `HELCIM_WEBHOOK_VERIFIER_TOKEN`

See `../docs/private-checkout-storage-setup.md` for database setup, migration, retention, and Sanity cleanup guidance.
