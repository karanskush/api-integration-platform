import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@readme/openapi-parser', 'undici'],
};

export default nextConfig;
