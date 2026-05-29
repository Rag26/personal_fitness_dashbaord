import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The dashboard was consolidated from 8 pages to 4 (Today / Train / Nutrition
   * / Progress). Redirect the retired routes so old bookmarks and inbound links
   * keep working.
   */
  async redirects() {
    return [
      { source: "/overview", destination: "/today", permanent: true },
      { source: "/recovery", destination: "/today", permanent: true },
      { source: "/running", destination: "/train", permanent: true },
      { source: "/lifting", destination: "/train", permanent: true },
      { source: "/insights", destination: "/progress", permanent: true },
      { source: "/journey", destination: "/progress", permanent: true },
    ];
  },
};

export default nextConfig;
