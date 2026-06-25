/**
 * This example attaches a political polling agent to an ongoing Guava campaign.
 *
 * To use this, first create a campaign from the dashboard or CLI and add contacts.
 * Then, run this script with the campaign code and the Agent will start making calls
 * to those registered contacts.
 *
 * Usage: guava-example polling-campaign <campaign-code>
 */
import * as guava from "@guava-ai/guava-sdk";

const agent = new guava.Agent({
  name: "Jordan",
  organization: "Harper Valley Research Center",
  purpose: "Conduct a non-partisan political opinion poll",
});

agent.onCallStart(async (call: guava.Call) => {
  const firstName = await call.getVariable("first_name");
  await call.reachPerson(firstName, {
    greeting:
      `Hi, is this ${firstName}? I'm calling from the Harper Valley Research Center. ` +
      "We're conducting a brief, non-partisan poll about issues affecting your State.",
  });
});

agent.onReachPerson(async (call: guava.Call, outcome: string) => {
  if (outcome === "available") {
    const firstName = await call.getVariable("first_name");
    await call.setTask({
      taskId: "political_poll",
      objective:
        `Conduct a brief political opinion poll with ${firstName}. ` +
        "Be polite, non-partisan, and respect their time.",
      checklist: [
        guava.Field({
          key: "top_issue",
          description: "The most important issue to the respondent right now",
          fieldType: "text",
          question: "What would you say is the most important issue facing your state right now?",
        }),
        guava.Field({
          key: "governor_approval",
          description: "Approval rating of the current governor",
          fieldType: "multiple_choice",
          question: "Do you approve or disapprove of the job the current governor is doing?",
          choices: ["approve", "disapprove", "no_opinion"],
        }),
        guava.Field({
          key: "likely_to_vote",
          description: "How likely the respondent is to vote in the next election",
          fieldType: "multiple_choice",
          question: "How likely are you to vote in the upcoming election?",
          choices: ["very_likely", "likely", "unlikely", "very_unlikely"],
        }),
      ],
    });
  } else {
    await call.hangup("Appropriately end the call.");
  }
});

agent.onTaskComplete("political_poll", async (call) => {
  // Here is where you would read the poll results using call.getField(...)
  await call.hangup(
    "Thank them for participating and let them know the results will be published next month.",
  );
});

export async function run(args: string[]) {
  const [campaignCode] = args;

  if (!campaignCode) {
    console.error("Usage: guava-example polling-campaign <campaign-code>");
    process.exit(1);
  }

  await agent.attachCampaign(campaignCode);
}
