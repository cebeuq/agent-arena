import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeAvailability,
  envFromResources,
  resourceOrderLines,
  resourceOrderWarnings,
  resourceBlockingErrors,
  resolveResourceAvailability
} from "../src/resources.js";
import type { ArenaResource } from "../src/types.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-arena-resources-"));
  tempDirs.push(root);
  return root;
}

const envResource: ArenaResource = {
  type: "env",
  name: "API key",
  envVar: "SERVICE_API_KEY"
};

describe("resource availability", () => {
  it("marks env resources available from process env", () => {
    const availability = resolveResourceAvailability(envResource, {
      processEnv: {
        SERVICE_API_KEY: "from-process"
      }
    });

    expect(availability.status).toBe("available");
    expect(availability.source).toBe("process env");
    expect(describeAvailability(availability)).toBe("required, available from process env");
  });

  it("marks env resources available from saved secrets without exposing values", () => {
    const availability = resolveResourceAvailability(envResource, {
      processEnv: {},
      savedSecrets: {
        SERVICE_API_KEY: "from-secret"
      }
    });

    expect(availability.status).toBe("available");
    expect(availability.source).toBe("saved secret");
    expect(availability.message).toContain("SERVICE_API_KEY");
    expect(availability.message).not.toContain("from-secret");
    expect(envFromResources([envResource], { savedSecrets: { SERVICE_API_KEY: "from-secret" } })).toEqual({
      SERVICE_API_KEY: "from-secret"
    });
  });

  it("blocks missing required env resources", () => {
    const availability = resolveResourceAvailability(envResource, {
      processEnv: {},
      savedSecrets: {}
    });

    expect(availability.status).toBe("missing");
    expect(availability.blocking).toBe(true);
    expect(resourceBlockingErrors([envResource], "shared", { processEnv: {}, savedSecrets: {} })[0]).toContain(
      "SERVICE_API_KEY is missing"
    );
  });

  it("checks local file resources", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "fixture.txt"), "ok\n", "utf8");

    const available = resolveResourceAvailability(
      {
        type: "file",
        name: "Fixture",
        path: "fixture.txt"
      },
      { baseDir: root }
    );
    const missingOptional = resolveResourceAvailability(
      {
        type: "file",
        name: "Optional fixture",
        optional: true,
        path: "missing.txt"
      },
      { baseDir: root }
    );

    expect(available.status).toBe("available");
    expect(available.source).toBe("file");
    expect(missingOptional.status).toBe("missing");
    expect(missingOptional.blocking).toBe(false);
  });

  it("renders provider resources as declared manual checks", () => {
    const availability = resolveResourceAvailability({
      type: "gpu",
      name: "Vast GPU",
      host: "vast.ai"
    });

    expect(availability.status).toBe("declared");
    expect(availability.source).toBe("manual");
    expect(availability.blocking).toBe(false);
  });

  it("warns when actionable resources lack usage directives", () => {
    const warnings = resourceOrderWarnings([
      {
        type: "gpu",
        name: "External GPU"
      },
      {
        type: "note",
        name: "Context note",
        notes: "Read this."
      }
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("External GPU");
  });

  it("renders resource order lines without secret values", () => {
    const lines = resourceOrderLines({
      type: "env",
      name: "Vast key",
      envVar: "VASTAI_API_KEY",
      usage: "Rent remote GPUs for long benchmark runs.",
      whenToUse: "Use when local CUDA is unavailable.",
      budget: "$50 max",
      cleanup: "Destroy rented instances.",
      verification: "Record a redacted auth check."
    });

    expect(lines.join("\n")).toContain("Rent remote GPUs");
    expect(lines.join("\n")).toContain("VASTAI_API_KEY");
    expect(lines.join("\n")).not.toContain("from-secret");
  });
});
