/** Password hashing, session lifecycle, and constant-time comparison. */
import { beforeAll, describe, expect, test } from 'bun:test';

import { assertPasswordAcceptable, hashPassword, verifyPassword } from '../src/auth/password.ts';
import {
  createSession,
  destroySession,
  destroySessionsForUser,
  hashToken,
  purgeExpiredSessions,
  resolveSession,
  safeEqual,
} from '../src/auth/session.ts';
import { db } from '../src/db/index.ts';
import { changePassword, changeRole, findUserByEmail } from '../src/models/users.ts';
import { ensureSchema, makeUser } from './helpers.ts';

beforeAll(ensureSchema);

describe('password hashing', () => {
  test('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('a sufficiently long passphrase');
    expect(await verifyPassword('a sufficiently long passphrase', hash)).toBe(true);
    expect(await verifyPassword('a sufficiently long passphrasE', hash)).toBe(false);
  });

  test('uses argon2id', async () => {
    expect(await hashPassword('a sufficiently long passphrase')).toStartWith('$argon2id$');
  });

  test('salts, so the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([hashPassword('same passphrase here'), hashPassword('same passphrase here')]);
    expect(a).not.toBe(b);
  });

  test('a malformed stored hash reads as a wrong password, not a crash', async () => {
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false);
  });

  test('policy rejects short passwords and accepts long ones', () => {
    expect(() => assertPasswordAcceptable('short')).toThrow();
    expect(() => assertPasswordAcceptable('a'.repeat(2000))).toThrow();
    expect(() => assertPasswordAcceptable('a sufficiently long passphrase')).not.toThrow();
  });
});

describe('sessions', () => {
  test('the raw token is never stored; only its hash is', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const { token, session } = createSession(user.id);

    expect(session.id).toBe(hashToken(token));

    const stored = db.query('SELECT id FROM sessions WHERE id = ?').get(session.id) as { id: string };
    expect(stored.id).not.toBe(token);
    expect(db.query('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(token)).toEqual({ n: 0 });
  });

  test('resolves a valid token to its user', async () => {
    const { email } = await makeUser('admin');
    const user = findUserByEmail(email)!;
    const { token } = createSession(user.id);

    const resolved = resolveSession(token);
    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.user.role).toBe('admin');
  });

  test('rejects an unknown, empty, or destroyed token', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const { token, session } = createSession(user.id);

    expect(resolveSession(undefined)).toBeNull();
    expect(resolveSession('not-a-real-token')).toBeNull();

    destroySession(session.id);
    expect(resolveSession(token)).toBeNull();
  });

  test('an expired session is refused and cleaned up', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const { token, session } = createSession(user.id);

    db.query('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, session.id);

    expect(resolveSession(token)).toBeNull();
    expect(db.query('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(session.id)).toEqual({ n: 0 });
  });

  test('an idle session is refused even while inside its absolute lifetime', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const { token, session } = createSession(user.id);

    // Still valid absolutely, but untouched for longer than the idle window.
    db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(
      Date.now() - (Number(process.env['SESSION_IDLE_SECONDS'] ?? 259_200) + 60) * 1000,
      session.id,
    );

    expect(resolveSession(token)).toBeNull();
  });

  test('deleting the account invalidates its sessions', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const { token } = createSession(user.id);

    db.query('DELETE FROM users WHERE id = ?').run(user.id);
    expect(resolveSession(token)).toBeNull();
  });

  test('changing the password signs every session out', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const { token } = createSession(user.id);

    expect(resolveSession(token)).not.toBeNull();
    await changePassword(email, 'a different long passphrase');
    expect(resolveSession(token)).toBeNull();
  });

  test('destroySessionsForUser clears them all', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const first = createSession(user.id);
    const second = createSession(user.id);

    destroySessionsForUser(user.id);
    expect(resolveSession(first.token)).toBeNull();
    expect(resolveSession(second.token)).toBeNull();
  });

  test('purgeExpiredSessions removes only lapsed rows', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const live = createSession(user.id);
    const dead = createSession(user.id);

    db.query('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, dead.session.id);

    expect(purgeExpiredSessions()).toBeGreaterThanOrEqual(1);
    expect(resolveSession(live.token)).not.toBeNull();
  });

  test('a role change is reflected when the session is next resolved', async () => {
    const { email } = await makeUser('viewer');
    const user = findUserByEmail(email)!;
    const { token } = createSession(user.id);

    changeRole(email, 'admin');
    expect(resolveSession(token)?.user.role).toBe('admin');
  });
});

describe('safeEqual', () => {
  test('matches identical strings and rejects everything else', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    // Differing lengths must not throw, which the underlying primitive does.
    expect(safeEqual('short', 'much longer value')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
