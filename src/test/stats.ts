import chalk from "chalk";
import type { TesterResult } from "./tester.js";
import * as log from "../utils/logger.js";

export type TestSummary = {
  totalTransactions: number;
  totalDurationMs: number;
  transactionsPerSecond: number;
  totalGasUsed: bigint;
  avgGasPerTx: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function computeStats(
  results: TesterResult[],
  durationMs: number
): TestSummary {
  // Only include testers that ran the full duration (not errored out)
  const cleanResults = results.filter((r) => r.completedCleanly);

  const allLatencies: number[] = [];
  let totalGas = 0n;

  for (const r of cleanResults) {
    for (const tx of r.transactions) {
      allLatencies.push(tx.latencyMs);
      totalGas += tx.gasUsed;
    }
  }

  allLatencies.sort((a, b) => a - b);

  const total = allLatencies.length;

  return {
    totalTransactions: total,
    totalDurationMs: durationMs,
    transactionsPerSecond: total > 0 ? total / (durationMs / 1000) : 0,
    totalGasUsed: totalGas,
    avgGasPerTx: total > 0 ? Number(totalGas / BigInt(total)) : 0,
    avgLatencyMs:
      total > 0 ? allLatencies.reduce((a, b) => a + b, 0) / total : 0,
    minLatencyMs: allLatencies[0] ?? 0,
    maxLatencyMs: allLatencies[allLatencies.length - 1] ?? 0,
    p50LatencyMs: percentile(allLatencies, 50),
    p95LatencyMs: percentile(allLatencies, 95),
    p99LatencyMs: percentile(allLatencies, 99),
  };
}

export function printSummary(
  stats: TestSummary,
  networkName: string,
  parallelTesters: number,
  results: TesterResult[],
  trafficShaped?: boolean
): void {
  log.header(`USDC Speedtest Results — ${networkName}`);

  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtMs = (n: number) => `${fmt(n)} ms`;

  const cleanCount = results.filter((r) => r.completedCleanly).length;
  const errorCount = parallelTesters - cleanCount;

  console.log();
  console.log(chalk.white(`  Duration:            ${fmt(stats.totalDurationMs / 1000)}s`));
  console.log(chalk.white(`  Parallel testers:    ${cleanCount} of ${parallelTesters}` +
    (errorCount > 0 ? chalk.yellow(` (${errorCount} errored out)`) : "")));
  console.log(chalk.bold.white(`  Total transactions:  ${stats.totalTransactions}`));
  console.log(chalk.bold.green(`  Throughput:          ${fmt(stats.transactionsPerSecond)} tx/s`));

  console.log();
  console.log(chalk.white.bold("  Latency:"));
  console.log(chalk.white(`    Average:           ${fmtMs(stats.avgLatencyMs)}`));
  console.log(chalk.white(`    Median (p50):      ${fmtMs(stats.p50LatencyMs)}`));
  console.log(chalk.white(`    p95:               ${fmtMs(stats.p95LatencyMs)}`));
  console.log(chalk.white(`    p99:               ${fmtMs(stats.p99LatencyMs)}`));
  console.log(chalk.white(`    Min:               ${fmtMs(stats.minLatencyMs)}`));
  console.log(chalk.white(`    Max:               ${fmtMs(stats.maxLatencyMs)}`));

  console.log();
  console.log(chalk.white.bold("  Gas:"));
  console.log(chalk.white(`    Total used:        ${stats.totalGasUsed.toLocaleString()}`));
  console.log(chalk.white(`    Average per tx:    ${fmt(stats.avgGasPerTx)}`));

  console.log();
  console.log(chalk.white.bold("  Per-tester breakdown:"));
  for (const r of results) {
    const count = r.transactions.length;
    const avg =
      count > 0
        ? r.transactions.reduce((s, t) => s + t.latencyMs, 0) / count
        : 0;
    const status = r.completedCleanly ? "" : chalk.yellow(" (errored)");
    console.log(
      chalk.white(`    Tester #${r.pairIndex}:  ${count} txs,  avg ${fmtMs(avg)}`) + status
    );
  }

  if (trafficShaped) {
    console.log();
    console.log(chalk.yellow("  Note: Throughput reflects traffic-shaped load, not maximum capacity"));
  }

  console.log(chalk.cyan("\n" + "═".repeat(60) + "\n"));
}
