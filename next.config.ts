import type { NextConfig } from "next";

// The release pipeline promotes one image digest between accounts, so the
// release identifier must never encode an account, domain, or region.
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

// A verification build must not overwrite the build serving a live walkthrough.
export default function nextConfig(): NextConfig {
  const config: NextConfig = {
    distDir: process.env.ONE_DOOR_BUILD_DIR || ".next",
  };
  const releaseId = process.env.RELEASE_ID;
  if (releaseId !== undefined && releaseId !== "") {
    if (!RELEASE_ID_PATTERN.test(releaseId)) {
      throw new Error(
        "RELEASE_ID must use only letters, digits, and hyphens, starting with a letter or digit",
      );
    }
    // deploymentId makes stale tabs hard-reload on a release mismatch; the
    // release-scoped asset prefix keeps every static file, including the
    // constant-build-id manifests, in a namespace retained releases never share.
    config.deploymentId = releaseId;
    config.assetPrefix = `/_assets/${releaseId}`;
  }
  return config;
}
