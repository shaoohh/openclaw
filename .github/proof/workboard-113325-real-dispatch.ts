import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dispatchAndStartWorkboardCards,
  type WorkboardSubagentRuntime,
} from "../../extensions/workboard/src/dispatcher.js";
import { createWorkboardSqliteStores } from "../../extensions/workboard/src/sqlite-store.js";
import { WorkboardStore } from "../../extensions/workboard/src/store.js";

const CLAIM_RECLAIM_GRACE_MS = 5 * 60 * 1000;
const PR_HEAD_SHA = "24ca647d061890d131e8756f8e78ca2b56e501a1";
const PROOF_RUN_ID = "proof-run-113325";

function assertProof(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`proof assertion failed: ${message}`);
  }
}

async function waitUntil(timestamp: number): Promise<void> {
  const delay = Math.max(0, timestamp - Date.now());
  if (delay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

function openStore(dbPath: string) {
  const stores = createWorkboardSqliteStores({ dbPath });
  return {
    store: new WorkboardStore(stores.cards, {
      boards: stores.boards,
      subscriptions: stores.subscriptions,
      attachments: stores.attachments,
      dataVersion: stores.dataVersion,
    }),
    close: stores.close,
  };
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-proof-"));
const dbPath = path.join(stateDir, "workboard.sqlite");
const primary = openStore(dbPath);

try {
  const stale = await primary.store.create({
    title: "Abandoned product run",
    status: "running",
    agentId: "proof-owner",
    boardId: "product",
    execution: {
      id: "stale-execution",
      kind: "agent-session",
      mode: "autonomous",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
    },
  });
  const claimed = await primary.store.claim(stale.id, {
    ownerId: "proof-owner",
    token: "proof-token-not-logged",
    ttlSeconds: 1,
  });
  const target = await primary.store.create({
    title: "Ready operations work",
    status: "ready",
    agentId: "proof-owner",
    boardId: "ops",
    workspaceAccess: { unrestricted: true },
  });
  const expiresAt = claimed.card.metadata?.claim?.expiresAt;
  assertProof(expiresAt, "the source card must have a finite claim expiry");

  let runCalls = 0;
  const subagent: WorkboardSubagentRuntime = {
    async run(input) {
      runCalls += 1;
      assertProof(input.sessionKey.includes(target.id), "the target card must reach the worker boundary");
      console.log(
        `[trace] worker_boundary invoked=true calls=${runCalls} session_target=true lane=${input.lane}`,
      );
      return { runId: PROOF_RUN_ID };
    },
  };
  const options = {
    boardId: "ops",
    maxStarts: 1,
    workspaceAccess: { unrestricted: true as const },
  };

  console.log(
    `[trace] setup sqlite=true ttl_ms=1000 reclaim_grace_ms=${CLAIM_RECLAIM_GRACE_MS} cross_board=true stale_status=running stale_execution=running exact_head=${PR_HEAD_SHA}`,
  );

  // Use the wall clock, not the dispatcher's injectable `now`, so this proves
  // the shipped grace interval and capacity decision together.
  await waitUntil(expiresAt + 1_500);
  const withinGraceNow = Date.now();
  assertProof(withinGraceNow > expiresAt, "the source claim must already be expired");
  assertProof(
    withinGraceNow - expiresAt < CLAIM_RECLAIM_GRACE_MS,
    "the first dispatch must remain inside the late-heartbeat grace window",
  );
  const withinGrace = await dispatchAndStartWorkboardCards({
    store: primary.store,
    subagent,
    options,
  });
  const staleWithinGrace = await primary.store.get(stale.id);
  assertProof(withinGrace.started.length === 0, "an expired claim inside grace must reserve capacity");
  assertProof(runCalls === 0, "the worker boundary must not run inside grace");
  assertProof(staleWithinGrace?.metadata?.claim, "board-scoped dispatch must retain the other claim");
  assertProof(staleWithinGrace.status === "running", "the source card must remain running inside grace");
  assertProof(
    staleWithinGrace.execution?.status === "running",
    "the source execution must remain running inside grace",
  );
  console.log(
    "[trace] within_grace expired=true claim_present=true stale_status=running stale_execution=running started=0 worker_calls=0 capacity_reserved=true",
  );

  const reclaimableAt = expiresAt + CLAIM_RECLAIM_GRACE_MS + 1_500;
  console.log(
    `[trace] waiting_for_reclaimable wall_clock_ms=${Math.max(0, reclaimableAt - Date.now())}`,
  );
  await waitUntil(reclaimableAt);
  const afterGrace = await dispatchAndStartWorkboardCards({
    store: primary.store,
    subagent,
    options,
  });
  const staleAfterGrace = await primary.store.get(stale.id);
  const targetAfterGrace = await primary.store.get(target.id);
  assertProof(afterGrace.started.length === 1, "the target must start after grace");
  assertProof(afterGrace.started[0]?.cardId === target.id, "the started card must be the ops target");
  assertProof(runCalls === 1, "the worker boundary must run exactly once after grace");
  assertProof(
    staleAfterGrace?.metadata?.claim,
    "the other-board claim must remain for its normal cleanup path",
  );
  assertProof(staleAfterGrace.status === "running", "the other-board card must not be cleaned up here");
  assertProof(
    staleAfterGrace.execution?.status === "running",
    "the other-board execution must not be cleaned up here",
  );
  assertProof(targetAfterGrace?.execution?.status === "running", "the target execution must persist");
  assertProof(targetAfterGrace.runId === PROOF_RUN_ID, "the persisted run id must match the worker");
  console.log(
    "[trace] after_grace reclaimable=true started=1 target_started=true stale_claim_present=true stale_status=running stale_execution=running worker_calls=1",
  );

  const verifier = openStore(dbPath);
  try {
    const persisted = await verifier.store.get(target.id);
    assertProof(persisted?.status === "running", "a second SQLite connection must see running state");
    assertProof(persisted.execution?.status === "running", "execution state must survive SQLite reopen");
    assertProof(persisted.runId === PROOF_RUN_ID, "run id must survive SQLite reopen");
    console.log(
      `[trace] persisted sqlite_reopen=true status=${persisted.status} execution=${persisted.execution.status} run_id=${persisted.runId}`,
    );
  } finally {
    verifier.close();
  }

  console.log(`[trace] result=PASS exact_head=${PR_HEAD_SHA}`);
} finally {
  primary.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
