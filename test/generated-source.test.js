import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGeneratedSources } from '../server/src/security/generated-source.js';

const valid = {
  'src/App.tsx': "import React from 'react'; import Card from './components/generated/Card.tsx'; export default function App(){return <Card/>}",
  'src/components/generated/Card.tsx': 'export default function Card(){return <div>Card</div>}',
  'src/index.css': ':root{--color:red}',
};

test('generated source accepts approved packages and candidate-relative imports', () => {
  assert.equal(validateGeneratedSources(valid).fileCount, 3);
});

for (const [name, source] of [
  ['Node built-in', "import {\n  readFile\n} from 'node:fs'; export default readFile"],
  ['arbitrary package', "import lodash from 'lodash'; export default lodash"],
  ['dynamic import', "export const x = import('./other.tsx')"],
  ['remote import', "import x from 'https://evil.example/x.js'; export default x"],
  ['CommonJS require', "const x = require('fs'); export default x"],
  ['escaping relative import', "import x from '../../outside.js'; export default x"],
  ['comment-obfuscated absolute import', "import/**/ secret from '/tmp/mypath-secret.js'; export default secret"],
]) test(`generated source rejects ${name}`, () => {
  assert.throws(() => validateGeneratedSources({ 'src/App.tsx': source }), { code: 'generated_source_invalid', status: 422 });
});

test('generated source rejects remote CSS import', () => {
  assert.throws(() => validateGeneratedSources({ 'src/index.css': "@import url('https://evil.example/a.css');" }), { code: 'generated_source_invalid' });
});

test('generated source enforces per-file and aggregate limits', () => {
  assert.throws(() => validateGeneratedSources({ 'src/App.tsx': 'x'.repeat(257 * 1024) }), { code: 'generated_source_invalid' });
  const files = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`assets/${index}.txt`, 'x']));
  assert.throws(() => validateGeneratedSources(files), { code: 'generated_source_invalid' });
});
