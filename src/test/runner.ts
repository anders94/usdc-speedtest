import type { JsonRpcProvider } from "ethers";
import ora from "ora";
import { runTester, type TesterResult } from "./tester.js";
import { computeStats, printSummary } from "./stats.js";
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

  const stopSignal = { stopped: false };
  const durationMs = durationSec * 1000;

  // Set up Ctrl+C handler
  const sigintHandler = () => {
    if (!stopSignal.stopped) {
      stopSignal.stopped = true;
      console.log(
        "\n  Ctrl+C received — stopping after current transactions complete..."
      );
    }
  };
  process.on("SIGINT", sigintHandler);

  // Set up timer
  const timer = setTimeout(() => {
    stopSignal.stopped = true;
  }, durationMs);

  const spinner = ora(
    `Running test... (${durationSec}s, Ctrl+C to stop early)`
  ).start();

  const startTime = Date.now();

  // Progress update interval
  const progressInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    spinner.text = `Running test... ${elapsed}s / ${durationSec}s (Ctrl+C to stop early)`;
  }, 1000);

  // Spawn all testers in parallel
  const results: TesterResult[] = await Promise.all(
    pairs.map((pair) =>
      runTester(pair, provider, network.usdcAddress, stopSignal)
    )
  );

  clearTimeout(timer);
  clearInterval(progressInterval);
  process.removeListener("SIGINT", sigintHandler);

  const actualDurationMs = Date.now() - startTime;
  spinner.stop();

  // Compute and display stats
  const stats = computeStats(results, actualDurationMs);
  printSummary(stats, network.name, pairs.length, results);
}
