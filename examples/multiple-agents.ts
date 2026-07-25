import * as guava from "@guava-ai/guava-sdk";

const agentA = new guava.Agent({
  name: "Grace",
  purpose: "You are a helpful voice agent.",
});

const agentB = new guava.Agent({
  name: "Jordan",
  purpose: "You are a helpful voice agent.",
});

export async function run(_prog: string, _args: string[]) {
  const runner = new guava.Runner();
  runner.listenPhone(agentA, process.env.GUAVA_AGENT_NUMBER!);
  runner.listenWebrtc(agentB);
  await runner.run();
}
