import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig = {
  reactStrictMode: false,
  allowedDevOrigins: ["10.0.2.2", "10.111.207.247"],
  devIndicators: {
    buildActivity: false,
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
