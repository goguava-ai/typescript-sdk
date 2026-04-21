import * as guava from "@guava-ai/guava-sdk";
import { DocumentQA } from "@guava-ai/guava-sdk/helpers/openai";
import { PROPERTY_INSURANCE_POLICY } from "@guava-ai/guava-sdk/example-data";

const agent = new guava.Agent({
  organization: "Harper Valley Property Insurance",
  purpose: "Answer questions regarding property insurance policy until there are no more questions",
});

// This is a built-in knowledge base helper that we will use for this example.
// You can use any RAG system you prefer.
const documentQA = new DocumentQA("harper-valley-property-insurance", PROPERTY_INSURANCE_POLICY);

// When the Agent is asked a question that it cannot answer, it will invoke the on_question callback.
agent.onQuestion(async (call: guava.Call, question: string) => {
  // Forward the Agent's question to the knowledge base and return the answer.
  // You can plug in any knowledge base system you want here.
  return await documentQA.ask(question);
});

export async function run(args: string[]) {
  agent.inboundPhone(process.env.GUAVA_AGENT_NUMBER!);
}
