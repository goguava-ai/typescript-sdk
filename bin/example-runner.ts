#!/usr/bin/env node
import * as schedulingOutbound from "../examples/scheduling-outbound";
import * as propertyInsurance from "../examples/property-insurance";
import * as creditCardActivation from "../examples/credit-card-activation";
import * as thaiPalace from "../examples/thai-palace";

const EXAMPLES = {
  "scheduling-outbound": schedulingOutbound,
  "property-insurance": propertyInsurance,
  "credit-card-activation": creditCardActivation,
  "thai-palace": thaiPalace,
};

const exampleName = process.argv[2];
if (!exampleName) {
  console.error("Usage: guava-example <example-name> <example-args>");
  console.error("Available examples:", Object.keys(EXAMPLES).join(", "))
  process.exit(1);
}

if (!(exampleName in EXAMPLES)) {
  console.error(`Unknown example "${exampleName}". Available examples: ${Object.keys(EXAMPLES).join(", ")}`);
  process.exit(1);
}

(async () => {
  await EXAMPLES[exampleName as keyof typeof EXAMPLES].run(process.argv.slice(3));
})();