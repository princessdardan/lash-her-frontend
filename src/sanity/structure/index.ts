import type { StructureResolver } from "sanity/structure";

export const structure: StructureResolver = (S) =>
  S.list()
    .title("Lash Her")
    .items([
      // ---- PAGES ----
      S.listItem()
        .title("Pages")
        .child(
          S.list()
            .title("Pages")
            .items([
              S.listItem()
                .title("Homepage")
                .id("homePage")
                .child(S.document().schemaType("homePage").documentId("homePage")),
              S.listItem()
                .title("Contact Page")
                .id("contactPage")
                .child(S.document().schemaType("contactPage").documentId("contactPage")),
              S.listItem()
                .title("Gallery")
                .id("galleryPage")
                .child(S.document().schemaType("galleryPage").documentId("galleryPage")),
              S.listItem()
                .title("Training")
                .id("trainingPage")
                .child(S.document().schemaType("trainingPage").documentId("trainingPage")),
              S.listItem()
                .title("Training Programs Overview")
                .id("trainingProgramsPage")
                .child(
                  S.document().schemaType("trainingProgramsPage").documentId("trainingProgramsPage")
                ),
              S.listItem()
                .title("Global Settings")
                .id("globalSettings")
                .child(S.document().schemaType("globalSettings").documentId("globalSettings")),
              S.listItem()
                .title("Navigation Menu")
                .id("mainMenu")
                .child(S.document().schemaType("mainMenu").documentId("mainMenu")),
            ])
        ),
      S.divider(),
      // ---- CONTENT ----
      S.listItem()
        .title("Content")
        .child(
          S.list()
            .title("Content")
            .items([
              S.documentTypeListItem("trainingProgram").title("Training Programs"),
            ])
        ),
      S.divider(),
      // ---- SUBMISSIONS ----
      S.listItem()
        .title("Submissions")
        .child(
          S.list()
            .title("Submissions")
            .items([
              S.documentTypeListItem("generalInquiry").title("General Inquiries"),
              S.documentTypeListItem("contactForm").title("Training Contact Forms"),
            ])
        ),
    ]);
