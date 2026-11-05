import Image from "next/image";
import { safeLearningUrl } from "@/lib/learning/presentation";

export function CourseCover({ cover, title }: { cover: { url: string; alt: string } | null; title: string }) {
  const src = safeLearningUrl(cover?.url);
  return src ? <Image src={src} alt={cover?.alt || title} width={960} height={540} unoptimized className="aspect-video w-full object-cover" />
    : <div aria-hidden="true" className="flex aspect-video items-end bg-lh-primary/10 p-6"><span className="font-heading text-4xl text-lh-primary">LASH HER<br />Academy</span></div>;
}
