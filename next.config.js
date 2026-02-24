/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable the built-in image optimizer entirely.
  // We don't use next/image anywhere; this also neutralises
  // the remotePatterns DoS advisory (next <=15.5.9).
  images: { unoptimized: true },

  webpack: (config) => {
    config.externals = [...(config.externals || []), 'better-sqlite3'];
    return config;
  },
};

module.exports = nextConfig;
