#!/usr/bin/env node
// Publishes the Strategy seat's lost-reason categories to the private preview:
//   node workspace/refresh/publish-lost-reasons.mjs /workspace/gtm-insights/lost-reasons.json [--dry-run]
// Validates the file (workspace/src/lost-reasons.js, the same check the page
// runs; shape in docs/lost-reasons-schema.md), refuses on any error, and uploads
// to s3://opstream-gtm-preview-db5553a4/lost-reasons.json only when its sha256
// differs from the sha256 metadata on the object already there. Same AWS CLI
// profile and behavior as publish-insights.mjs.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkText as check, publishFile, runCli } from './publish-insights.mjs';

const require = createRequire(import.meta.url);
const lostReasons = require('../src/lost-reasons.js');

export const KEY = 'lost-reasons.json';
export const checkText = (text) => check(text, lostReasons.parse);

const main = (argv) => publishFile(argv, {
  key: KEY, parse: lostReasons.parse, script: 'publish-lost-reasons.mjs', shown: 'the "Why … deals were lost" panel',
  describe: (doc) => `${doc.deals.length} deals${doc.competitors ? `, ${doc.competitors.length} competitor names` : ''}`,
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli(main);
