
const nextConfig = {
  reactStrictMode: true,
  
  
  experimental: {
    instrumentationHook: true,
    serverActions: {
      bodySizeLimit: '5mb',
    },
  },
};

module.exports = nextConfig;
