import { permanentRedirect } from "next/navigation";
import { buildPageMetadata } from "@/lib/metadata";

// Revalidate every 30 minutes (1800 seconds)
export const revalidate = 1800;

export const metadata = buildPageMetadata({
  title: "Training Programs",
  description:
    "Professional lash training programs for beginners and advanced artists. Learn from expert lash artist Nataliea.",
});

export default function TrainingPage(): never {
  permanentRedirect("/training-programs");
}
