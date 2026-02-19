import chalk from "chalk";

export function header(text: string): void {
  const line = "═".repeat(60);
  console.log(chalk.bold.cyan(`\n${line}`));
  console.log(chalk.bold.cyan(`  ${text}`));
  console.log(chalk.bold.cyan(line));
}

export function info(text: string): void {
  console.log(chalk.blue(`  ${text}`));
}

export function success(text: string): void {
  console.log(chalk.green(`  ${text}`));
}

export function warn(text: string): void {
  console.log(chalk.yellow(`  ${text}`));
}

export function error(text: string): void {
  console.log(chalk.red(`  ${text}`));
}

export function table(rows: string[][]): void {
  if (rows.length === 0) return;

  const colWidths = rows[0].map((_, colIdx) =>
    Math.max(...rows.map((row) => (row[colIdx] || "").length))
  );

  for (const row of rows) {
    const formatted = row
      .map((cell, i) => cell.padEnd(colWidths[i]))
      .join("  ");
    console.log(`  ${formatted}`);
  }
}
