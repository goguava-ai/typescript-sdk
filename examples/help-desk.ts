import * as guava from "@guava-ai/guava-sdk";
import { DocumentQA } from "@guava-ai/guava-sdk/helpers";
import { IntentRecognizer } from "@guava-ai/guava-sdk/helpers";
import { FURNITURE_RETAILER_QA } from "@guava-ai/guava-sdk/example-data";

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

export async function run(args: string[]) {
  if (args.includes("--webrtc")) {
    await agent.listenWebrtc();
  } else if (args.includes("--phone")) {
    agent.listenPhone(process.env.GUAVA_AGENT_NUMBER!);
  } else if (args.includes("--sip")) {
    const sipCode = args[args.indexOf("--sip") + 1];
    if (!sipCode) {
      console.error("Error: --sip requires a SIP code argument.");
      process.exit(1);
    }
    await agent.listenSip(sipCode);
  } else if (args.includes("--local")) {
    await agent.callLocal();
  } else if (args.includes("--chat")) {
    await agent.chat();
  } else {
    console.error("Usage: guava-example help-desk --phone | --webrtc | --sip | --local | --chat");
    process.exit(1);
  }
}
