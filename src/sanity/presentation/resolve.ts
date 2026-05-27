import { defineLocations, type PresentationPluginOptions } from "sanity/presentation";

function singletonLocation(title: string, href: string) {
  return defineLocations({
    select: { title: "title" },
    resolve: () => ({ locations: [{ title, href }] }),
  });
}

function routableDocumentLocation(indexTitle: string, indexHref: string, detailBasePath: string) {
  return defineLocations({
    select: { title: "title", slug: "slug.current" },
    resolve: (doc) => {
      const slug = typeof doc?.slug === "string" ? doc.slug : undefined;
      const title = typeof doc?.title === "string" && doc.title.length > 0 ? doc.title : indexTitle;
      const locations = [{ title: indexTitle, href: indexHref }];

      if (slug) {
        locations.unshift({
          title,
          href: `${detailBasePath}/${slug}`,
        });
      }

      return { locations };
    },
  });
}

export const resolve: PresentationPluginOptions["resolve"] = {
  locations: {
    homePage: singletonLocation("Home", "/"),
    contactPage: singletonLocation("Contact", "/contact"),
    galleryPage: singletonLocation("Gallery", "/gallery"),
    trainingPage: singletonLocation("Training programs", "/training-programs"),
    trainingProgramsPage: singletonLocation("Training programs", "/training-programs"),
    productsPage: singletonLocation("Products", "/products"),
    globalSettings: singletonLocation("Site settings", "/"),
    mainMenu: singletonLocation("Navigation", "/"),
    bookingSettings: singletonLocation("Booking", "/booking"),
    product: routableDocumentLocation("Products", "/products", "/products"),
    service: routableDocumentLocation("Services", "/services", "/services"),
    trainingProgram: routableDocumentLocation("Training programs", "/training-programs", "/training-programs"),
  },
};
