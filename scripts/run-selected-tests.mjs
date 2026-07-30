import { spawnSync } from 'node:child_process';

const suite = process.argv[2]; const selection = process.argv.slice(3).join(' ').trim();
if (!['security', 'integration', 'e2e'].includes(suite)) { console.error(`Unknown acceptance suite: ${suite || '(missing)'}`); process.exit(2); }
const defaults = suite === 'security' ? ['test/forge.test.js', 'test/http.test.js'] : suite === 'e2e' ? ['test/phase7-http.test.js'] : ['test/database.test.js', 'test/http.test.js'];
const selections = {
  'theme-url-ssrf': 'theme URL policy rejects SSRF',
  'exact-library-revision': 'library membership, canvas reuse',
  'skill-import-boundary': 'skill package import is text-only',
  'offline-fonts': 'versioned compiler pins exact design context',
  'selected-context-reaching-generation': 'selected operational context reaches provider generation',
  'export-path-grant': 'export path grants are canonical|browser ZIP and native path grant',
  'clean-export-build': 'clean export build is deterministic',
  'external-agent-auth-separation': 'external-agent HTTP auth|external agent submit, poll',
  'agent-submit-accept-reject': 'external agent submit, poll|external-agent HTTP auth',
  'ide-unavailable-after-export': 'IDE launch source retains export success|browser ZIP and native path grant',
  'web-import-ssrf-sanitize': 'web import SSRF policy and sanitizer|web import HTTP rejects SSRF',
  'semantic-import-job': 'immutable sanitized web artifact converts',
  'capture-ticket': 'capture tickets are exact-origin|capture ticket HTTP submission',
  'search-provenance': 'search and result fetch require opt-in',
  'figma-roundtrip-fixtures': 'FigmaExchangeV1 fixture imports',
  'web-import-convert': 'web import UI exposes safe import',
  'surgical-capture': 'capture ticket HTTP submission|web import UI exposes safe import',
};
let files = defaults; const args = ['--test'];
if (selection && selections[selection]) {
  const phase5 = selection in { 'theme-url-ssrf': 1, 'exact-library-revision': 1, 'skill-import-boundary': 1, 'offline-fonts': 1, 'selected-context-reaching-generation': 1 };
  const phase7 = selection in { 'web-import-ssrf-sanitize': 1, 'semantic-import-job': 1, 'capture-ticket': 1, 'search-provenance': 1, 'figma-roundtrip-fixtures': 1, 'web-import-convert': 1, 'surgical-capture': 1 };
  const phase7UnitOnly = selection in { 'semantic-import-job': 1, 'search-provenance': 1, 'figma-roundtrip-fixtures': 1 };
  files = phase5 ? ['test/phase5.test.js'] : phase7 ? (suite === 'e2e' ? ['test/phase7-http.test.js'] : phase7UnitOnly ? ['test/phase7.test.js'] : ['test/phase7.test.js', 'test/phase7-http.test.js']) : (suite === 'e2e' ? ['test/phase6.test.js'] : ['test/phase6.test.js', 'test/phase6-http.test.js']); args.push(`--test-name-pattern=${selections[selection]}`);
}
else if (selection) { console.error(`Unknown acceptance selector: ${selection}`); process.exit(2); }
args.push(...files);
const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
const count = Number(output.match(/# tests (\d+)/)?.[1] || output.match(/ℹ tests (\d+)/)?.[1] || 0);
if ((result.status ?? 1) === 0 && count === 0) { console.error(`Acceptance selector executed zero tests: ${selection || `${suite} defaults`}`); process.exit(3); }
process.exit(result.status ?? 1);
