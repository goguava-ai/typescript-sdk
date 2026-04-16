import * as guava from "@guava-ai/guava-sdk";
import { IntentRecognizer } from "@guava-ai/guava-sdk/helpers/openai";
import type { Logger } from "@guava-ai/guava-sdk";

interface Customer {
  name: string;
  ssn: string;
  unactivated_cards: Record<string, number>;
}

const CUSTOMER_DB: Customer[] = [
  {
    name: "John Smith",
    ssn: "123456789",
    unactivated_cards: {
      "6011002980139424": 567,
    },
  },
];

function findCustomerBySSN(ssn: string): Customer | undefined {
  return CUSTOMER_DB.find((c) => c.ssn === ssn);
}

const ORGANIZATION_NAME = "Harper Valley Bank";

class CreditCardActivationController extends guava.CallController {
  private choices = ["activate credit card", "anything else"] as const;
  private intentRecognizer: IntentRecognizer<typeof this.choices>;
  constructor(logger: Logger) {
    super(logger);
    this.intentRecognizer = new IntentRecognizer(this.choices, logger);
    this.setPersona({
      organizationName: ORGANIZATION_NAME,
      agentPurpose: `You are a customer service voice agent that activates credit cards for customers of ${ORGANIZATION_NAME}.`,
    });
    this.readScript(
      `Hello, thank you for calling the credit card activation line for ${ORGANIZATION_NAME}. My name is Grace. Are you here to activate your credit card?`,
    );
    this.acceptCall();
  }

  override async onIntent(intent: string) {
    const choice = await this.intentRecognizer.classify(intent);
    this.logger.info(`Chosen intent: ${choice}`);
    if (choice === "activate credit card") {
      await this.activateCreditCard();
      return null;
    } else {
      return "Unfortunately I'm not able to help with that.";
    }
  }

  async findCustomer() {
    let customer: Customer | undefined;
    let cardNumber: string;
    while (true) {
      await this.awaitTask({
        checklist: [
          guava.Field({
            description: "Could you give me your social security number?",
            key: "social_security_number",
            fieldType: "integer",
            required: true,
          }),
        ],
      });

      const ssn_data = this.getField("social_security_number");
      let ssn: string;
      if (typeof ssn_data === "string") {
        ssn = ssn_data;
      } else {
        // Should we assume all payloads are strings? or leave room by returning unknown
        ssn = JSON.stringify(ssn_data);
      }
      customer = findCustomerBySSN(ssn);
      if (!customer) {
        this.sendInstruction(
          "We were unable to identify the customer using the SSN they provided. Let the caller know this, and ask if they have the correct social security number.",
        );
      } else {
        await this.awaitTask({
          objective:
            "We were able to identify the customer using the Social Security Number they have provided. We're going to confirm the client's name.",
          checklist: [
            guava.Field({
              description: `We're going to confirm the client's name. Am I speaking with ${customer.name}?`,
              key: "is_client",
              fieldType: "multiple_choice",
              choices: ["yes", "no"],
              required: true,
            }),
          ],
        });

        if (this.getField("is_client") === "no") {
          this.sendInstruction(
            "We were unable to identify the client's name in our files. Let the caller know this, and re-ask their social security number.",
          );
        } else {
          break;
        }
      }
    }

    this.sendInstruction(
      "We were able to find the client's name in our files. Proceed to ask for their card number.",
    );
    while (true) {
      await this.awaitTask({
        checklist: [
          guava.Field({
            fieldType: "integer",
            description: "Could you read me the digits on the front of your credit card?",
            key: "credit_card_number",
            required: true,
          }),
        ],
      });

      cardNumber = this.getField("credit_card_number") as string;
      if (!(cardNumber in customer.unactivated_cards)) {
        this.sendInstruction(
          "We were unable to find the matching card number in our system. Let the caller know this, and re-ask for the credit card number.",
        );
      } else {
        this.sendInstruction(
          "We were able to find the matching card number in our system. Let the caller know this, and ask for security code on their card.",
        );
        break;
      }
    }

    const correctCvv = customer.unactivated_cards[cardNumber];
    while (true) {
      await this.awaitTask({
        checklist: [
          guava.Field({
            fieldType: "integer",
            key: "security_code",
            description: "To wrap up, could I get the security code on your card?",
            required: true,
          }),
        ],
      });

      const security_code = this.getField("security_code") as string;
      if (security_code !== correctCvv.toString()) {
        this.sendInstruction(
          "We were unable to match the security code to the credit card. Let the caller know this and re-ask for the security code.",
        );
      } else {
        break;
      }
    }
    this.hangup(
      "Explain to the caller that their credit card has now been activated. Thank them for using the bank's services, and hang up.",
    );
  }

  async activateCreditCard() {
    this.sendInstruction(
      "We are starting the credit card activation process, which starts with asking the caller for their social security number.",
    );

    await this.findCustomer();
  }
}

export async function run(_args: string[]) {
  new guava.Client().listenInbound(
    {
      agent_number: process.env.GUAVA_AGENT_NUMBER!,
    },
    (logger) => new CreditCardActivationController(logger),
  );
}
