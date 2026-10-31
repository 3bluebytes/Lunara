# Web access references and dependencies

Protocol and parsing reference: `pi-web-access@0.44.0`, https://github.com/nicobailon/pi-web-access (`exa.ts`, `degoog.ts`, `ssrf-protection.ts`). Lunara uses its own host-neutral implementation, not the Pi extension/runtime, account discovery, provider router or MCP subprocess. The Exa formatted-result field conventions and JSON-RPC request shape were adapted from that reference. Preserve this notice with distributed source.

## pi-web-access reference license

MIT License

Copyright (c) 2025 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## New direct dependencies

- `ipaddr.js@2.2.0` — MIT, Node >=10; maintained address-range parsing rather than a custom IPv6 parser.
- `linkedom@0.18.12` — ISC, Node >=16; inert DOM without a resource loader/browser.
- `@mozilla/readability@0.6.0` — Apache-2.0, Node >=14; offline main-article extraction.

HTTP, DNS pinning, decompression, worker cancellation and concurrency use Node built-ins; no change to Lunara's Node/Electron minimum. Transitive additions and their licenses are recorded in package-lock.json; npm distributions retain the installed packages' license files. No other upstream Pi code or its dependencies were copied wholesale.
