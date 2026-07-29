import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeRequestError } from "../../src/bridge/bridgeError.js";
import { SyntheticMessagesClient } from "../../src/bridge/syntheticMessagesClient.js";
import { DEFAULT_SYNTHETIC_SETTINGS } from "../../src/providers/syntheticProvider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SyntheticMessagesClient", () => {
  it("keeps the upstream token in the bridge and reads live model context", async () => {
    let lastInit: RequestInit | undefined;
    const fetchMock = vi.fn(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        lastInit = init;
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.endsWith("/openai/v1/models")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "hf:moonshotai/Kimi-K3",
                  context_length: 262_144,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "msg_1",
            content: [{ type: "text", text: "Done." }],
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SyntheticMessagesClient(
      "synthetic-secret",
      DEFAULT_SYNTHETIC_SETTINGS,
    );

    expect(
      await client.contextWindow("hf:moonshotai/Kimi-K3"),
    ).toBe(262_144);
    await client.complete({
      model: "hf:moonshotai/Kimi-K3",
      messages: [{ role: "user", content: "Continue." }],
    });

    expect(
      (lastInit?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer synthetic-secret");
    expect(
      (lastInit?.headers as Record<string, string>)["x-api-key"],
    ).toBe("synthetic-secret");
  });

  it("classifies an upstream context rejection as terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "Maximum context length exceeded",
            },
          }),
          { status: 400 },
        ),
      ),
    );
    const client = new SyntheticMessagesClient(
      "synthetic-secret",
      DEFAULT_SYNTHETIC_SETTINGS,
    );

    const error = await client
      .complete({
        model: "hf:moonshotai/Kimi-K3",
        messages: [{ role: "user", content: "Continue." }],
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BridgeRequestError);
    expect((error as BridgeRequestError).code).toBe(
      "context_window_exceeded",
    );
    expect((error as BridgeRequestError).status).toBe(400);
  });

  it("falls back when the optional token counter is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("counter unavailable")),
    );
    const client = new SyntheticMessagesClient(
      "synthetic-secret",
      DEFAULT_SYNTHETIC_SETTINGS,
    );

    await expect(
      client.countTokens({
        model: "hf:moonshotai/Kimi-K3",
        messages: [{ role: "user", content: "Continue." }],
      }),
    ).resolves.toBeUndefined();
  });
});
