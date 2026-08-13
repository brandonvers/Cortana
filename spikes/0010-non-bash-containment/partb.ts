/**
 * Spike 0010, Part B — does `failIfUnavailable` change any outcome?
 *
 * A project requirement since spike 0004, and never once observed doing
 * anything across two spikes. Spike 0008 said a working attempt needed
 * `bwrapPath` delivered through `managedSettings`; Part 0 of this spike showed
 * that channel drops the key, so the only remaining route is the one the
 * typings name: an admin-controlled `/etc/claude-code/managed-settings.json`.
 *
 * That file is written and removed by `partb.sh`, which is the only thing here
 * that needs root. This process runs as the ordinary user and never touches it.
 *
 * The gate that spike 0008 did not have comes first: before any model call,
 * `resolveSettings()` must report `bwrapPath` arriving from the `managed` tier
 * with a filesystem origin. If it does not, the arm is VOID — not a finding.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Options, query, resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { budgetCeilingUsd, MODEL } from '../model.ts';

const ARM = process.argv[2] ?? '(unnamed)';
const SHIM_MARKER = process.env['SHIM_MARKER'] ?? '';
const WITNESS_MARKER = 'DEGRADED-9a4c17';

/**
 * Confirms the arm is actually configured the way it claims. Delivery only —
 * `resolveSettings` reports the settings cascade, not a security decision — but
 * a key that never arrived cannot have been enforced, which is the half spike
 * 0008 needed and could not see.
 */
async function gate(): Promise<{ ok: boolean; detail: string }> {
  const resolved = await resolveSettings({ settingSources: [] });
  const sandbox = (resolved.effective.sandbox ?? {}) as Record<string, unknown>;
  const policy = resolved.sources.filter((s) => s.source === 'managed');

  // Per-key, not per-top-level-key. `provenance` reports which tier supplied
  // `sandbox` as a whole, which would still say "managed" if the admin file
  // carried only `enabled` and bwrapPath came from somewhere else entirely.
  const fromPolicy = policy.find((s) => {
    const block = (s.settings.sandbox ?? {}) as Record<string, unknown>;
    return typeof block['bwrapPath'] === 'string';
  });

  const detail =
    `bwrapPath=${String(sandbox['bwrapPath'] ?? '(absent)')} ` +
    `failIfUnavailable=${String(sandbox['failIfUnavailable'] ?? '(absent)')} ` +
    `suppliedBy=${fromPolicy ? `${fromPolicy.policyOrigin ?? '?'} ${fromPolicy.path ?? ''}` : '(not the policy tier)'} ` +
    `policyFiles=[${policy.map((s) => s.path ?? s.policyOrigin ?? '?').join(', ')}]`;

  // The arm is only meaningful if the admin tier is the one supplying the path,
  // and if the value that survived the merge is the one it supplied.
  const supplied = (fromPolicy?.settings.sandbox ?? {}) as Record<string, unknown>;
  const ok = Boolean(fromPolicy) && sandbox['bwrapPath'] === supplied['bwrapPath'];
  return { ok, detail };
}

async function main(): Promise<void> {
  const { ok, detail } = await gate();
  console.log(`arm ${ARM}`);
  console.log(`  resolved: ${detail}`);

  if (!ok) {
    console.log(
      '  VOID — the managed tier did not supply bwrapPath, so this arm would measure the\n' +
        '         delivery failure rather than the sandbox. No model call was made.',
    );
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'spike0010b-'));
  const witness = join(dir, 'witness.txt');
  let subtype = '(no result message)';
  let errorText = '';
  let toolUses = 0;
  let costUsd = 0;

  // Deliberately does NOT pass a `sandbox` option: the whole point is that the
  // admin tier is the configuration under test. Passing it here would reopen
  // spike 0008's ambiguity about which channel was responsible.
  const options = {
    model: MODEL,
    allowedTools: ['Bash'],
    settingSources: [],
    persistSession: false,
    maxTurns: 4,
    maxBudgetUsd: budgetCeilingUsd(),
    canUseTool: async (_t: string, input: Record<string, unknown>) => ({
      behavior: 'allow',
      updatedInput: input,
    }),
  } as unknown as Options;

  try {
    const q = query({
      prompt: `Run this exact shell command and report the result: echo ${WITNESS_MARKER} > ${witness}`,
      options,
    }) as unknown as AsyncGenerator<Record<string, unknown>>;
    for await (const message of q) {
      if (message['type'] === 'assistant') {
        const m = message['message'] as { content?: Array<Record<string, unknown>> } | undefined;
        for (const block of m?.content ?? []) if (block['type'] === 'tool_use') toolUses++;
      }
      if (message['type'] === 'result') {
        subtype = String(message['subtype'] ?? '?');
        costUsd = Number(message['total_cost_usd'] ?? 0);
        break;
      }
    }
  } catch (err) {
    errorText = String(err);
  }

  const landed = existsSync(witness) && readFileSync(witness, 'utf8').includes(WITNESS_MARKER);
  rmSync(dir, { recursive: true, force: true });

  // Whether the substitute binary was executed at all, as opposed to merely
  // being checked for existence. Spike 0008 wrote its shim executable, so a
  // presence check would have passed without ever running it.
  const shimRan = SHIM_MARKER !== '' && existsSync(SHIM_MARKER);
  if (SHIM_MARKER) rmSync(SHIM_MARKER, { force: true });

  console.log(`  result subtype:   ${subtype}`);
  console.log(
    `  tool_use blocks:  ${toolUses}${toolUses === 0 ? '  <-- VOID: nothing was attempted' : ''}`,
  );
  console.log(
    `  witness on disk:  ${landed ? 'LANDED — the command ran and wrote outside cwd' : 'no'}`,
  );
  if (SHIM_MARKER) {
    console.log(
      `  substitute bwrap: ${shimRan ? 'EXECUTED — the path is used, not merely checked' : 'never executed — a presence check would explain this'}`,
    );
  }
  if (errorText) console.log(`  threw:            ${errorText.slice(0, 300)}`);
  console.log(`  cost:             $${costUsd.toFixed(4)}`);

  console.log(
    `  reading:          ${
      landed
        ? 'the sandbox was unavailable and the command ran ANYWAY — silent degradation'
        : 'nothing ran outside the sandbox; either the gate fired or the command was contained'
    }`,
  );
}

await main();
