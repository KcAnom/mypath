/**
 * Shared MyPath domain types — local solo mode.
 */

export type ReleaseChannel = 'local';

export interface ChannelConfig {
  apiOrigin: string;
  appHomeUrl: string;
  appOrigin: string;
  updateUrl: string | null;
  webUrl: string;
}

export interface DesktopInfo {
  isDesktop: true;
  channel: ReleaseChannel | string;
  platform: string;
  version: string;
}

/** Desktop bridge intentionally omitted (Swift WKWebView shell has no JS bridge). */

export type EntityId = string;

export interface UserSelf {
  id: EntityId;
  displayName: string;
  [key: string]: unknown;
}

export interface Project {
  id: EntityId;
  name: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface Component {
  id: EntityId;
  projectId: EntityId;
  name: string;
  [key: string]: unknown;
}

export interface ComponentRevision {
  id: EntityId;
  componentId: EntityId;
  createdAt: string;
  [key: string]: unknown;
}

export interface DesignSystem {
  id: EntityId;
  name: string;
  [key: string]: unknown;
}

export interface Library {
  id: EntityId;
  name: string;
  [key: string]: unknown;
}

export interface Skill {
  id: EntityId;
  name: string;
  [key: string]: unknown;
}

export interface ChatThread {
  id: EntityId;
  title: string;
  [key: string]: unknown;
}

export interface LocalAsset {
  id: EntityId;
  path: string;
  mimeType?: string;
  [key: string]: unknown;
}
