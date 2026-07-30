/**
 * Local generation — template provider.
 * Swap body of generateComponent() for Ollama / OpenAI / Anthropic.
 */
export function generateComponent({ prompt, nameHint }) {
  const safe = String(nameHint || prompt || 'Component')
    .slice(0, 48)
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim() || 'Component';
  const name =
    safe
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('')
      .replace(/[^A-Za-z0-9]/g, '') || 'Component';

  const escaped = String(prompt || '').replace(/`/g, "'").replace(/\\/g, '\\\\').replace(/\$/g, '\\$');

  const tsx = `export default function ${name}() {
  return (
    <div className="min-h-[240px] w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-sm">
      <div className="text-xs uppercase tracking-wider text-[var(--muted-foreground)]">MyPath · local</div>
      <h2 className="mt-2 text-xl font-semibold tracking-tight">${name}</h2>
      <p className="mt-2 text-sm text-[var(--muted-foreground)] whitespace-pre-wrap">${escaped}</p>
      <div className="mt-4 flex gap-2">
        <button type="button" className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)]">
          Primary
        </button>
        <button type="button" className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm">
          Secondary
        </button>
      </div>
    </div>
  );
}
`;

  const app = `import ${name} from './components/generated/${name}.tsx';

export default function App() {
  return (
    <div className="min-h-full grid place-items-center p-8 bg-[var(--background)] text-[var(--foreground)]">
      <${name} />
    </div>
  );
}
`;

  const css = `:root {
  --background: #0b0b0c;
  --foreground: #f3f3f4;
  --muted-foreground: #9a9aa3;
  --primary: #7c6cff;
  --primary-foreground: #ffffff;
  --border: #2a2a30;
  --card: #141416;
  --radius: 12px;
  --font-body: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  font-family: var(--font-body);
  background: var(--background);
  color: var(--foreground);
}
`;

  return {
    name,
    files: {
      [`src/components/generated/${name}.tsx`]: tsx,
      'src/App.tsx': app,
      'src/index.css': css,
    },
    note: 'local-template provider — wire your LLM in server/generate.js',
  };
}
