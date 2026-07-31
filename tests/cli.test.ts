/**
 * The account CLI, driven as a real subprocess.
 *
 * Each run gets its own database so these tests never touch the one the HTTP
 * tests share, and exit codes are asserted because scripts depend on them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'battlemapper-cli-'));
const CLI = join(import.meta.dir, '..', 'cli', 'user.ts');

const env = {
  ...process.env,
  DATABASE_PATH: join(root, 'cli.sqlite'),
  IMAGE_DIR: join(root, 'images'),
  LOG_LEVEL: 'error',
  MIN_PASSWORD_LENGTH: '12',
};

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], stdin?: string): Promise<Result> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], {
    env,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

const PASSWORD = 'a sufficiently long passphrase';

beforeAll(async () => {
  // First invocation also migrates the fresh database.
  await run(['list']);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('usage', () => {
  test('no command prints usage and exits non-zero', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('Usage:');
  });

  test('--help succeeds', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('change-password');
  });

  test('an unknown command is rejected with guidance', async () => {
    const result = await run(['teleport']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command');
  });

  test('lists every command the spec requires', async () => {
    const { stdout } = await run(['--help']);
    for (const command of ['create', 'delete', 'list', 'change-role', 'change-password']) {
      expect(stdout).toContain(command);
    }
  });
});

describe('create', () => {
  test('creates an admin', async () => {
    const result = await run(['create', '--email', 'admin@test.local', '--password', PASSWORD, '--role', 'admin']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('admin@test.local');
  });

  test('creates a viewer', async () => {
    const result = await run(['create', '--email', 'viewer@test.local', '--password', PASSWORD, '--role', 'viewer']);
    expect(result.code).toBe(0);
  });

  test('accepts the password on standard input', async () => {
    const result = await run(['create', '--email', 'stdin@test.local', '--password-stdin', '--role', 'viewer'], PASSWORD);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stdin@test.local');
  });

  test('refuses a duplicate address, matching case-insensitively', async () => {
    const result = await run(['create', '--email', 'ADMIN@test.local', '--password', PASSWORD, '--role', 'viewer']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('already in use');
  });

  test('refuses a short password', async () => {
    const result = await run(['create', '--email', 'short@test.local', '--password', 'tiny', '--role', 'viewer']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('at least 12');
  });

  test('refuses a malformed address', async () => {
    const result = await run(['create', '--email', 'not-an-email', '--password', PASSWORD, '--role', 'viewer']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('valid email');
  });

  test('refuses an unknown role', async () => {
    const result = await run(['create', '--email', 'wizard@test.local', '--password', PASSWORD, '--role', 'wizard']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not a valid role');
  });

  test('refuses both password flags at once', async () => {
    const result = await run(
      ['create', '--email', 'both@test.local', '--password', PASSWORD, '--password-stdin', '--role', 'viewer'],
      PASSWORD,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not both');
  });

  test('requires an email', async () => {
    const result = await run(['create', '--password', PASSWORD, '--role', 'viewer']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('email address is required');
  });
});

describe('list', () => {
  test('shows the accounts created so far', async () => {
    const { code, stdout } = await run(['list']);
    expect(code).toBe(0);
    expect(stdout).toContain('admin@test.local');
    expect(stdout).toContain('viewer@test.local');
  });

  test('--json emits parseable output with no secrets in it', async () => {
    const { code, stdout } = await run(['list', '--json']);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout) as { email: string; role: string }[];
    expect(parsed.some((u) => u.email === 'admin@test.local' && u.role === 'admin')).toBe(true);
    // A password hash must never be printed.
    expect(stdout).not.toContain('$argon2');
    expect(stdout).not.toContain('password');
  });
});

describe('change-role', () => {
  test('promotes a viewer', async () => {
    const result = await run(['change-role', '--email', 'viewer@test.local', '--role', 'admin']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('is now an admin');
  });

  test('reports a no-op rather than pretending to change something', async () => {
    const result = await run(['change-role', '--email', 'viewer@test.local', '--role', 'admin']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already');
  });

  test('demotes again', async () => {
    const result = await run(['change-role', '--email', 'viewer@test.local', '--role', 'viewer']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('is now a viewer');
  });

  test('fails on an unknown account', async () => {
    const result = await run(['change-role', '--email', 'ghost@test.local', '--role', 'admin']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No account found');
  });
});

describe('change-password', () => {
  test('updates the password', async () => {
    const result = await run(['change-password', '--email', 'viewer@test.local', '--password', 'a different long one']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('signed out');
  });

  test('enforces the minimum length', async () => {
    const result = await run(['change-password', '--email', 'viewer@test.local', '--password', 'nope']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('at least 12');
  });

  test('fails on an unknown account', async () => {
    const result = await run(['change-password', '--email', 'ghost@test.local', '--password', PASSWORD]);
    expect(result.code).toBe(1);
  });
});

describe('delete', () => {
  test('removes an account', async () => {
    expect((await run(['delete', '--email', 'stdin@test.local'])).code).toBe(0);
    expect((await run(['list'])).stdout).not.toContain('stdin@test.local');
  });

  test('fails on an unknown account', async () => {
    const result = await run(['delete', '--email', 'ghost@test.local']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No account found');
  });

  test('warns when the last administrator is being removed', async () => {
    await run(['change-role', '--email', 'viewer@test.local', '--role', 'viewer']);
    const result = await run(['delete', '--email', 'admin@test.local']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('last administrator');
  });
});
