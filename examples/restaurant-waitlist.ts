import { Command } from "commander";
import * as guava from "@guava-ai/guava-sdk";
import { getDefaultLogger } from "@guava-ai/guava-sdk";
import { getAgentNumber } from "@guava-ai/guava-sdk/example-utils";

const logger = getDefaultLogger();

export const agent = new guava.Agent({
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
