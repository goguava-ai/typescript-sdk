import * as guava from "@guava-ai/guava-sdk";
import { DocumentQA } from "@guava-ai/guava-sdk/helpers/openai";
import { PROPERTY_INSURANCE_POLICY } from "@guava-ai/guava-sdk/example-data";

class InsuranceCallController extends guava.CallController {
  private documentQA: DocumentQA;
  constructor() {
    super();

    this.documentQA = new DocumentQA("harper-valley-property-insurance", PROPERTY_INSURANCE_POLICY);

    this.setPersona({
      organizationName: "Harper Valley Property Insurance",
    });
    this.setTask({
      objective:
        "You are making an outbound call to a potential customer. Your task is to answer questions regarding property insurance policy until there are no more questions.",
    });
  }

  override async onQuestion(question: string): Promise<string> {
    return await this.documentQA.ask(question);
  }
}

export async function run(args: string[]) {
  const [phone] = args;

  if (!phone) {
    console.error("Usage: guava-example property-insurance <phone>");
    process.exit(1);
  }

  new guava.Client().createOutbound(
    process.env.GUAVA_AGENT_NUMBER!,
    phone,
    new InsuranceCallController(),
  );
}
