/**
 * Hand-written because the project has no @types/chrome (same convention
 * worker/handler.ts uses for the Cloudflare Workers runtime): a minimal
 * subset of the real chrome.* extension APIs covering exactly the four
 * methods this extension actually calls (storage.local.get/set,
 * runtime.sendMessage, runtime.onMessage.addListener), rather than pulling
 * in @types/chrome's much larger surface for that.
 */
declare const chrome: {
  storage: {
    local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      // Generic (defaulting to `unknown`), rather than a fixed `unknown`
      // message parameter: the real API has no statically-typed message
      // protocol at all (any listener can be sent anything), so the caller
      // explicitly instantiating this with its own message type here is the
      // one place that type safety actually comes from in this codebase.
      addListener<TMessage = unknown>(
        callback: (message: TMessage, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void,
      ): void;
    };
  };
};
