/**
 * MyPath Desktop — preload (local)
 */
import { contextBridge } from 'electron';

const INFO_ARG_PREFIX = '--mypath-desktop-info=';

function readDesktopInfo() {
  const arg = process.argv.find(v => v.startsWith(INFO_ARG_PREFIX));
  const fallback = { channel: 'local', platform: process.platform, version: '' };
  if (!arg) return fallback;
  try {
    return { ...fallback, ...JSON.parse(arg.slice(INFO_ARG_PREFIX.length)) };
  } catch {
    return fallback;
  }
}

const info = readDesktopInfo();
contextBridge.exposeInMainWorld('mypathDesktop', {
  isDesktop: true,
  channel: info.channel,
  platform: info.platform,
  version: info.version,
});

export {};
