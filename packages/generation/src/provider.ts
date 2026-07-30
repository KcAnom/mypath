/** Pluggable local generation provider — no MagicPath cloud */
export interface GenerateRequest {
  prompt: string;
  system?: string;
  files?: Record<string, string>; // existing forge files
  images?: string[]; // local paths
}

export interface GenerateResult {
  files: Record<string, string>; // path -> content
  note?: string;
  raw?: string;
}

export interface GenerationProvider {
  name: string;
  generateComponent(req: GenerateRequest): Promise<GenerateResult>;
}

/** Stub that writes a real React+Tailwind component from the prompt text */
export class LocalTemplateProvider implements GenerationProvider {
  name = 'local-template';
  async generateComponent(req: GenerateRequest): Promise<GenerateResult> {
    const safe = (req.prompt || 'Component').slice(0, 48).replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Component';
    const name = safe.split(/\s+/).map(w => w[0]?.toUpperCase() + w.slice(1)).join('') || 'Component';
    const tsx = `export default function ${name}() {
  return (
    <div className="min-h-[240px] w-full max-w-xl rounded-2xl border border-border bg-background p-6 text-foreground shadow-sm">
      <h2 className="text-xl font-semibold tracking-tight">${name}</h2>
      <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">${req.prompt.replace(/`/g, "'")}</p>
      <button className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        Action
      </button>
    </div>
  );
}
`;
    return {
      files: {
        [`src/components/generated/${name}.tsx`]: tsx,
        'src/App.tsx': `import ${name} from './components/generated/${name}';\nexport default function App(){return <div className=\"min-h-screen grid place-items-center p-8 bg-background\"><${name} /></div>}`,
      },
      note: 'local-template (wire OpenAI/Anthropic/Ollama in provider)',
    };
  }
}
