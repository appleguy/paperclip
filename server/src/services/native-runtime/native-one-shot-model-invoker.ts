// NAR one-shot model invocation (SCO-1137; dup T-67).
//
// The existing runner-side boundary for this is the `IsolatedModelProvider`
// interface and its `invokeFreshToolsOff` method in
// packages/paperclip-runner/src/nar/model-invocation.ts; the request contract
// behind it (packages/paperclip-runner/src/nar/model-invocation-contract.ts)
// already requires `freshContext: true` and `toolsDisabled: true` on every
// request. This module adds the server-side session option and invoker for
// that boundary: every invocation runs on a brand-new conversation with no
// tool calls offered. It unblocks T-25 and the curriculum factory.

/** Session option for a one-shot model invocation. */
export interface OneShotSessionOptions {
  /** Every invocation starts a new conversation; earlier turns are never replayed into it. */
  readonly freshContext: true;
  /** No tool definitions are offered, so the model cannot call a tool. */
  readonly toolsDisabled: true;
}

export interface OneShotProviderSession {
  /** Provider conversation backing this call. */
  readonly conversationId: string;
  /** Turns already visible to the session before this invocation. */
  readonly history: readonly unknown[];
  /** Tool definitions offered to the model for this invocation. */
  readonly tools: readonly unknown[];
  send(prompt: string): Promise<{ response: string }>;
}

export interface OneShotProviderPort {
  /** Open the session for one invocation; the invoker never reuses a session. */
  openSession(options: OneShotSessionOptions): Promise<OneShotProviderSession>;
}

export interface OneShotModelInvoker {
  readonly options: OneShotSessionOptions;
  invoke(prompt: string): Promise<string>;
}

/**
 * Create a one-shot model invoker bound to the tools-off, fresh-context
 * session option. Each invoke() opens its own session and refuses to send a
 * prompt into a session that carries history or offers tools, so two
 * invocations share no history and no tool call is ever offered.
 */
export function createOneShotModelInvoker(
  options: OneShotSessionOptions,
  provider: OneShotProviderPort,
): OneShotModelInvoker {
  if (options.freshContext !== true) throw new Error("one_shot_session_requires_fresh_context");
  if (options.toolsDisabled !== true) throw new Error("one_shot_session_requires_tools_disabled");
  const sessionOptions = Object.freeze({ ...options });
  return {
    options: sessionOptions,
    async invoke(prompt) {
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("one_shot_prompt_required");
      const session = await provider.openSession(sessionOptions);
      if (session.history.length !== 0) throw new Error("one_shot_session_not_fresh");
      if (session.tools.length !== 0) throw new Error("one_shot_session_offers_tools");
      const result = await session.send(prompt);
      if (typeof result.response !== "string") throw new Error("one_shot_response_must_be_text");
      return result.response;
    },
  };
}
