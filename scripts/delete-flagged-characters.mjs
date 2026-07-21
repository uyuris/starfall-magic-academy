#!/usr/bin/env node

import { deleteFlaggedCharacters } from '../app/src/characterDeletion.mjs';

function parseArgs(args) {
  let apply = false;
  for (const arg of args) {
    if (arg === '--apply') {
      apply = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { apply, root: process.cwd() };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await deleteFlaggedCharacters(options);
  console.log(JSON.stringify({
    applied: result.applied,
    ...result.plan
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
