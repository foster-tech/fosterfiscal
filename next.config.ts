import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["xmllint-wasm"],
  outputFileTracingIncludes: {
    "/api/dgii/ecf/prepare-test": [
      "./schemas/dgii/ecf-31-v1.0.xsd",
      "./node_modules/xmllint-wasm/xmllint-node.js",
      "./node_modules/xmllint-wasm/xmllint.wasm",
    ],
  },
};

export default nextConfig;
