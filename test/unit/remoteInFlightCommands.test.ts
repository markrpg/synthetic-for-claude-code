import { describe, expect, it } from "vitest";
import { InFlightCommands } from "../../src/remote/inFlightCommands.js";

describe("remote command duplicate prevention", () => {
  it("shares one in-flight execution for the same command ID", async () => {
    const commands = new InFlightCommands<string>();
    let executions = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = async (): Promise<string> => {
      executions += 1;
      await blocked;
      return "done";
    };

    const first = commands.run("same-id", action);
    const duplicate = commands.run("same-id", action);
    release();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      "done",
      "done",
    ]);
    expect(executions).toBe(1);
  });
});
