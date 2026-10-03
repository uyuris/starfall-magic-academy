#!/usr/bin/env node

// 収蔵庫 v2 -> v3 の明示変換 CLI（唯一の呼び出し口）。
//
//   node scripts/migrate-library-collection-v3.mjs --root <absolute-project-root> --mode check
//   node scripts/migrate-library-collection-v3.mjs --root <absolute-project-root> --mode apply
//
// --root と --mode は必須で既定値を持たない。check は完全 read-only、apply は全 file の検査が通った
// あとにだけ書く。処理本体と引数の綴りは app/src/libraryCollectionMigration.mjs にあり、この file は
// import されただけでは何も実行しない（実行は下の entrypoint gate の内側だけ）。
//
// 変換結果は JSON で stdout に出す。異常は stderr に1行出して exit 1。

import { migrateLibraryCollectionV3, parseMigrationArgs } from '../app/src/libraryCollectionMigration.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { root, mode } = parseMigrationArgs(process.argv.slice(2));
    const result = await migrateLibraryCollectionV3({ root, mode });
    console.log(JSON.stringify(result, null, 2));
    if (mode === 'check') {
      console.error(result.changed_count > 0
        ? `check: ${result.changed_count} of ${result.file_count} file(s) would be migrated to v3. Re-run with --mode apply to write.`
        : `check: nothing to migrate (${result.file_count} file(s) already at v3).`);
    }
  } catch (error) {
    console.error(`migrate-library-collection-v3 failed: ${error.message}`);
    process.exitCode = 1;
  }
}
