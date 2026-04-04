import { PrismaClient } from "@prisma/client";
import {
  Account,
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { config } from "../config/index.js";
import {
  callSetCooldownPeriod,
  callSetLpProtocolFeeBps,
  callUpdateBorrowRate,
  callUpdateCollateralFactor,
  callUpdateLiquidationThreshold,
} from "../staking-engine/contractClient.js";
import { DexIntegrationService } from "../dex-integration/service.js";

const READ_ONLY_SIMULATION_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface SyncedGovernanceProposal {
  id: number;
  proposer: string;
  paramKey: string;
  newValue: string;
  votesFor: string;
  votesAgainst: string;
  startLedger: number;
  endLedger: number;
  executed: boolean;
  status: string;
  expiresAt: string;
}

type GovernanceProposalCacheRow = {
  id: number;
  chainProposalId: number | null;
  proposer: string;
  paramKey: string;
  newValue: string;
  votesFor: bigint | string | number;
  votesAgainst: bigint | string | number;
  status: string;
  appliedAt: Date | string | null;
  expiresAt: Date | string;
};

const server = new rpc.Server(config.stellar.rpcUrl);
const governanceContract = new Contract(config.contracts.governanceContractId);
let governanceColumnsEnsured = false;

async function ensureGovernanceColumns(prisma: PrismaClient): Promise<void> {
  if (governanceColumnsEnsured) return;

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "governance_proposals"
    ADD COLUMN IF NOT EXISTS "chainProposalId" INTEGER,
    ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMPTZ
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "governance_proposals_chainProposalId_key"
    ON "governance_proposals" ("chainProposalId")
    WHERE "chainProposalId" IS NOT NULL
  `);
  governanceColumnsEnsured = true;
}

async function queryGovernanceView(method: string, args: any[]) {
  const op = governanceContract.call(method, ...args);
  const account = getReadOnlySimulationAccount();
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(simResult) && simResult.result) {
    return scValToNative(simResult.result.retval);
  }
  return null;
}

function getReadOnlySimulationAccount(): Account {
  try {
    return new Account(config.admin.publicKey, "0");
  } catch {
    return new Account(READ_ONLY_SIMULATION_ACCOUNT, "0");
  }
}

export async function applyGovernanceParam(
  paramKey: string,
  newValue: string,
  dexIntegrationService: DexIntegrationService,
  proposalId?: number
): Promise<boolean> {
  const value = parseInt(newValue, 10);
  if (paramKey.startsWith("liquidity_mining_program")) {
    await dexIntegrationService.applyLiquidityMiningProposal(proposalId ?? 0, paramKey, newValue);
    console.log(`[Governance] Applied liquidity mining program from proposal ${proposalId ?? "n/a"}`);
    return true;
  }

  if (Number.isNaN(value)) {
    console.warn(`[Governance] Cannot apply param "${paramKey}": invalid value "${newValue}"`);
    return false;
  }

  try {
    switch (paramKey) {
      case "cooldown_period":
        await callSetCooldownPeriod(value);
        break;
      case "collateral_factor":
        await callUpdateCollateralFactor(value);
        break;
      case "borrow_rate_bps":
        await callUpdateBorrowRate(value);
        break;
      case "liquidation_threshold":
        await callUpdateLiquidationThreshold(value);
        break;
      case "lp_protocol_fee_bps":
        await callSetLpProtocolFeeBps(value);
        break;
      default:
        console.log(`[Governance] Param "${paramKey}" does not map to a contract call`);
        return true;
    }
    console.log(`[Governance] Applied ${paramKey} = ${newValue}`);
    return true;
  } catch (err) {
    console.error(`[Governance] Failed to apply param "${paramKey}" = "${newValue}":`, err);
    return false;
  }
}

function deriveStatus(params: {
  executed: boolean;
  currentLedger: number;
  endLedger: number;
  votesFor: bigint;
  votesAgainst: bigint;
}): string {
  if (params.executed) return "executed";
  if (params.currentLedger <= params.endLedger) return "active";
  if (params.votesFor > params.votesAgainst) return "passed";
  return "rejected";
}

async function upsertGovernanceProposal(params: {
  prisma: PrismaClient;
  dexIntegrationService: DexIntegrationService;
  chainProposalId: number;
  proposer: string;
  paramKey: string;
  newValue: string;
  votesFor: bigint;
  votesAgainst: bigint;
  startLedger: number;
  endLedger: number;
  executed: boolean;
  status: string;
  latestLedger: number;
}): Promise<SyncedGovernanceProposal> {
  await ensureGovernanceColumns(params.prisma);
  const now = Date.now();
  const expiresAt = new Date(now + Math.max(0, params.endLedger - params.latestLedger) * 5_000);
  const existing = await params.prisma.$queryRawUnsafe<GovernanceProposalCacheRow[]>(
    `SELECT "id", "chainProposalId", "appliedAt"
     FROM "governance_proposals"
     WHERE "chainProposalId" = $1
     LIMIT 1`,
    params.chainProposalId
  );
  const record = existing[0];

  if (record) {
    await params.prisma.$executeRawUnsafe(
      `UPDATE "governance_proposals"
       SET "proposer" = $2,
           "paramKey" = $3,
           "newValue" = $4,
           "votesFor" = $5,
           "votesAgainst" = $6,
           "status" = $7,
           "expiresAt" = $8
       WHERE "id" = $1`,
      record.id,
      params.proposer,
      params.paramKey,
      params.newValue,
      params.votesFor.toString(),
      params.votesAgainst.toString(),
      params.status,
      expiresAt
    );
  } else {
    await params.prisma.$executeRawUnsafe(
      `INSERT INTO "governance_proposals"
        ("chainProposalId", "proposer", "paramKey", "newValue", "votesFor", "votesAgainst", "status", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      params.chainProposalId,
      params.proposer,
      params.paramKey,
      params.newValue,
      params.votesFor.toString(),
      params.votesAgainst.toString(),
      params.status,
      expiresAt
    );
  }

  if (params.executed && !record?.appliedAt) {
    const applied = await applyGovernanceParam(
      params.paramKey,
      params.newValue,
      params.dexIntegrationService,
      params.chainProposalId
    );
    if (applied) {
      await params.prisma.$executeRawUnsafe(
        `UPDATE "governance_proposals"
         SET "appliedAt" = $2, "status" = 'executed'
         WHERE "chainProposalId" = $1`,
        params.chainProposalId,
        new Date()
      );
    }
  }

  return {
    id: params.chainProposalId,
    proposer: params.proposer,
    paramKey: params.paramKey,
    newValue: params.newValue,
    votesFor: params.votesFor.toString(),
    votesAgainst: params.votesAgainst.toString(),
    startLedger: params.startLedger,
    endLedger: params.endLedger,
    executed: params.executed,
    status: params.executed ? "executed" : params.status,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function syncGovernanceProposals(
  prisma: PrismaClient,
  dexIntegrationService: DexIntegrationService,
  proposalId?: number
): Promise<SyncedGovernanceProposal[]> {
  await ensureGovernanceColumns(prisma);
  const latestLedger = await server.getLatestLedger();
  const proposalIds =
    proposalId !== undefined
      ? [proposalId]
      : Array.from(
          { length: Number((await queryGovernanceView("proposal_count", [])) ?? 0) },
          (_, index) => index
        );

  const proposals: SyncedGovernanceProposal[] = [];
  for (const id of proposalIds.slice(0, 50)) {
    try {
      const proposal = await queryGovernanceView("get_proposal", [
        nativeToScVal(BigInt(id), { type: "u64" }),
      ]);
      if (!proposal) continue;

      const voteCount = await queryGovernanceView("get_vote_count", [
        nativeToScVal(BigInt(id), { type: "u64" }),
      ]);
      const votesFor = BigInt(voteCount?.[0] ?? 0);
      const votesAgainst = BigInt(voteCount?.[1] ?? 0);
      const startLedger = Number(proposal.start_ledger ?? 0);
      const endLedger = Number(proposal.end_ledger ?? 0);
      const executed = Boolean(proposal.executed ?? false);
      const status = deriveStatus({
        executed,
        currentLedger: latestLedger.sequence,
        endLedger,
        votesFor,
        votesAgainst,
      });

      proposals.push(
        await upsertGovernanceProposal({
          prisma,
          dexIntegrationService,
          chainProposalId: id,
          proposer: proposal.proposer?.toString() ?? "",
          paramKey: proposal.param_key ?? "",
          newValue: proposal.new_value ?? "",
          votesFor,
          votesAgainst,
          startLedger,
          endLedger,
          executed,
          status,
          latestLedger: latestLedger.sequence,
        })
      );
    } catch {
      // Skip individual proposals that fail to decode or query.
    }
  }

  return proposals.sort((left, right) => right.id - left.id);
}

export async function listCachedGovernanceProposals(
  prisma: PrismaClient
): Promise<SyncedGovernanceProposal[]> {
  await ensureGovernanceColumns(prisma);
  const rows = await prisma.$queryRawUnsafe<GovernanceProposalCacheRow[]>(
    `SELECT
      "id",
      "chainProposalId",
      "proposer",
      "paramKey",
      "newValue",
      "votesFor",
      "votesAgainst",
      "status",
      "appliedAt",
      "expiresAt"
     FROM "governance_proposals"
     ORDER BY "createdAt" DESC`
  );

  return rows.map((row) => ({
    id: row.chainProposalId ?? row.id - 1,
    proposer: row.proposer,
    paramKey: row.paramKey,
    newValue: row.newValue,
    votesFor: BigInt(row.votesFor).toString(),
    votesAgainst: BigInt(row.votesAgainst).toString(),
    startLedger: 0,
    endLedger: 0,
    executed: row.status === "executed",
    status: row.status,
    expiresAt: new Date(row.expiresAt).toISOString(),
  }));
}
