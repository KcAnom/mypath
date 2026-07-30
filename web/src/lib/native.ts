type TauriCore = { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
declare global { interface Window { __TAURI__?: { core?: TauriCore } } }

export type DestinationGrant = { status: 'granted' | 'cancelled' | 'unavailable'; destinationGrantId?: string; expiresAt?: string };
export type IdeLaunch = { exportedPath: string; launchStatus: 'launched' | 'unavailable' | 'failed' };

export function nativeAvailable() { return typeof window.__TAURI__?.core?.invoke === 'function'; }
export async function pickExportDestination() {
  if (!nativeAvailable()) return { status: 'unavailable' } as DestinationGrant;
  return window.__TAURI__!.core!.invoke<DestinationGrant>('pick_export_destination');
}
export async function openExportInIde(exportedPath: string, ide = 'auto') {
  if (!nativeAvailable()) return { exportedPath, launchStatus: 'unavailable' } as IdeLaunch;
  return window.__TAURI__!.core!.invoke<IdeLaunch>('open_export_in_ide', { exportedPath, ide });
}
