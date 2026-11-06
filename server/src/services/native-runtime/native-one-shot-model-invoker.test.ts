import { describe, expect, it } from "vitest";
import {
  createOneShotModelInvoker,
  type OneShotProviderPort,
  type OneShotProviderSession,
  type OneShotSessionOptions,
} from "./native-one-shot-model-invoker.js";

interface RecordedSession extends OneShotProviderSession {
  sentPrompts: string[];
}

class RecordingProvider implements OneShotProviderPort {
  openedOptions: OneShotSessionOptions[] = [];
  sessions: RecordedSession[] = [];
  private counter = 0;
  private nextSession: Partial<Omit<RecordedSession, "sentPrompts" | "send">> = {};

  /** Configure the session the next openSession() call will return. */
  setNextSession(partial: Partial<Omit<RecordedSession, "sentPrompts" | "send">>): void {
    this.nextSession = partial;
  }

  async openSession(options: OneShotSessionOptions): Promise<RecordedSession> {
    this.openedOptions.push(options);
    const conversationId = this.nextSession.conversationId ?? `conversation-${++this.counter}`;
    const configuredResponse = this.nextSession.response;
    const session: RecordedSession = {
      conversationId,
      history: this.nextSession.history ?? [],
      tools: this.nextSession.tools ?? [],
      sentPrompts: [],
      async send(prompt: string) {
        session.sentPrompts.push(prompt);
        return { response: configuredResponse ?? `response-${conversationId}` };
      },
    };
    this.sessions.push(session);
    this.nextSession = {};
    return session;
  }
}

const oneShotOptions = { freshContext: true, toolsDisabled: true } as const;

describe("createOneShotModelInvoker", () => {
  it("gives each invocation a fresh, tool-free session that shares no history", async () => {
    const provider = new RecordingProvider();
    const invoker = createOneShotModelInvoker(oneShotOptions, provider);

    const first = await invoker.invoke("first prompt");
    const second = await invoker.invoke("second prompt");

    expect(first).toBe("response-conversation-1");
    expect(second).toBe("response-conversation-2");
    expect(provider.sessions).toHaveLength(2);
    expect(provider.sessions[0]!.conversationId).not.toBe(provider.sessions[1]!.conversationId);
    for (const session of provider.sessions) {
      expect(session.history).toEqual([]);
      expect(session.tools).toEqual([]);
    }
    expect(provider.sessions[0]!.sentPrompts).toEqual(["first prompt"]);
    expect(provider.sessions[1]!.sentPrompts).toEqual(["second prompt"]);
    for (const opened of provider.openedOptions) {
      expect(opened).toEqual({ freshContext: true, toolsDisabled: true });
    }
  });

  it("rejects a session that already carries history and sends nothing", async () => {
    const provider = new RecordingProvider();
    provider.setNextSession({ history: [{ role: "user", content: "earlier turn" }] });
    const invoker = createOneShotModelInvoker(oneShotOptions, provider);

    await expect(invoker.invoke("prompt")).rejects.toThrow("one_shot_session_not_fresh");
    expect(provider.sessions).toHaveLength(1);
    expect(provider.sessions[0]!.sentPrompts).toEqual([]);
  });

  it("rejects a session that offers tools and sends nothing", async () => {
    const provider = new RecordingProvider();
    provider.setNextSession({ tools: [{ name: "read_file" }] });
    const invoker = createOneShotModelInvoker(oneShotOptions, provider);

    await expect(invoker.invoke("prompt")).rejects.toThrow("one_shot_session_offers_tools");
    expect(provider.sessions).toHaveLength(1);
    expect(provider.sessions[0]!.sentPrompts).toEqual([]);
  });

  it("requires the fresh-context and tools-off session option at construction", () => {
    const provider = new RecordingProvider();
    expect(() =>
      createOneShotModelInvoker({ freshContext: false, toolsDisabled: true } as unknown as OneShotSessionOptions, provider),
    ).toThrow("one_shot_session_requires_fresh_context");
    expect(() =>
      createOneShotModelInvoker({ freshContext: true, toolsDisabled: false } as unknown as OneShotSessionOptions, provider),
    ).toThrow("one_shot_session_requires_tools_disabled");
  });

  it("rejects empty prompts and non-text responses", async () => {
    const provider = new RecordingProvider();
    provider.setNextSession({ response: 42 as unknown as string });
    const invoker = createOneShotModelInvoker(oneShotOptions, provider);

    await expect(invoker.invoke("   ")).rejects.toThrow("one_shot_prompt_required");
    await expect(invoker.invoke("prompt")).rejects.toThrow("one_shot_response_must_be_text");
    expect(provider.sessions).toHaveLength(1);
    expect(provider.sessions[0]!.sentPrompts).toEqual(["prompt"]);
  });
});
