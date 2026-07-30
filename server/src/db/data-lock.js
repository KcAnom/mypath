import fs from 'node:fs';
import path from 'node:path';

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function acquireDataLock(dataDir, purpose = 'mutation') {
  const lockDir = path.join(dataDir, '.data-lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, purpose, createdAt: new Date().toISOString() }), { mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
          if (owner.pid === process.pid) fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')); } catch {}
      if (owner && pidAlive(Number(owner.pid))) {
        const locked = Object.assign(new Error(`MyPath data is busy (${owner.purpose || 'operation'}, PID ${owner.pid})`), { code: 'data_busy', status: 503 });
        throw locked;
      }
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
  throw new Error('Unable to acquire MyPath data lock');
}
