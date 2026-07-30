/**
 * Generation / revision / external-agent API surface
 * Recovered from MagicPath web client + magicpath-ai CLI 2.6.1
 */
export const GenerationRoutes = {
  // Component revisions (web client)
  component: '/components/:id',
  revisions: '/components/:id/revisions',
  revisionsQueue: '/components/:id/revisions-queue',
  revisionJob: '/components/:id/revisions/jobs/:jobId',
  revision: '/components/:id/revision/:revisionId',
  revisionCode: '/components/:id/revision/:revisionId/code',
  revisionRetry: '/components/:id/revision/:revisionId/retry',
  revisionScreenshot: '/components/:id/revision/:revisionId/screenshot',
  revisionVariations: '/components/:id/revision/:revisionId/variations',
  revisionDownloadZip: '/components/:id/revision/:revisionId/download-zip',
  visualEditCommit: '/components/:id/visual-edit-commit',
  editElement: '/components/:id/edit-element',
  flowChild: '/components/:id/flow-child',

  // Chat / agent threads
  chatThreads: '/users/me/chat-threads',
  chatThread: '/users/me/chat-threads/:threadId',
  chatMessages: '/users/me/chat-threads/:threadId/messages',
  apiChat: '/api/chat',

  // External agent code forge (CLI)
  extComponents: '/v1/external-agent/components',
  extStart: '/v1/external-agent/components/:id/start',
  extContext: '/v1/external-agent/components/:id/context',
  extRevisions: '/v1/external-agent/components/:id/revisions',
  extJobs: '/v1/external-agent/jobs/:id',

  // Images
  projectImages: '/projects/:id/images',
  imageGenerate: '/images/generate',
  assetsUploadUrl: '/users/me/assets/upload-url',

  // Registry
  registry: '/v1/registry/:generatedName',
  designPublic: '/v1/:generatedName',
  componentSearch: '/components/search',

  // Liveblocks auth (cloud — local omit)
  liveblocksAuth: '/liveblocks/auth',
  socketRooms: '/users/me/socket-rooms',
} as const;

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'processing'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'ready';

export interface Revision {
  id: string;
  componentId: string;
  code?: string;
  note?: string;
  status?: JobStatus;
  createdAt: string;
}

export interface BuildJob {
  id: string;
  status: JobStatus;
  diagnostics?: string;
  componentId?: string;
  revisionId?: string;
}

/** Editable forge boundary (from magicpath-ai code flow) */
export const ForgeFileBoundary = [
  'src/App.tsx',
  'src/index.css',
  'src/components/generated/**',
  'assets/**',
] as const;

export const CodeSessionFlow = [
  'code start --project|--component',
  'edit only ForgeFileBoundary',
  'code submit --wait',
  'poll job status until completed|failed',
] as const;
