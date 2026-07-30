import path from 'node:path';
import zlib from 'node:zlib';

export const MAX_SKILL_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_RATIO = 100;
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.skill']);
const decoder = new TextDecoder('utf-8', { fatal: true });

function invalid(message, code = 'skill_package_invalid') { return Object.assign(new Error(message), { status: 422, code }); }
function safePath(name) {
  if (!name || name.includes('\\') || name.includes('\u0000') || name.startsWith('/') || /^[a-z]:/i.test(name)) throw invalid(`Unsafe skill package path: ${name}`, 'skill_path_invalid');
  const parts = name.split('/'); if (parts.some((part) => part === '..' || part === '.' || !part)) throw invalid(`Unsafe skill package path: ${name}`, 'skill_path_invalid');
  const normalized = path.posix.normalize(name); if (normalized !== name || normalized.startsWith('../')) throw invalid(`Unsafe skill package path: ${name}`, 'skill_path_invalid');
  if (!TEXT_EXTENSIONS.has(path.posix.extname(name).toLowerCase())) throw invalid(`Skill packages are text-only; rejected ${name}`, 'skill_file_type_invalid');
  return normalized;
}
let crcTable;
function crc32(bytes) {
  crcTable ||= Array.from({ length: 256 }, (_, index) => { let c = index; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}
function text(bytes, name) { try { const value = decoder.decode(bytes); if (value.includes('\u0000')) throw new Error(); return value; } catch { throw invalid(`Skill file is not valid UTF-8 text: ${name}`, 'skill_text_invalid'); } }

function parseZip(bytes) {
  let eocd = -1; const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset--) if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  if (eocd < 0) throw invalid('ZIP end-of-directory record is missing');
  const disk = bytes.readUInt16LE(eocd + 4); const centralDisk = bytes.readUInt16LE(eocd + 6); const count = bytes.readUInt16LE(eocd + 10); const centralSize = bytes.readUInt32LE(eocd + 12); const centralOffset = bytes.readUInt32LE(eocd + 16); const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk || centralDisk || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw invalid('Multi-disk and ZIP64 skill packages are not supported');
  if (!count || count > MAX_FILES || eocd + 22 + commentLength !== bytes.length || centralOffset + centralSize > eocd) throw invalid('ZIP directory bounds are invalid');
  const files = []; let cursor = centralOffset; let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid('ZIP central directory is malformed');
    const flags = bytes.readUInt16LE(cursor + 8); const method = bytes.readUInt16LE(cursor + 10); const expectedCrc = bytes.readUInt32LE(cursor + 16); const compressedSize = bytes.readUInt32LE(cursor + 20); const size = bytes.readUInt32LE(cursor + 24); const nameLength = bytes.readUInt16LE(cursor + 28); const extraLength = bytes.readUInt16LE(cursor + 30); const entryCommentLength = bytes.readUInt16LE(cursor + 32); const external = bytes.readUInt32LE(cursor + 38); const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength; if (end > bytes.length) throw invalid('ZIP directory entry is truncated');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength); const name = text(rawName, 'entry name'); cursor = end;
    if (name.endsWith('/')) { const directory = name.slice(0, -1); if (!directory || directory.includes('\\') || directory.startsWith('/') || directory.split('/').some((part) => !part || part === '.' || part === '..')) throw invalid(`Unsafe skill package path: ${name}`, 'skill_path_invalid'); continue; }
    const unixType = (external >>> 16) & 0xf000; if (unixType === 0xa000) throw invalid(`Symbolic links are not accepted: ${name}`, 'skill_path_invalid');
    const normalized = safePath(name); if (flags & 1) throw invalid('Encrypted skill packages are not accepted'); if (![0, 8].includes(method)) throw invalid(`Unsupported ZIP compression method for ${name}`);
    if (size > MAX_SKILL_PACKAGE_BYTES || compressedSize > MAX_SKILL_PACKAGE_BYTES || (compressedSize === 0 ? size > 0 : size / compressedSize > MAX_RATIO)) throw invalid(`Skill entry exceeds decompression limits: ${name}`, 'skill_package_too_large');
    total += size; if (total > MAX_SKILL_PACKAGE_BYTES) throw invalid('Skill package expands beyond 5 MiB', 'skill_package_too_large');
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw invalid(`ZIP local entry is invalid: ${name}`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26); const localExtraLength = bytes.readUInt16LE(localOffset + 28); const dataStart = localOffset + 30 + localNameLength + localExtraLength; const dataEnd = dataStart + compressedSize; if (dataEnd > bytes.length) throw invalid(`ZIP entry is truncated: ${name}`);
    const compressed = bytes.subarray(dataStart, dataEnd); let content;
    try { content = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: Math.min(MAX_SKILL_PACKAGE_BYTES, size + 1) }); } catch { throw invalid(`ZIP entry could not be safely decompressed: ${name}`); }
    if (content.length !== size || crc32(content) !== expectedCrc) throw invalid(`ZIP entry checksum or size is invalid: ${name}`);
    files.push({ path: normalized, content: text(content, normalized), byteSize: content.length });
  }
  if (cursor !== centralOffset + centralSize || !files.length) throw invalid('ZIP directory size is invalid or has no text files');
  return files;
}

export function parseSkillPackage(input, packageName = 'skill.skill') {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!bytes.length || bytes.length >= MAX_SKILL_PACKAGE_BYTES) throw Object.assign(new Error('Skill package must be non-empty and smaller than 5 MiB'), { status: 413, code: 'skill_package_too_large' });
  const zip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  const files = zip ? parseZip(bytes) : [{ path: safePath(path.basename(String(packageName || 'skill.skill'))), content: text(bytes, packageName), byteSize: bytes.length }];
  const manifestFile = files.find((file) => /(^|\/)skill\.json$/i.test(file.path)); let manifest = {};
  if (manifestFile) { try { manifest = JSON.parse(manifestFile.content); } catch { throw invalid('skill.json must be valid JSON', 'skill_manifest_invalid'); } if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalid('skill.json must be an object', 'skill_manifest_invalid'); }
  const primary = files.find((file) => /(^|\/)(SKILL\.md|README\.md)$/i.test(file.path)) || files.find((file) => file.path.endsWith('.skill')) || files.find((file) => file.path.endsWith('.md')) || files[0];
  return { name: String(manifest.name || path.basename(packageName, path.extname(packageName)) || 'Imported skill').slice(0, 100), description: String(manifest.description || primary.content.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) || '').slice(0, 500), optionalActivation: manifest.optionalActivation === true, content: primary.content, files, uncompressedBytes: files.reduce((sum, file) => sum + file.byteSize, 0), archive: zip };
}
