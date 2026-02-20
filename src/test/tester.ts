import { Contract, Wallet, type JsonRpcProvider } from "ethers";
import { ERC20_ABI, USDC_CENT } from "../utils/usdc.js";
import { rpcSendRawTx } from "../utils/rpc.js";
import type { WalletPair } from "../wallet/derive.js";
import type { ReceiptStrategy } from "./receipt.js";

// Fixed gas limit for USDC transfers — skips eth_estimateGas which can fail
// on L2s when RPC state hasn't caught up with the just-confirmed prior tx.
// Typical USDC transfer uses ~40k-65k gas; 100k is generous but safe.
const TRANSFER_GAS_LIMIT = 100_000n;

// Retry config for transient RPC errors (rate limits, connection drops)
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

export type TxRecord = {
  txHash: string;
  latencyMs: number;
  gasUsed: bigint;
  direction: "A→B" | "B→A";
};

export type TesterResult = {
  pairIndex: number;
  transactions: TxRecord[];
  /** True if the tester ran until the stop signal (timer/Ctrl+C), false if it errored out. */
  completedCleanly: boolean;
};

/** Check if an error is transient (RPC issue, not an on-chain revert). */
function isTransientError(err: any): boolean {
  const msg = (err.message || err.shortMessage || "").toLowerCase();
  return (
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
  rpcUrl?: string
): Promise<TesterResult> {
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
          // Single RPC round trip — sign locally, send raw, get receipt back
          const signedTx = await wallet.signTransaction({
            to: usdcAddress,
            data,
            gasLimit: TRANSFER_GAS_LIMIT,
            nonce,
            chainId: providerNetwork.chainId,
            type: feeData.maxFeePerGas ? 2 : 0,
            ...feeOverrides,
          });

          const raw = await rpcSendRawTx(rpcUrl!, signedTx);

          const txHash = typeof raw === "string" ? raw : raw.transactionHash;
          const gasUsed = raw.gasUsed != null ? BigInt(raw.gasUsed) : TRANSFER_GAS_LIMIT;

          if (raw.status != null && BigInt(raw.status) === 0n) {
            throw new Error("transaction reverted on-chain");
          }

          const latencyMs = Date.now() - startTime;
          transactions.push({ txHash, latencyMs, gasUsed, direction });
        } else {
          // Standard path: send + wait for receipt (2 RPC round trips)
          const tx = await wallet.sendTransaction({
            to: usdcAddress,
            data,
            gasLimit: TRANSFER_GAS_LIMIT,
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
          gasLimit: TRANSFER_GAS_LIMIT,
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
