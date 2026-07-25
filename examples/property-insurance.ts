import { Command } from "commander";
import * as guava from "@guava-ai/guava-sdk";
import { DocumentQA } from "@guava-ai/guava-sdk/helpers";
import { PROPERTY_INSURANCE_POLICY } from "@guava-ai/guava-sdk/example-data";
import { getAgentNumber } from "@guava-ai/guava-sdk/example-utils";

const agent = new guava.Agent({
  organization: "Harper Valley Property Insurance",
  purpose: "Answer questions regarding property insurance policy until there are no more questions",
});

// This is a built-in knowledge base helper that we will use for this example.
// You can use any RAG system you prefer.
const documentQA = new DocumentQA({
  documents: PROPERTY_INSURANCE_POLICY,
  namespace: "harper-valley-property-insurance",
});

// When the Agent is asked a question that it cannot answer, it will invoke the on_question callback.
agent.onQuestion(async (call: guava.Call, question: string) => {
  // Forward the Agent's question to the knowledge base and return the answer.
  // You can plug in any knowledge base system you want here.
  return await documentQA.ask(question);
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
    .description("Start an interactive terminal chat.")
    .action(async () => {
      await agent.chat();
    });

  await program.parseAsync(args, { from: "user" });
}
