/**
 * `make_slideshow`: the first action the kernel runs for the agent.
 *
 * Photos and clips the person sent, named by id, into a vertical video with
 * captions — the assembly itself is `@cortana/media`'s, and this is the action
 * around it: the input the agent may give, what it declares it touches, and the
 * sentence it comes back with.
 *
 * It declares no write. It adds a new file to the system's own store and
 * changes nothing that existed, which is not what `confirm = "writes"` exists to
 * catch — that is about effects that cannot be taken back, and a video nobody
 * else has seen is not one. Nor does it reach the network.
 */

import { MAX_CLIP_SECONDS, makeSlideshow, type Toolkit, VIDEO_TYPE } from '@cortana/media';
import { z } from 'zod';
import type { KernelAction } from './actions.ts';

/** The longest video one action makes. A short, not a film. */
const MAX_TOTAL_SECONDS = 120;

const input = z
  .object({
    slides: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[0-9a-f]{16}$/, 'an id is sixteen hex digits, as you were given it'),
          // How long each kind may be is the slideshow's to say: only the store
          // knows which an id is.
          seconds: z.number().min(1).max(MAX_CLIP_SECONDS).default(3),
          caption: z.string().max(120).default(''),
          from: z.number().min(0).default(0),
        }),
      )
      .min(1)
      .max(30),
  })
  .refine(
    (value) => value.slides.reduce((total, slide) => total + slide.seconds, 0) <= MAX_TOTAL_SECONDS,
    { message: `the whole video may be at most ${MAX_TOTAL_SECONDS} seconds`, path: ['slides'] },
  );

const counted = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

export function slideshowAction(toolkit: Toolkit): KernelAction<z.infer<typeof input>> {
  return {
    name: 'make_slideshow',
    description:
      'turns photos and video clips you were sent into one vertical 1080×1920 video for ' +
      'TikTok or Reels — one slide after another, each with an optional short caption drawn ' +
      'over it. A photo is shown for its seconds (1–10). A clip is cut: `seconds` of it ' +
      `(1–${MAX_CLIP_SECONDS}), starting \`from\` seconds in — use the frames you were shown ` +
      'to choose the stretch. No sound, a clip’s own included: the person adds it on the platform.',
    input:
      '{"slides":[{"id":"<id of a photo>","seconds":3,"caption":"A few words"},' +
      '{"id":"<id of a clip>","from":2,"seconds":5,"caption":"A few words"}]}',
    writes: false,
    network: false,
    schema: input,
    async run(value, context) {
      const video = await makeSlideshow({
        store: context.store,
        toolkit,
        slides: value.slides,
      });
      const seconds = value.slides.reduce((total, slide) => total + slide.seconds, 0);
      const clips = value.slides.filter(
        (slide) => context.store.get(slide.id)?.mediaType === VIDEO_TYPE,
      ).length;
      const photos = value.slides.length - clips;
      const made = [
        photos > 0 ? counted(photos, 'photo', 'photos') : null,
        clips > 0 ? counted(clips, 'clip', 'clips') : null,
      ]
        .filter((part) => part !== null)
        .join(' and ');
      return {
        summary: `made a ${seconds}-second vertical video from ${made}, held as ${video.id}`,
        files: [video.id],
      };
    },
  };
}
