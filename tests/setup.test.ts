import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChecked } from "../src/shell.js";
import {
  buildSetupPrompt,
  captureProjectSignature,
  createNewProject,
  importSetupDraft,
  projectChangesSince,
  renderSetupDraftPreview,
  selectSetupHelper,
  setupDraftSchema,
  writeSetupAutoExitWatcher,
  writeSetupCompletionTool
} from "../src/setup.js";
import { configFromDraft } from "../src/tui-model.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

describe("setup helper draft import", () => {
  it("validates setup draft shape", () => {
    expect(() =>
      setupDraftSchema.parse({
        goal: "",
        successCriteria: []
      })
    ).toThrow();

    expect(
      setupDraftSchema.parse({
        goal: "Make the app faster.",
        successCriteria: ["Tests pass."],
        constraints: [],
        resources: []
      }).goal
    ).toBe("Make the app faster.");
  });

  it("imports draft fields and stores raw secrets outside arena config", async () => {
    const root = await makeTempRoot("agent-arena-setup-");
    const arenaDir = path.join(root, ".agent-arena");
    await fs.mkdir(arenaDir, { recursive: true });
    await fs.writeFile(
      path.join(arenaDir, "setup-draft.json"),
      JSON.stringify(
        {
          goal: "Make search p95 under 300ms.",
          successCriteria: ["p95 under 300ms", "Existing tests pass"],
          constraints: ["Do not change public APIs"],
          resources: [
            {
              type: "url",
              name: "Benchmark docs",
              url: "https://example.com/bench",
              usage: "Read benchmark rules before editing.",
              whenToUse: "Use during project orientation.",
              verification: "Cite the relevant benchmark rule in the goal draft."
            }
          ],
          agentInstructions: {
            codex: "Focus on benchmark proof."
          },
          agentResources: {
            codex: [
              {
                type: "gpu",
                name: "GPU box",
                host: "gpu.local",
                usage: "Run benchmark experiments that are too slow locally.",
                whenToUse: "Use when local hardware is insufficient.",
                cleanup: "Stop remote jobs when finished."
              }
            ]
          },
          secrets: [
            {
              name: "Service key",
              envVar: "SERVICE_API_KEY",
              value: "super-secret-value"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const { draft } = await importSetupDraft(root, ["codex", "claude"]);
    const config = configFromDraft(draft);
    const configText = JSON.stringify(config);
    const secrets = await fs.readFile(path.join(arenaDir, "secrets.env"), "utf8");

    expect(draft.goal).toContain("p95");
    // Legacy constraints fold into the single done-when list.
    expect(draft.successCriteria).toEqual(["p95 under 300ms", "Existing tests pass", "Do not change public APIs"]);
    expect(draft.resources.map((resource) => resource.name)).toContain("Service key");
    expect(draft.resources.find((resource) => resource.name === "Benchmark docs")?.usage).toContain("benchmark rules");
    const codex = draft.agents.find((agent) => agent.preset === "codex");
    expect(codex?.instructions).toBe("Focus on benchmark proof.");
    expect(codex?.resources[0].name).toBe("GPU box");
    expect(codex?.resources[0].whenToUse).toContain("local hardware");
    expect(secrets).toContain("SERVICE_API_KEY=super-secret-value");
    expect(configText).toContain("SERVICE_API_KEY");
    expect(configText).not.toContain("super-secret-value");
  });

  it("normalizes helper resource value aliases into config fields", async () => {
    const root = await makeTempRoot("agent-arena-setup-value-");
    const arenaDir = path.join(root, ".agent-arena");
    await fs.mkdir(arenaDir, { recursive: true });
    await fs.writeFile(
      path.join(arenaDir, "setup-draft.json"),
      JSON.stringify({
        goal: "Build a CLI.",
        successCriteria: [],
        constraints: [],
        resources: [
          {
            type: "url",
            name: "Package docs",
            value: "https://example.com/package"
          }
        ],
        agentResources: {
          codex: [
            {
              type: "file",
              name: "Fixture",
              value: "test/fixtures/ranges.json"
            }
          ]
        }
      })
    );

    const { draft } = await importSetupDraft(root, ["codex", "claude"]);
    const config = configFromDraft(draft);

    expect(config.resources[0]).toMatchObject({
      type: "url",
      url: "https://example.com/package"
    });
    expect(config.agents[0].resources?.[0]).toMatchObject({
      type: "file",
      path: "test/fixtures/ranges.json"
    });
  });

  it("imports verifier judging from helper drafts and setup verifier scripts", async () => {
    const root = await makeTempRoot("agent-arena-setup-verifier-");
    const arenaDir = path.join(root, ".agent-arena");
    await fs.mkdir(path.join(arenaDir, "setup"), { recursive: true });
    await fs.writeFile(
      path.join(arenaDir, "setup-draft.json"),
      JSON.stringify({
        goal: "Make the benchmark faster.",
        successCriteria: ["Verifier passes."],
        constraints: ["Keep outputs identical."],
        resources: [],
        verifyCommand: "npm run verify:arena"
      })
    );

    const importedCommand = await importSetupDraft(root, ["codex", "claude"]);
    expect(importedCommand.draft.judging).toEqual({
      mode: "verifier",
      verifyCommand: "npm run verify:arena"
    });

    await fs.writeFile(path.join(arenaDir, "setup", "verifier.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    const importedScript = await importSetupDraft(root, ["codex", "claude"]);
    expect(importedScript.draft.judging).toEqual({
      mode: "verifier",
      verifyCommand: "./.arena/verifier.sh"
    });
  });

  it("does not reject the whole helper draft when an unused resource card is invalid", async () => {
    const root = await makeTempRoot("agent-arena-setup-lenient-");
    const arenaDir = path.join(root, ".agent-arena");
    await fs.mkdir(arenaDir, { recursive: true });
    await fs.writeFile(
      path.join(arenaDir, "setup-draft.json"),
      JSON.stringify({
        goal: "Make the docs easier to navigate.",
        successCriteria: ["Navigation labels are clearer."],
        constraints: ["Do not add dependencies."],
        resources: [
          {
            type: "note",
            name: "Local-only task",
            notes: "No external resources are required."
          },
          {
            type: "repo",
            name: "Unused placeholder"
          }
        ],
        agentInstructions: {
          codex: "Focus on concise implementation."
        }
      })
    );

    const { draft, warnings } = await importSetupDraft(root, ["codex", "claude"]);
    const preview = await renderSetupDraftPreview(root, "contract");

    expect(draft.goal).toBe("Make the docs easier to navigate.");
    expect(draft.resources.map((resource) => resource.name)).toEqual(["Local-only task"]);
    expect(draft.agents.find((agent) => agent.preset === "codex")?.instructions).toBe("Focus on concise implementation.");
    expect(warnings.some((warning) => warning.includes("unsupported resource type"))).toBe(true);
    expect(preview).toContain("Import warnings:");
    expect(preview).toContain("unsupported resource type");
  });

  it("renders setup draft previews in contract and redacted JSON modes", async () => {
    const root = await makeTempRoot("agent-arena-setup-preview-");
    const arenaDir = path.join(root, ".agent-arena");
    await fs.mkdir(arenaDir, { recursive: true });
    await fs.writeFile(
      path.join(arenaDir, "setup-draft.json"),
      JSON.stringify({
        goal: "Ship the feature.",
        successCriteria: ["Tests pass"],
        constraints: ["No secrets in config"],
        resources: [],
        secrets: [
          {
            envVar: "SERVICE_API_KEY",
            value: "secret-value"
          }
        ]
      })
    );

    await expect(renderSetupDraftPreview(root, "contract")).resolves.toContain("Ship the feature.");
    const json = await renderSetupDraftPreview(root, "json");
    expect(json).toContain("[redacted]");
    expect(json).not.toContain("secret-value");
  });
});

describe("setup helper project handling", () => {
  it("creates a new git project with starter files", async () => {
    const root = await makeTempRoot("agent-arena-new-project-");
    const projectPath = path.join(root, "my-project");

    const created = await createNewProject(projectPath);

    await expect(fs.access(path.join(created.repoRoot, ".git"))).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(created.repoRoot, "README.md"), "utf8")).resolves.toContain("my-project");
    await expect(fs.readFile(path.join(created.repoRoot, ".gitignore"), "utf8")).resolves.toContain(".agent-arena/");
    expect(runChecked("git", ["rev-parse", "--verify", "HEAD"], created.repoRoot)).toBeTruthy();
  });

  it("detects project changes after a captured signature", async () => {
    const root = await makeTempRoot("agent-arena-change-check-");
    const project = await createNewProject(path.join(root, "repo"));
    const signature = captureProjectSignature(project.repoRoot);

    await fs.writeFile(path.join(project.repoRoot, "changed.txt"), "changed\n", "utf8");

    expect(projectChangesSince(project.repoRoot, signature)).toContain("changed.txt");
  });

  it("prefers installed Codex as setup helper", () => {
    const helper = selectSetupHelper(["claude", "codex"], (binary) => binary === "codex");
    expect(helper).toBe("codex");
  });

  it("writes a setup completion tool that validates draft JSON and closes the tmux session", async () => {
    const root = await makeTempRoot("agent-arena-complete-tool-");
    const toolPath = await writeSetupCompletionTool(root, "agent-arena-setup-test");
    const script = await fs.readFile(toolPath, "utf8");
    const stat = await fs.stat(toolPath);

    expect(stat.mode & 0o111).toBeTruthy();
    expect(script).toContain("setup-draft.json");
    expect(script).toContain("JSON.parse");
    expect(script).toContain("tmux kill-session -t \"$SESSION\"");
  });

  it("writes an auto-exit watcher that sends /exit after a valid draft appears", async () => {
    const root = await makeTempRoot("agent-arena-auto-exit-");
    const watcherPath = await writeSetupAutoExitWatcher(root, "agent-arena-setup-test");
    const script = await fs.readFile(watcherPath, "utf8");
    const stat = await fs.stat(watcherPath);

    expect(stat.mode & 0o111).toBeTruthy();
    expect(script).toContain("setup-draft.json");
    expect(script).toContain("JSON.parse");
    expect(script).toContain('tmux send-keys -t "$SESSION" "/exit" Enter');
    expect(script).toContain("tmux kill-session -t \"$SESSION\"");
  });

  it("tells setup helpers to run the completion tool after writing the draft", () => {
    const prompt = buildSetupPrompt(
      "/tmp/repo",
      ["codex", "claude"],
      "/tmp/repo/.agent-arena/setup-complete.sh"
    );

    expect(prompt).toContain("your final action must be to run this completion/exit tool: /tmp/repo/.agent-arena/setup-complete.sh");
    expect(prompt).toContain("If the user gives any API key, token, password, or raw secret value");
    expect(prompt).toContain("add both a resources entry with type env and a secrets entry using the same envVar name");
    expect(prompt).toContain("For every resource that agents should use, fill usage and whenToUse.");
    expect(prompt).toContain("Resource order fields mean");
    expect(prompt).toContain("Write any setup secret file before setup-draft.json");
    expect(prompt).toContain("Do not run the completion tool until setup-draft.json exists and contains valid JSON.");
    expect(prompt).toContain("Do not ask the user to run /exit, detach tmux, or close the session.");
    expect(prompt).not.toContain("tell the user to exit or detach");
  });
});
