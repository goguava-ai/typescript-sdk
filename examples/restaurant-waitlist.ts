import * as guava from "@guava-ai/guava-sdk";
import { getDefaultLogger } from "@guava-ai/guava-sdk";

const logger = getDefaultLogger();

const agent = new guava.Agent({
  name: "Mia",
  organization: "Thai Palace",
  purpose: "Helping callers join the restaurant waitlist",
});

agent.onCallReceived(async (_callInfo: guava.CallInfo) => {
  // In this callback you have the option to accept or reject a call based off the caller info.
  // For now we will accept all calls. If this callback is not provided, the default behavior is
  // to accept all calls.
  return { action: "accept" };
});

agent.onCallStart(async (call: guava.Call) => {
  await call.setTask({
    taskId: "waitlist",
    objective: "You are a virtual assistant for Thai Palace. Add callers to the waitlist.",
    checklist: [
      guava.Field({ key: "caller_name", fieldType: "text", description: "Name for the waitlist" }),
      guava.Field({ key: "party_size", fieldType: "integer", description: "Number of people" }),
      guava.Field({
        key: "phone_number",
        fieldType: "text",
        description: "Phone number to text when the table is ready",
      }),
      "Read the phone number back to the caller to confirm.",
    ],
  });
});

agent.onTaskComplete("waitlist", async (call: guava.Call) => {
  logger.info(
    "Added %s, party of %d, to waitlist.",
    await call.getField("caller_name"),
    await call.getField("party_size"),
  );
  await call.hangup("Thank the caller and let them know we'll text when their table is ready.");
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
    console.error(
      "Usage: guava-example restaurant-waitlist --phone | --webrtc | --sip | --local | --chat",
    );
    process.exit(1);
  }
}
