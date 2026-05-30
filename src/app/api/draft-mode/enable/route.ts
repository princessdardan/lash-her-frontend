import { client } from "@/sanity/lib/client";
import { getSanityApiReadToken } from "@/sanity/env";
import { defineEnableDraftMode } from "next-sanity/draft-mode";

export const { GET } = defineEnableDraftMode({
  client: client.withConfig({ token: getSanityApiReadToken() }),
});
