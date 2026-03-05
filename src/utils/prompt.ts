import { createInterface } from "readline";

export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/**
 * Present numbered options and return the 1-based index the user picked.
 * Returns 0 if the user enters nothing or an invalid choice.
 */
export async function choose(
  message: string,
  options: string[]
): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i]}`);
  }
  return new Promise((resolve) => {
    rl.question(`${message} `, (answer) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      resolve(num >= 1 && num <= options.length ? num : 0);
    });
  });
}
