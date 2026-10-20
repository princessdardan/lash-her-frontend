# HighLevel workflow drafts — review required

These are copy specifications for the six native drafts configured in **Lash Her
By Nataliea → LH Website — Drafts**. Actual IDs and per-draft setup status are in the
[manifest](./highlevel-setup-manifest.json); native configuration evidence is in the
[account audit](./highlevel-account-audit-2026-10-20.md). The user supplied browser
access; the developer MCP itself remains read-only. All drafts remain unpublished
and unapproved until the shared gate and designated-contact tests pass.

Use the fields and names in [the setup manifest](./highlevel-setup-manifest.json).
Insert merge fields using HighLevel's picker; the `{field}` references below are
editorial placeholders. The native condition picker exposes `{{contact.email}}`
and `{{contact.phone_raw}}` for exact-destination comparisons. Their runtime behavior,
including phone normalization, must still be verified with designated test contacts.
Use the current production website origin from the site settings for relative links.

## Shared gate and stop conditions

All marketing, including manually composed campaigns, must pass one contact-level
gate. Configure a rolling seven-day maximum of two emails and one SMS. Welcome and
offer messages count. Transactional Resend messages do not use this marketing budget.
Keep time windows, sender registration, geographic eligibility, monitored reply
destinations, and staff assignment in HighLevel.

Before every send:

1. Check that marketing is enabled in the native account settings, the contact is
   in the selected journey, and no competing marketing journey can send concurrently.
2. Check that the channel's website eligibility field is `yes`, the eligibility
   destination matches the contact's current email/phone, and both global and channel
   DND permit sending. Treat an empty field as ineligible. Never derive SMS permission
   from a phone number, email permission, purchase, or a cleared DND flag.
3. Check the shared rolling send history. If the budget is exhausted, defer until
   the next eligible instant inside the sending window, then recheck all conditions.
   Count a provider-accepted message once using its stable journey/effect identity.
   A retry or timeout must not reserve another send or produce another message.
4. Recheck replies, conversion, withdrawal, refunds/cancellation, staff takeover,
   and changed contact destinations immediately before sending. A reply or takeover
   exits sales nurture and hands the conversation to the assigned person.

Each draft normally completes within fourteen days. The application prevents new
simultaneous admissions within that period, but **that is not the aggregate sending
gate**: conversion can replace a journey, staff campaigns also consume budget, and
native deferred sends may extend duration. Build and test the shared gate across all
of those paths. If this account cannot implement a reliable shared counter/dispatcher,
leave `HIGHLEVEL_WORKFLOWS_REVIEWED=false` and marketing disabled. Do not substitute
per-workflow delays or per-workflow send limits for the contact-wide budget.

No contact-created, imported, tag-added, or pipeline-stage trigger should send these
messages. Use explicit API admission for website journeys. Historical imports have
no marketing admission. Reactivation requires deliberate reviewed admission.

## Welcome / approved offer

Entry: new popup signup admitted by the application. Email and SMS are independent.
If the contact has no permission for a channel, skip that channel's action.

| Timing               | Channel       | Draft                                                                                                                                                                                                                                                                |
| -------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 0                | Email         | **Subject:** Welcome to Lash Her. **Body:** Thank you for joining Lash Her by Nataliea. We’ll share lash care, studio updates, and selected offers. Explore our current products and training at the links below. **CTA:** Explore products → `/products`.           |
| Day 0, offer variant | Email         | **Subject:** Your Lash Her welcome offer. **Body:** Thank you for joining us. Your offer is **{offer_label}**. Use **{offer_code}** at checkout. **Terms:** {offer_terms}. **CTA:** Use your offer → {offer_url}. Replace the generic Day 0 email; do not send both. |
| Day 4                | Email         | **Subject:** Make room for your lash care routine. **Body:** Explore Lash Her’s lash care products and free course resources. You can return to your course whenever you’re ready. **CTAs:** Explore products → `/products`; Explore courses → `/courses`.           |
| Day 7                | SMS, optional | Lash Her by Nataliea: Explore our current lash care products and learning resources at {website}/products. Reply STOP to unsubscribe.                                                                                                                                |

Only use the snapshotted, approved offer fields. Do not invent a percentage, expiry,
shipping promise, or new code. Confirm the promotion is still valid when activating
or releasing a previously paused offer. A highlevel-owned row marked handed off by
its `workflow:` reference still needs delivery verification in HighLevel.

## General inquiry

Entry: a live general inquiry; Marketing Pipeline → New Lead. Create the staff task
regardless of marketing consent. Resend continues the inquiry acknowledgement.

| Timing | Channel       | Draft                                                                                                                                                                                                          |
| ------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 2  | Email         | **Subject:** Following up on your Lash Her inquiry. **Body:** If you have another question, reply here and our team can help. You can also explore our current services. **CTA:** View services → `/services`. |
| Day 4  | SMS, optional | Lash Her by Nataliea: Still have a question about our services? Reply here and our team can help. Reply STOP to unsubscribe.                                                                                   |
| Day 6  | Email         | **Subject:** When you’re ready. **Body:** You can review our services and current information on the website. Reply if you’d like help choosing your next step. **CTA:** View services → `/services`.          |

Do not describe a booking click as an appointment. Fresha confirmation or attendance
is unavailable to this application.

## In-person training inquiry

Entry: a live training inquiry; General In-Person Training → New Lead, grouped by
the exact program interest. Resend retains the inquiry acknowledgement.

| Timing | Channel       | Draft                                                                                                                                                                                                                                                                   |
| ------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 2  | Email         | **Subject:** Your Lash Her training questions. **Body:** Review our current training programs and reply with any questions about the program you’re considering. Our team can help you find the relevant information. **CTA:** Explore training → `/training-programs`. |
| Day 4  | SMS, optional | Lash Her by Nataliea: Have a question about training? Reply here, or review our current programs at {website}/training-programs. Reply STOP to unsubscribe.                                                                                                             |
| Day 6  | Email         | **Subject:** Explore your next training step. **Body:** Our website has current program details. If you’re deciding between options, reply and tell us what you’d like to learn. **CTA:** Explore training → `/training-programs`.                                      |

Use the current program destination when it has been verified. Do not add unsupported
claims about qualification, certification, availability, income, or guaranteed results.

## Course interest

Entry: free-course signup with optional marketing permission. No sales opportunity.
Course access must already be available independently of this journey.

| Timing | Channel       | Draft                                                                                                                                                                                                                                        |
| ------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 2  | Email         | **Subject:** Continue learning with Lash Her. **Body:** Visit your course when you’re ready to continue. You can explore our other available learning resources from the course page. **CTA:** Explore courses → `/courses`.                 |
| Day 6  | Email         | **Subject:** Interested in hands-on training? **Body:** If you’d like to explore in-person learning, our current training programs are available on the website. Reply with any questions. **CTA:** Explore training → `/training-programs`. |
| Day 9  | SMS, optional | Lash Her by Nataliea: Explore our current learning resources at {website}/courses. Reply STOP to unsubscribe.                                                                                                                                |

Do not resend access credentials or imply marketing is required to keep access.

## Post-purchase

Entry: paid training enrollment or confirmed product dispatch/delivery. A payment
authorization, failed payment, or website booking click does not qualify. Stop sales
nurture before this admission; the shared budget retains earlier sends.

| Timing after qualifying event | Channel       | Draft                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Day 2                         | Email         | **Subject:** Thank you for choosing Lash Her. **Body:** We’re glad to be part of your lash care or learning routine. Explore our current educational resources when you’re ready. For a question about your purchase, reply here. **CTA:** Explore courses → `/courses`. |
| Day 6                         | Email         | **Subject:** More from Lash Her. **Body:** Browse our current products and learning opportunities, or reply if you would like help finding something. **CTA:** Product customer → `/products`; training customer → `/training-programs`.                                 |
| Day 9                         | SMS, optional | Lash Her by Nataliea: Questions about our products or training? Reply here and our team can help. Reply STOP to unsubscribe.                                                                                                                                             |

Exclude receipts, shipping updates, scheduling/access links, and mandatory care or
operational instructions already delivered by Resend. Stop on refund/cancellation.
Do not automatically request a service review without verified Fresha attendance.

## Reactivation

Entry: deliberate staff-reviewed admission after at least ninety days without an
observed qualifying website inquiry, signup, purchase, or enrollment change. Check
HighLevel conversation and staff activity before admission. Missing Fresha activity
means the website cannot prove service-customer dormancy. Backfill never enrolls it.

| Timing | Channel       | Draft                                                                                                                                                                                                                                        |
| ------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 0  | Email         | **Subject:** An update from Lash Her. **Body:** If you’re ready to revisit your lash care or learning plans, explore our current products and training. Reply if you have a question. **CTA:** Explore Lash Her → `/`.                       |
| Day 4  | Email         | **Subject:** Find your next step. **Body:** Our current services, products, and training information are available online. You can choose what fits your plans, and our team is available by reply. **CTA:** Explore services → `/services`. |
| Day 7  | SMS, optional | Lash Her by Nataliea: You can explore our current services and training at {website}. Reply STOP to unsubscribe.                                                                                                                             |

Use the existing Reactivation/ Win Back Pipeline only on this deliberate admission.
Do not create a discount unless an existing approved offer has been selected.

## Account-side review evidence

For every draft, record its actual workflow ID, reviewer, approved copy, sender,
reply owner, time-window settings, suppression behavior, and test-contact execution
logs. Test an overlapping inquiry → purchase transition near the weekly boundary,
manual campaign overlap, retry/lost acknowledgement, STOP during a wait, changed
phone/email, staff takeover, and backfill. Count actual accepted sends across all
journeys and campaigns. Enable marketing only after those results meet the policy.

Prioritize Conversations/staff tasks and source-to-sale reporting at launch. Review
requests and web chat follow once attendance/fulfillment evidence and inbox ownership
exist. Defer abandoned-checkout recovery until abandonment/stop detection is durable.
Keep replacement calendars, payments, courses, websites, and AI agents out of scope.
