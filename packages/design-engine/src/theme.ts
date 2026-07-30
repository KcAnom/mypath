/** Design system / theme model (MagicPath "themes") */
export interface DesignSystem {
  id: string;
  name: string;
  version?: number;
  /** Natural-language styling instructions from designer */
  prompt?: string;
  defaultTheme?: 'light' | 'dark';
  light: Record<string, string>; // CSS variables
  dark: Record<string, string>;
  fonts?: { family: string; role?: string; url?: string }[];
  markdown?: string; // DESIGN.md
  createdAt: string;
  updatedAt: string;
}

export const DefaultThemeTokens: DesignSystem['light'] = {
  '--background': '#0b0b0c',
  '--foreground': '#f3f3f4',
  '--muted-foreground': '#9a9aa3',
  '--primary': '#7c6cff',
  '--primary-foreground': '#ffffff',
  '--border': '#2a2a30',
  '--card': '#141416',
  '--radius': '12px',
  '--font-body': '"IBM Plex Sans", system-ui, sans-serif',
};

/** Tailwind v4 forge CSS skeleton (from MagicPath code template rules) */
export function forgeIndexCss(tokens: Record<string, string> = DefaultThemeTokens): string {
  const vars = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `@import 'tailwindcss';

:root {
${vars}
}

.dark {
  /* override tokens for dark if needed */
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-border: var(--border);
  --color-card: var(--card);
  --font-sans: var(--font-body);
  --radius-lg: var(--radius);
}
`;
}

export const DesignRoutes = {
  list: '/design-systems/',
  one: '/design-systems/:id',
  userList: '/users/me/design-systems',
  designMdPreview: '/design-systems/design-md-preview',
  designMdJob: '/design-systems/design-md-preview/:jobId',
  extractFromUrl: '/design-systems/extract-from-url',
  extractJob: '/design-systems/extract-from-url/:jobId',
} as const;
