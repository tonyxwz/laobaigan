#!/usr/bin/env node
// The `lbg` command. Runs the TypeScript sources when they exist (a checkout, or
// `npm link` of one: Node resolves the link to the checkout, outside node_modules,
// so it can strip types), otherwise the compiled build (the published package
// ships dist/ but not src/).
import { existsSync } from "node:fs";

const src = new URL("../src/cli.ts", import.meta.url);
await import(existsSync(src) ? src.href : new URL("../dist/cli.js", import.meta.url).href);
