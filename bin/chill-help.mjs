#!/usr/bin/env node
import { formatHelp } from '../lib/cli-help.mjs';
try {
  console.log(formatHelp(process.argv.slice(2).filter(arg => !['--help', '-h'].includes(arg)).join(' ')));
} catch (error) { console.error(error.message); process.exitCode = 1; }
