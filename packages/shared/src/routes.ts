/**
 * MyPath local API route constants
 * SaaS/auth/billing/admin/community/org routes stripped for solo local use.
 * Default origin: local loopback (no remote SaaS).
 */

export const API_ORIGIN = {
  local: 'http://127.0.0.1:8787',
} as const;

export const DESIGNS_ORIGIN = 'http://127.0.0.1:8787';
export const RELEASES_ORIGIN = 'http://127.0.0.1:8787';
export const STORAGE_BUCKET = 'local://data/assets';

/** Local session marker (no SaaS cookies) */
export const AuthCookies = {
  access: 'x-local-session',
  refresh: 'x-local-session',
} as const;

export const Routes = {
  COMPONENT: '/components/:id',
  COMPONENT_COPY: '/components/:id/copy',
  COMPONENT_COPY_TO_NEW_PROJECT: '/components/:id/copy-to-new-project',
  COMPONENT_COPY_TO_PROJECT: '/components/:id/copy-to-project',
  COMPONENT_EDIT_ELEMENT: '/components/:id/edit-element',
  COMPONENT_FLOW_CHILD: '/components/:id/flow-child',
  COMPONENT_LIKE: '/components/:id/like',
  COMPONENT_REVISION: '/components/:id/revision/:revisionId',
  COMPONENT_REVISION_CODE: '/components/:id/revision/:revisionId/code',
  COMPONENT_REVISION_DOWNLOAD_KEY: '/components/:id/revision/:revisionId/download-key',
  COMPONENT_REVISION_DOWNLOAD_ZIP: '/components/:id/revision/:revisionId/download-zip',
  COMPONENT_REVISION_RETRY: '/components/:id/revision/:revisionId/retry',
  COMPONENT_SCREENSHOT: '/components/:id/revision/:revisionId/screenshot',
  COMPONENT_REVISION_VARIATIONS: '/components/:id/revision/:revisionId/variations',
  COMPONENT_REVISIONS: '/components/:id/revisions',
  COMPONENT_REVISIONS_QUEUE: '/components/:id/revisions-queue',
  COMPONENT_REVISION_JOB: '/components/:id/revisions/jobs/:jobId',
  COMPONENT_SEND_TO_LIBRARY: '/components/:id/send-to-library',
  COMPONENT_VISUAL_EDIT_COMMIT: '/components/:id/visual-edit-commit',
  COMPONENTS_BATCH: '/components/batch',
  COMPONENTS_LIKED: '/components/liked',
  COMPONENTS_SEND_TO_LIBRARY: '/components/send-to-library',
  COMPONENTS_TOP: '/components/top',
  DESIGN_SYSTEMS: '/design-systems/',
  DESIGN_SYSTEM: '/design-systems/:id',
  DESIGN_SYSTEM_DESIGN_MD_PREVIEW: '/design-systems/design-md-preview',
  DESIGN_SYSTEM_DESIGN_MD_PREVIEW_JOB_STATUS: '/design-systems/design-md-preview/:jobId',
  DESIGN_SYSTEM_EXTRACT_FROM_URL: '/design-systems/extract-from-url',
  DESIGN_SYSTEM_EXTRACT_JOB_STATUS: '/design-systems/extract-from-url/:jobId',
  FONTS: '/fonts',
  FONT: '/fonts/:id',
  IMAGE_COPY: '/images/:id/copy',
  IMAGE_FINALIZE: '/images/:id/finalize',
  IMAGE_URL: '/images/:id/url',
  IMAGES_BATCH: '/images/batch',
  LIBRARIES: '/libraries/',
  LIBRARY: '/libraries/:id',
  LIBRARY_ACTIVE: '/libraries/:id/active',
  LIBRARY_COMPONENTS: '/libraries/:id/components',
  LIBRARY_COMPONENT_COPY_TO_PROJECT: '/libraries/:id/components/:componentId/copy-to-project',
  LIBRARY_COPY: '/libraries/:id/copy',
  LIBRARY_INSTALL: '/libraries/:id/install',
  LIBRARY_PROMOTE_DEFAULT: '/libraries/:id/promote-default',
  PROJECTS: '/projects',
  PROJECT: '/projects/:id',
  PROJECT_COMPONENTS: '/projects/:id/components',
  PROJECT_COMPONENTS_SYNC: '/projects/:id/components/sync',
  PROJECT_CONTEXT: '/projects/:id/context',
  PROJECT_COPY: '/projects/:id/copy',
  PROJECT_IMAGES: '/projects/:id/images',
  PROJECT_LEAVE: '/projects/:id/leave',
  PROJECT_MAKE_SHARED: '/projects/:id/make-shared',
  PROJECT_MEMBER: '/projects/:id/members/:userId',
  PROJECT_MOVE_TO_ORGANIZATION: '/projects/:id/move-to-organization',
  PROJECT_OPEN: '/projects/:id/open',
  PROJECT_SHARE: '/projects/:id/share',
  PROJECTS_POPULAR: '/projects/popular',
  PROJECTS_PUBLIC: '/projects/public',
  PROJECTS_TOP_VIEWED: '/projects/top-viewed',
  SKILL: '/skills/:id',
  SKILL_FILES: '/skills/:id/files',
  SKILL_FILE_CONTENT: '/skills/:id/files/content',
  USER_SELF: '/users/me',
  USER_ASSETS_UPLOAD_URL: '/users/me/assets/upload-url',
  USER_CHAT_THREADS: '/users/me/chat-threads',
  USER_CHAT_THREAD: '/users/me/chat-threads/:threadId',
  USER_CHAT_THREAD_MESSAGES: '/users/me/chat-threads/:threadId/messages',
  USER_DESIGN_SYSTEMS: '/users/me/design-systems',
  USER_FONTS: '/users/me/fonts',
  USER_ONBOARDING: '/users/me/onboarding',
  USER_ONBOARDING_INITIALIZE: '/users/me/onboarding/initialize',
  USER_ONBOARDING_SUGGESTION: '/users/me/onboarding/suggestions/:suggestionId',
  USER_ONBOARDING_SYNC: '/users/me/onboarding/sync',
  USERS_PROJECTS: '/users/me/projects',
  USER_SKILLS: '/users/me/skills',
  USER_SKILLS_IMPORT: '/users/me/skills/import',
  DESIGN: '/v1/:generatedName',
} as const;

export type RouteName = keyof typeof Routes;
export type RoutePath = (typeof Routes)[RouteName];

/** Replace :param segments in a route template. */
export function fillRoute(template: string, params: Record<string, string | number>): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key: string) => {
    if (!(key in params)) throw new Error(`Missing route param: ${key}`);
    return encodeURIComponent(String(params[key]));
  });
}
