import * as fs from "node:fs";

import { type TurnEntry, TurnWindowedKeyLog } from "./turn-window.ts";

// File-read tracker. Backs the read-before-edit gate (records reads, blocks
// edits to unread or changed files) and contributes its recent paths to the
// verifier's <RECENT_INSPECTIONS> evidence. The sliding-turn-window lifecycle
// (prune/clear/recentKeys + the window constant) is inherited from
// TurnWindowedKeyLog so it stays in lockstep with the other trackers.

export interface ReadEntry extends TurnEntry {
  /** Wall-clock time (ms since epoch) when the read tool fired. */
  readAt: number;
  /** File mtime (ms since epoch) captured immediately after the read. */
  modifiedAt: number;
  /** File size (bytes) captured immediately after the read. */
  size: number;
}

/** Reason a write/edit was blocked. Returned by `check()`. */
export interface BlockReason {
  block: true;
  reason: string;
}

interface ReadFingerprint {
  rawPath: string;
  canonicalPath: string;
  modifiedAt: number;
  size: number;
}

export class ReadTracker extends TurnWindowedKeyLog<ReadEntry> {
  private readonly pendingReads = new Map<string, ReadFingerprint>();

  /**
   * Capture a non-authorizing fingerprint immediately before a read executes.
   * The matching successful result must complete it before the path enters the
   * authorization log.
   */
  beginRead(toolCallId: string, rawPath: string): void {
    const fingerprint = this.captureFingerprint(rawPath);
    if (fingerprint) this.pendingReads.set(toolCallId, fingerprint);
    else this.pendingReads.delete(toolCallId);
  }

  /**
   * Complete a pending read. Failed reads are discarded. Successful reads
   * authorize only when the path, mtime, and size still match the pre-read
   * fingerprint, preventing stale content from authorizing an edit.
   */
  completeRead(toolCallId: string, succeeded: boolean): void {
    const fingerprint = this.pendingReads.get(toolCallId);
    this.pendingReads.delete(toolCallId);
    if (!succeeded || !fingerprint) return;

    let canonicalPath: string;
    let stat: fs.Stats;
    try {
      canonicalPath = fs.realpathSync(fingerprint.rawPath);
      stat = fs.statSync(canonicalPath);
    } catch {
      return;
    }
    if (
      canonicalPath !== fingerprint.canonicalPath ||
      stat.mtimeMs !== fingerprint.modifiedAt ||
      stat.size !== fingerprint.size
    ) {
      return;
    }
    this.recordFingerprint(fingerprint);
  }

  /**
   * Record a trusted current file state. Used after successful writes so
   * consecutive edits remain allowed.
   */
  record(rawPath: string): void {
    const fingerprint = this.captureFingerprint(rawPath);
    if (fingerprint) this.recordFingerprint(fingerprint);
  }

  private captureFingerprint(rawPath: string): ReadFingerprint | null {
    try {
      const canonicalPath = fs.realpathSync(rawPath);
      const stat = fs.statSync(canonicalPath);
      return {
        rawPath,
        canonicalPath,
        modifiedAt: stat.mtimeMs,
        size: stat.size,
      };
    } catch {
      return null;
    }
  }

  private recordFingerprint(fingerprint: ReadFingerprint): void {
    this.log.set(fingerprint.canonicalPath, {
      readAt: Date.now(),
      modifiedAt: fingerprint.modifiedAt,
      size: fingerprint.size,
      turn: this.currentTurn,
    });
  }

  /**
   * Check whether an edit/write is allowed.
   *
   *   - returns null when allowed
   *   - returns { block: true, reason } when blocked
   *
   * Three cases:
   *   1. Path does not resolve (likely a new file being created): allow.
   *   2. Path is not in the read log (not read within the current window,
   *      or never read) but exists: block with "Read the file before
   *      editing it." The agent must call the read tool first.
   *   3. Path was recorded but file changed on disk (mtime or size
   *      differs): block with "File has been modified since you read it."
   *      Catches modifications by external tools (formatters, bash
   *      scripts, the user's editor) since the read. This mtime/size
   *      revalidation is what keeps the wider window safe: a stale read
   *      never authorizes an edit to a file that changed underneath it.
   */
  check(rawPath: string): BlockReason | null {
    let canonical: string;
    try {
      canonical = fs.realpathSync(rawPath);
    } catch {
      return null;
    }
    const entry = this.log.get(canonical);
    if (!entry) {
      return {
        block: true,
        reason: "Read the file before editing it. (read log keeps the last few turns)",
      };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(canonical);
    } catch {
      return null;
    }
    if (stat.mtimeMs !== entry.modifiedAt || stat.size !== entry.size) {
      return {
        block: true,
        reason: "File has been modified since you read it. Re-read before editing.",
      };
    }
    return null;
  }

  /**
   * Refresh the entry for a path that was just written. Without this, every
   * consecutive edit to the same file in one turn would be blocked by the
   * mtime check — the agent's own write would invalidate the entry it just
   * recorded. Re-stamps the entry on the current turn.
   */
  refresh(rawPath: string): void {
    this.record(rawPath);
  }

  override clear(): void {
    super.clear();
    this.pendingReads.clear();
  }

  /**
   * Canonical paths still inside the sliding window. Unioned with
   * InspectionTracker.recentPaths() at agent_end to feed <RECENT_INSPECTIONS>.
   */
  recentPaths(): readonly string[] {
    return this.recentKeys();
  }

  /** Read-only snapshot of canonical paths in the log. Used by tests. */
  paths(): readonly string[] {
    return this.recentKeys();
  }

  /** Read-only snapshot of an entry, or undefined. Used by tests. */
  entry(canonicalPath: string): Readonly<ReadEntry> | undefined {
    return this.log.get(canonicalPath);
  }
}
