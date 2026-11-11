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
      // Unlike the Python SDK, code creation happens here to prevent Runner.listen_webrtc from becoming async.
      if (!webrtcCode) this._logger.info("No WebRTC code provided. Creating a temporary one.");
      const code = webrtcCode || (await agent._client.createWebrtcAgent(3600));
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
    // Wait for every task, so one failing doesn't tear down signal handling and
    // the health server while others are still draining.
    const results = await Promise.allSettled(this._tasks.map((task) => task()));
    this._logger.info("All tasks done.");

    const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, `${errors.length} runner tasks failed.`);
  }
}
