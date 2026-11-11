import crypto from "node:crypto";
import { Command } from "commander";
import * as guava from "@guava-ai/guava-sdk";
import { getAgentNumber } from "@guava-ai/guava-sdk/example-utils";

let agentNumber: string;
let transferDestination: string;

const agent = new guava.Agent({
  name: "Nova",
  organization: "Acme Corp",
});

agent.onCallStart(async (call: guava.Call) => {
  await call.setTask({
    taskId: "collect_reason",
    checklist: [guava.Field({ key: "reason_for_calling", fieldType: "text" })],
  });
});

agent.onTaskComplete("collect_reason", async (call: guava.Call) => {
  await call.setTask({
    taskId: "stall_customer",
    objective: `Inform the caller that you're checking if a customer service
      representative is ready to help them. Stay with the caller on the
      line until the expert notifies you that the representative is ready.`,
  });

  // Generate a random conference ID that will be eventually used to join the two calls.
  const conferenceId = crypto.randomBytes(10).toString("hex");

  // Place the outbound call in the background, so this handler doesn't block until it
  // ends. Pass this call's ID so the outbound call can transfer it later.
  outboundAgent
    .callPhone(agentNumber, transferDestination, {
      conference_id: conferenceId,
      original_call_id: call.id,
      call_reason: await call.getField("reason_for_calling"),
    })
    .catch((err) => console.error("Outbound call failed:", err));
});

const outboundAgent = new guava.Agent({
  name: "Nova",
  organization: "Acme Corp",
  purpose:
    "You are an outbound calling agent. You talk to customer service representatives on behalf of callers and brief them before a warm transfer.",
});

outboundAgent.onCallStart(async (call: guava.Call) => {
  await call.setTask({
    taskId: "confirm_ready",
    objective: `A caller is calling about ${await call.getVariable("call_reason")}. You are not talking to the caller - you are talking to a customer service representative.`,
    checklist: [
      "Inform the customer service agent of the caller's reason for calling.",
      "Determine if the service agent is ready for a transfer.",
    ],
  });
});

outboundAgent.onTaskComplete("confirm_ready", async (call: guava.Call) => {
  const conferenceId = await call.getVariable("conference_id");
  const otherCall = new guava.RemoteCall(await call.getVariable("original_call_id"));

  // Join the two calls.
  const destination = `conference:${conferenceId}`;
  await otherCall.transfer(destination, "The customer service representative is ready.");
  await call.transfer(
    destination,
    "Transfer to the caller. Tell the rep that you are 'Patching in the caller.'",
  );
});

export async function run(prog: string, args: string[]) {
  const program = new Command()
    .name(prog)
    .showHelpAfterError()
    .requiredOption("--transfer-destination <phone_number>", "Number to warm transfer callers to.")
    .option(
      "--agent-number <phone_number>",
      "Number to listen on. Defaults to GUAVA_AGENT_NUMBER or your account's number.",
    )
    .action(async (options: { transferDestination: string; agentNumber?: string }) => {
      transferDestination = options.transferDestination;
      agentNumber = options.agentNumber ?? (await getAgentNumber());
      await agent.listenPhone(agentNumber);
    });

  await program.parseAsync(args, { from: "user" });
}
