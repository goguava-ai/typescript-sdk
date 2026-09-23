/**
 * This example runs an agent at a slower speech speed.
 *
 * `speechSpeed` sets how quickly the agent speaks via a named preset: "x-slow",
 * "slow", "medium" (normal), "fast", or "x-fast". Here the agent runs at the
 * "slow" preset so speech is easier to follow.
 *
 * Usage: guava-example slow-speech local
 */
import { Command } from "commander";
import * as guava from "@guava-ai/guava-sdk";
import { getAgentNumber } from "@guava-ai/guava-sdk/example-utils";

export const agent = new guava.Agent({
  name: "Nova",
  organization: "Clearfield Home & Living",
  purpose: "Answer caller questions clearly and at a relaxed pace.",
  speechSpeed: "slow",
});

agent.onQuestion(async (_call: guava.Call, _question: string) => {
  return "Thanks for asking! Let me look into that for you.";
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
