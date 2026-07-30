/** Local canvas model (tldraw-shaped, no multiplayer SaaS) */
export type CanvasPoint = { x: number; y: number };
export type CanvasSize = { width: number; height: number };

export interface CanvasComponentShape {
  id: string;
  kind: 'component';
  componentId: string;
  clientId?: string;
  name: string;
  generatedName?: string;
  selectedRevisionId?: string | null;
  position: CanvasPoint;
  size: CanvasSize;
  z: number;
}

export interface CanvasImageShape {
  id: string;
  kind: 'image';
  imageId: string;
  name: string;
  url: string; // local path or data url
  position: CanvasPoint;
  size: CanvasSize;
  z: number;
}

export type CanvasShape = CanvasComponentShape | CanvasImageShape;

export interface CanvasDocument {
  id: string;
  projectId: string;
  shapes: CanvasShape[];
  camera: { x: number; y: number; zoom: number };
  updatedAt: string;
}

/** Stack signals from MagicPath web client */
export const CanvasStack = {
  engine: 'tldraw',
  packages: [
    '@tldraw/editor',
    '@tldraw/store',
    '@tldraw/tlschema',
    '@tldraw/state',
    '@tldraw/state-react',
    '@tldraw/utils',
    '@tldraw/validate',
  ],
  presence: 'liveblocks (cloud — omit for local)',
  socket: 'socket.io client events (see events.ts)',
} as const;
