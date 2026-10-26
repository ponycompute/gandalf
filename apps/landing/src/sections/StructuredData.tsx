import { GITHUB_URL, SITE_URL } from "@/data/links";
import { SITE_DESCRIPTION, SITE_NAME } from "@/data/site";
import { QUESTIONS } from "./Faq";

/* Schema.org JSON-LD: who makes the page, what the product is, and the FAQ as it reads on the page. */
const GRAPH = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#app`,
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      description: SITE_DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS 26 or later",
      image: `${SITE_URL}/opengraph-image`,
      sameAs: [GITHUB_URL],
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: QUESTIONS.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
};

export function StructuredData() {
  return (
    <script
      type="application/ld+json"
      // Escape "<" so no string in the data can close the script tag.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(GRAPH).replace(/</g, "\\u003c") }}
    />
  );
}
