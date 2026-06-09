import { format as utilFormat } from "node:util";
import type { TestSession } from "./session.ts";

type SystemLevel = "log" | "info" | "debug" | "warn" | "error";
type Message =
  | { speaker: "agent" | "you"; text: string }
  | { speaker: "system"; text: string; level: SystemLevel };

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED_BOLD = "\x1b[1;31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

function wordWrap(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    let breakAt = remaining.lastIndexOf(" ", width);
    if (breakAt <= 0) breakAt = width;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function lineColor(speaker: Message["speaker"], level?: SystemLevel): string {
  if (speaker === "agent") return CYAN;
  if (speaker === "you") return GREEN;
  if (level === "warn") return YELLOW;
  if (level === "error") return RED_BOLD;
  return DIM;
}

function render(messages: Message[], inputBuf: string, sessionEnded: boolean): void {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const convHeight = Math.max(1, height - 2);

  const allLines: { text: string; speaker: Message["speaker"]; level?: SystemLevel }[] = [];
  for (const msg of messages) {
    if (msg.speaker === "system") {
      const wrapped = wordWrap(msg.text, width);
      for (const line of wrapped) {
        allLines.push({ text: line, speaker: "system", level: msg.level });
      }
    } else {
      const prefix = msg.speaker === "agent" ? "agent: " : "you:   ";
      const continuation = " ".repeat(prefix.length);
      const innerWidth = Math.max(1, width - prefix.length);
      const wrapped = wordWrap(msg.text, innerWidth);
      wrapped.forEach((line, i) => {
        allLines.push({ text: (i === 0 ? prefix : continuation) + line, speaker: msg.speaker });
      });
    }
  }

  const visibleLines = allLines.slice(-convHeight);

  let out = "\x1b[?25l\x1b[2J\x1b[H";

  for (let i = 0; i < convHeight; i++) {
    out += moveTo(i + 1, 1);
    const line = visibleLines[i];
    if (line) {
      const color = lineColor(line.speaker, line.level);
      out += color + line.text.slice(0, width) + RESET;
    }
  }

  out += moveTo(height - 1, 1) + "─".repeat(width);

  if (sessionEnded) {
    out += `${moveTo(height, 1)}Session ended. Press any key to exit.`;
  } else {
    const label = "you: ";
    const maxLen = Math.max(0, width - label.length);
    out += moveTo(height, 1) + label + inputBuf.slice(-maxLen);
  }

  out += "\x1b[?25h";
  process.stdout.write(out);
}

function hookConsole(
  messages: Message[],
  getState: () => { inputBuf: string; sessionEnded: boolean; cleaned: boolean },
): () => void {
  const orig = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  function makeHook(level: SystemLevel) {
    return (...args: unknown[]) => {
      const { cleaned, inputBuf, sessionEnded } = getState();
      messages.push({
        speaker: "system",
        text: utilFormat(...args),
        level,
      });
      if (!cleaned) render(messages, inputBuf, sessionEnded);
    };
  }

  console.log = makeHook("log");
  console.info = makeHook("info");
  console.debug = makeHook("debug");
  console.warn = makeHook("warn");
  console.error = makeHook("error");

  return () => {
    console.log = orig.log;
    console.info = orig.info;
    console.debug = orig.debug;
    console.warn = orig.warn;
    console.error = orig.error;
  };
}

export async function runChat(session: TestSession): Promise<void> {
  const messages: Message[] = [];
  let inputBuf = "";
  let sessionEnded = false;
  let cleaned = false;

  const restoreConsole = hookConsole(messages, () => ({ inputBuf, sessionEnded, cleaned }));

  // Consume agent messages in the background
  void (async () => {
    try {
      while (true) {
        const event = await session.recv();
        if (event.message_type === "bot-tts") {
          messages.push({ speaker: "agent", text: event.transcript });
          if (!cleaned) render(messages, inputBuf, sessionEnded);
        }
      }
    } catch {
      if (!cleaned) {
        sessionEnded = true;
        render(messages, inputBuf, sessionEnded);
      }
    }
  })();

  process.stdin.setRawMode(true);
  process.stdin.resume();
  render(messages, inputBuf, sessionEnded);

  try {
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        const ch = chunk[0]!;

        if (sessionEnded || ch === 0x03 /* Ctrl+C */) {
          process.stdin.off("data", onData);
          resolve();
          return;
        }

        if (ch === 0x0d || ch === 0x0a /* Enter */) {
          const utterance = inputBuf.trim();
          if (utterance) {
            messages.push({ speaker: "you", text: utterance });
            session.say(utterance);
          }
          inputBuf = "";
        } else if (ch === 0x7f || ch === 0x08 /* Backspace */) {
          inputBuf = inputBuf.slice(0, -1);
        } else if (ch >= 0x20 && ch < 0x7f /* Printable ASCII */) {
          inputBuf += String.fromCharCode(ch);
        }

        render(messages, inputBuf, sessionEnded);
      };

      process.stdin.on("data", onData);
    });
  } finally {
    cleaned = true;
    restoreConsole();
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
  }
}
