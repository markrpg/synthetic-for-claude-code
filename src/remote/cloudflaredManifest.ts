export const CLOUDFLARED_VERSION = "2026.7.3";

export interface CloudflaredPackage {
  url: string;
  sha256: string;
  format: "binary" | "tgz";
  executable: string;
}

const RELEASE_ROOT =
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

export const CLOUDFLARED_PACKAGES: Readonly<
  Record<string, CloudflaredPackage>
> = {
  "darwin-arm64": {
    url: `${RELEASE_ROOT}/cloudflared-darwin-arm64.tgz`,
    sha256:
      "90c5a4f914d705fd70c135dba6d80b1791d254b08d6d4136301941f88330dd09",
    format: "tgz",
    executable: "cloudflared",
  },
  "darwin-x64": {
    url: `${RELEASE_ROOT}/cloudflared-darwin-amd64.tgz`,
    sha256:
      "70d1c8684fa6d14b5843787ec8d1ea8e18b23650e424f4ea43d849a506487c3b",
    format: "tgz",
    executable: "cloudflared",
  },
  "linux-arm64": {
    url: `${RELEASE_ROOT}/cloudflared-linux-arm64`,
    sha256:
      "65259e652a7bea08bf5df603233ab22b8bf3116af8df9f9206209af6a1b955c0",
    format: "binary",
    executable: "cloudflared",
  },
  "linux-x64": {
    url: `${RELEASE_ROOT}/cloudflared-linux-amd64`,
    sha256:
      "9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17",
    format: "binary",
    executable: "cloudflared",
  },
  "win32-x64": {
    url: `${RELEASE_ROOT}/cloudflared-windows-amd64.exe`,
    sha256:
      "8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841",
    format: "binary",
    executable: "cloudflared.exe",
  },
};

export function cloudflaredPlatformKey(
  platform = process.platform,
  architecture = process.arch,
): string {
  return `${platform}-${architecture}`;
}
