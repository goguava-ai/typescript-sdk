import type { Agent } from "./agent.ts";
import { MultiHealthContext, getHealthServer } from "./health.ts";

export class Runner {
  private _healthCtx = new MultiHealthContext();
  private _tasks: Array<() => Promise<void>> = [];

  listenPhone(agent: Agent, agentNumber: string): this {
    const ctx = this._healthCtx.createCtx();
    this._tasks.push(() => agent._listenInbound(ctx, { agent_number: agentNumber }));
    return this;
  }

  listenWebrtc(agent: Agent, webrtcCode?: string): this {
    const ctx = this._healthCtx.createCtx();
    this._tasks.push(async () => {
      const code = webrtcCode ?? (await agent._client.createWebrtcAgent(3600));
      return agent._listenInbound(ctx, { webrtc_code: code });
    });
    return this;
  }

  listenSip(agent: Agent, sipCode: string): this {
    const ctx = this._healthCtx.createCtx();
    this._tasks.push(() => agent._listenInbound(ctx, { sip_code: sipCode }));
    return this;
  }

  attachCampaign(agent: Agent, campaignCode: string): this {
    const ctx = this._healthCtx.createCtx();
    this._tasks.push(() => agent._serveCampaign(ctx, campaignCode));
    return this;
  }

  async run(): Promise<void> {
    await using _server = await getHealthServer(this._healthCtx);
    await Promise.all(this._tasks.map((task) => task()));
  }
}
