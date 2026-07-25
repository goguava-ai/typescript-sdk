import { Command } from "commander";
import * as guava from "@guava-ai/guava-sdk";
import { DatetimeFilter } from "@guava-ai/guava-sdk/helpers";
import { mockAppointmentsForFuture } from "@guava-ai/guava-sdk/example-data";
import { getAgentNumber } from "@guava-ai/guava-sdk/example-utils";

const agent = new guava.Agent({
  organization: "Bright Smile Dental",
  purpose: "You are calling patients to help them schedule a dental appointment",
});

const datetimeFilter = new DatetimeFilter(mockAppointmentsForFuture());

agent.onCallStart(async (call: guava.Call) => {
  await call.reachPerson(await call.getVariable("patientName"));
});

agent.onSearchQuery("appointment_time", async (_call, query) => {
  return datetimeFilter.filter(query, { maxResults: 3 });
});

agent.onReachPerson(async (call: guava.Call, outcome: string) => {
  if (outcome === "available") {
    await call.setTask({
      taskId: "schedule_appointment",
      checklist: [
        "Tell them that it's been a while since their regular cleaning with Dr. Teeth.",
        guava.Field({
          key: "appointment_time",
          fieldType: "calendar_slot",
          description: "Find a time that works for the caller",
          searchable: true,
        }),
        "Tell them their appointment has been confirmed and answer any questions before ending the call.",
      ],
    });
  } else {
    await call.hangup("Appropriately end the call.");
  }
});

agent.onTaskComplete("schedule_appointment", async (call) => {
  await call.hangup("Thank them for their time and hang up the call.");
});

export async function run(prog: string, args: string[]) {
  const program = new Command().name(prog).showHelpAfterError();

  program
    .command("phone <number>")
    .description("Call a phone number.")
    .option("-n, --name <name>", "Name of the patient.", "Benjamin Buttons")
    .action(async (number: string, options: { name: string }) => {
      await agent.callPhone(await getAgentNumber(), number, { patientName: options.name });
    });

  program
    .command("local")
    .description("Start a local call (for testing).")
    .option("-n, --name <name>", "Name of the patient.", "Benjamin Buttons")
    .action(async (options: { name: string }) => {
      await agent.callLocal({ patientName: options.name });
    });

  program
    .command("chat")
    .description("Start a local chat session (for testing).")
    .option("-n, --name <name>", "Name of the patient.", "Benjamin Buttons")
    .action(async (options: { name: string }) => {
      await agent.chat({ patientName: options.name });
    });

  await program.parseAsync(args, { from: "user" });
}
