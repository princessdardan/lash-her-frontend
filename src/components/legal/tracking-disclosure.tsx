export function TrackingDisclosure() {
  return (
    <section
      aria-label="Website tracking preferences"
      className="mt-8 border-t border-lh-line pt-6 font-body text-sm font-bold leading-6 text-lh-shadow/80"
    >
      <h2 className="font-heading text-xl font-normal text-lh-shadow">
        Website tracking preferences
      </h2>
      <p className="mt-3">
        Required storage supports your cart, checkout, course access and
        progress, and privacy preferences. Optional website analytics loads only
        with analytics permission.
      </p>
      <p className="mt-3">
        CRM/marketing tracking is a separate optional choice for linking
        public-page browsing and campaign attribution with a HighLevel contact.
        HighLevel website tracking is currently disabled: no HighLevel tracking
        script, browsing events, or browser identifiers are created by this
        site.
      </p>
      <p className="mt-3">
        Use Manage cookie preferences at the bottom of the page to change either
        choice. These choices do not subscribe you to, or unsubscribe you from,
        marketing emails or text messages. Forms, purchases, and course access
        continue through the website’s existing services regardless of tracking
        choices.
      </p>
    </section>
  );
}
