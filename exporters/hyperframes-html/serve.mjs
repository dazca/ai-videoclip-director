#!/usr/bin/env node
// Serve an exported HTML package (any static server with byte ranges works; this one needs nothing installed).
//   node serve.mjs <outDir> [port]   ->  http://127.0.0.1:<port>/
import { resolve } from 'node:path';
import { serve } from './lib.mjs';

const dir = resolve(process.argv[2] || '.'), port = Number(process.argv[3] || 8150);
const s = await serve([{ prefix: '/', dir }], port);
console.log(`${dir}\n  -> ${s.url}`);
