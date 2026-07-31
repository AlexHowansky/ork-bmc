/**
 * User records. Accounts are created only by the CLI tool — there is no
 * self-service registration path anywhere in the app.
 */
import { db } from '../db/index.ts';
import { conflict, notFound, validationFailed } from '../errors.ts';
import { hashPassword } from '../auth/password.ts';

export const ROLES = ['viewer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
  updatedAt: number;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  created_at: number;
  updated_at: number;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  role: row.role,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Deliberately permissive: this only catches obvious typos at the CLI. Real
 * validation of an address is impossible without sending mail to it.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidEmail(email: string, field = 'email'): void {
  if (!EMAIL_PATTERN.test(email)) {
    throw validationFailed({ [field]: 'Enter a valid email address.' });
  }
  if (email.length > 320) {
    throw validationFailed({ [field]: 'That email address is too long.' });
  }
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function findUserById(id: string): User | null {
  const row = db.query('SELECT * FROM users WHERE id = ?').get(id) as UserRow | null;
  return row ? toUser(row) : null;
}

export function findUserByEmail(email: string): User | null {
  // `email` is UNIQUE COLLATE NOCASE, so this comparison is case-insensitive.
  const row = db.query('SELECT * FROM users WHERE email = ?').get(normaliseEmail(email)) as UserRow | null;
  return row ? toUser(row) : null;
}

export function listUsers(): User[] {
  const rows = db.query('SELECT * FROM users ORDER BY email COLLATE NOCASE').all() as UserRow[];
  return rows.map(toUser);
}

export function countAdmins(): number {
  const row = db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
  return row.n;
}

export async function createUser(input: { email: string; password: string; role: Role }): Promise<User> {
  const email = normaliseEmail(input.email);
  assertValidEmail(email);

  if (findUserByEmail(email)) {
    throw conflict(`An account already exists for ${email}.`, { fields: { email: 'This email is already in use.' } });
  }

  const now = Date.now();
  const user: User = {
    id: crypto.randomUUID(),
    email,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };

  db.query(
    `INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
     VALUES ($id, $email, $passwordHash, $role, $createdAt, $updatedAt)`,
  ).run({
    $id: user.id,
    $email: user.email,
    $passwordHash: user.passwordHash,
    $role: user.role,
    $createdAt: user.createdAt,
    $updatedAt: user.updatedAt,
  });

  return user;
}

export function deleteUser(email: string): void {
  const user = requireUserByEmail(email);
  // Sessions cascade via the foreign key, so deletion also signs the user out.
  db.query('DELETE FROM users WHERE id = ?').run(user.id);
}

export function changeRole(email: string, role: Role): User {
  const user = requireUserByEmail(email);
  db.query('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, Date.now(), user.id);
  return { ...user, role };
}

export async function changePassword(email: string, password: string): Promise<User> {
  const user = requireUserByEmail(email);
  const passwordHash = await hashPassword(password);
  db.query('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, Date.now(), user.id);
  // A password change must invalidate anyone already holding a session for
  // this account — that is the entire point of changing it under duress.
  db.query('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return { ...user, passwordHash };
}

export function requireUserByEmail(email: string): User {
  const user = findUserByEmail(email);
  if (!user) {
    throw notFound(`No account found for ${normaliseEmail(email)}.`);
  }
  return user;
}
