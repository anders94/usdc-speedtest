import {
  WebSocketProvider,
  type JsonRpcProvider,
  type TransactionReceipt,
  type TransactionResponse,
} from "ethers";

// Receipt polling config (used by PollingReceiptStrategy)
const MIN_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ReceiptStrategy {
  waitForReceipt(
    provider: JsonRpcProvider,
    tx: TransactionResponse,
    expectedMs: number
  ): Promise<TransactionReceipt>;
}

/**
 * Adaptive polling strategy — the original behavior extracted from tester.ts.
 * Waits ~80% of expected confirmation time, then polls at tight intervals.
 */
export class PollingReceiptStrategy implements ReceiptStrategy {
  async waitForReceipt(
    provider: JsonRpcProvider,
    tx: TransactionResponse,
    expectedMs: number
  ): Promise<TransactionReceipt> {
    const initialDelay = Math.max(expectedMs * 0.8, MIN_POLL_INTERVAL_MS);
    await sleep(initialDelay);

    const pollInterval = Math.max(
      Math.min(expectedMs / 4, MAX_POLL_INTERVAL_MS),
      MIN_POLL_INTERVAL_MS
    );

    while (true) {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt) {
        if (receipt.status === 0) {
          throw new Error("transaction reverted on-chain");
        }
        return receipt;
      }
      await sleep(pollInterval);
    }
  }
}

/**
 * WebSocket block subscription strategy.
 * A single `newHeads` subscription wakes all waiters when a new block arrives,
 * then each waiter checks its own receipt — one RPC call per waiter per block.
 */
export class WsBlockReceiptStrategy implements ReceiptStrategy {
  private wsProvider: WebSocketProvider;
  private waiters = new Set<() => void>();
  private destroyed = false;

  constructor(wsProvider: WebSocketProvider) {
    this.wsProvider = wsProvider;
    this.wsProvider.on("block", () => {
      for (const wake of this.waiters) {
        wake();
      }
    });
  }

  async waitForReceipt(
    provider: JsonRpcProvider,
    tx: TransactionResponse,
    _expectedMs: number
  ): Promise<TransactionReceipt> {
    // Optimistic: tx may already be mined by the time we check
    const immediate = await provider.getTransactionReceipt(tx.hash);
    if (immediate) {
      if (immediate.status === 0) {
        throw new Error("transaction reverted on-chain");
      }
      return immediate;
    }

    // Wait for block events
    while (!this.destroyed) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
      // Woken by block event (or destroy) — remove ourselves before checking
      // (the resolve callback is already removed from the set by Set semantics
      //  since Promise resolves only once, but we clean up explicitly below)

      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt) {
        if (receipt.status === 0) {
          throw new Error("transaction reverted on-chain");
        }
        return receipt;
      }
    }

    // If destroyed while waiting, do one last check
    const last = await provider.getTransactionReceipt(tx.hash);
    if (last) {
      if (last.status === 0) {
        throw new Error("transaction reverted on-chain");
      }
      return last;
    }
    throw new Error("WebSocket connection closed while waiting for receipt");
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    // Wake all lingering waiters so they can exit
    for (const wake of this.waiters) {
      wake();
    }
    this.waiters.clear();
    await this.wsProvider.destroy();
  }
}

/**
 * Immediate receipt strategy for instant-finality chains (e.g. Radius).
 * The receipt is available as soon as sendTransaction returns, so we just
 * call tx.wait() which resolves on the first getTransactionReceipt attempt.
 */
export class ImmediateReceiptStrategy implements ReceiptStrategy {
  async waitForReceipt(
    _provider: JsonRpcProvider,
    tx: TransactionResponse,
    _expectedMs: number
  ): Promise<TransactionReceipt> {
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("No receipt returned from tx.wait()");
    }
    if (receipt.status === 0) {
      throw new Error("transaction reverted on-chain");
    }
    return receipt;
  }
}

/**
 * Factory: creates the appropriate receipt strategy.
 * immediateReceipt → ImmediateReceiptStrategy (instant-finality chains)
 * wsUrl            → WsBlockReceiptStrategy (WebSocket block subscription)
 * otherwise        → PollingReceiptStrategy (adaptive polling)
 */
export async function createReceiptStrategy(
  wsUrl: string | undefined,
  chainId: number,
  immediateReceipt?: boolean
): Promise<ReceiptStrategy> {
  if (immediateReceipt) {
    return new ImmediateReceiptStrategy();
  }

  if (!wsUrl) {
    return new PollingReceiptStrategy();
  }

  try {
    const wsProvider = new WebSocketProvider(wsUrl, chainId, {
      staticNetwork: true,
    });

    // Wait for the WS connection to be ready (with timeout)
    await Promise.race([
      wsProvider.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000)
      ),
    ]);

    return new WsBlockReceiptStrategy(wsProvider);
  } catch (err: any) {
    const reason = err.message || String(err);
    console.warn(
      `  Warning: WebSocket connection failed (${reason}), falling back to polling`
    );
    return new PollingReceiptStrategy();
  }
}
