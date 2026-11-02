# Landing pages

After the application and Studio schema are deployed, open **Studio → Pages → Landing Pages**. Create a **Landing Page**, or choose **Founding Membership Landing Page** from the create menu for prefilled salon-opening copy.

1. Set the page title, headline, introduction, and URL slug. For example, `founding-membership` publishes at `/founding-membership`. Slugs must be unique among landing pages; existing website sections are reserved.
2. Optionally add an image, additional details, and search/sharing settings.
3. In **Email Signup**, edit the form heading, description, button label, and confirmation message. Select the privacy policy to display its link below the form.
4. Preview, then publish. Share the full URL; creating a landing page does not add it to site navigation. Add a link through **Navigation Menu** if needed.

The page collects email interest with an explicit, initially unchecked consent checkbox. It does not charge for or activate a membership. The standard site signup popup is suppressed on published landing-page URLs. The landing form works independently of that popup's enabled state and does not issue its discount offer.

Signups use the existing private marketing-contact pipeline. Each submission stores the canonical source path, the landing page's stable document ID and title in `payload.landingPage`, and permitted UTM attribution. Multiple people can sign up for the same page. Contacts are deduplicated by normalized email; individual submissions and consent events remain auditable. The existing `contact_popup` source/submission type is retained for compatibility with marketing sync and retention. No new database migration is needed. Welcome email delivery follows the configured marketing provider; this template does not create a separate campaign email sequence.

Changing the slug changes the public URL. Old links do not redirect automatically. Update campaign links after a rename. Unpublishing or deleting the document removes the page after revalidation; the server accepts signups only against published content.

The Sanity revalidation webhook must include `landingPage` publish/update/delete events. The handler invalidates the `landingPage` cache tag for both page content and the list used to suppress the global popup. The route also retains a 30-minute revalidation interval.

Validation:

```sh
env NEXT_PUBLIC_SANITY_DATASET=test NEXT_PUBLIC_SANITY_PROJECT_ID=test-project node --import ./scripts/register-server-only-test.mjs --import tsx --test src/lib/landing-pages/*.test.ts
npx playwright test --config tests/landing-pages.playwright.config.ts
```

The browser suite renders the actual page/form components with a mocked action transport. Service tests cover server-side validation and private persistence inputs. These checks do not prove live Sanity publication, database connectivity, or provider delivery; verify those in the target environment after deployment.
