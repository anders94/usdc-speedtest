import { Contract, Wallet, type JsonRpcProvider } from "ethers";
import { ERC20_ABI, USDC_CENT } from "../utils/usdc.js";
import type { WalletPair } from "../wallet/derive.js";
import type { ReceiptStrategy } from "./receipt.js";

// Fallback gas limit for USDC transfers when no RPC estimate is available.
const DEFAULT_TRANSFER_GAS_LIMIT = 100_000n;

// Retry config for transient RPC errors (rate limits, connection drops)
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

export type TxRecord = {
  txHash: string;
  latencyMs: number;
  gasUsed: bigint;
  direction: "A→B" | "B→A";
  timestampMs: number;
};

export type TesterResult = {
  pairIndex: number;
  transactions: TxRecord[];
  /** True if the tester ran until the stop signal (timer/Ctrl+C), false if it errored out. */
  completedCleanly: boolean;
};

/** Dig through ethers' error wrappers to find the real RPC message + data. */
function extractRpcError(err: any): string {
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
  const full = extractRpcError(err).toLowerCase();
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

/** Check if an error is transient (RPC issue, not an on-chain revert). */
function isTransientError(err: any): boolean {
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
    msg.includes("http 502") ||
    msg.includes("http 503") ||
    msg.includes("http 504") ||
    err.code === "TIMEOUT" ||
    err.code === "NETWORK_ERROR" ||
    err.code === "SERVER_ERROR"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export async function runTester(
  pair: WalletPair,
  provider: JsonRpcProvider,
  usdcAddress: string,
  estimatedBlockTimeMs: number,
  stopSignal: { stopped: boolean },
  receiptStrategy: ReceiptStrategy,
  immediateReceipt?: boolean,
  rpcUrl?: string,
  trafficCurve?: { currentTarget: number },
  erc20GasLimit?: bigint
): Promise<TesterResult> {
  const transferGasLimit = erc20GasLimit ?? DEFAULT_TRANSFER_GAS_LIMIT;
  const walletA = new Wallet(pair.sender.privateKey, provider);
  const walletB = new Wallet(pair.receiver.privateKey, provider);

  // Pre-encode calldata for both directions — avoids ABI encoding per tx
  const iface = new Contract(usdcAddress, ERC20_ABI).interface;
  const dataAtoB = iface.encodeFunctionData("transfer", [
    walletB.address,
    USDC_CENT,
  ]);
  const dataBtoA = iface.encodeFunctionData("transfer", [
    walletA.address,
    USDC_CENT,
  ]);

  // Fetch nonces, fee data, and chain ID once — track locally to avoid per-tx RPC calls
  const [initNonceA, initNonceB, feeData, providerNetwork] = await Promise.all([
    provider.getTransactionCount(walletA.address, "pending"),
    provider.getTransactionCount(walletB.address, "pending"),
    provider.getFeeData(),
    provider.getNetwork(),
  ]);

  let nonceA = initNonceA;
  let nonceB = initNonceB;

  // Build fee overrides once (works for both EIP-1559 and legacy chains)
  const feeOverrides = feeData.maxFeePerGas
    ? {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      }
    : { gasPrice: feeData.gasPrice };

  const transactions: TxRecord[] = [];
  // usdcOnA tracks whether the USDC is currently held by wallet A (the even/sender wallet).
  // It starts true because funding puts USDC on even wallets.
  let usdcOnA = true;

  // Adaptive receipt polling — starts with block time estimate, learns from observations
  let expectedConfirmMs = estimatedBlockTimeMs;

  let erroredOut = false;

  while (!stopSignal.stopped) {
    // Traffic shaping: probabilistic skip to throttle throughput
    if (trafficCurve) {
      while (!stopSignal.stopped && Math.random() > trafficCurve.currentTarget) {
        await sleep(200);
      }
      if (stopSignal.stopped) break;
    }

    const wallet = usdcOnA ? walletA : walletB;
    const data = usdcOnA ? dataAtoB : dataBtoA;
    const direction: TxRecord["direction"] = usdcOnA ? "A→B" : "B→A";
    const nonce = usdcOnA ? nonceA : nonceB;

    const startTime = Date.now();
    let succeeded = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (stopSignal.stopped) break;

      try {
        if (immediateReceipt) {
          // Single RPC round trip — ethers handles tx construction,
          // we provide all fields so it skips estimateGas/getFeeData calls.
          // Don't wait for receipt — just record the hash and latency.
          const tx = await wallet.sendTransaction({
            to: usdcAddress,
            data,
            gasLimit: transferGasLimit,
            nonce,
            ...feeOverrides,
          });

          const latencyMs = Date.now() - startTime;
          transactions.push({
            txHash: tx.hash,
            latencyMs,
            gasUsed: transferGasLimit,
            direction,
            timestampMs: Date.now(),
          });
        } else {
          // Standard path: send + wait for receipt (2 RPC round trips)
          const tx = await wallet.sendTransaction({
            to: usdcAddress,
            data,
            gasLimit: transferGasLimit,
            nonce,
            ...feeOverrides,
          });
          const broadcastTime = Date.now();
          const receipt = await receiptStrategy.waitForReceipt(provider, tx, expectedConfirmMs);
          const latencyMs = Date.now() - startTime;

          // Update expected confirmation time (exponential moving average)
          const confirmMs = Date.now() - broadcastTime;
          expectedConfirmMs = Math.round(
            expectedConfirmMs * 0.7 + confirmMs * 0.3
          );

          transactions.push({
            txHash: receipt.hash,
            latencyMs,
            gasUsed: receipt.gasUsed,
            direction,
            timestampMs: Date.now(),
          });
        }

        if (usdcOnA) nonceA++;
        else nonceB++;
        usdcOnA = !usdcOnA;
        succeeded = true;
        break;
      } catch (err: any) {
        if (stopSignal.stopped) break;

        if (isTransientError(err) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * 2 ** attempt;
          await sleep(delay);
          continue;
        }

        const shortReason =
          err.reason || err.shortMessage || err.message?.slice(0, 120);
        console.error(
          `  Tester #${pair.index} error (${direction}): ${shortReason}`
        );
        break;
      }
    }

    if (!succeeded && !stopSignal.stopped) {
      erroredOut = true;
      break;
    }
    if (!succeeded) break;
  }

  // If USDC ended up on wallet B (the odd wallet), send it back to A
  // so that cleanup always finds USDC on the even wallets.
  if (!usdcOnA) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const tx = await walletB.sendTransaction({
          to: usdcAddress,
          data: dataBtoA,
          gasLimit: transferGasLimit,
          nonce: nonceB,
          ...feeOverrides,
        });
        await receiptStrategy.waitForReceipt(provider, tx, expectedConfirmMs);
        break;
      } catch (err: any) {
        if (isTransientError(err) && attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        const shortReason =
          err.reason || err.shortMessage || err.message?.slice(0, 120);
        console.error(
          `  Tester #${pair.index}: failed to return USDC to sender wallet: ${shortReason}`
        );
        break;
      }
    }
  }

  return { pairIndex: pair.index, transactions, completedCleanly: !erroredOut };
}
