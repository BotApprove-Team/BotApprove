#!/usr/bin/env node
import fs from 'node:fs';
import { measure, SEAL_PATH } from '../src/services/integrity.js';

const measured = measure();
const seal = {
  root: measured.root,
  sealedAt: Date.now(),
  files: measured.files,
};

fs.rmSync(SEAL_PATH, { force: true });
fs.writeFileSync(SEAL_PATH, `${JSON.stringify(seal, null, 2)}\n`, { mode: 0o444 });

console.log(`sealed ${Object.keys(seal.files).length} files`);
console.log(`root   ${seal.root}`);
console.log(`wrote  ${SEAL_PATH}`);
