#!/usr/bin/env node
/**
 * The `cortana` command. Everything it does is in `cli.ts`, where a test can
 * reach it; this is the process around it.
 */

import { runCli } from './cli.ts';

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  input: process.stdin,
  output: process.stdout,
  errors: process.stderr,
  interactive: Boolean(process.stdin.isTTY),
});
