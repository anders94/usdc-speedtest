import {
  Contract,
  type JsonRpcProvider,
  Wallet,
  type HDNodeWallet,
  formatEther,
} from "ethers";
import ora from "ora";
import { getUsdcContract, USDC_CENT, formatUsdc } from "../utils/usdc.js";
import {
  isDisperseAvailable,
  getDisperseContract,
  DISPERSE_ADDRESS,
} from "../utils/disperse.js";
import { confirm, choose } from "../utils/prompt.js";
import { pMap } from "../utils/concurrency.js";
import * as log from "../utils/logger.js";
import type { NetworkConfig } from "../config/networks.js";
import type { GasLimits } from "../cli.js";

// Gas estimate for disperseEther call (base + per-recipient)
const GAS_DISPERSE_ETHER_BASE = 30_000n;
const GAS_DISPERSE_ETHER_PER_ADDR = 25_000n;
// Gas estimate for disperseToken call (base + per-recipient)
const GAS_DISPERSE_TOKEN_BASE = 50_000n;
const GAS_DISPERSE_TOKEN_PER_ADDR = 70_000n;
// Gas for an ERC-20 approve tx
const GAS_ERC20_APPROVE = 50_000n;
// Minimum assumed cost per transaction (wei). On L2 chains (Base, OP Stack),
// gasPrice only reflects the L2 execution cost and misses L1 data posting fees
// which typically dominate. This floor ensures accurate estimates on L2s.
const MIN_COST_PER_TX = 5_000_000_000_000n; // 0.000005 ETH
// Safety buffer multiplier: 20% extra
const BUFFER_NUMERATOR = 120n;
const BUFFER_DENOMINATOR = 100n;

type FundingItem = {
  index: number;
  address: string;
  ethNeeded: bigint;
  usdcNeeded: bigint;
};

/**
 * Estimate the ETH required per wallet for the full test duration plus cleanup.
 *
 * Per wallet in a pair:
 *   - Test txs: the pair sends ~(durationMs / blockTimeMs) txs total,
 *     each wallet sends roughly half of those
 *   - Return-to-sender tx: 1 (in case USDC ends on the odd wallet)
 *   - Cleanup USDC sweep: 1 ERC-20 transfer back to master
 *   - Cleanup ETH sweep: 1 simple ETH transfer back to master
 *   - 20% buffer on top
 */
function estimateEthPerWallet(
  network: NetworkConfig,
  durationSec: number,
  gasPrice: bigint,
  gasLimits: GasLimits
): bigint {
  const durationMs = BigInt(durationSec) * 1000n;
  const blockTimeMs = BigInt(network.estimatedBlockTimeMs);

  // Txs this wallet will send during the test (half of pair's total)
  const testTxs = durationMs / blockTimeMs / 2n + 1n; // +1 to round up

  // Extra txs: possible return-to-sender + USDC sweep + ETH/gas-token sweep
  const returnTx = 1n;
  const usdcSweepTx = 1n;
  const ethSweepTx = 1n;

  const totalTxs = testTxs + returnTx + usdcSweepTx + ethSweepTx;

  const totalErc20Gas = (testTxs + returnTx + usdcSweepTx) * gasLimits.erc20Transfer;
  // On gas-token chains the "ETH sweep" is also an ERC-20 transfer
  const sweepGas = network.gasTokenAddress ? gasLimits.erc20Transfer : gasLimits.ethTransfer;
  const totalEthGas = ethSweepTx * sweepGas;
  const totalGas = totalErc20Gas + totalEthGas;

  const gasPriceEstimate = totalGas * gasPrice;
  const floorEstimate = totalTxs * MIN_COST_PER_TX;

  // Use whichever is higher: gas-based estimate (accurate on L1) or floor (covers L2 data fees)
  const baseAmount = gasPriceEstimate > floorEstimate ? gasPriceEstimate : floorEstimate;
  return (baseAmount * BUFFER_NUMERATOR) / BUFFER_DENOMINATOR;
}

export async function checkAndFund(
  wallets: HDNodeWallet[],
  masterWallet: Wallet,
  provider: JsonRpcProvider,
  network: NetworkConfig,
  durationSec: number,
  gasLimits: GasLimits
): Promise<void> {
  const spinner = ora("Checking wallet balances and gas prices...").start();

  // On gas-token chains (e.g. Radius), wallets are funded with an ERC-20 gas
  // token instead of native ETH. The base-layer token is auto-converted from
  // this ERC-20, so native ETH transfers fail with "lack of funds".
  const gasToken = network.gasTokenAddress
    ? getUsdcContract(network.gasTokenAddress, provider)
    : null;
  const gasLabel = gasToken ? "Gas Token" : "ETH";

  // Query live gas price
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 50_000_000_000n;

  const minEthPerWallet = estimateEthPerWallet(network, durationSec, gasPrice, gasLimits);

  log.info(`Current gas price: ${(Number(gasPrice) / 1e9).toFixed(4)} gwei`);
  log.info(`Estimated ${gasLabel} per wallet: ${formatEther(minEthPerWallet)}`);
  console.log();

  const usdc = getUsdcContract(network.usdcAddress, provider);

  // Query wallet balances with limited concurrency to avoid RPC rate limits
  const balances = await pMap(
    wallets,
    async (w) => {
      const [ethBalance, usdcBalance] = await Promise.all([
        provider.getBalance(w.address),
        usdc.balanceOf(w.address) as Promise<bigint>,
      ]);
      return { address: w.address, ethBalance, usdcBalance };
    },
    10
  );

  spinner.stop();

  // Display current balances
  const balanceRows: string[][] = [["Wallet", "Address", `${gasLabel} Balance`, "USDC Balance"]];
  for (let i = 0; i < balances.length; i++) {
    const b = balances[i];
    const role = i % 2 === 0 ? "sender" : "receiver";
    balanceRows.push([
      `#${i} ${role}`,
      b.address,
      formatEther(b.ethBalance),
      formatUsdc(b.usdcBalance),
    ]);
  }
  log.table(balanceRows);
  console.log();

  // Build funding plan
  const plan: FundingItem[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const { address, ethBalance, usdcBalance } = balances[i];

    let ethNeeded = 0n;
    let usdcNeeded = 0n;

    if (ethBalance < minEthPerWallet) {
      // Fund the full target amount, not just the delta — avoids dust top-ups
      ethNeeded = minEthPerWallet;
    }

    // Even wallets (senders) need USDC
    if (i % 2 === 0 && usdcBalance < USDC_CENT) {
      usdcNeeded = USDC_CENT;
    }

    if (ethNeeded > 0n || usdcNeeded > 0n) {
      plan.push({ index: i, address, ethNeeded, usdcNeeded });
    }
  }

  if (plan.length === 0) {
    log.success("All wallets are already funded.");
    return;
  }

  // Display funding plan
  log.header(`Funding Plan — ${network.name}`);

  const totalEth = plan.reduce((sum, item) => sum + item.ethNeeded, 0n);
  const totalUsdc = plan.reduce((sum, item) => sum + item.usdcNeeded, 0n);

  log.info(`${gasLabel} needed:  ${formatEther(totalEth)} across ${plan.filter((p) => p.ethNeeded > 0n).length} wallets`);
  log.info(`USDC needed: ${formatUsdc(totalUsdc)} across ${plan.filter((p) => p.usdcNeeded > 0n).length} wallets`);
  console.log();

  const rows: string[][] = [["Wallet", "Address", `${gasLabel} Needed`, "USDC Needed"]];
  for (const item of plan) {
    rows.push([
      `#${item.index}`,
      item.address,
      item.ethNeeded > 0n ? formatEther(item.ethNeeded) : "—",
      item.usdcNeeded > 0n ? formatUsdc(item.usdcNeeded) : "—",
    ]);
  }
  log.table(rows);
  console.log();

  // Check master wallet has enough
  const [masterEth, masterUsdc, disperseAvailable] = await Promise.all([
    provider.getBalance(masterWallet.address),
    usdc.balanceOf(masterWallet.address) as Promise<bigint>,
    isDisperseAvailable(provider),
  ]);

  if (disperseAvailable) {
    log.info("Disperse.app detected — will batch funding transactions");
  }

  // Gas the master wallet needs for its own funding transactions
  const ethRecipients = BigInt(plan.filter((p) => p.ethNeeded > 0n).length);
  const usdcRecipients = BigInt(plan.filter((p) => p.usdcNeeded > 0n).length);

  let masterGasCost: bigint;
  if (gasToken) {
    // On gas-token chains, all funding txs are ERC-20 transfers (no native ETH sends).
    // With Disperse: 1 approve + 1 disperseToken per asset type
    // Without: N individual ERC-20 transfers
    if (disperseAvailable) {
      let gas = 0n;
      if (ethRecipients > 0n) {
        gas += GAS_ERC20_APPROVE + GAS_DISPERSE_TOKEN_BASE + GAS_DISPERSE_TOKEN_PER_ADDR * ethRecipients;
      }
      if (usdcRecipients > 0n) {
        gas += GAS_ERC20_APPROVE + GAS_DISPERSE_TOKEN_BASE + GAS_DISPERSE_TOKEN_PER_ADDR * usdcRecipients;
      }
      masterGasCost = gas * gasPrice;
    } else {
      masterGasCost = (ethRecipients + usdcRecipients) * gasLimits.erc20Transfer * gasPrice;
    }
  } else if (disperseAvailable) {
    // 1 disperseEther + 1 approve + 1 disperseToken = 3 txs
    const disperseEthGas =
      ethRecipients > 0n
        ? GAS_DISPERSE_ETHER_BASE + GAS_DISPERSE_ETHER_PER_ADDR * ethRecipients
        : 0n;
    const approveGas = usdcRecipients > 0n ? GAS_ERC20_APPROVE : 0n;
    const disperseTokenGas =
      usdcRecipients > 0n
        ? GAS_DISPERSE_TOKEN_BASE +
          GAS_DISPERSE_TOKEN_PER_ADDR * usdcRecipients
        : 0n;
    masterGasCost =
      (disperseEthGas + approveGas + disperseTokenGas) * gasPrice;
  } else {
    masterGasCost =
      ethRecipients * gasLimits.ethTransfer * gasPrice +
      usdcRecipients * gasLimits.erc20Transfer * gasPrice;
  }

  if (masterEth < totalEth + masterGasCost) {
    log.error(
      `Master wallet has ${formatEther(masterEth)} ${gasLabel} but needs ~${formatEther(totalEth + masterGasCost)} ${gasLabel} (transfers + gas)`
    );
    throw new Error(`Insufficient ${gasLabel} in master wallet`);
  }
  if (masterUsdc < totalUsdc) {
    log.error(
      `Master wallet has ${formatUsdc(masterUsdc)} USDC but needs ${formatUsdc(totalUsdc)}`
    );
    throw new Error("Insufficient USDC in master wallet");
  }

  const ok = await confirm("Proceed with funding these wallets?");
  if (!ok) {
    throw new Error("Funding cancelled by user");
  }

  // Check for stuck pending transactions (skip on gas-token chains where
  // native balance is unreliable).
  if (!gasToken) {
    let pendingBalance = masterEth;
    try {
      const hex = await provider.send("eth_getBalance", [
        masterWallet.address,
        "pending",
      ]);
      pendingBalance = BigInt(hex);
    } catch {}

    const lockedEth = masterEth - pendingBalance;
    if (lockedEth > 0n) {
      log.warn(
        `Master wallet has ${formatEther(lockedEth)} ETH locked by pending transactions in the mempool.`
      );
      log.warn(
        `Confirmed balance: ${formatEther(masterEth)} ETH — Available: ${formatEther(pendingBalance)} ETH`
      );
    }

    if (pendingBalance < totalEth + masterGasCost && lockedEth > 0n) {
      console.log();
      await offerWalletReset(masterWallet, provider, lockedEth);
    }
  }

  // Execute funding
  const fundSpinner = ora("Sending funding transactions...").start();

  const ethItems = plan.filter((p) => p.ethNeeded > 0n);
  const usdcItems = plan.filter((p) => p.usdcNeeded > 0n);

  try {
    if (disperseAvailable) {
      await fundWithDisperse(
        masterWallet,
        provider,
        network,
        ethItems,
        usdcItems,
        fundSpinner,
        gasToken
      );
    } else {
      await fundIndividually(
        masterWallet,
        provider,
        network,
        ethItems,
        usdcItems,
        fundSpinner,
        gasLimits,
        gasToken
      );
    }
  } catch (err: any) {
    fundSpinner.fail(err.message);

    // If funding failed due to lack of funds, run diagnostics to understand the
    // discrepancy between the RPC's reported balance and the sequencer's view.
    const errMsg = extractError(err).toLowerCase();
    if (errMsg.includes("lack of funds") || errMsg.includes("insufficient funds")) {
      console.log();
      await diagnoseBalanceDiscrepancy(masterWallet, provider, plan, ethItems);
    }

    throw err;
  }

  fundSpinner.succeed(
    `Funded ${plan.length} wallet(s): ${ethItems.length} ${gasLabel} + ${usdcItems.length} USDC transfers` +
      (disperseAvailable ? " (batched via Disperse)" : "")
  );
}

/**
 * Batch-fund wallets using the Disperse.app contract.
 * 1 disperseEther tx + 1 approve tx + 1 disperseToken tx = 3 txs total.
 */
async function fundWithDisperse(
  masterWallet: Wallet,
  provider: JsonRpcProvider,
  network: NetworkConfig,
  ethItems: FundingItem[],
  usdcItems: FundingItem[],
  spinner: ReturnType<typeof ora>,
  gasToken: Contract | null
): Promise<void> {
  const disperse = getDisperseContract(masterWallet);
  let nonce = await provider.getTransactionCount(masterWallet.address);

  // Batch gas-token / ETH sends
  if (ethItems.length > 0) {
    const addresses = ethItems.map((item) => item.address);
    const values = ethItems.map((item) => item.ethNeeded);
    const totalValue = values.reduce((sum, v) => sum + v, 0n);

    if (gasToken) {
      // Gas-token chain: approve + disperseToken for the gas token ERC-20
      spinner.text = `Approving Disperse contract for gas token...`;
      const gasTokenWithSigner = gasToken.connect(masterWallet) as Contract;
      const approveTx = await (gasTokenWithSigner.approve as any)(
        DISPERSE_ADDRESS,
        totalValue,
        { nonce: nonce++ }
      );
      await approveTx.wait();

      spinner.text = `Sending batch gas token to ${ethItems.length} wallet(s) via Disperse...`;
      nonce = await provider.getTransactionCount(masterWallet.address);
      const tokenTx = await (disperse.disperseToken as any)(
        network.gasTokenAddress,
        addresses,
        values,
        { nonce: nonce++ }
      );
      await tokenTx.wait();
    } else {
      spinner.text = `Sending batch ETH to ${ethItems.length} wallet(s) via Disperse...`;
      const ethTx = await (disperse.disperseEther as any)(addresses, values, {
        value: totalValue,
        nonce: nonce++,
      });
      await ethTx.wait();
    }
  }

  // Approve + batch USDC sends
  if (usdcItems.length > 0) {
    const addresses = usdcItems.map((item) => item.address);
    const values = usdcItems.map((item) => item.usdcNeeded);
    const totalUsdc = values.reduce((sum, v) => sum + v, 0n);

    // Approve Disperse contract to spend USDC
    spinner.text = "Approving Disperse contract for USDC...";
    const usdcContract = getUsdcContract(network.usdcAddress, masterWallet);
    const approveTx = await (usdcContract.approve as any)(
      DISPERSE_ADDRESS,
      totalUsdc,
      { nonce: nonce++ }
    );
    await approveTx.wait();

    // Batch USDC sends
    spinner.text = `Sending batch USDC to ${usdcItems.length} wallet(s) via Disperse...`;
    nonce = await provider.getTransactionCount(masterWallet.address);
    const tokenTx = await (disperse.disperseToken as any)(
      network.usdcAddress,
      addresses,
      values,
      { nonce: nonce++ }
    );
    await tokenTx.wait();
  }
}

/**
 * Fund wallets individually (fallback when Disperse is unavailable).
 *
 * Uses ethers' sendTransaction for correct tx construction on all chains,
 * and waits for each receipt before proceeding to maintain nonce ordering.
 */
const FUND_MAX_RETRIES = 5;
const FUND_RETRY_BASE_MS = 1000;

/** Dig through ethers' error wrappers to find the real RPC message + data. */
function extractError(err: any): string {
  // The real info is often in err.error (ethers wraps) or err.info.error (RPC payload).
  // The RPC `data` field frequently contains the actual reason (e.g. "lack of funds").
  const inner = err.error || err.info?.error;
  const data = inner?.data || err.error?.error?.data;
  const msg =
    err.error?.error?.message ||
    err.error?.message ||
    err.info?.error?.message ||
    err.reason ||
    err.shortMessage ||
    err.message?.slice(0, 200) ||
    String(err);
  return data ? `${msg}: ${data}` : msg;
}

/** Check if an RPC error is deterministic (should NOT be retried). */
function isDeterministicError(err: any): boolean {
  const full = extractError(err).toLowerCase();
  return (
    full.includes("lack of funds") ||
    full.includes("insufficient funds") ||
    full.includes("insufficient balance") ||
    full.includes("exceeds balance") ||
    full.includes("not enough funds") ||
    full.includes("reverted") ||
    full.includes("nonce too low")
  );
}

function isFundingRetryable(err: any): boolean {
  // Never retry deterministic failures
  if (isDeterministicError(err)) return false;

  const msg = (err.message || err.shortMessage || "").toLowerCase();
  return (
    msg.includes("exec failed") ||
    msg.includes("could not coalesce error") ||
    msg.includes("timeout") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("network error") ||
    msg.includes("missing response") ||
    msg.includes("bad response") ||
    msg.includes("too many") ||
    msg.includes("nonce") ||
    err.code === "TIMEOUT" ||
    err.code === "NETWORK_ERROR" ||
    err.code === "SERVER_ERROR"
  );
}

/**
 * Offer the user a choice to reset the wallet or exit, then execute if chosen.
 */
async function offerWalletReset(
  masterWallet: Wallet,
  provider: JsonRpcProvider,
  lockedAmount: bigint
): Promise<void> {
  log.warn(
    `${formatEther(lockedAmount)} ETH is unavailable due to pending transactions in the mempool.`
  );
  console.log();
  const choice = await choose("What would you like to do?", [
    "Reset wallet — cancel stuck transactions so funding can proceed",
    "Exit — try again later",
  ]);
  if (choice !== 1) {
    throw new Error("Exiting due to stuck pending transactions");
  }
  await resetWallet(masterWallet, provider);
}

/**
 * Send no-op self-transfers at each pending nonce to replace stuck transactions.
 * If nonce-based detection doesn't find pending txs (some chains hide them),
 * sends a single no-op at the current nonce to nudge the sequencer.
 */
async function resetWallet(
  masterWallet: Wallet,
  provider: JsonRpcProvider
): Promise<void> {
  const spinner = ora("Resetting wallet...").start();
  try {
    const [nonceLatest, noncePending] = await Promise.all([
      provider.getTransactionCount(masterWallet.address, "latest"),
      provider.getTransactionCount(masterWallet.address, "pending"),
    ]);

    const feeData = await provider.getFeeData();
    const bumpedGasPrice =
      (feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n) * 3n;

    if (noncePending > nonceLatest) {
      // Replace each stuck nonce
      const stuck = noncePending - nonceLatest;
      for (let n = nonceLatest; n < noncePending; n++) {
        spinner.text = `Replacing stuck transaction ${n - nonceLatest + 1}/${stuck} (nonce ${n})...`;
        const tx = await masterWallet.sendTransaction({
          to: masterWallet.address,
          value: 0n,
          nonce: n,
          gasLimit: 21_000n,
          gasPrice: bumpedGasPrice,
          type: 0,
        });
        await tx.wait();
      }
      spinner.succeed(`Replaced ${stuck} stuck transaction(s) — wallet is clear`);
    } else {
      // Nonces look clean but the sequencer has hidden pending state.
      // Send a few no-op self-sends at sequential nonces to flush the mempool.
      const FLUSH_COUNT = 5;
      let nonce = nonceLatest;
      for (let i = 0; i < FLUSH_COUNT; i++) {
        spinner.text = `Flushing sequencer state ${i + 1}/${FLUSH_COUNT} (nonce ${nonce})...`;
        try {
          const tx = await masterWallet.sendTransaction({
            to: masterWallet.address,
            value: 0n,
            nonce,
            gasLimit: 21_000n,
            gasPrice: bumpedGasPrice,
            type: 0,
          });
          await tx.wait();
          nonce++;
        } catch {
          // If a flush tx fails, stop — we've done what we can
          break;
        }
      }
      spinner.succeed("Sent flush transactions to clear sequencer state");
    }
    console.log();
  } catch (err: any) {
    spinner.fail(`Wallet reset failed: ${extractError(err)}`);
    throw new Error(`Wallet reset failed: ${extractError(err)}`);
  }
}

/**
 * Diagnose why the sequencer rejected a transfer with "lack of funds" despite
 * eth_getBalance reporting a high balance.  Compares eth_getBalance (latest vs
 * pending), eth_call simulation, and eth_estimateGas for the failing transfer.
 */
async function diagnoseBalanceDiscrepancy(
  masterWallet: Wallet,
  provider: JsonRpcProvider,
  plan: FundingItem[],
  ethItems: FundingItem[]
): Promise<void> {
  log.header("Balance Diagnostics");

  // 1. Fresh balance queries at every block tag the RPC supports
  const tags = ["latest", "pending", "earliest"] as const;
  const balanceByTag: Record<string, bigint | null> = {};
  for (const tag of tags) {
    try {
      const hex = await provider.send("eth_getBalance", [
        masterWallet.address,
        tag,
      ]);
      balanceByTag[tag] = BigInt(hex);
      log.info(`eth_getBalance("${tag}"):   ${formatEther(BigInt(hex))} ETH`);
    } catch (e: any) {
      balanceByTag[tag] = null;
      log.info(`eth_getBalance("${tag}"):   error — ${e.message?.slice(0, 80)}`);
    }
  }

  // 2. Nonce at latest vs pending
  try {
    const [nonceLatest, noncePending] = await Promise.all([
      provider.getTransactionCount(masterWallet.address, "latest"),
      provider.getTransactionCount(masterWallet.address, "pending"),
    ]);
    log.info(`Nonce (latest):  ${nonceLatest}`);
    log.info(`Nonce (pending): ${noncePending}`);
    if (noncePending > nonceLatest) {
      log.warn(`  → ${noncePending - nonceLatest} transaction(s) in mempool`);
    } else {
      log.info(`  → no pending nonce gap`);
    }
  } catch {}

  console.log();

  // 3. For each unfunded wallet, simulate with eth_call and eth_estimateGas
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 1_000_000_000n;

  for (const item of ethItems) {
    const label = `#${item.index} (${item.address})`;
    const txObj = {
      from: masterWallet.address,
      to: item.address,
      value: "0x" + item.ethNeeded.toString(16),
    };

    log.info(`Wallet ${label} — transfer ${formatEther(item.ethNeeded)} ETH:`);

    // eth_call — does the execution layer accept this?
    try {
      await provider.send("eth_call", [txObj, "latest"]);
      log.info(`  eth_call("latest"):    ✓ success`);
    } catch (e: any) {
      log.warn(`  eth_call("latest"):    ✗ ${extractError(e)}`);
    }

    try {
      await provider.send("eth_call", [txObj, "pending"]);
      log.info(`  eth_call("pending"):   ✓ success`);
    } catch (e: any) {
      log.warn(`  eth_call("pending"):   ✗ ${extractError(e)}`);
    }

    // eth_estimateGas — does gas estimation agree?
    try {
      const gasHex = await provider.send("eth_estimateGas", [txObj]);
      log.info(`  eth_estimateGas:       ✓ ${BigInt(gasHex)} gas`);
    } catch (e: any) {
      log.warn(`  eth_estimateGas:       ✗ ${extractError(e)}`);
    }

    // Try a tiny transfer (1 wei) to see if ANY value transfer works
    const tinyTxObj = {
      from: masterWallet.address,
      to: item.address,
      value: "0x1",
    };
    try {
      await provider.send("eth_call", [tinyTxObj, "latest"]);
      log.info(`  eth_call(1 wei):       ✓ success`);
    } catch (e: any) {
      log.warn(`  eth_call(1 wei):       ✗ ${extractError(e)}`);
    }
  }

  // 4. Binary search for the maximum transferable amount
  const latest = balanceByTag["latest"];
  if (latest != null && ethItems.length > 0) {
    console.log();
    log.info("Binary-searching for max transferable amount...");
    const target = ethItems[0].address;
    let lo = 0n;
    let hi = latest;
    // Subtract a generous gas cost estimate so we search over transferable value
    const maxGasCost = 21_000n * gasPrice * 2n;
    if (hi > maxGasCost) hi -= maxGasCost;

    for (let i = 0; i < 64 && lo < hi; i++) {
      const mid = (lo + hi + 1n) / 2n;
      try {
        await provider.send("eth_call", [
          {
            from: masterWallet.address,
            to: target,
            value: "0x" + mid.toString(16),
          },
          "latest",
        ]);
        lo = mid; // succeeded — try higher
      } catch {
        hi = mid - 1n; // failed — try lower
      }
    }
    log.info(`Max transferable (eth_call): ${formatEther(lo)} ETH`);
    log.info(`Reported balance (latest):   ${formatEther(latest)} ETH`);
    if (latest > 0n) {
      const pct = Number((lo * 10000n) / latest) / 100;
      log.info(`Usable: ${pct}% of reported balance`);
    }
  }

  console.log();
}

async function fundIndividually(
  masterWallet: Wallet,
  provider: JsonRpcProvider,
  network: NetworkConfig,
  ethItems: FundingItem[],
  usdcItems: FundingItem[],
  spinner: ReturnType<typeof ora>,
  _gasLimits: GasLimits,
  gasToken: Contract | null
): Promise<void> {
  // Let ethers auto-detect tx type, gas price, and gas limit.
  // Funding only runs once so the extra estimateGas/getFeeData RPCs are fine.
  // This avoids issues with chains that don't support type 0 or have unusual fee structures.

  const gasLabel = gasToken ? "gas token" : "ETH";

  // Send ETH / gas-token transfers sequentially
  for (let i = 0; i < ethItems.length; i++) {
    const item = ethItems[i];
    spinner.text = `Sending ${gasLabel} transfer ${i + 1}/${ethItems.length}...`;
    for (let attempt = 0; attempt <= FUND_MAX_RETRIES; attempt++) {
      try {
        if (gasToken) {
          const gasTokenWithSigner = gasToken.connect(masterWallet) as Contract;
          const tx = await (gasTokenWithSigner.transfer as any)(
            item.address,
            item.ethNeeded
          );
          await tx.wait();
        } else {
          const tx = await masterWallet.sendTransaction({
            to: item.address,
            value: item.ethNeeded,
          });
          await tx.wait();
        }
        break;
      } catch (err: any) {
        if (isFundingRetryable(err) && attempt < FUND_MAX_RETRIES) {
          const delay = FUND_RETRY_BASE_MS * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(
          `${gasLabel} transfer ${i + 1}/${ethItems.length} to wallet #${item.index} (${item.address}) failed after ${attempt + 1} attempts: ${extractError(err)}`
        );
      }
    }
  }

  // Send USDC transfers sequentially
  const usdcContract = getUsdcContract(network.usdcAddress, masterWallet);
  for (let i = 0; i < usdcItems.length; i++) {
    const item = usdcItems[i];
    spinner.text = `Sending USDC transfer ${i + 1}/${usdcItems.length}...`;
    for (let attempt = 0; attempt <= FUND_MAX_RETRIES; attempt++) {
      try {
        const tx = await (usdcContract.transfer as any)(
          item.address,
          item.usdcNeeded
        );
        const receipt = await tx.wait();
        if (receipt && receipt.status === 0) {
          throw new Error("transaction reverted on-chain");
        }
        break;
      } catch (err: any) {
        if (isFundingRetryable(err) && attempt < FUND_MAX_RETRIES) {
          const delay = FUND_RETRY_BASE_MS * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(
          `USDC transfer ${i + 1}/${usdcItems.length} to wallet #${item.index} (${item.address}) failed after ${attempt + 1} attempts: ${extractError(err)}`
        );
      }
    }
  }
}
