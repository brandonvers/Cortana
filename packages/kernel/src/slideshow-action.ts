/**
 * `make_slideshow`: the first action the kernel runs for the agent.
 *
 * Photos the person sent, named by id, into a vertical video with captions —
 * the assembly itself is `@cortana/media`'s, and this is the action around it:
 * the input the agent may give, what it declares it touches, and the sentence
 * it comes back with.
 *
 * It declares no write. It adds a new file to the system's own store and
 * changes nothing that existed, which is not what `confirm = "writes"` exists to
 * catch — that is about effects that cannot be taken back, and a video nobody
 * else has seen is not one. Nor does it reach the network.
 */

import { makeSlideshow, type Toolkit } from '@cortana/media';
import { z } from 'zod';
import type { KernelAction } from './actions.ts';

/** The longest video one action makes. A clip, not a film. */
const MAX_TOTAL_SECONDS = 120;

const input = z
  .object({
    photos: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[0-9a-f]{16}$/, 'an id is sixteen hex digits, as you were given it'),
          seconds: z.number().min(1).max(10).default(3),
          caption: z.string().max(120).default(''),
        }),
      )
      .min(1)
      .max(30),
  })
  .refine(
    (value) => value.photos.reduce((total, photo) => total + photo.seconds, 0) <= MAX_TOTAL_SECONDS,
    { message: `the whole video may be at most ${MAX_TOTAL_SECONDS} seconds`, path: ['photos'] },
  );

export function slideshowAction(toolkit: Toolkit): KernelAction<z.infer<typeof input>> {
  return {
    name: 'make_slideshow',
    description:
      'turns photos you were sent into a vertical 1080×1920 video for TikTok or Reels — one ' +
      'photo after another, each for its own number of seconds (1–10), each with an optional ' +
      'short caption drawn over it. No sound: the person adds it on the platform.',
    input:
      '{"photos":[{"id":"<id of a photo you were sent>","seconds":3,"caption":"A few words"}]}',
    writes: false,
    network: false,
    schema: input,
    async run(value, context) {
      const video = await makeSlideshow({
        store: context.store,
        toolkit,
        slides: value.photos,
      });
      const seconds = value.photos.reduce((total, photo) => total + photo.seconds, 0);
      return {
        summary:
          `made a ${seconds}-second vertical video from ${value.photos.length} ` +
          `photo${value.photos.length === 1 ? '' : 's'}, held as ${video.id}`,
        files: [video.id],
      };
    },
  };
}
