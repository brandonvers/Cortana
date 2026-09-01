/**
 * The M1 assembly: what exists, in what order it comes up, and what order it
 * goes down in.
 *
 * The ordering is the whole content of this file, and it is not a preference.
 *
 *   start   storage -> writer -> bus -> instance record
 *   stop    instance record -> bus -> writer -> storage
 *
 * Reading the stop order backwards is the useful way to see why:
 *
 * - **The instance record is closed first because closing it is a write.** It
 *   sets `stoppedAt`, which has to reach the database before the writer stops
 *   accepting work. Put it any later and every clean shutdown would be recorded
 *   as an unclean one.
 * - **The bus closes before the writer drains**, so that no subscriber can
 *   react to a late event by queueing a write into a queue that is closing.
 * - **The writer drains before the database closes**, or the drained work would
 *   have nowhere to go.
 * - **The database closes last**, which is also when the write-ahead log is
 *   folded back into the file.
 *
 * The logger is not in this list. It belongs to whoever owns the process — the
 * plan puts flushing it after the database closes — and this package has no
 * opinion about processes.
 */

import type { Bus } from '@cortana/bus';
import { createBus } from '@cortana/bus';
import type { Config } from '@cortana/config';
import {
  AppError,
  type Clock,
  type InstanceId,
  type Logger,
  newInstanceId,
  systemClock,
} from '@cortana/core';
import {
  createWriter,
  instances,
  migrateToLatest,
  openStorage,
  type Storage,
  type Writer,
} from '@cortana/storage';
import { eq } from 'drizzle-orm';
import {
  type Component,
  createLifecycle,
  type HealthReport,
  type Lifecycle,
  type StopReport,
} from './lifecycle.ts';

export interface KernelEvents {
  'kernel.started': {
    readonly instanceId: InstanceId;
    readonly version: string;
    readonly startedAt: number;
  };
  /**
   * Published before anything is taken down, because by the time the sequence
   * runs the bus is one of the things being closed. There is deliberately no
   * `kernel.stopped`: nobody would be subscribed to receive it, and whoever
   * asked for the stop already has the report.
   */
  'kernel.stopping': { readonly reason: string };
}

export interface KernelOptions {
  readonly config: Config;
  readonly logger: Logger;
  /** Recorded against this run, so that "which build did that" has an answer. */
  readonly version: string;
  readonly clock?: Clock;
}

export interface RunningKernel {
  readonly instanceId: InstanceId;
  readonly storage: Storage;
  readonly writer: Writer;
  readonly bus: Bus<KernelEvents>;
  readonly lifecycle: Lifecycle;
  health(): Promise<HealthReport>;
  stop(reason: string): Promise<StopReport>;
}

export async function startKernel(options: KernelOptions): Promise<RunningKernel> {
  const clock = options.clock ?? systemClock;
  const log = options.logger;
  const instanceId = newInstanceId(clock.now());

  /**
   * Filled in by each component's `start()`.
   *
   * A holder rather than three `let`s, and not for tidiness: TypeScript narrows
   * a variable from its assignments, cannot see the ones inside these closures,
   * and would conclude the values are still `null` — which then makes the
   * not-null check narrow them to `never`. A property on an object is not
   * narrowed across the `await` that starts them.
   */
  const parts: {
    storage?: Storage;
    writer?: Writer;
    bus?: Bus<KernelEvents>;
  } = {};

  const storageComponent: Component = {
    name: 'storage',
    start() {
      const opened = openStorage({ dataDir: options.config.dataDir });
      parts.storage = opened;
      const result = migrateToLatest(opened);
      log.info('storage ready', {
        path: opened.path,
        migrationsApplied: result.applied,
        migrationsTotal: result.total,
      });
    },
    stop() {
      parts.storage?.close();
    },
    health() {
      try {
        parts.storage?.connection.prepare('select 1').get();
        return { status: 'ok' as const };
      } catch (error) {
        return { status: 'failing' as const, detail: String(error) };
      }
    },
  };

  const writerComponent: Component = {
    name: 'writer',
    start() {
      if (!parts.storage) throw new Error('storage must start before the writer');
      parts.writer = createWriter({ storage: parts.storage, clock });
    },
    async stop() {
      await parts.writer?.drain();
    },
    health() {
      const depth = parts.writer?.depth ?? 0;
      return {
        status: parts.writer?.draining ? ('degraded' as const) : ('ok' as const),
        detail: `${depth} unit(s) outstanding`,
      };
    },
  };

  const busComponent: Component = {
    name: 'bus',
    start() {
      parts.bus = createBus<KernelEvents>({
        // The reason the bus requires this rather than defaulting: a subscriber
        // throwing is a defect worth seeing, and it is not a reason to take the
        // process down or to lose the entry.
        onHandlerError: ({ event, position, error }) => {
          log.error('an event subscriber failed', { event, position, error: String(error) });
        },
      });
    },
    stop() {
      parts.bus?.close();
    },
  };

  const instanceComponent: Component = {
    name: 'instance-record',
    async start() {
      if (!parts.writer) throw new Error('the writer must start before the instance record');
      await parts.writer.write('record instance start', ({ db }) => {
        db.insert(instances)
          .values({ id: instanceId, version: options.version, startedAt: clock.now() })
          .run();
      });
    },
    async stop() {
      // A write, which is why this component stops before the writer drains.
      await parts.writer?.write('record instance stop', ({ db }) => {
        db.update(instances)
          .set({ stoppedAt: clock.now() })
          .where(eq(instances.id, instanceId))
          .run();
      });
    },
  };

  const lifecycle = createLifecycle({
    components: [storageComponent, writerComponent, busComponent, instanceComponent],
    logger: log,
    stopTimeoutMs: options.config.shutdown.timeoutMs,
    clock,
  });

  await lifecycle.start();

  // Every one of these is assigned by a component's start(), and the lifecycle
  // rolls back and throws rather than returning with one unstarted — so this
  // cannot fail. It is checked rather than asserted with a cast, because a cast
  // here would turn a broken invariant into `undefined` surfacing three layers
  // away instead of into a sentence naming what went wrong.
  const { storage, writer, bus } = parts;
  if (!storage || !writer || !bus) {
    throw new AppError('the kernel reported a successful start without assembling itself', {
      category: 'internal',
      code: 'kernel-assembly-incomplete',
      detail: { storage: Boolean(storage), writer: Boolean(writer), bus: Boolean(bus) },
    });
  }

  const startedAt = clock.now();
  // Only the identifier. The version is on every line already — the daemon puts
  // it in the logger's base — and repeating it here emitted the same key twice
  // in one JSON object, which some parsers resolve to the first value and some
  // to the last. It is also recorded durably in the instances row, which is the
  // copy that answers "which build did that" after the fact.
  log.info('kernel started', { instanceId });
  await bus.publish('kernel.started', {
    instanceId,
    version: options.version,
    startedAt,
  });

  return {
    instanceId,
    storage,
    writer,
    bus,
    lifecycle,
    health: () => lifecycle.health(),
    stop: async (reason: string) => {
      // Published before the sequence runs, because the bus is one of the
      // things the sequence closes.
      if (!bus.closed) await bus.publish('kernel.stopping', { reason });
      return lifecycle.stop(reason);
    },
  };
}
