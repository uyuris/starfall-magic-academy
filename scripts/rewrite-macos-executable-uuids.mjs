import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_UUID = 0x1b;
const MACH_HEADER_64_SIZE = 32;
const LOAD_COMMAND_HEADER_SIZE = 8;
const UUID_COMMAND_SIZE = 24;
const UUID_NAMESPACE = 'f587ba26-4b2c-4ce5-94ef-6f1ccfac6468';
const FAT_MAGICS = new Set(['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

export const EXECUTABLE_RELATIVE_PATHS = Object.freeze([
  'Contents/MacOS/STARFALL MAGIC ACADEMY',
  'Contents/Frameworks/STARFALL MAGIC ACADEMY Helper.app/Contents/MacOS/STARFALL MAGIC ACADEMY Helper',
  'Contents/Frameworks/STARFALL MAGIC ACADEMY Helper (GPU).app/Contents/MacOS/STARFALL MAGIC ACADEMY Helper (GPU)',
  'Contents/Frameworks/STARFALL MAGIC ACADEMY Helper (Plugin).app/Contents/MacOS/STARFALL MAGIC ACADEMY Helper (Plugin)',
  'Contents/Frameworks/STARFALL MAGIC ACADEMY Helper (Renderer).app/Contents/MacOS/STARFALL MAGIC ACADEMY Helper (Renderer)'
]);

function parseUuid(uuid, label) {
  if (typeof uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error(`${label} must be an RFC 4122 UUID`);
  }
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function formatUuid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function locateUuidCommand(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError('Mach-O bytes must be a Buffer');
  }
  if (bytes.length < 4) {
    throw new Error('Mach-O header is truncated');
  }
  const magicBytes = bytes.subarray(0, 4).toString('hex');
  if (FAT_MAGICS.has(magicBytes)) {
    throw new Error('fat Mach-O is not supported; expected one arm64 slice');
  }
  if (bytes.length < MACH_HEADER_64_SIZE || bytes.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error('unsupported Mach-O; expected a little-endian 64-bit header');
  }
  if (bytes.readUInt32LE(4) !== CPU_TYPE_ARM64) {
    throw new Error('unsupported Mach-O CPU type; expected arm64');
  }

  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  const commandsEnd = MACH_HEADER_64_SIZE + commandBytes;
  if (commandsEnd > bytes.length) {
    throw new Error('Mach-O load commands exceed file bounds');
  }

  const uuidOffsets = [];
  let offset = MACH_HEADER_64_SIZE;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + LOAD_COMMAND_HEADER_SIZE > commandsEnd) {
      throw new Error(`Mach-O load command ${index} header exceeds declared bounds`);
    }
    const command = bytes.readUInt32LE(offset);
    const commandSize = bytes.readUInt32LE(offset + 4);
    if (commandSize < LOAD_COMMAND_HEADER_SIZE || offset + commandSize > commandsEnd) {
      throw new Error(`Mach-O load command ${index} has invalid size ${commandSize}`);
    }
    if (command === LC_UUID) {
      if (commandSize !== UUID_COMMAND_SIZE) {
        throw new Error(`LC_UUID command has invalid size ${commandSize}`);
      }
      uuidOffsets.push(offset + LOAD_COMMAND_HEADER_SIZE);
    }
    offset += commandSize;
  }
  if (offset !== commandsEnd) {
    throw new Error('Mach-O load command count does not consume the declared command bytes');
  }
  if (uuidOffsets.length !== 1) {
    throw new Error(`expected exactly one LC_UUID command; found ${uuidOffsets.length}`);
  }
  return uuidOffsets[0];
}

export function readMachOUuid(bytes) {
  const offset = locateUuidCommand(bytes);
  return formatUuid(bytes.subarray(offset, offset + 16));
}

export function rewriteMachOUuid(bytes, uuid) {
  const offset = locateUuidCommand(bytes);
  const rewritten = Buffer.from(bytes);
  parseUuid(uuid, 'replacement UUID').copy(rewritten, offset);
  return rewritten;
}

export function deriveExecutableUuid({ bundleId, relativePath }) {
  if (typeof bundleId !== 'string' || bundleId.length === 0) {
    throw new Error('bundleId is required');
  }
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('relativePath is required');
  }
  const digest = createHash('sha1')
    .update(parseUuid(UUID_NAMESPACE, 'UUID namespace'))
    .update(`${bundleId}/${relativePath}`, 'utf8')
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return formatUuid(digest);
}

export async function rewriteExecutableUuidAtPath(filePath, newUuid, io = { readFile, writeFile }) {
  const before = await io.readFile(filePath);
  const oldUuid = readMachOUuid(before);
  await io.writeFile(filePath, rewriteMachOUuid(before, newUuid));
  const actualUuid = readMachOUuid(await io.readFile(filePath));
  if (actualUuid !== newUuid.toLowerCase()) {
    throw new Error(`UUID verification failed for ${filePath}: expected ${newUuid}, got ${actualUuid}`);
  }
  return { oldUuid, newUuid: actualUuid };
}

async function findSingleAppBundle(appOutDir) {
  const entries = await readdir(appOutDir, { withFileTypes: true });
  const appNames = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => entry.name);
  if (appNames.length !== 1) {
    throw new Error(`expected exactly one .app in ${appOutDir}; found ${appNames.length}`);
  }
  return path.join(appOutDir, appNames[0]);
}

export default async function afterPack(context) {
  if (context?.electronPlatformName !== 'darwin') {
    console.log(`rewrite-macos-executable-uuids: platform ${context?.electronPlatformName ?? '<missing>'} is not macOS`);
    return;
  }
  const appOutDir = context.appOutDir;
  const bundleId = context.packager?.appInfo?.id;
  if (typeof appOutDir !== 'string' || appOutDir.length === 0) {
    throw new Error('afterPack context.appOutDir is required');
  }
  if (typeof bundleId !== 'string' || bundleId.length === 0) {
    throw new Error('afterPack context.packager.appInfo.id is required');
  }

  const appBundle = await findSingleAppBundle(appOutDir);
  const plans = await Promise.all(EXECUTABLE_RELATIVE_PATHS.map(async (relativePath) => {
    const filePath = path.join(appBundle, ...relativePath.split('/'));
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`expected executable is not a regular file: ${filePath}`);
    }
    readMachOUuid(await readFile(filePath));
    return {
      filePath,
      relativePath,
      newUuid: deriveExecutableUuid({ bundleId, relativePath })
    };
  }));

  for (const plan of plans) {
    const result = await rewriteExecutableUuidAtPath(plan.filePath, plan.newUuid);
    console.log(`${plan.relativePath} ${result.oldUuid} ${result.newUuid}`);
  }
}
