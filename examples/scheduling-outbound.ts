import * as guava from "@guava-ai/guava-sdk";
import { DatetimeFilter } from "@guava-ai/guava-sdk/helpers/openai";
import { mockAppointmentsForFuture } from "@guava-ai/guava-sdk/example-data";

class SchedulingController extends guava.CallController {
  private readonly patientName: string;
  private readonly datetimeFilter: DatetimeFilter;

  constructor(patientName: string) {
    super();

    this.patientName = patientName;

    // This is a basic appointment time selector that pulls from a mock list of appointments.
    // In production, you would likely replace this with your own agentic scheduling backend.
    this.datetimeFilter = new DatetimeFilter({
      sourceList: mockAppointmentsForFuture(),
    });

    // Use setPersona to set basic information about the agent, as well as its high-level purpose.
    this.setPersona({
      organizationName: "Bright Smile Dental",
      agentName: "Grace",
      agentPurpose: `You are calling ${patientName} to help them schedule a dental appointment`,
    });

    // reachPerson is a convenience function to confirm that we are talking to the intended recipient.
    this.reachPerson(this.patientName, {
      onSuccess: () => this.scheduleRecipient(),
      onFailure: () => this.recipientUnavailable(),
    });
  }

  private scheduleRecipient() {
    // We have now confirmed that we are talking to the patient.
    // Set the Agent's current task to collect the desired appointment time.
    this.setTask(
      {
        // The check list is an ordered list of items for the agent to go through.
        // It can include short prompts as well as Fields to capture structured information.
        checklist: [
          "tell them that it's been a while since their regular cleaning with Dr. Teeth, and ask if they would like to schedule an appointment now.",
          // We have one field to collect, which is the appointment_time.
          guava.Field({
            key: "appointment_time",
            fieldType: "calendar_slot",
            description: "Find a time that works for the caller",

            // The choiceGenerator will be called when negotiating a calendar slot.
            // We respond with a list of datetime options based on the user's
            // criteria, which is summarized in the query string.
            choiceGenerator: async (query: string) => {
              // Query will have some natural language preferences like "early morning" or
              // "next week". The dateTime filter queries our calendar for matching slots.
              const result = await this.datetimeFilter.filter(query, { maxResults: 3 });
              this.logger.info("Appointment slot matches: %s", JSON.stringify(result));
              return result;
            },
          }),
          "tell them their appointment has been confirmed and answer any questions before ending the call.",
        ],
      },
      () => this.hangup("Thank them for their time and hang up the call."),
    );
  }

  private recipientUnavailable() {
    this.hangup("Apologize for your mistake and hang up the call.");
  }

  override onSessionDone() {
    // This callback is invoked at the end of the bot session.
    const selectedTime = this.getField("appointment_time");
    if (selectedTime) {
      this.logger.info(`Appointment confirmed for: ${selectedTime}`);
    }
  }
}

export async function run(args: string[]) {
  const [toNumber, patientName = "Benjamin Buttons"] = args;

  if (!toNumber) {
    console.error("Usage: guava-example scheduling-outbound <phone> [name]");
    process.exit(1);
  }

  new guava.Client().createOutbound(
    process.env.GUAVA_AGENT_NUMBER,
    toNumber,
    new SchedulingController(patientName),
  );
}
