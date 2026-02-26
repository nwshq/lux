/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ['better-sqlite3'],
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
};
