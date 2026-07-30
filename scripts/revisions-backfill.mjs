import path from 'node:path';
import { Store } from '../server/store.js';
import { CandidateService } from '../server/src/build/candidate-service.js';

const dataDir = path.resolve(process.env.MYPATH_DATA_DIR || 'data');
const store = new Store(dataDir);
try {
  const service = new CandidateService(store);
  const revisions = store.get().revisions.filter((revision) => revision.status === 'imported_unbuilt');
  const retry = process.argv.includes('--retry');
  let succeeded = 0; let failed = 0;
  for (const revision of revisions) {
    const build = await service.buildRevision(revision.id, { retry });
    if (build.status === 'succeeded') succeeded += 1;
    else { failed += 1; console.error(`${revision.id}: ${build.diagnostics.map((item) => item.message).join('; ')}`); }
  }
  console.log(`Revision backfill: ${succeeded} succeeded, ${failed} failed, ${revisions.length} total`);
  if (failed) process.exitCode = 1;
} finally { store.close(); }
