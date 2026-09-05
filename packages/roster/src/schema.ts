/**
 * What the database knows about an agent, which is deliberately not its
 * definition.
 *
 * The M4 plan's first decision, in table form: **whoever wrote it, owns it.**
 * An agent you authored lives in a file — in git, reviewable, shippable by a
 * module — and this table holds only what a *running* system needs to remember
 * about it. An agent the system created and promoted has nowhere else to live,
 * so its definition is here, and `origin` is what says which is which.
 *
 * Two failures that shape is chosen to avoid. A daemon that wrote authored
 * definitions back into the database would make your file and its copy disagree
 * the first time you edited one, with nothing to say which was current. A daemon
 * that wrote created agents into your directory would be editing files you also
 * edit, in a repository you also commit.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable(
  'agents',
  {
    /** The name it is addressed by, which is also the filename for an authored one. */
    name: text('name').primaryKey(),
    /**
     * Where the definition comes from.
     *
     * `authored` means a file is the truth and `definition` below is null.
     * `created` means this row is the truth, because nothing else holds it.
     */
    origin: text('origin', { enum: ['authored', 'created'] }).notNull(),
    /**
     * The definition, as JSON, for a created agent — and null for an authored
     * one.
     *
     * Null rather than a copy. A copy would be a second answer to "what is this
     * agent", and the whole point of the split is that there is one.
     */
    definition: text('definition'),
    /**
     * `dormant` unless something is using it. [ADR-0006](../../../docs/adr/0006-dormancy-is-the-default.md):
     * residency is an identity, not a running process.
     *
     * The column exists here; the state machine that moves it is M4 step 2. A
     * row written now is written as `dormant`, which is true and stays true
     * until something can wake it.
     */
    state: text('state', { enum: ['dormant', 'warming', 'active', 'idle'] })
      .notNull()
      .default('dormant'),
    stateChangedAt: integer('state_changed_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('agents_state_idx').on(table.state)],
);

export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
