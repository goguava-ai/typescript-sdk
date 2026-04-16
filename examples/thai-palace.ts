import * as guava from "@guava-ai/guava-sdk";
import { getConsoleLogger, type Logger } from "@guava-ai/guava-sdk";
import { IntentRecognizer } from "@guava-ai/guava-sdk/helpers/openai";

class ThaiPalaceCallController extends guava.CallController {
  private choices = ["restaurant waitlist", "anything else"] as const;
  private intentRecognizer: IntentRecognizer<typeof this.choices>;
  constructor(logger: Logger) {
    super(logger);
    this.intentRecognizer = new IntentRecognizer(this.choices, logger);
    this.setPersona({
      organizationName: "Thai Palace",
    });
  }

  override async onIncomingCall(from_number?: string): Promise<void> {
    await super.onIncomingCall(from_number);
    this.acceptCall();
    this.setThaiPalaceTask();
  }

  setThaiPalaceTask() {
    this.setTask(
      {
        objective: `You are a virtual assistant for a restaurant called Thai Palace.
 Your job is to add callers to the waitlist.`,
        checklist: [
          guava.Field({
            key: "caller_name",
            fieldType: "text",
            description: "The name to be added to the waitlist",
          }),
          guava.Field({
            key: "party_size",
            fieldType: "integer",
            description: "The number of people attending",
          }),
          guava.Field({
            key: "phone_number",
            fieldType: "text",
            description: "phone number to text when table is ready",
          }),
          "Read the phone number back to the caller to make sure you got it right",
        ],
      },
      () => this.hangup(),
    );
  }

  override async onIntent(intent: string) {
    const choice = await this.intentRecognizer.classify(intent);
    this.logger.info(`Chosen intent: ${choice}`);
    if (choice === "restaurant waitlist") {
      this.setThaiPalaceTask();
      return null;
    } else {
      return "Tell them we only handle waitlist additions at this number.";
    }
  }
}

export async function run(_args: string[]) {
  new guava.Client().listenInbound(
    { agent_number: process.env.GUAVA_AGENT_NUMBER! },
    (logger) => new ThaiPalaceCallController(getConsoleLogger("debug")),
  );
}
