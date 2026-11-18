import { client } from "@/sanity/lib/client";
import { getSanityApiReadToken } from "@/sanity/env";
import { defineEnableDraftMode } from "next-sanity/draft-mode";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { GET: enableDraftMode } = defineEnableDraftMode({
    client: client.withConfig({ token: getSanityApiReadToken() }),
  });
  return enableDraftMode(request);
}
