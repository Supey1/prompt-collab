import fs from 'node:fs';
import path from 'node:path';

// Load settings from .env before any other server file runs. index.js imports
// this first: imports run before the importing file's own code, so loading
// .env inside index.js itself would be too late for files that read settings
// as they load (like keys.js and house.js). Real environment variables win.
try {
  const text = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file */ }
