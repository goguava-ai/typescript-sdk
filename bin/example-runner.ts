#!/usr/bin/env node

import * as path from "node:path";
import { Command } from "commander";

const USE_COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = {
  reset: USE_COLOR ? "\x1b[0m" : "",
  dim: USE_COLOR ? "\x1b[2m" : "",
  green: USE_COLOR ? "\x1b[32m" : "",
  red: USE_COLOR ? "\x1b[38;5;196m" : "",
  bold: USE_COLOR ? "\x1b[1m" : "",
  cyan: USE_COLOR ? "\x1b[36m" : "",
};

type TestFn = () => Promise<void> | void;
type Registered = { suite: string; name: string; fn: TestFn };

// This is a minimal in-process implementation of a Jest-like test runnner to allow the agent testing example
// to be run from example runner.
async function runAgentTesting(_prog: string, _args: string[]): Promise<void> {
  const registered: Registered[] = [];
  let currentSuite = "";

  (global as any).describe = (name: string, fn: () => void) => {
    currentSuite = name;
    fn();
    currentSuite = "";
  };

  (global as any).test = (name: string, fn: TestFn) => {
    registered.push({ suite: currentSuite, name, fn });
  };

  (global as any).expect = (received: unknown) => ({
    toBe(expected: unknown) {
      if (received !== expected)
        throw new Error(`Expected ${JSON.stringify(received)} to be ${JSON.stringify(expected)}`);
    },
    toContain(expected: unknown) {
      if (!Array.isArray(received) || !received.includes(expected))
        throw new Error(`Expected array to contain ${JSON.stringify(expected)}`);
    },
    toContainEqual(expected: unknown) {
      if (
        !Array.isArray(received) ||
        !received.some(
          (item) => JSON.stringify(item) === JSON.stringify(expected),
        )
      )
        throw new Error(`Expected array to contain equal to ${JSON.stringify(expected)}`);
    },
    toHaveProperty(key: string, expected?: unknown) {
      const obj = received as Record<string, unknown>;
      if (!(key in obj))
        throw new Error(`Expected object to have property "${key}"`);
      if (expected !== undefined && obj[key] !== expected)
        throw new Error(
          `Expected property "${key}" to be ${JSON.stringify(expected)}, got ${JSON.stringify(obj[key])}`,
        );
    },
  });

  const prevLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "off";
  await import("../examples/agent-testing.test");

  let passed = 0,
    failed = 0;
  for (const { suite, name, fn } of registered) {
    process.stdout.write(`${c.dim}${suite} › ${name}${c.reset} `);
    try {
      await fn();
      process.stdout.write(`${c.green}✓ passed${c.reset}\n`);
      passed++;
    } catch (e: any) {
      process.stdout.write(`${c.red}✗ FAILED${c.reset}\n`);
      console.error(`  ${c.red}${e.message}${c.reset}`);
      failed++;
    }
  }

  process.env.LOG_LEVEL = prevLogLevel ?? "";

  const summary =
    failed > 0
      ? `${c.bold}${c.green}${passed} passed${c.reset}, ${c.bold}${c.red}${failed} failed${c.reset}`
      : `${c.bold}${c.green}${passed} passed${c.reset}`;
  console.log(`\n${summary}`);
  if (failed > 0) process.exit(1);
}

type ExampleEntry = {
  description: string;
  load: () => Promise<{ run: (prog: string, args: string[]) => Promise<void> }>;
};

// Reconstruct how this program was launched so usage/help text matches the
// command the user actually typed.
function launcher(): string {
  const script = process.argv[1] ?? "";
  if (script.endsWith(".ts")) {
    // Developer workflow, e.g. `npx tsx ./bin/example-runner.ts <example>`.
    const rel = path.relative(process.cwd(), script) || path.basename(script);
    return `npx tsx ${rel}`;
  }
  // Installed package: exposed as the `guava-example` bin (also how
  // `npx @guava-ai/guava-sdk@latest ...` resolves).
  return "guava-example";
}

function invocationPrefix(exampleName: string): string {
  return `${launcher()} ${exampleName}`;
}

const EXAMPLES: Record<string, ExampleEntry> = {
  "scheduling-outbound": {
    description: "Outbound scheduling agent",
    load: () => import("../examples/scheduling-outbound"),
  },
  "property-insurance": {
    description: "Inbound property insurance Q&A agent",
    load: () => import("../examples/property-insurance"),
  },
  "restaurant-waitlist": {
    description: "Inbound restaurant waitlist agent",
    load: () => import("../examples/restaurant-waitlist"),
  },
  "help-desk": {
    description: "Inbound customer support routing and FAQ agent",
    load: () => import("../examples/help-desk"),
  },
  "polling-campaign": {
    description: "Attach a polling agent to a Guava campaign",
    load: () => import("../examples/polling-campaign"),
  },
  "multiple-agents": {
    description: "Run two agents simultaneously using Runner",
    load: () => import("../examples/multiple-agents"),
  },
  "agent-testing": {
    description: "Run agent unit tests and conversation simulations",
    load: async () => ({ run: runAgentTesting }),
  },
};

// Help styling. We always emit ANSI here; commander strips it per output stream
// when the destination doesn't support color (NO_COLOR, non-TTY, etc.).
const ansi = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// Each example owns its own commander program (its channel subcommands live in
// its `run`). This top-level program just selects an example and forwards the
// remaining args verbatim, so only the chosen example's module is imported.
const program = new Command()
  .name(launcher())
  .description("Runnable examples for the Guava TypeScript SDK.")
  .showHelpAfterError()
  .helpCommand(false)
  .configureHelp({
    styleTitle: ansi.bold,
    styleCommandText: ansi.green,
    styleSubcommandTerm: ansi.green,
    styleOptionTerm: ansi.cyan,
    styleArgumentTerm: ansi.cyan,
    styleSubcommandDescription: ansi.dim,
    styleOptionDescription: ansi.dim,
    styleArgumentDescription: ansi.dim,
  });

for (const [name, entry] of Object.entries(EXAMPLES)) {
  program
    .command(name)
    .description(entry.description)
    .argument("[args...]", "arguments forwarded to the example")
    // The example has no options of its own here, so everything after its name
    // (including flags like `--phone` and `--help`) is forwarded into `args`
    // for the example's own commander to parse.
    .allowUnknownOption()
    .helpOption(false)
    .action(async (args: string[]) => {
      const mod = await entry.load();
      await mod.run(invocationPrefix(name), args);
    });
}

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
