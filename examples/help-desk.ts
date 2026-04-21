import * as guava from "@guava-ai/guava-sdk";
import { DocumentQA, IntentRecognizer } from "@guava-ai/guava-sdk/helpers/openai";
import { FURNITURE_RETAILER_QA } from "@guava-ai/guava-sdk/example-data";
import { getDefaultLogger } from "@guava-ai/guava-sdk";

const agent = new guava.Agent({
  name: "Nova",
  organization: "Clearfield Home & Living",
  purpose: "Answer questions and route callers to the appropriate department.",
});

const logger = getDefaultLogger();

const documentQA = new DocumentQA("clearfield-home-living-qa", FURNITURE_RETAILER_QA);

const intentRecognizer = new IntentRecognizer(
  ["sales", "delivery-and-returns", "account-management", "other"] as const,
  logger,
);

agent.onQuestion(async (_call: guava.Call, question: string) => {
  return await documentQA.ask(question);
});

agent.onActionRequest(async (_call: guava.Call, request: string) => {
  const key = await intentRecognizer.classify(request);
  return { key };
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

export async function run(_args: string[]) {
  agent.inboundPhone(process.env.GUAVA_AGENT_NUMBER!);
}
