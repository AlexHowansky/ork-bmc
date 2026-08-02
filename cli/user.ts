#!/usr/bin/env bun
/**
 * Account management CLI.
 *
 * The only way to create a Battle Map Curator account — the web app has no
 * registration path. Fully non-interactive: every argument comes from argv.
 *
 *   bun run cli/user.ts create          --email a@b.c --password 'secret' --role admin
 *   bun run cli/user.ts delete          --email a@b.c
 *   bun run cli/user.ts list            [--json]
 *   bun run cli/user.ts change-role     --email a@b.c --role viewer
 *   bun run cli/user.ts change-password --email a@b.c --password 'secret'
 */
import { parseArgs } from 'node:util';

import { assertPasswordAcceptable } from '../src/auth/password.ts';
import { destroySessionsForUser } from '../src/auth/session.ts';
import { config } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { isAppError } from '../src/errors.ts';
import {
  ROLES,
  changePassword,
  changeRole,
  countAdmins,
  createUser,
  deleteUser,
  isRole,
  listUsers,
  normaliseEmail,
  requireUserByEmail,
  type Role,
} from '../src/models/users.ts';

const COMMANDS = ['create', 'delete', 'list', 'change-role', 'change-password'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `Battle Map Curator — account management

Usage: bun run cli/user.ts <command> [options]

Commands:
  create           --email <address> --password <secret> --role <admin|viewer>
  delete           --email <address>
  list             [--json]
  change-role      --email <address> --role <admin|viewer>
  change-password  --email <address> --password <secret>

Options:
  --email <address>     Account email address.
  --password <secret>   New password (minimum ${config.minPasswordLength} characters).
  --password-stdin      Read the password from standard input instead of argv.
                        Preferred: an argv password is visible to other users
                        via 'ps' and is recorded in your shell history.
  --role <role>         One of: ${ROLES.join(', ')}.
  --json                Machine-readable output (list only).
  --help                Show this message.

Examples:
  bun run cli/user.ts create --email gm@example.com --password 'correct horse battery' --role admin
  printf '%s' "$PASSWORD" | bun run cli/user.ts create --email p@example.com --password-stdin --role viewer
  bun run cli/user.ts list --json
`;

class UsageError extends Error {}

function fail(message: string, code = 1): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

async function readPassword(values: { password?: string; 'password-stdin'?: boolean }): Promise<string> {
  if (values['password-stdin']) {
    if (values.password !== undefined) {
      throw new UsageError('Use either --password or --password-stdin, not both.');
    }
    const password = (await Bun.stdin.text()).replace(/\r?\n$/, '');
    if (!password) throw new UsageError('No password was received on standard input.');
    return password;
  }

  if (values.password === undefined) {
    throw new UsageError('A password is required: pass --password <secret> or --password-stdin.');
  }
  return values.password;
}

function requireEmail(email: string | undefined): string {
  if (!email) throw new UsageError('An email address is required: pass --email <address>.');
  return normaliseEmail(email);
}

function requireRole(role: string | undefined): Role {
  if (!role) throw new UsageError(`A role is required: pass --role <${ROLES.join('|')}>.`);
  if (!isRole(role)) throw new UsageError(`"${role}" is not a valid role. Use one of: ${ROLES.join(', ')}.`);
  return role;
}

const article = (word: string): string => ('aeiou'.includes(word[0]?.toLowerCase() ?? '') ? 'an' : 'a');

/** Warns when an action leaves the instance with no administrator. */
function warnIfLastAdmin(currentRole: Role, action: string): void {
  if (currentRole === 'admin' && countAdmins() <= 1) {
    console.warn(
      `Warning: this was the last administrator. After ${action}, no one can upload or edit maps\n` +
        `         until you create another admin account.`,
    );
  }
}

async function run(argv: string[]): Promise<void> {
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }

  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`Unknown command "${command}". Expected one of: ${COMMANDS.join(', ')}.`);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: {
        email: { type: 'string' },
        password: { type: 'string' },
        'password-stdin': { type: 'boolean' },
        role: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'Could not parse the arguments.');
  }

  const { values } = parsed;

  if (values.help) {
    console.log(USAGE);
    return;
  }

  // Every command touches the database, so make sure the schema is current.
  await migrate();

  switch (command as Command) {
    case 'create': {
      const email = requireEmail(values.email);
      const role = requireRole(values.role);
      const password = await readPassword(values);
      assertPasswordAcceptable(password);

      const user = await createUser({ email, password, role });
      console.log(`Created ${article(role)} ${role} account for ${user.email}.`);
      break;
    }

    case 'delete': {
      const email = requireEmail(values.email);
      const user = requireUserByEmail(email);
      warnIfLastAdmin(user.role, 'deleting it');

      deleteUser(email);
      console.log(`Deleted ${user.email} and signed out any active sessions.`);
      break;
    }

    case 'list': {
      const users = listUsers();

      if (values.json) {
        console.log(
          JSON.stringify(
            users.map((u) => ({
              id: u.id,
              email: u.email,
              role: u.role,
              createdAt: new Date(u.createdAt).toISOString(),
            })),
            null,
            2,
          ),
        );
        break;
      }

      if (users.length === 0) {
        console.log('No accounts yet. Create one with:\n  bun run cli/user.ts create --email <address> --password <secret> --role admin');
        break;
      }

      const width = Math.max(5, ...users.map((u) => u.email.length));
      console.log(`${'EMAIL'.padEnd(width)}  ${'ROLE'.padEnd(6)}  CREATED`);
      for (const user of users) {
        console.log(
          `${user.email.padEnd(width)}  ${user.role.padEnd(6)}  ${new Date(user.createdAt).toISOString().slice(0, 10)}`,
        );
      }
      console.log(`\n${users.length} account${users.length === 1 ? '' : 's'}.`);
      break;
    }

    case 'change-role': {
      const email = requireEmail(values.email);
      const role = requireRole(values.role);
      const user = requireUserByEmail(email);

      if (user.role === role) {
        console.log(`${user.email} is already ${article(role)} ${role}. No change made.`);
        break;
      }
      if (role !== 'admin') warnIfLastAdmin(user.role, 'the change');

      changeRole(email, role);
      // A demoted admin must not keep admin rights on an open tab.
      destroySessionsForUser(user.id);
      console.log(`${user.email} is now ${article(role)} ${role}. Active sessions were signed out.`);
      break;
    }

    case 'change-password': {
      const email = requireEmail(values.email);
      const password = await readPassword(values);
      assertPasswordAcceptable(password);

      const user = requireUserByEmail(email);
      await changePassword(email, password);
      console.log(`Password updated for ${user.email}. Active sessions were signed out.`);
      break;
    }
  }
}

try {
  await run(process.argv.slice(2));
  process.exit(0);
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`Error: ${error.message}\n`);
    console.error(`Run 'bun run cli/user.ts --help' for usage.`);
    process.exit(2);
  }
  if (isAppError(error)) {
    // Field-level validation messages are the useful part for a CLI user.
    const detail = error.fields ? Object.values(error.fields).join(' ') : error.userMessage;
    fail(detail);
  }
  fail(error instanceof Error ? error.message : String(error));
}
