#!/usr/bin/env node

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
async function runAgentTesting(_args: string[]): Promise<void> {
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
  load: () => Promise<{ run: (args: string[]) => Promise<void> }>;
};

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

function printUsage(message?: string): void {
  const colWidth = Math.max(...Object.keys(EXAMPLES).map((k) => k.length)) + 3;
  if (message) {
    console.error(`${c.red}${message}${c.reset}\n`);
  }
  console.error(`${c.bold}Usage:${c.reset} guava-example <example-name> [args...]\n`);
  console.error(`${c.bold}Examples:${c.reset}`);
  for (const [name, { description }] of Object.entries(EXAMPLES)) {
    const padded = name.padEnd(colWidth);
    console.error(`  ${c.cyan}${padded}${c.reset}${c.dim}${description}${c.reset}`);
  }
}

const exampleName = process.argv[2];
if (!exampleName) {
  printUsage();
  process.exit(1);
}

if (!(exampleName in EXAMPLES)) {
  printUsage(`Unknown example "${exampleName}".`);
  process.exit(1);
}

(async () => {
  const mod = await EXAMPLES[exampleName].load();
  await mod.run(process.argv.slice(3));
})();
