import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { query, getClient } from '../../db/connection.js';
import type { PoolClient } from 'pg';

const mockGetOnChainCreditScore = jest.fn<(userPublicKey: string) => Promise<number>>();

jest.unstable_mockModule('../../services/sorobanService.js', () => ({
  sorobanService: {
    getOnChainCreditScore: mockGetOnChainCreditScore,
  },
}));

const { crossContractReconciler } = await import('../../services/crossContractReconciler.js');

let dbAvailable = false;

beforeAll(async () => {
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

const describeIfDb = (name: string, fn: () => void) => {
  if (dbAvailable || process.env.INTEGRATION_TESTS === 'true') {
    describe(name, fn);
  } else {
    describe.skip(`${name} (skipped: no database)`, fn);
  }
};

describeIfDb('Integration: crossContractReconciler against real schema', () => {
  let client: PoolClient;
  const matchedBorrower = 'G_RECONCILER_INT_MATCHED_BORROWER_840';
  const mismatchBorrower = 'G_RECONCILER_INT_MISMATCH_BORROWER_840';
  const repayEventId = 'evt_reconciler_int_repay_840';
  const scoreEventId = 'evt_reconciler_int_score_840';
  const mismatchEventId = 'evt_reconciler_int_default_840';
  const originalEnv = { ...process.env };

  async function cleanupTestRows(): Promise<void> {
    await query(
      `DELETE FROM cross_contract_reconciliation WHERE borrower IN ($1, $2) OR intent_key LIKE $3`,
      [matchedBorrower, mismatchBorrower, `%840%`],
    );
    await query(
      `DELETE FROM contract_events WHERE event_id IN ($1, $2, $3) OR address IN ($4, $5)`,
      [repayEventId, scoreEventId, mismatchEventId, matchedBorrower, mismatchBorrower],
    );
    await query(`DELETE FROM scores WHERE borrower IN ($1, $2)`, [
      matchedBorrower,
      mismatchBorrower,
    ]);
  }

  beforeAll(async () => {
    client = await getClient();
    await cleanupTestRows();
  });

  afterAll(async () => {
    try {
      await cleanupTestRows();
    } catch {
      // ignore cleanup errors when DB is unavailable
    }
    if (client) {
      client.release();
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanupTestRows();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('backfills a LoanRepaid event, matches its ScoreUpdated event, and is idempotent on re-run', async () => {
    await query(
      `INSERT INTO contract_events
         (event_id, contract_id, event_type, loan_id, address, amount, ledger, ledger_closed_at, tx_hash)
       VALUES
         ($1, 'CLOAN', 'LoanRepaid', 840, $3, 1000, 9000, NOW(), 'tx_repay_840'),
         ($2, 'CNFT', 'ScoreUpdated', 840, $3, NULL, 9002, NOW(), 'tx_score_840')`,
      [repayEventId, scoreEventId, matchedBorrower],
    );

    const firstResult = await crossContractReconciler.run();
    expect(firstResult.backfilledRows).toBeGreaterThanOrEqual(1);
    expect(firstResult.reconciledCount).toBeGreaterThanOrEqual(1);

    const rowResult = await query(
      `SELECT state, score_applied, score_ledger, attempts, expected_score_delta
       FROM cross_contract_reconciliation
       WHERE borrower = $1`,
      [matchedBorrower],
    );

    expect(rowResult.rows).toHaveLength(1);
    expect(rowResult.rows[0]).toMatchObject({
      state: 'reconciled',
      score_applied: true,
      score_ledger: 9002,
      attempts: 1,
      expected_score_delta: 10,
    });

    const secondResult = await crossContractReconciler.run();
    expect(secondResult.backfilledRows).toBe(0);

    const afterSecondRun = await query(
      `SELECT state, score_applied, score_ledger, attempts
       FROM cross_contract_reconciliation
       WHERE borrower = $1`,
      [matchedBorrower],
    );
    expect(afterSecondRun.rows).toHaveLength(1);
    expect(afterSecondRun.rows[0]?.attempts).toBe(1);
  });

  it('transitions a mismatched custody event without a matching score event through pending to compensated failure and applies on-chain score autocorrect', async () => {
    process.env.CROSS_RECONCILE_STALE_ATTEMPTS = '2';
    process.env.CROSS_RECONCILE_AUTOCORRECT_ENABLED = 'true';
    mockGetOnChainCreditScore.mockResolvedValue(645);

    await query(
      `INSERT INTO contract_events
         (event_id, contract_id, event_type, loan_id, address, amount, ledger, ledger_closed_at, tx_hash)
       VALUES
         ($1, 'CLOAN', 'LoanDefaulted', 841, $2, 500, 9100, NOW(), 'tx_default_841')`,
      [mismatchEventId, mismatchBorrower],
    );

    // Cycle 1: backfills row and keeps it pending (attempts = 1 < staleAttempts = 2)
    const firstRun = await crossContractReconciler.run();
    expect(firstRun.backfilledRows).toBeGreaterThanOrEqual(1);
    expect(firstRun.stillPendingCount).toBeGreaterThanOrEqual(1);

    const pendingRow = await query(
      `SELECT state, score_applied, score_ledger, attempts, expected_score_delta
       FROM cross_contract_reconciliation
       WHERE borrower = $1`,
      [mismatchBorrower],
    );
    expect(pendingRow.rows).toHaveLength(1);
    expect(pendingRow.rows[0]).toMatchObject({
      state: 'pending',
      score_applied: false,
      score_ledger: null,
      attempts: 1,
      expected_score_delta: -50,
    });

    // Cycle 2: reaches staleAttempts (2), triggers partial failure + saga compensation + score autocorrect
    const secondRun = await crossContractReconciler.run();
    expect(secondRun.halfAppliedCount).toBeGreaterThanOrEqual(1);
    expect(secondRun.compensatedCount).toBeGreaterThanOrEqual(1);
    expect(secondRun.correctedCount).toBeGreaterThanOrEqual(1);
    expect(mockGetOnChainCreditScore).toHaveBeenCalledWith(mismatchBorrower);

    const compensatedRow = await query(
      `SELECT state, score_applied, attempts
       FROM cross_contract_reconciliation
       WHERE borrower = $1`,
      [mismatchBorrower],
    );
    expect(compensatedRow.rows).toHaveLength(1);
    expect(compensatedRow.rows[0]?.state).toBe('failed');
    expect(Number(compensatedRow.rows[0]?.attempts)).toBeGreaterThanOrEqual(2);

    const scoreRow = await query(`SELECT score FROM scores WHERE borrower = $1`, [
      mismatchBorrower,
    ]);
    expect(scoreRow.rows).toHaveLength(1);
    expect(Number(scoreRow.rows[0]?.score)).toBe(645);
  });
});
