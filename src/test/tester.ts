import { Wallet, type JsonRpcProvider } from "ethers";
import { getUsdcContract, USDC_CENT } from "../utils/usdc.js";
import type { WalletPair } from "../wallet/derive.js";

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
  stopSignal: { stopped: boolean }
): Promise<TesterResult> {
  const walletA = new Wallet(pair.sender.privateKey, provider);
  const walletB = new Wallet(pair.receiver.privateKey, provider);

  const usdcA = getUsdcContract(usdcAddress, walletA);
  const usdcB = getUsdcContract(usdcAddress, walletB);

  // Fetch nonces once upfront — track locally to avoid stale RPC reads
  let nonceA = await provider.getTransactionCount(walletA.address, "pending");
  let nonceB = await provider.getTransactionCount(walletB.address, "pending");

  const transactions: TxRecord[] = [];
  // usdcOnA tracks whether the USDC is currently held by wallet A (the even/sender wallet).
  // It starts true because funding puts USDC on even wallets.
  let usdcOnA = true;

  let erroredOut = false;

  while (!stopSignal.stopped) {
    const sender = usdcOnA ? usdcA : usdcB;
    const receiverAddr = usdcOnA ? walletB.address : walletA.address;
    const direction: TxRecord["direction"] = usdcOnA ? "A→B" : "B→A";
    const nonce = usdcOnA ? nonceA : nonceB;

    const startTime = Date.now();
    let succeeded = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (stopSignal.stopped) break;

      try {
        const tx = await (sender.transfer as any)(receiverAddr, USDC_CENT, {
          gasLimit: TRANSFER_GAS_LIMIT,
          nonce,
        });
        const receipt = await tx.wait();
        const latencyMs = Date.now() - startTime;

        transactions.push({
          txHash: receipt.hash,
          latencyMs,
          gasUsed: receipt.gasUsed,
          direction,
        });

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
        const tx = await (usdcB.transfer as any)(walletA.address, USDC_CENT, {
          gasLimit: TRANSFER_GAS_LIMIT,
          nonce: nonceB,
        });
        await tx.wait();
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
