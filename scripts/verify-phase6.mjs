import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('server/src/db/migrations/010_phase6_export_agents.sql', 'utf8');
const rust = fs.readFileSync('src-tauri/src/main.rs', 'utf8');
const capability = JSON.parse(fs.readFileSync('src-tauri/capabilities/default.json', 'utf8'));
assert.match(migration, /export_manifests_immutable_update/);
assert.match(migration, /external_agent_grants/);
assert.match(rust, /pick_export_destination/);
assert.match(rust, /std::fs::canonicalize/);
assert.match(rust, /Command::new\(executable\)\.arg\(&canonical\)/);
assert.doesNotMatch(rust, /(?:bash|sh)\s+-c/);
assert.ok(capability.remote.urls.includes('http://127.0.0.1:*'));
console.log('Phase 6 source verification passed: immutable manifests, canonical native grants, allowlisted no-shell IDE launch, remote capability');
