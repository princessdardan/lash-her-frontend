import qs from "qs";
import type { TStrapiResponse, THomePage, TGlobal, TMetaData, TTrainingPage, TContactPage, TGalleryPage, TTrainingProgram, TMainMenu } from "@/types";

import { api } from "@/data/data-api";
import { getStrapiURL } from "@/lib/utils";

const baseUrl = getStrapiURL();

async function getHomePageData(): Promise<TStrapiResponse<THomePage>> {
  const query = qs.stringify({
    populate: {
      blocks: {
        on: {
          "layout.hero-section": {
            populate: {
              image: {
                fields: ["url", "alternativeText"],
              },
              link: {
                populate: true,
              },
            },
          },
          "layout.features-section": {
            populate: {
              features: {
                populate: true,
              },
            },
          },
        },
      },
    },
  });

  const url = new URL("/api/home-page", baseUrl);
  url.search = query;
  return api.get<THomePage>(url.href);
}

async function getMainMenuData(): Promise<TStrapiResponse<TMainMenu>> {
  const query = qs.stringify({
  populate: {
    MainMenuItems: {
      on: {
        "menu.dropdown": {
          populate: {
            sections: {
              populate: {
                links: {
                  populate: true,
                },
              },
            },
          },
        },
        "menu.menu-link": {
          populate:true,
        },
      },
    },
  },
});

  const url = new URL("/api/main-menu", baseUrl);
  url.search = query;
  return api.get<TMainMenu>(url.href);
}

async function getGlobalData(): Promise<TStrapiResponse<TGlobal>> {
  const query = qs.stringify({
    populate: [
      "header.logoText",
      "header.ctaButton",
      "footer.logoText",
      "footer.socialLink",
    ],
  });

  const url = new URL("/api/global", baseUrl);
  url.search = query;
  return api.get<TGlobal>(url.href);
}

async function getContactPageData(): Promise<TStrapiResponse<TContactPage>> {
  const query = qs.stringify({
    populate: {
      blocks: {
        on: {
          "layout.schedule": {
            populate: {              
              hours: {
                populate: true,
              },
            },
          },
          "layout.contact-info": {
            populate: {
              contact:{
                populate: true,
              },
            },
          },
          "layout.general-inquiry-labels": {
            populate: true,
          },
        },
      },
    },
  });
  const url = new URL("/api/contact", baseUrl);
  url.search = query;
  return api.get<TContactPage>(url.href);
}

async function getGalleryPageData(): Promise<TStrapiResponse<TGalleryPage>> {
  const query = qs.stringify({
    populate: {
      blocks: {
        on: {
          "layout.hero-section": {
            populate: {
              image: {
                fields: ["url", "alternativeText"],
              },
              link: {
                populate: true,
              },
            },
          },
          "layout.photo-gallery": {
            populate: {
              image: {
                populate: true,
              },
            },
          },
        },
      },
    },
  });

  const url = new URL("/api/gallery", baseUrl);
  url.search = query;
  return api.get<TGalleryPage>(url.href);
}

async function getTrainingsPageData(): Promise<TStrapiResponse<TTrainingPage>> {
  const query = qs.stringify({
    populate: {
      blocks: {
        on: {
          "layout.cta-features-section": {
            populate: {
              features: {
                populate: {
                  link: {
                    populate: true,
                  },
                },
              },
            },
          },
          "layout.image-with-text": {
            populate: {
              image: {
                fields: ["url", "alternativeText"],
              },
            },
          },
        },
      },
    },
  });

  const url = new URL("/api/training", baseUrl);
  url.search = query;
  return api.get<TTrainingPage>(url.href);
}

async function getMetaData(): Promise<TStrapiResponse<TMetaData>> {
  const query = qs.stringify({
    fields: ["title", "description"],
  });

  const url = new URL("/api/global", baseUrl);
  url.search = query;
  return api.get<TMetaData>(url.href);
}

type TrainingProgramType = "beginner-private-training" | "advanced-private-training" | "lash-designer-academy";

async function getTrainingProgramData(programType: TrainingProgramType): Promise<TStrapiResponse<TTrainingProgram>> {
  const query = qs.stringify({
    populate: {
      blocks: {
        on: {
          "layout.hero-section": {
            populate: {
              image: {
                fields: ["url", "alternativeText"],
              },
              link: {
                populate: true,
              },
            },
          },
          "layout.info-section": {
            populate: true,
          },
          "layout.contact-form": {
            populate: true,
          },
        },
      },
    },
  });

  const url = new URL(`/api/${programType}`, baseUrl);
  url.search = query;
  return api.get<TTrainingProgram>(url.href);
}

export const loaders = {
  getHomePageData,
  getGlobalData,
  getMetaData,
  getMainMenuData,
  getTrainingsPageData,
  getContactPageData,
  getGalleryPageData,
  getTrainingProgramData,
};