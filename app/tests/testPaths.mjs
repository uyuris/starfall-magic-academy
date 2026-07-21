import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(moduleDir, '../..');
export const definitionsRoot = path.join(projectRoot, 'data/definitions/game_data');
export const seedsRoot = path.join(projectRoot, 'data/seeds/game_data');
export const mutableRoot = path.join(projectRoot, 'data/mutable/game_data');
export const characterContentRoot = path.join(projectRoot, 'content/characters');
export const runtimePublicReferenceRoot = path.join(projectRoot, 'app/public');
export const runtimeSourceReferenceRoot = path.join(projectRoot, 'app/src');
export const runtimeTestsReferenceRoot = path.join(projectRoot, 'app/tests');
export const testsFixtureRoot = path.join(projectRoot, 'app/tests/fixtures');
export const assetsRoot = path.join(projectRoot, 'assets');
