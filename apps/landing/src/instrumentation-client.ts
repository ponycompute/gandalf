import posthog from "posthog-js";

/** The project's public key: it only writes events, so it can ship in the page. */
const POSTHOG_KEY = "phc_tKu42GQid4MY4AhEg9dMccgjvvYBZ4eTPYMz957UThDt";

if (process.env.NODE_ENV === "production") {
  posthog.init(POSTHOG_KEY, {
    // Events go through our own /ingest (see next.config.ts) so ad blockers don't drop them.
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2025-11-30",
  });
}
