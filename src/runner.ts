import type { Agent } from "./agent.ts";
import { MultiHealthContext, getHealthServer } from "./health.ts";
import { nullDisposable, onSignal } from "./utils.ts";
import { getDefaultLogger, type Logger } from "./logging.ts";

export interface RunOptions {
  /**
   * Install SIGINT/SIGTERM handlers that drain in-flight calls on the first
   * signal; a second signal terminates the process. Defaults to `true`.
   */
  handleSignals?: boolean;
}

export class Runner {
  private _healthCtx = new MultiHealthContext();
  private _tasks: Array<() => Promise<void>> = [];
  private _drainController: AbortController = new AbortController();
  private _logger: Logger = getDefaultLogger();

  listenPhone(agent: Agent, agentNumber: string): this {
    const ctx = this._healthCtx.createCtx();
    this._tasks.push(() =>
      agent._listenInbound(ctx, { agent_number: agentNumber }, {}, this._drainController.signal),
    );
    return this;
  }

  listenWebrtc(agent: Agent, webrtcCode?: string): this {
    const ctx = this._healthCtx.createCtx();
    this._tasks.push(async () => {
      const code = webrtcCode ?? (await agent._client.createWebrtcAgent(3600));
      return agent._listenInbound(ctx, { webrtc_code: code }, {}, this._drainController.signal);
    });
    return this;
  }

  listenSip(agent: Agent, sipCode: string): this {
    const ctx = this._healthCtx.createCtx();
    this._tasks.push(() =>
      agent._listenInbound(ctx, { sip_code: sipCode }, {}, this._drainController.signal),
    );
    return this;
  }

  attachCampaign(agent: Agent, campaignCode: string): this {
    const ctx = this._healthCtx.createCtx();
    this._tasks.push(() => agent._serveCampaign(ctx, campaignCode, this._drainController.signal));
    return this;
  }

  async run({ handleSignals = true }: RunOptions = {}): Promise<void> {
    await using _server = await getHealthServer(this._healthCtx);
    using _ = handleSignals
      ? onSignal((signal) => {
          this._logger.info(`Received ${signal} - draining calls. Send signal again to terminate.`);
          this._drainController.abort();
        })
      : nullDisposable;
    await Promise.all(this._tasks.map((task) => task()));
    this._logger.info("All tasks done.");
  }
}
