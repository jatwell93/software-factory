/**
 * The spec-source adapter contract. The factory reads and updates a change only
 * through this interface, so the router, the guard and the workflows never name
 * a spec framework. Each method may return a value or a promise of one.
 *
 * Every adapter runs the shared suite in contract-suite.js; see contract.js.
 */

export type MaybePromise<T> = T | Promise<T>;

export interface ChangeSummary {
  /** Lowercase letters, digits and hyphens, at most change_id_max_length. */
  id: string;
}

export interface Task {
  /** The id the spec source uses for the task, for example "2.1". */
  id: string;
  title: string;
  done: boolean;
  /** True for a task only the owner can do: the factory escalates it, never runs it. */
  owner: boolean;
  /** Ids of tasks that must be done first. Empty when none. */
  blockedBy: string[];
  /** Number of the GitHub issue published for the task, when there is one. */
  issue?: number;
}

export interface Autonomy {
  /** The only value in use: the owner always merges. */
  merge: 'human';
  /** per-change keeps every task on one PR; per-task opens one PR per task. */
  pr: 'per-task' | 'per-change';
  /** Paths this change adds to the protected baseline. */
  noGo: string[];
  /** An existing issue the factory reports on, when the change names one. */
  issue?: number;
}

export interface SpecSourceAdapter {
  /** The value a consumer puts in spec_source. */
  readonly name: string;

  /** Active changes, not archived ones. */
  listChanges(): MaybePromise<ChangeSummary[]>;

  /** A change's tasks in order. Rejects when the change does not exist. */
  listTasks(changeId: string): MaybePromise<Task[]>;

  /** The change's autonomy settings with defaults applied. Rejects when the change does not exist. */
  readAutonomy(changeId: string): MaybePromise<Autonomy>;

  /** Mark a task done. Doing it twice changes nothing. Rejects when the change or the task does not exist. */
  tickTask(changeId: string, taskId: string): MaybePromise<void>;

  /** Archive a finished change: it leaves listChanges. Rejects when the change does not exist. */
  archive(changeId: string): MaybePromise<void>;

  /** Create an empty change and return where it lives. Rejects when the id is taken. */
  scaffold(changeId: string, options?: { title?: string }): MaybePromise<{ path: string }>;

  /**
   * Prepare a project to use the spec source, for example run openspec init.
   * Safe to run again: the second run reports changed: false.
   */
  setup(projectRoot: string): MaybePromise<{ changed: boolean }>;

  /**
   * True when the change has been archived. False for an active or unknown
   * change: it never rejects, so the router can ask about any id.
   */
  isArchived(changeId: string): MaybePromise<boolean>;

  /**
   * The archived change's title (its proposal heading, without a "Proposal:"
   * prefix), or '' when the change is not archived or has no heading. The
   * factory names a finished per-change PR after it.
   */
  archivedTitle(changeId: string): MaybePromise<string>;
}
