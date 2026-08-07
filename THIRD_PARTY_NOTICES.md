# Third-party notices

ModelHop is MIT licensed. Its distributable bundle also includes third-party
components under their own terms:

- `@anthropic-ai/claude-agent-sdk` is provided by Anthropic and governed by
  Anthropic's Commercial Terms of Service and Privacy Policy. ModelHop uses it
  to continue a local Claude Code session; it does not relicense that package.
- `qrcode` is copyright Ryan Day and distributed under the MIT License.
- `markdown-it` is copyright 2014 Vitaly Puzrin and Alex Kocharin and
  distributed under the MIT License. ModelHop uses its parser locally and
  constructs an allowlisted DOM without enabling raw HTML.
- `vanta` 0.5.24 is copyright 2020 Teng Bao and distributed under the MIT
  License. ModelHop bundles only its WAVES background effect, renders the
  surface as a decorative wireframe, and disables pointer controls and
  external asset loading.
- `three` 0.134.0 is copyright 2010-2021 three.js authors and distributed
  under the MIT License. It is bundled locally as Vanta's WebGL renderer.
- `cloudflared` is copyright Cloudflare, Inc. and distributed under the
  Apache License 2.0. ModelHop does not bundle the executable in its VSIX; with
  explicit consent it downloads pinned official release 2026.7.3 into private
  extension storage and verifies the published asset digest before use.
- Other bundled JavaScript dependencies retain the notices and licenses
  published with their packages.

See the dependency package metadata and
`https://www.anthropic.com/legal/commercial-terms` for Anthropic's controlling
terms. Cloudflare's license is at
`https://github.com/cloudflare/cloudflared/blob/2026.7.3/LICENSE`; Quick Tunnel
service terms are linked from
`https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/`.

## Vanta, three.js, and markdown-it MIT license

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notices and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
