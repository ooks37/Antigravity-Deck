import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === 'development';
const BE_PORT = process.env.BACKEND_PORT || '3500';
const BE_HOST = `http://localhost:${BE_PORT}`;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Production builds emit static files into `frontend/out` hosted directly by Express,
  // eliminating the standalone `next-server` process and saving ~180 MB RAM.
  ...(isDev
    ? {
        experimental: {
          proxyTimeout: 60_000,
        },
        httpAgentOptions: {
          keepAlive: true,
        },
        async rewrites() {
          return [
            {
              source: '/api/:path*',
              destination: `${BE_HOST}/api/:path*`,
            },
          ];
        },
      }
    : {
        output: 'export',
        images: {
          unoptimized: true,
        },
      }),
};

export default nextConfig;
