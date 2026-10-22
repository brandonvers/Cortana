/**
 * What is in a clip, for a model that can only see pictures.
 *
 * The provider is shown images, never video. A clip the owner sent is kept as
 * it is — it is what goes into a slideshow — and the agent is shown a few of
 * its frames, spread evenly through it, each with the second it was taken at,
 * so that it can say which part of the clip to use.
 *
 * Measured with `ffprobe` and cut with `ffmpeg`. The path is the store's, the
 * output is a directory this module made, and no model text is anywhere near
 * either command.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '@cortana/core';
import type { Toolkit } from './slideshow.ts';

/** One frame of a clip: a JPEG, and the second it was taken at. */
export interface Frame {
  readonly at: number;
  readonly data: Uint8Array;
}

export interface VideoLook {
  readonly seconds: number;
  readonly frames: readonly Frame[];
}

/** The longest side of a frame shown to the model. Enough to read a screen. */
const FRAME_SIZE = 768;

/** How long one measurement or one frame may take. */
const STEP_TIMEOUT_MS = 30_000;

/**
 * When to take frames from a clip this long: about one every three seconds,
 * never fewer than three nor more than eight, each in the middle of its stretch
 * — so the first is not a black opening frame and the last not a closing one.
 */
export function frameTimes(seconds: number): number[] {
  if (!(seconds > 0)) return [];
  const count = seconds < 1 ? 1 : Math.min(8, Math.max(3, Math.round(seconds / 3)));
  return Array.from(
    { length: count },
    (_, at) => Math.round(((at + 0.5) * seconds * 10) / count) / 10,
  );
}

function run(program: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { timeout: STEP_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        reject(
          new AppError(
            `${program} could not read the clip: ${String(stderr).trim().split('\n').at(-1) || 'no reason given'}`,
            { category: 'internal', code: 'video-unreadable' },
          ),
        );
      },
    );
  });
}

/** How long a clip is, in seconds. */
export async function measureVideo(toolkit: Toolkit, path: string): Promise<number> {
  if (toolkit.ffprobe === null) {
    throw new AppError('this machine has no ffprobe, so a clip cannot be measured here', {
      category: 'contract',
      code: 'video-no-ffprobe',
    });
  }
  const out = await run(toolkit.ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const seconds = Number(out.trim());
  if (!(seconds > 0)) {
    throw new AppError('the clip has no length that could be measured', {
      category: 'internal',
      code: 'video-unreadable',
    });
  }
  return seconds;
}

/** A clip's length and frames from it, for the agent to see. */
export async function lookAtVideo(toolkit: Toolkit, path: string): Promise<VideoLook> {
  const seconds = await measureVideo(toolkit, path);
  if (toolkit.ffmpeg === null) {
    throw new AppError('this machine has no ffmpeg, so frames cannot be taken from a clip', {
      category: 'contract',
      code: 'video-no-ffmpeg',
    });
  }
  const ffmpeg = toolkit.ffmpeg;
  const work = mkdtempSync(join(tmpdir(), 'cortana-frames-'));
  try {
    const frames: Frame[] = [];
    for (const [index, at] of frameTimes(seconds).entries()) {
      const out = join(work, `frame-${index}.jpg`);
      await run(ffmpeg, [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        at.toFixed(2),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        `scale=${FRAME_SIZE}:${FRAME_SIZE}:force_original_aspect_ratio=decrease`,
        '-q:v',
        '5',
        '-y',
        out,
      ]);
      frames.push({ at, data: readFileSync(out) });
    }
    return { seconds, frames };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
