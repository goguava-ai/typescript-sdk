#!/usr/bin/env node

const EXAMPLES = {
  "scheduling-outbound": () => import("../examples/scheduling-outbound"),
  "property-insurance": () => import("../examples/property-insurance"),
  "restaurant-waitlist": () => import("../examples/restaurant-waitlist"),
  "help-desk": () => import("../examples/help-desk"),
  "polling-campaign": () => import("../examples/polling-campaign"),
};

const exampleName = process.argv[2];
if (!exampleName) {
  console.error("Usage: guava-example <example-name> <example-args>");
  console.error("Available examples:", Object.keys(EXAMPLES).join(", "));
  process.exit(1);
}

if (!(exampleName in EXAMPLES)) {
  console.error(`Unknown example "${exampleName}". Available examples: ${Object.keys(EXAMPLES).join(", ")}`);
  process.exit(1);
}

(async () => {
  const mod = await EXAMPLES[exampleName as keyof typeof EXAMPLES]();
  await mod.run(process.argv.slice(3));
})();