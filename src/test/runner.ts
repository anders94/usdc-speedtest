import { JsonRpcProvider, formatEther } from "ethers";
import ora from "ora";
import { runTester, type TesterResult } from "./tester.js";
import {
  createReceiptStrategy,
  WsBlockReceiptStrategy,
  ImmediateReceiptStrategy,
} from "./receipt.js";
import { computeStats, printSummary } from "./stats.js";
import { getUsdcContract, USDC_CENT, formatUsdc } from "../utils/usdc.js";
import { pMap } from "../utils/concurrency.js";
import { confirm } from "../utils/prompt.js";
import * as log from "../utils/logger.js";
import type { WalletPair } from "../wallet/derive.js";
import type { NetworkConfig } from "../config/networks.js";

export async function runTest(
  pairs: WalletPair[],
  provider: JsonRpcProvider,
  network: NetworkConfig,
  durationSec: number
): Promise<void> {
  log.header(`Ready to Start — ${network.name}`);
  log.info(`${pairs.length} parallel testers for ${durationSec} seconds`);
  log.warn("Running the test will spend gas on each transaction.");
  console.log();

  const ok = await confirm("Start the test?");
  if (!ok) {
    log.warn("Test cancelled.");
    return;
  }

  // Pre-flight: verify sender wallets have USDC and all wallets have ETH
  const preflight = ora("Pre-flight check: verifying wallet balances...").start();
  const usdc = getUsdcContract(network.usdcAddress, provider);
  const problems: string[] = [];

  await pMap(
    pairs,
    async (pair) => {
      const [senderUsdc, senderEth, receiverEth] = await Promise.all([
        usdc.balanceOf(pair.sender.address) as Promise<bigint>,
        provider.getBalance(pair.sender.address),
        provider.getBalance(pair.receiver.address),
      ]);

      if (senderUsdc < USDC_CENT) {
        problems.push(
          `Tester #${pair.index} sender ${pair.sender.address.slice(0, 6)}...${pair.sender.address.slice(-4)} has ${formatUsdc(senderUsdc)} USDC (need ${formatUsdc(USDC_CENT)})`
        );
      }
      if (senderEth === 0n) {
        problems.push(
          `Tester #${pair.index} sender ${pair.sender.address.slice(0, 6)}...${pair.sender.address.slice(-4)} has 0 ETH for gas`
        );
      }
      if (receiverEth === 0n) {
        problems.push(
          `Tester #${pair.index} receiver ${pair.receiver.address.slice(0, 6)}...${pair.receiver.address.slice(-4)} has 0 ETH for gas`
        );
      }
    },
    10
  );

  if (problems.length > 0) {
    preflight.fail("Pre-flight check failed:");
    for (const p of problems) {
      log.error(`  ${p}`);
    }
    console.log();
    log.info("Run without --skip-funding to fund wallets, or use --cleanup and start fresh.");
    throw new Error("Pre-flight check failed: wallets not ready");
  }
  preflight.succeed("Pre-flight check passed — all wallets ready");

  // Set up receipt waiting strategy (WebSocket or polling)
  const receiptStrategy = await createReceiptStrategy(
    network.wsUrl,
    network.chainId,
    network.immediateReceipt
  );
  const mode =
    receiptStrategy instanceof ImmediateReceiptStrategy
      ? "immediate"
      : receiptStrategy instanceof WsBlockReceiptStrategy
        ? "WebSocket"
        : "polling";

  const stopSignal = { stopped: false };
  const durationMs = durationSec * 1000;
  let testEndTime = 0;

  // Set up Ctrl+C handler
  const sigintHandler = () => {
    if (!stopSignal.stopped) {
      stopSignal.stopped = true;
      testEndTime = Date.now();
    }
  };
  process.on("SIGINT", sigintHandler);

  // Set up timer
  const timer = setTimeout(() => {
    stopSignal.stopped = true;
    testEndTime = Date.now();
  }, durationMs);

  const spinner = ora(
    `Running test (${mode})... (${durationSec}s, Ctrl+C to stop early)`
  ).start();

  const startTime = Date.now();
  const doneCount = { value: 0 };

  // Progress update interval
  const progressInterval = setInterval(() => {
    if (stopSignal.stopped) {
      const remaining = pairs.length - doneCount.value;
      spinner.text = `Cleaning up... ${remaining} of ${pairs.length} testers still finishing`;
    } else {
      const elapsed = Math.min(
        Math.floor((Date.now() - startTime) / 1000),
        durationSec
      );
      spinner.text = `Running test (${mode})... ${elapsed}s / ${durationSec}s (Ctrl+C to stop early)`;
    }
  }, 1000);

  // Spawn all testers in parallel
  // When immediateReceipt is true, each tester gets its own JsonRpcProvider
  // so they have independent HTTP connections — avoids socket pool bottleneck
  // when eth_sendRawTransaction blocks until finality.
  const results: TesterResult[] = await Promise.all(
    pairs.map(async (pair) => {
      const testerProvider = network.immediateReceipt
        ? new JsonRpcProvider(network.rpcUrl, network.chainId, { staticNetwork: true })
        : provider;
      const result = await runTester(
        pair,
        testerProvider,
        network.usdcAddress,
        network.estimatedBlockTimeMs,
        stopSignal,
        receiptStrategy,
        network.immediateReceipt
      );
      doneCount.value++;
      return result;
    })
  );

  clearTimeout(timer);
  clearInterval(progressInterval);
  process.removeListener("SIGINT", sigintHandler);

  // Tear down WebSocket connection if active
  if (receiptStrategy instanceof WsBlockReceiptStrategy) {
    await receiptStrategy.destroy();
  }

  // Use the time the stop signal fired (not when cleanup finished) for accurate throughput
  const actualDurationMs = testEndTime - startTime;
  spinner.stop();

  // Compute and display stats
  const stats = computeStats(results, actualDurationMs);
  printSummary(stats, network.name, pairs.length, results);
}
