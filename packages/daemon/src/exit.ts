/**
 * What each exit code means.
 *
 * They are distinct because systemd reports them and a person reads them at
 * three in the morning. "It exited 2" should be enough to know the operator has
 * to edit something rather than that the software is broken.
 *
 * `Restart=on-failure` in the unit file treats every non-zero code as a reason to
 * restart. That is right for `INTERNAL` and `START_FAILED`, which may be
 * transient, and wrong for `CONFIGURATION`, which will fail identically every
 * time — so the unit lists it in `RestartPreventExitStatus`.
 */
export const EXIT = {
  /** Stopped cleanly, everything drained. */
  OK: 0,
  /** A defect in this software, or something nobody anticipated. */
  INTERNAL: 1,
  /** The configuration is wrong. Restarting will not help; a person must act. */
  CONFIGURATION: 2,
  /** Something needed to start could not. May be transient — a locked database. */
  START_FAILED: 3,
  /** It stopped, but not cleanly: a component failed or ran out of time. */
  UNCLEAN_STOP: 4,
  /** An operator signalled twice and asked not to wait. */
  INSISTED: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
