/** SQLite/WAL-backed compatibility store for the local-solo API. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MyPathDatabase } from './src/db/database.js';
import { writeForgeFiles } from './src/security/forge-path.js';
import { acquireDataLock } from './src/db/data-lock.js';

function id() { return crypto.randomBytes(8).toString('hex'); }
function now() { return new Date().toISOString(); }
function slugName(s) {
  const base = String(s || 'component').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'component';
  return `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.sqlite');
    this.forgeRoot = path.join(dataDir, 'forge');
    fs.mkdirSync(this.forgeRoot, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'skills'), { recursive: true });
    this.database = new MyPathDatabase(dataDir);
    // Reconcile normalized imported CSS into existing forge trees; the untouched JSON archive remains provenance.
    for (const component of this.database.loadState().components) {
      const css = component.files?.['src/index.css'];
      if (typeof css === 'string' && fs.existsSync(path.join(this.forgeRoot, component.id))) {
        writeForgeFiles(this.forgeRoot, component.id, { 'src/index.css': css });
      }
    }
  }
  with(mutator) {
    const release = acquireDataLock(this.dataDir, 'api-mutation');
    try { return this.database.transaction((db) => mutator(db, { id, now, slugName, forgeRoot: this.forgeRoot })); }
    finally { release(); }
  }
  get() { return this.database.loadState(); }
  close() { this.database.close(); }
}
