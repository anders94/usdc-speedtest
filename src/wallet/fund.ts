import {
  type JsonRpcProvider,
  type Wallet,
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
import { confirm } from "../utils/prompt.js";
import { pMap } from "../utils/concurrency.js";
import * as log from "../utils/logger.js";
import type { NetworkConfig } from "../config/networks.js";

// Gas units for an ERC-20 transfer (approve-less)
const GAS_PER_ERC20_TRANSFER = 65_000n;
// Gas units for a simple ETH transfer
const GAS_PER_ETH_TRANSFER = 21_000n;
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
  gasPrice: bigint
): bigint {
  const durationMs = BigInt(durationSec) * 1000n;
  const blockTimeMs = BigInt(network.estimatedBlockTimeMs);

  // Txs this wallet will send during the test (half of pair's total)
  const testTxs = durationMs / blockTimeMs / 2n + 1n; // +1 to round up

  // Extra txs: possible return-to-sender + USDC sweep + ETH sweep
  const returnTx = 1n;
  const usdcSweepTx = 1n;
  const ethSweepTx = 1n;

  const totalTxs = testTxs + returnTx + usdcSweepTx + ethSweepTx;

  const totalErc20Gas = (testTxs + returnTx + usdcSweepTx) * GAS_PER_ERC20_TRANSFER;
  const totalEthGas = ethSweepTx * GAS_PER_ETH_TRANSFER;
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
  durationSec: number
): Promise<void> {
  const spinner = ora("Checking wallet balances and gas prices...").start();

  // Query live gas price
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 50_000_000_000n;

  const minEthPerWallet = estimateEthPerWallet(network, durationSec, gasPrice);

  log.info(`Current gas price: ${(Number(gasPrice) / 1e9).toFixed(4)} gwei`);
  log.info(`Estimated ETH per wallet: ${formatEther(minEthPerWallet)}`);
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
  const balanceRows: string[][] = [["Wallet", "Address", "ETH Balance", "USDC Balance"]];
  for (let i = 0; i < balances.length; i++) {
    const b = balances[i];
    const role = i % 2 === 0 ? "sender" : "receiver";
    balanceRows.push([
      `#${i} ${role}`,
      `${b.address.slice(0, 6)}...${b.address.slice(-4)}`,
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

  log.info(`ETH needed:  ${formatEther(totalEth)} ETH across ${plan.filter((p) => p.ethNeeded > 0n).length} wallets`);
  log.info(`USDC needed: ${formatUsdc(totalUsdc)} across ${plan.filter((p) => p.usdcNeeded > 0n).length} wallets`);
  console.log();

  const rows: string[][] = [["Wallet", "Address", "ETH Needed", "USDC Needed"]];
  for (const item of plan) {
    rows.push([
      `#${item.index}`,
      `${item.address.slice(0, 6)}...${item.address.slice(-4)}`,
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
  if (disperseAvailable) {
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
    const fundingTxCount = ethRecipients + usdcRecipients;
    masterGasCost =
      fundingTxCount * GAS_PER_ETH_TRANSFER * gasPrice +
      usdcRecipients *
        (GAS_PER_ERC20_TRANSFER - GAS_PER_ETH_TRANSFER) *
        gasPrice;
  }

  if (masterEth < totalEth + masterGasCost) {
    log.error(
      `Master wallet has ${formatEther(masterEth)} ETH but needs ~${formatEther(totalEth + masterGasCost)} ETH (transfers + gas)`
    );
    throw new Error("Insufficient ETH in master wallet");
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

  // Execute funding
  const fundSpinner = ora("Sending funding transactions...").start();

  const ethItems = plan.filter((p) => p.ethNeeded > 0n);
  const usdcItems = plan.filter((p) => p.usdcNeeded > 0n);

  if (disperseAvailable) {
    await fundWithDisperse(
      masterWallet,
      provider,
      network,
      ethItems,
      usdcItems,
      fundSpinner
    );
  } else {
    await fundIndividually(
      masterWallet,
      provider,
      network,
      ethItems,
      usdcItems,
      fundSpinner
    );
  }

  fundSpinner.succeed(
    `Funded ${plan.length} wallet(s): ${ethItems.length} ETH + ${usdcItems.length} USDC transfers` +
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
  spinner: ReturnType<typeof ora>
): Promise<void> {
  const disperse = getDisperseContract(masterWallet);
  let nonce = await provider.getTransactionCount(masterWallet.address);

  // Batch ETH sends
  if (ethItems.length > 0) {
    const addresses = ethItems.map((item) => item.address);
    const values = ethItems.map((item) => item.ethNeeded);
    const totalValue = values.reduce((sum, v) => sum + v, 0n);

    spinner.text = `Sending batch ETH to ${ethItems.length} wallet(s) via Disperse...`;
    const ethTx = await (disperse.disperseEther as any)(addresses, values, {
      value: totalValue,
      nonce: nonce++,
    });
    await ethTx.wait();
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
 * Fund wallets individually with nonce pipelining (fallback when Disperse is unavailable).
 */
async function fundIndividually(
  masterWallet: Wallet,
  provider: JsonRpcProvider,
  network: NetworkConfig,
  ethItems: FundingItem[],
  usdcItems: FundingItem[],
  spinner: ReturnType<typeof ora>
): Promise<void> {
  let nonce = await provider.getTransactionCount(masterWallet.address);

  // Send ETH transfers (pipelined)
  const ethTxPromises: Promise<void>[] = [];
  for (const item of ethItems) {
    const txPromise = masterWallet
      .sendTransaction({
        to: item.address,
        value: item.ethNeeded,
        nonce: nonce++,
      })
      .then((tx) => tx.wait())
      .then(() => {});
    ethTxPromises.push(txPromise);
  }

  if (ethTxPromises.length > 0) {
    spinner.text = `Confirming ${ethTxPromises.length} ETH transfer(s)...`;
    await Promise.all(ethTxPromises);
  }

  // Re-fetch nonce after ETH transfers
  nonce = await provider.getTransactionCount(masterWallet.address);
  const usdcContract = getUsdcContract(network.usdcAddress, masterWallet);

  const usdcTxPromises: Promise<void>[] = [];
  for (const item of usdcItems) {
    const txPromise = (usdcContract.transfer as any)(
      item.address,
      item.usdcNeeded,
      { nonce: nonce++ }
    )
      .then((tx: any) => tx.wait())
      .then(() => {});
    usdcTxPromises.push(txPromise);
  }

  if (usdcTxPromises.length > 0) {
    spinner.text = `Confirming ${usdcTxPromises.length} USDC transfer(s)...`;
    await Promise.all(usdcTxPromises);
  }
}
