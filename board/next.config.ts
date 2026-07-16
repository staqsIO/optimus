import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // /board was renamed to /issues (Linear vocabulary: projects have issues).
  // Keep old links/bookmarks/deep-links working.
  async redirects() {
    return [
      { source: "/board", destination: "/issues", permanent: true },
    ];
  },
};

export default nextConfig;
