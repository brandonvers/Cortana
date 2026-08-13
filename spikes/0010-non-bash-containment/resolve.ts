/**
 * Spike 0010, Part 0 — settings delivery, before any question of enforcement.
 *
 * Spike 0008 spent eight runs measuring a sandbox it had never actually
 * reconfigured: `sandbox.bwrapPath` was supplied through the SDK `sandbox`
 * option, which its own typings say is "only honored from admin-controlled
 * managed settings". Nothing in that harness could tell the difference between
 * "the setting was applied and had no effect" and "the setting was dropped".
 *
 * `resolveSettings()` closes that gap for free. It runs the CLI's own merge
 * engine in-process, spawns nothing, costs nothing, and reports which tier
 * supplied each value. So this part asks the prior question:
 *
 *   Does the value arrive at all, and through which channel?
 *
 * **This proves delivery, not enforcement.** The SDK says so directly: it
 * "reports the raw settings cascade, not a security decision". A key that
 * survives the cascade may still be ignored by the sandbox at runtime. Part 0
 * can therefore only ever *disqualify* a channel, never bless one.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSettings, type Settings } from '@anthropic-ai/claude-agent-sdk';

const SHIM = '/nonexistent/bwrap-shim';

/**
 * Every sandbox key the kernel would need to set, and why we care.
 *
 * `restrictive` records the pre-registered prediction: the `managedSettings`
 * option is filtered through a "restrictive-key allowlist", so a key that only
 * *redirects* rather than *restricts* is predicted to be dropped. Writing the
 * prediction down is what makes the result a test rather than an observation.
 */
const PROBES = [
  { key: 'enabled', value: true, restrictive: true },
  { key: 'failIfUnavailable', value: true, restrictive: true },
  { key: 'allowUnsandboxedCommands', value: false, restrictive: true },
  { key: 'bwrapPath', value: SHIM, restrictive: false },
  { key: 'autoAllowBashIfSandboxed', value: false, restrictive: true },
] as const;

function sandboxBlock(): Settings {
  const sandbox: Record<string, unknown> = {};
  for (const p of PROBES) sandbox[p.key] = p.value;
  return { sandbox } as Settings;
}

type Row = { channel: string; key: string; landed: boolean; source?: string; origin?: string };

function readBack(resolved: Awaited<ReturnType<typeof resolveSettings>>, channel: string): Row[] {
  const effective = (resolved.effective.sandbox ?? {}) as Record<string, unknown>;
  const prov = resolved.provenance.sandbox;
  return PROBES.map((p) => {
    const landed = Object.hasOwn(effective, p.key) && effective[p.key] === p.value;
    return {
      channel,
      key: p.key,
      landed,
      source: prov?.source,
      origin: prov?.policyOrigin,
    };
  });
}

/** A pre-existing admin tier drops `managedSettings` entirely — that would confound every row below. */
async function preconditions(): Promise<boolean> {
  const base = await resolveSettings({ settingSources: [] });
  const policy = base.sources.filter((s) => s.source === 'managed');
  const foreign = policy.filter((s) => s.policyOrigin !== 'parent');

  console.log('--- preconditions ---');
  console.log(`policy-tier sources present: ${policy.length}`);
  for (const s of policy) {
    console.log(`  origin=${s.policyOrigin ?? '?'} path=${s.path ?? '(none)'}`);
  }
  const baseSandbox = base.effective.sandbox;
  console.log(`baseline sandbox settings on this machine: ${JSON.stringify(baseSandbox ?? null)}`);

  if (foreign.length > 0) {
    console.log(
      'PRECONDITION FAILED — an admin-controlled policy tier exists on this machine.\n' +
        '  `managedSettings` is dropped by default when one is present (parentSettingsBehavior:\n' +
        '  "first-wins"), so every Part 0 row would measure that drop rather than the filter.',
    );
    return false;
  }
  console.log(
    'OK — no foreign admin tier, so `managedSettings` applies as the sole policy tier.\n',
  );
  return true;
}

/**
 * The user tier reads `$HOME/.claude/settings.json`, so it can only be probed
 * under a scratch HOME — this spike does not write to the operator's real
 * config. Re-exec rather than mutate `process.env.HOME` in place, so the answer
 * does not depend on whether the SDK reads the variable lazily.
 */
function userChannel(): Row[] {
  const home = mkdtempSync(join(tmpdir(), 'spike0010-home-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(sandboxBlock()));
    const out = execFileSync(process.execPath, [new URL(import.meta.url).pathname], {
      env: { ...process.env, HOME: home, SPIKE_USER_PROBE: '1' },
      encoding: 'utf8',
    });
    return JSON.parse(out) as Row[];
  } catch (err) {
    console.log(`user channel probe failed: ${String(err)}`);
    return [];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Child mode: resolve the user tier under the scratch HOME and emit rows as JSON. */
if (process.env['SPIKE_USER_PROBE']) {
  const resolved = await resolveSettings({ settingSources: ['user'] });
  process.stdout.write(JSON.stringify(readBack(resolved, 'user')));
  process.exit(0);
}

async function main(): Promise<void> {
  const ok = await preconditions();
  const rows: Row[] = [];

  // Channel 1 — the SDK `managedSettings` option. The one channel spike 0008
  // named as the fix it never tried.
  rows.push(
    ...readBack(
      await resolveSettings({ settingSources: [], managedSettings: sandboxBlock() }),
      'managedSettings',
    ),
  );

  // Channels 2 and 3 — filesystem tiers, in a scratch directory. The docs say
  // project settings are ignored for several sandbox keys; spike 0008 noted
  // that this directory is one the sandbox leaves writable, which is why it
  // matters whether a project file can turn a restriction off.
  const dir = mkdtempSync(join(tmpdir(), 'spike0010-'));
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(sandboxBlock()));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(sandboxBlock()));

    rows.push(
      ...readBack(await resolveSettings({ cwd: dir, settingSources: ['project'] }), 'project'),
      ...readBack(await resolveSettings({ cwd: dir, settingSources: ['local'] }), 'local'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  rows.push(...userChannel());

  console.log('--- delivery ---');
  console.log('channel'.padEnd(17) + 'key'.padEnd(27) + 'landed  source/origin');
  for (const r of rows) {
    const where = r.landed ? `${r.source ?? '?'}${r.origin ? `/${r.origin}` : ''}` : '';
    console.log(
      r.channel.padEnd(17) + r.key.padEnd(27) + (r.landed ? 'yes ' : 'NO  ').padEnd(8) + where,
    );
  }

  const managed = rows.filter((r) => r.channel === 'managedSettings');
  const bwrap = managed.find((r) => r.key === 'bwrapPath');
  const gate = managed.find((r) => r.key === 'failIfUnavailable');

  console.log('\n--- what this decides ---');
  console.log(
    `0a  bwrapPath via managedSettings: ${bwrap?.landed ? 'LANDS' : 'DROPPED'}\n` +
      `      ${
        bwrap?.landed
          ? 'Part B can substitute a broken sandbox binary from an SDK embedding.'
          : 'Part B cannot run from an SDK embedding at all. The only remaining channel is a\n' +
            '      root-owned managed-settings.json — which a self-hosted install cannot assume.'
      }`,
  );
  console.log(
    `0b  failIfUnavailable via managedSettings: ${gate?.landed ? 'LANDS' : 'DROPPED'}\n` +
      `      ${
        gate?.landed
          ? 'The project requirement standing since spike 0004 has a delivery channel.\n' +
            '      Whether it changes any outcome is Part B, and is still unmeasured.'
          : 'The requirement standing since spike 0004 is undeliverable through the SDK.'
      }`,
  );
  if (!ok) console.log('\n(rows above are confounded — see preconditions)');
}

await main();
