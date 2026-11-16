/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@assessiq/shared'],
  // Static export: served from S3 + CloudFront (see infra/terraform/cdn.tf). Output goes to `out/`.
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
