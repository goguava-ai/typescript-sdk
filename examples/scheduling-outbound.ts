import * as guava from "@guava-ai/guava-sdk";
import { DatetimeFilter } from "@guava-ai/guava-sdk/helpers/openai";
import { mockAppointmentsForFuture } from "@guava-ai/guava-sdk/example-data";

const agent = new guava.Agent({
  organization: "Bright Smile Dental",
  purpose: "You are calling patients to help them schedule a dental appointment",
});

const datetimeFilter = new DatetimeFilter({
  sourceList: mockAppointmentsForFuture(),
});

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
    await call.hangup("Apologize for your mistake and hang up the call.");
  }
});

agent.onTaskComplete("schedule_appointment", async (call) => {
  await call.hangup("Thank them for their time and hang up the call.");
});

export async function run(args: string[]) {
  const [toNumber, patientName = "Benjamin Buttons"] = args;

  if (!toNumber) {
    console.error("Usage: guava-example scheduling-outbound <phone> [name]");
    process.exit(1);
  }

  agent.outboundPhone(process.env.GUAVA_AGENT_NUMBER, toNumber, {
    patientName: patientName,
  });
}
