import type { MetadataRoute } from "next";
import { SITE_URL } from "@/data/links";

/** One page today. Add an entry here for each new route so search engines find it. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
  ];
}
