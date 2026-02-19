import { Wallet, type JsonRpcProvider } from "ethers";
import { getUsdcContract, USDC_CENT } from "../utils/usdc.js";
import type { WalletPair } from "../wallet/derive.js";

// Fixed gas limit for USDC transfers — skips eth_estimateGas which can fail
// on L2s when RPC state hasn't caught up with the just-confirmed prior tx.
// Typical USDC transfer uses ~40k-65k gas; 100k is generous but safe.
const TRANSFER_GAS_LIMIT = 100_000n;

export type TxRecord = {
  txHash: string;
  latencyMs: number;
  gasUsed: bigint;
  direction: "A→B" | "B→A";
};

export type TesterResult = {
  pairIndex: number;
  transactions: TxRecord[];
};

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

  const transactions: TxRecord[] = [];
  // usdcOnA tracks whether the USDC is currently held by wallet A (the even/sender wallet).
  // It starts true because funding puts USDC on even wallets.
  let usdcOnA = true;

  while (!stopSignal.stopped) {
    const sender = usdcOnA ? usdcA : usdcB;
    const receiverAddr = usdcOnA ? walletB.address : walletA.address;
    const direction: TxRecord["direction"] = usdcOnA ? "A→B" : "B→A";

    const startTime = Date.now();

    try {
      const tx = await (sender.transfer as any)(receiverAddr, USDC_CENT, {
        gasLimit: TRANSFER_GAS_LIMIT,
      });
      const receipt = await tx.wait();
      const latencyMs = Date.now() - startTime;

      transactions.push({
        txHash: receipt.hash,
        latencyMs,
        gasUsed: receipt.gasUsed,
        direction,
      });

      usdcOnA = !usdcOnA;
    } catch (err: any) {
      // If stopped during a tx, just break — the send failed so USDC didn't move
      if (stopSignal.stopped) break;

      const shortReason =
        err.reason || err.shortMessage || err.message?.slice(0, 120);
      console.error(
        `  Tester #${pair.index} error (${direction}): ${shortReason}`
      );
      break;
    }
  }

  // If USDC ended up on wallet B (the odd wallet), send it back to A
  // so that cleanup always finds USDC on the even wallets.
  if (!usdcOnA) {
    try {
      const tx = await (usdcB.transfer as any)(walletA.address, USDC_CENT, {
        gasLimit: TRANSFER_GAS_LIMIT,
      });
      await tx.wait();
    } catch (err: any) {
      const shortReason =
        err.reason || err.shortMessage || err.message?.slice(0, 120);
      console.error(
        `  Tester #${pair.index}: failed to return USDC to sender wallet: ${shortReason}`
      );
    }
  }

  return { pairIndex: pair.index, transactions };
}
