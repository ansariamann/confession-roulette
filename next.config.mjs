const nextConfig = {
  reactStrictMode: false, // Disabled for testing speed
  devIndicators: {
    buildActivity: false,
  },
};

export default nextConfig;

import('@opennextjs/cloudflare').then(m => m.initOpenNextCloudflareForDev());
