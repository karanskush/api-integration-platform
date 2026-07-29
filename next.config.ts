import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@readme/openapi-parser', 'undici'],
  // The floating dev indicator sits bottom-left, which is where the landing
  // page's own content is. It never ships to production; this just stops it
  // covering the thing you are trying to look at while developing.
  devIndicators: false,
};

export default nextConfig;
