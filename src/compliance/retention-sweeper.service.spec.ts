import { describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../app-config/app-config.service';
import { ComplianceService } from './compliance.service';
import { RetentionSweeperService } from './retention-sweeper.service';

function build(over: { enabled?: boolean; sweepThrows?: Error } = {}) {
  const configGet = vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(over.enabled);
  const applyRetentionAsSystem = vi
    .fn<() => Promise<{ deleted: number }>>()
    .mockImplementation(() => {
      if (over.sweepThrows) return Promise.reject(over.sweepThrows);
      return Promise.resolve({ deleted: 4 });
    });
  const retentionDays = vi.fn<() => Promise<number>>().mockResolvedValue(2920);

  return {
    sweeper: new RetentionSweeperService(
      { get: configGet } as unknown as AppConfigService,
      { applyRetentionAsSystem, retentionDays } as unknown as ComplianceService,
    ),
    applyRetentionAsSystem,
  };
}

/**
 * *** THIS ONE SHIPS OFF, UNLIKE EVERY OTHER SWEEPER. ***
 *
 * The others do recoverable things — a slot released early can be rebooked, an
 * alert raised twice can be closed. This DELETES AUDIT ENTRIES, and an entry
 * deleted is gone. Until the client's counsel has signed a retention period off,
 * the shipped default is a guess, and a guess that silently erases evidence on a
 * schedule is not a default anybody should inherit.
 */
describe('RetentionSweeperService', () => {
  it('does nothing at all when nobody has turned it on', async () => {
    const { sweeper, applyRetentionAsSystem } = build();
    await sweeper.sweep();
    expect(applyRetentionAsSystem).not.toHaveBeenCalled();
  });

  it('does nothing when it is explicitly disabled', async () => {
    const { sweeper, applyRetentionAsSystem } = build({ enabled: false });
    await sweeper.sweep();
    expect(applyRetentionAsSystem).not.toHaveBeenCalled();
  });

  it('sweeps once the client turns it on', async () => {
    const { sweeper, applyRetentionAsSystem } = build({ enabled: true });
    await sweeper.sweep();
    expect(applyRetentionAsSystem).toHaveBeenCalledTimes(1);
  });

  /**
   * Runs as the PLATFORM, not as a person. "Who deleted these entries" must not
   * answer with the name of whichever admin happened to be configured — nobody
   * clicked it, and a trail that implies somebody did is worse than one that
   * says nothing.
   */
  it('runs as the system, taking no actor', async () => {
    const { sweeper, applyRetentionAsSystem } = build({ enabled: true });
    await sweeper.sweep();
    expect(applyRetentionAsSystem.mock.calls[0]).toEqual([]);
  });

  /** A failed sweep must not stop the next one. What it missed is still old. */
  it('swallows a failure so tomorrow’s run still happens', async () => {
    const { sweeper } = build({ enabled: true, sweepThrows: new Error('database down') });
    await expect(sweeper.sweep()).resolves.toBeUndefined();
  });

  it('does not overlap itself on a slow run', async () => {
    const { sweeper, applyRetentionAsSystem } = build({ enabled: true });
    await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    // The second call finds the first still running and returns immediately.
    expect(applyRetentionAsSystem.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
