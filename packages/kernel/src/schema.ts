/**
 * What the kernel remembers about a conversation between processes.
 *
 * One row per agent: the token its runner gave out to continue the
 * conversation, and which runner gave it. Every deploy restarts the daemon,
 * and without this every deploy was the agent forgetting what it had just been
 * told.
 *
 * Not memory. The conversation itself lives where the provider keeps it, and
 * this table holds only the handle to it — which is why a row is worth nothing
 * to any runner but the one that wrote it, and is ignored by any other.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const agentSessions = sqliteTable('agent_sessions', {
  /** Which agent's conversation. `main` for the one the person talks to. */
  agent: text('agent').primaryKey(),
  /** The runner that issued the token. A token is meaningless to any other. */
  runner: text('runner').notNull(),
  /** The runner's token, opaque here. */
  resume: text('resume').notNull(),
  /** Epoch milliseconds. */
  updatedAt: integer('updated_at').notNull(),
});
