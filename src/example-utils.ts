import * as process from "node:process";
import { Client } from "./client.ts";

export async function getAgentNumber(): Promise<string> {
  if (process.env.GUAVA_AGENT_NUMBER) return process.env.GUAVA_AGENT_NUMBER;

  const client = new Client();
  const numbers = await client.listNumbers();

  if (numbers.length === 0) {
    console.error("No agent phone numbers found. Please purchase a number first.");
    process.exit(1);
  }
  if (numbers.length === 1) return numbers[0].phoneNumber;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return terminalPicker(
      numbers.map((n) => n.phoneNumber),
      "Multiple agent phone numbers found. Select one",
    );
  }
  console.error(
    `Multiple agent phone numbers found: ${numbers.map((n) => n.phoneNumber).join(", ")}. Please set GUAVA_AGENT_NUMBER.`,
  );
  process.exit(1);
}

export async function terminalPicker(
  options: string[],
  prompt = "Select an option",
): Promise<string> {
  if (!options.length) throw new Error("options must be non-empty");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("terminalPicker requires a TTY stdin and stdout");

  return new Promise((resolve, reject) => {
    let selected = 0;
    let renderedLines = 0;

    function render() {
      const lines = [`${prompt}:`];
      for (let i = 0; i < options.length; i++) {
        lines.push(`${i === selected ? "❯" : " "} ${options[i]}`);
      }
      if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}F`);
      for (const line of lines) {
        process.stdout.write("\r\x1b[2K");
        process.stdout.write(line);
        process.stdout.write("\n");
      }
      for (let i = 0; i < renderedLines - lines.length; i++) {
        process.stdout.write("\r\x1b[2K\n");
      }
      renderedLines = lines.length;
    }

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    }

    function onData(data: Buffer) {
      const ch = data.toString();
      if (ch === "\r" || ch === "\n") {
        cleanup();
        process.stdout.write(`\r\x1b[2KSelected: ${options[selected]}\n`);
        resolve(options[selected]);
      } else if (ch === "\x03") {
        cleanup();
        reject(new Error("Interrupted"));
      } else if (ch === "\x1b[A") {
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (ch === "\x1b[B") {
        selected = (selected + 1) % options.length;
        render();
      }
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?25l");
    render();
    process.stdin.on("data", onData);
  });
}
