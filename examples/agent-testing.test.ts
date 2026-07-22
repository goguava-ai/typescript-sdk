/**
 * Agent testing example — demonstrates agent.test(), agent.testRoleplay(),
 * agent.patch(), and session.evaluate().
 */

import type { Call } from "@guava-ai/guava-sdk";
import { MockCall } from "@guava-ai/guava-sdk";
import { agent } from "@guava-ai/guava-sdk/examples/help-desk";

describe("HelpDeskAgent", () => {
  test("handler unit test - new purchase routes to sales", async () => {
    const suggestion = await agent.handlers.onActionRequest(new MockCall(), "make a new purchase");
    expect(suggestion).toContainEqual({ key: "sales" });
  });

  test("new purchase routes to sales", async () => {
    const session = await agent.test(async (session) => {
      // Wait for the agent to finish its opening turn, then inject a caller utterance.
      await session.waitForTurn();
      session.say("Hi, I'm looking to make a new purchase.");

      // Wait for the bot to complete its transfer.
      await session.waitForEnd();
    });

    // You can inspect the full transcript with session.getTranscript()

    expect(session.executedActions).toContain("sales");
    expect(session.terminationReason).toBe("bot-transfer");
  });

  test("roleplay - caller buys a table", async () => {
    // testRoleplay() drives the conversation automatically using an LLM as the caller.
    const session = await agent.testRoleplay("You are a caller trying to buy a new table.");

    expect(session.executedActions).toContain("sales");
    expect(session.terminationReason).toBe("bot-transfer");
  });

  test("patched agent - sales department closed", async () => {
    // patch() returns a shallow clone with independently overridable callbacks.
    const patched = agent.patch();

    patched.onAction("sales", async (call: Call) => {
      call.hangup(
        "Tell the caller that the sales department is closed and that they should call back tomorrow from 9am to 5pm.",
      );
    });

    const session = await patched.testRoleplay("You are a caller trying to buy a new table.");

    // evaluate() uses an LLM to check natural-language pass/fail criteria against the transcript.
    await session.evaluate({
      passCriteria: ["The agent informed the caller of the business hours from 9am to 5pm."],
      failCriteria: ["The agent transferred the caller to the sales department."],
    });
  });
});
