#!/usr/bin/env node

import { runCli } from "./features/tooling/index.js";

process.exitCode = await runCli(process.argv.slice(2));
