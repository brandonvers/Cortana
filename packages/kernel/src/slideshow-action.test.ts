import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, socketPathFor } from '@cortana/channel';
import type { Config } from '@cortana/config';
import { recordingLogger } from '@cortana/core/testing';
import { createMediaStore, findToolkit, type Toolkit } from '@cortana/media';
import { fakeRunner } from '@cortana/runner/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningKernel, startKernel } from './kernel.ts';
import { slideshowAction } from './slideshow-action.ts';

let root: string;
let config: Config;
let kernel: RunningKernel | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-sl-'));
  kernel = null;
  config = {
    dataDir: join(root, 'state'),
    log: { level: 'error' },
    audit: { retentionDays: 90 },
    agent: {
      persona: 'You are Cortana.',
      tier: 'balanced',
      tools: [],
      actions: ['make_slideshow'],
      readable: [],
      writable: [],
      confirm: 'writes',
    },
    roster: { directory: '/etc/cortana/agents', idleTtlMs: 300_000, maxAwake: 4 },
    shutdown: { timeoutMs: 5_000 },
  };
});

afterEach(async () => {
  await kernel?.stop('test over');
  rmSync(root, { recursive: true, force: true });
});

const toolkit = findToolkit();

/** A held photo, put where the daemon's store will find it, before the daemon starts. */
function heldPhoto(): string {
  const file = join(root, 'photo.jpg');
  execFileSync(toolkit.ffmpeg as string, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x480:rate=1',
    '-frames:v',
    '1',
    '-y',
    file,
  ]);
  return createMediaStore({ dir: join(config.dataDir, 'media') }).put(readFileSync(file)).id;
}

async function ask(id: string, kit: Toolkit, reply = 'Here is your video.') {
  const runner = fakeRunner({
    values: [
      {
        reply: 'Making it.',
        actions: [
          {
            tool: 'make_slideshow',
            path: null,
            writes: false,
            network: false,
            why: 'the person asked for a video',
            input: JSON.stringify({ photos: [{ id, seconds: 1.5, caption: 'Vízpumpa kész' }] }),
          },
        ],
      },
      { reply, actions: [] },
    ],
  });
  kernel = await startKernel({
    config,
    logger: recordingLogger(),
    version: '0.4.0',
    openRunner: async () => runner,
    actions: [slideshowAction(kit)],
  });
  const client = await connect({ path: socketPathFor(config.dataDir), onAsk: async () => false });
  try {
    return { said: await client.say('make a video of it'), runner };
  } finally {
    client.close();
  }
}

describe.skipIf(toolkit.ffmpeg === null || toolkit.font === null)('a video asked for', () => {
  it('is made from a held photo and sent with the reply', async () => {
    const { said, runner } = await ask(heldPhoto(), toolkit);

    expect(runner.turns[1]?.prompt).toContain(
      'make_slideshow: done — made a 1.5-second vertical video from 1 photo',
    );
    expect(said).toMatch(
      /^Here is your video\.\n\[attached: [0-9a-f]{16} \(video\/mp4, \d+ KB\)\]$/,
    );
  }, 60_000);
});

describe('a video that cannot be made here', () => {
  it('reaches the agent as a sentence it can tell the person', async () => {
    const { runner } = await ask('0123456789abcdef', { ffmpeg: null, font: null }, 'Sorry.');

    expect(runner.turns[1]?.prompt).toContain(
      'make_slideshow: not done — this machine has no ffmpeg that can draw captions',
    );
  });
});

describe('what the action takes', () => {
  const schema = slideshowAction({ ffmpeg: null, font: null }).schema;
  const photo = (seconds: number) => ({ id: '0123456789abcdef', seconds, caption: '' });

  it('fills in a duration and an empty caption when they are left out', () => {
    expect(schema.parse({ photos: [{ id: '0123456789abcdef' }] })).toEqual({
      photos: [{ id: '0123456789abcdef', seconds: 3, caption: '' }],
    });
  });

  it('refuses a clip longer than two minutes, or a photo shown for too long', () => {
    expect(schema.safeParse({ photos: Array.from({ length: 13 }, () => photo(10)) }).success).toBe(
      false,
    );
    expect(schema.safeParse({ photos: [photo(11)] }).success).toBe(false);
  });

  it('refuses anything that is not an id as it was given', () => {
    expect(schema.safeParse({ photos: [{ id: '../../etc/passwd' }] }).success).toBe(false);
    expect(schema.safeParse({ photos: [] }).success).toBe(false);
  });

  it('declares that it writes nothing that existed and reaches no network', () => {
    const action = slideshowAction({ ffmpeg: null, font: null });
    expect({ writes: action.writes, network: action.network }).toEqual({
      writes: false,
      network: false,
    });
  });
});
