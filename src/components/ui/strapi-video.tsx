import { getStrapiURL } from "@/lib/utils";

interface IStrapiVideoProps {
    src: string;
    ariaLabel?: string | null;
    height?: number;
    width?: number;
    className?: string;
    controls?: boolean;
    autoPlay?: boolean;
    loop?: boolean;
    muted?: boolean;
    poster?: string;
    preload?: "none" | "metadata" | "auto";
    playsInline?: boolean;
}

export function getStrapiVideo(url: string | null) {
  const strapiURL = getStrapiURL();
  if (url == null) return null;
  if (url.startsWith("data:")) return url;
  if (url.startsWith("http") || url.startsWith("//")) return url;
  return `${strapiURL}${url}`;
}

export function StrapiVideo({
    src,
    ariaLabel,
    height,
    width,
    className,
    controls,
    autoPlay,
    loop,
    muted,
    poster,
    preload,
    playsInline,
}: Readonly<IStrapiVideoProps>) {
    const videoUrl = getStrapiVideo(src);
    if (!videoUrl) return null;
    return (
        <video
            src={videoUrl}
            aria-label={ariaLabel ?? "Video content"}
            height={height}
            width={width}
            className={className}
            controls={controls}
            autoPlay={autoPlay}
            loop={loop}
            muted={muted}
            poster={poster}
            preload={preload}
            playsInline={playsInline}
        />
    );
}