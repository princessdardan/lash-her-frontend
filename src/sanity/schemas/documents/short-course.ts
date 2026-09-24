import {
  defineArrayMember,
  defineField,
  defineType,
  type ValidationContext,
} from "sanity";

export async function validateCourseMuxVideo(
  value: unknown,
  context: ValidationContext,
): Promise<true | string> {
  const reference = (value as { asset?: { _ref?: string } } | undefined)?.asset
    ?._ref;
  if (!reference) return "Upload or select a Mux video.";
  const asset = await context.getClient({ apiVersion: "2026-03-24" }).fetch<{
    status?: string;
    playbackId?: string;
  } | null>(`*[_id == $id && _type == "mux.videoAsset"][0]{status, "playbackId": data.playback_ids[policy == "public"][0].id}`, { id: reference });
  if (!asset) return "Select an existing Mux video.";
  if (asset.status !== "ready")
    return "Wait for Mux to finish processing the video, or replace it if processing failed.";
  return asset.playbackId
    ? true
    : "This course needs a public Mux playback ID. Signed and DRM-only videos are not supported.";
}

export function validateCourseOptions(value: unknown): true | string {
  if (!Array.isArray(value) || value.length < 2)
    return "Add at least two answers.";
  const options = value as Array<{ isCorrect?: boolean }>;
  return options.filter((option) => option.isCorrect === true).length === 1
    ? true
    : "Mark exactly one answer as correct.";
}

export const shortCourse = defineType({
  name: "shortCourse",
  title: "Short Course",
  type: "document",
  fields: [
    defineField({
      name: "title",
      type: "string",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "slug",
      type: "slug",
      options: { source: "title" },
      validation: (rule) =>
        rule
          .required()
          .custom((value) =>
            !value?.current || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.current)
              ? true
              : "Use lowercase letters, numbers, and single hyphens.",
          ),
    }),
    defineField({
      name: "introduction",
      type: "text",
      rows: 4,
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "coverImage",
      title: "Cover image",
      type: "image",
      options: { hotspot: true },
      fields: [
        defineField({ name: "alt", type: "string", title: "Alternative text" }),
      ],
    }),
    defineField({
      name: "modules",
      type: "array",
      validation: (rule) => rule.required().min(1).max(30),
      description:
        "Drag to reorder. Edit existing modules to preserve their saved progress identifiers.",
      of: [
        defineArrayMember({
          name: "courseModule",
          title: "Module",
          type: "object",
          fields: [
            defineField({
              name: "title",
              type: "string",
              validation: (rule) => rule.required(),
            }),
            defineField({
              name: "lesson",
              title: "Lesson text",
              type: "array",
              validation: (rule) => rule.required().min(1),
              of: [
                defineArrayMember({
                  type: "block",
                  marks: {
                    decorators: [
                      { title: "Strong", value: "strong" },
                      { title: "Emphasis", value: "em" },
                    ],
                    annotations: [],
                  },
                }),
              ],
            }),
            defineField({
              name: "muxVideo",
              title: "Video (Mux)",
              type: "mux.video",
              description:
                "Upload or select a Mux video with public playback. Wait for processing to finish before publishing. This replaces the legacy Sanity video when selected.",
              validation: (rule) =>
                rule.required().custom(validateCourseMuxVideo),
            }),
            defineField({
              name: "video",
              title: "Legacy video (Sanity)",
              type: "file",
              readOnly: true,
              hidden: ({ value }) => !value?.asset,
              description:
                "Retained for existing published lessons. Import this file's URL into Video (Mux), then publish. New uploads use Mux.",
            }),
            defineField({
              name: "poster",
              type: "image",
              title: "Video poster",
            }),
            defineField({
              name: "captions",
              type: "file",
              title: "English captions (WebVTT)",
              options: { accept: ".vtt,text/vtt" },
              validation: (rule) =>
                rule.custom((value) =>
                  !value?.asset || value.asset._ref?.endsWith("-vtt")
                    ? true
                    : "Upload a .vtt captions file.",
                ),
            }),
            defineField({ name: "transcript", type: "text", rows: 8 }),
            defineField({
              name: "quiz",
              type: "array",
              validation: (rule) => rule.required().min(1).max(10),
              of: [
                defineArrayMember({
                  name: "courseQuestion",
                  title: "Question",
                  type: "object",
                  fields: [
                    defineField({
                      name: "prompt",
                      type: "string",
                      validation: (rule) => rule.required(),
                    }),
                    defineField({
                      name: "options",
                      type: "array",
                      validation: (rule) =>
                        rule.required().max(6).custom(validateCourseOptions),
                      of: [
                        defineArrayMember({
                          name: "courseAnswer",
                          title: "Answer",
                          type: "object",
                          fields: [
                            defineField({
                              name: "text",
                              type: "string",
                              validation: (rule) => rule.required(),
                            }),
                            defineField({
                              name: "isCorrect",
                              title: "Correct answer",
                              type: "boolean",
                              initialValue: false,
                            }),
                          ],
                          preview: {
                            select: { title: "text", correct: "isCorrect" },
                            prepare: ({ title, correct }) => ({
                              title,
                              subtitle: correct ? "Correct answer" : "",
                            }),
                          },
                        }),
                      ],
                    }),
                    defineField({
                      name: "explanation",
                      type: "text",
                      rows: 3,
                      validation: (rule) => rule.required(),
                    }),
                  ],
                  preview: { select: { title: "prompt" } },
                }),
              ],
            }),
          ],
          preview: { select: { title: "title", media: "poster" } },
        }),
      ],
    }),
    defineField({
      name: "seo",
      title: "SEO",
      type: "object",
      fields: [
        defineField({ name: "title", type: "string" }),
        defineField({ name: "description", type: "text", rows: 3 }),
        defineField({
          name: "noIndex",
          title: "Hide from search engines",
          type: "boolean",
          initialValue: false,
        }),
      ],
    }),
  ],
  preview: { select: { title: "title", media: "coverImage" } },
});
