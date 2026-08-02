/**
 * Test bootstrap, loaded via `bunfig.toml` preload.
 *
 * Runs before any application module is imported, which matters because
 * `config.ts` reads the environment once at import time and `db/index.ts` opens
 * its connection from that config.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'bmc-test-'));

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_PATH'] = join(root, 'test.sqlite');
process.env['IMAGE_DIR'] = join(root, 'images');
// The test client is not a browser and does not speak TLS.
process.env['COOKIE_SECURE'] = 'false';
// Keep the run readable; failures still surface through assertions.
process.env['LOG_LEVEL'] = 'error';
// Low enough to exercise the limit without generating huge fixtures.
process.env['MAX_UPLOAD_BYTES'] = '8MB';
process.env['MIN_PASSWORD_LENGTH'] = '12';
process.env['PAGE_SIZE'] = '24';

export const TEST_ROOT = root;

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not worth failing the run over.
  }
});
