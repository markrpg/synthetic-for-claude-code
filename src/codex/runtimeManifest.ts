export const CODEX_RUNTIME_VERSION = "0.146.0";

export interface CodexRuntimePackage {
  url: string;
  integrity: string;
  executable: string;
}

export const CODEX_RUNTIME_PACKAGES: Readonly<
  Record<string, CodexRuntimePackage>
> = {
  "darwin-arm64": {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0-darwin-arm64.tgz",
    integrity:
      "sha512-nb61yX4r5L6Z0dlC4o3u0GAK1YCd4TUvjaB382bajDoh84V+uv2hTBIVZ++fgXWV9yoeuNrNnNcn7GoTGOe2Tg==",
    executable: "vendor/aarch64-apple-darwin/bin/codex",
  },
  "darwin-x64": {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0-darwin-x64.tgz",
    integrity:
      "sha512-hTQR5jy/ObfTf1MDnuJCZJAe+SljKE8DDwQWN6lDFgjsPhMQz852U2tILt8Ei+G5GkQSzemHYKl2AYPwW0Y5xw==",
    executable: "vendor/x86_64-apple-darwin/bin/codex",
  },
  "linux-arm64": {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0-linux-arm64.tgz",
    integrity:
      "sha512-qiYDxkkEFnXG7joadJW6Q+XcgyDXCpGdpa9nk/c+i0gEomur1j7bHvx12NfWWCF/y8Tqri6ay+FLuC2MjdehtA==",
    executable: "vendor/aarch64-unknown-linux-musl/bin/codex",
  },
  "linux-x64": {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0-linux-x64.tgz",
    integrity:
      "sha512-fswvyGprAPCMiOEue/7MKMk7pCjh9kZIJfJX5i9atmfnmGYbYCcUhZsEH9LEP0+0t5xyPqDbfNXY7NSxIVuXxA==",
    executable: "vendor/x86_64-unknown-linux-musl/bin/codex",
  },
  "win32-arm64": {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0-win32-arm64.tgz",
    integrity:
      "sha512-EW6zdjDe+SLX2Iw+xymJ5+Pz2+DGexdstfFHXh4Ub+TfJsQPiMjGfZfNaoWgdJ2FsqSIzVKu2+G0KCMGYz2W8g==",
    executable: "vendor/aarch64-pc-windows-msvc/bin/codex.exe",
  },
  "win32-x64": {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.146.0-win32-x64.tgz",
    integrity:
      "sha512-b3lxMYeR0+IhstNo4JjX1P9cPc1xwVcCVkPd1lD1wpWPJ0SBhpIkPczwbu3ZRkJcdyl342+rgyf4DUrbZLdrGA==",
    executable: "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  },
};
