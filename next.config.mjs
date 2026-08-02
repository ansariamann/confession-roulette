import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig = {
  reactStrictMode: false,
  devIndicators: {
    buildActivity: false,
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
