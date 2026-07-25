import { Command } from "commander";
import * as guava from "@guava-ai/guava-sdk";
import { DocumentQA } from "@guava-ai/guava-sdk/helpers";
import { IntentRecognizer } from "@guava-ai/guava-sdk/helpers";
import { FURNITURE_RETAILER_QA } from "@guava-ai/guava-sdk/example-data";
import { getAgentNumber } from "@guava-ai/guava-sdk/example-utils";

export const agent = new guava.Agent({
  name: "Nova",
  organization: "Clearfield Home & Living",
  purpose: "Answer questions and route callers to the appropriate department.",
});

const documentQA = new DocumentQA({
  documents: FURNITURE_RETAILER_QA,
  namespace: "clearfield-home-living-qa",
});

const intentRecognizer = new IntentRecognizer([
  "sales",
  "delivery-and-returns",
  "account-management",
  "other",
]);

agent.onQuestion(async (_call: guava.Call, question: string) => {
  return await documentQA.ask(question);
});

agent.onActionRequest(async (_call: guava.Call, request: string) => {
  return await intentRecognizer.classify(request);
});

agent.onAction("sales", async (call: guava.Call) => {
  call.transfer(
    "+15555555555",
    "Notify the caller that you will be transferring them to the Sales department.",
  );
});

agent.onAction("delivery-and-returns", async (call: guava.Call) => {
  call.transfer(
    "+15555555555",
    "Notify the caller that you will be transferring them to the Delivery and Returns department.",
  );
});

agent.onAction("account-management", async (call: guava.Call) => {
  call.transfer(
    "+15555555555",
    "Notify the caller that you will be transferring them to the Account Management department.",
  );
});

agent.onAction("other", async (call: guava.Call) => {
  call.transfer(
    "+15555555555",
    "Notify the caller that you will be connecting them with a service representative.",
  );
});

export async function run(prog: string, args: string[]) {
  const program = new Command().name(prog).showHelpAfterError();

  // Every Agent can be attached to one of many different channels.
  program
    .command("phone [number]")
    .description("Listen for phone calls.")
    .action(async (number?: string) => {
      await agent.listenPhone(number ?? (await getAgentNumber()));
    });

  program
    .command("webrtc [code]")
    .description("Listen on a WebRTC code.")
    .action(async (code?: string) => {
      await agent.listenWebrtc(code);
    });

  program
    .command("sip <code>")
    .description("Listen on a SIP code 'guavasip-...'.")
    .action(async (code: string) => {
      await agent.listenSip(code);
    });

  program
    .command("local")
    .description("Start a local call.")
    .action(async () => {
      await agent.callLocal();
    });

  program
    .command("chat")
    .description("Start a local chat session (for testing).")
    .action(async () => {
      await agent.chat();
    });

  await program.parseAsync(args, { from: "user" });
}
