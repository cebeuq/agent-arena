import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { isEmptyDir, listDirectory } from "../src/tui/view-models/browse-vm.js";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arena-browse-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "zeta"));
  await fs.mkdir(path.join(root, "alpha"));
  await fs.mkdir(path.join(root, ".hidden"));
  await fs.mkdir(path.join(root, "repo"));
  execFileSync("git", ["init"], { cwd: path.join(root, "repo"), stdio: "ignore" });
  await fs.writeFile(path.join(root, "file.txt"), "not a dir\n", "utf8");
  return root;
}

describe("listDirectory", () => {
  it("lists only sub-directories, non-hidden first then alphabetical", async () => {
    const root = await makeTree();
    const listing = await listDirectory(root);

    expect(listing.dir).toBe(path.resolve(root));
    expect(listing.parent).toBe(path.dirname(path.resolve(root)));
    expect(listing.entries.map((entry) => entry.name)).toEqual(["alpha", "repo", "zeta", ".hidden"]);
    // The file is excluded.
    expect(listing.entries.some((entry) => entry.name === "file.txt")).toBe(false);
  });

  it("marks git repositories", async () => {
    const root = await makeTree();
    const listing = await listDirectory(root);
    const repo = listing.entries.find((entry) => entry.name === "repo");
    const alpha = listing.entries.find((entry) => entry.name === "alpha");
    expect(repo?.isGitRepo).toBe(true);
    expect(alpha?.isGitRepo).toBe(false);
    expect(listing.entries.find((entry) => entry.name === ".hidden")?.hidden).toBe(true);
  });

  it("reports an error for an unreadable path instead of throwing", async () => {
    const listing = await listDirectory(path.join(os.tmpdir(), "arena-does-not-exist-xyz"));
    expect(listing.error).toBeDefined();
    expect(listing.entries).toEqual([]);
  });

  it("has no parent at the filesystem root", async () => {
    const listing = await listDirectory("/");
    expect(listing.parent).toBeUndefined();
  });
});

describe("isEmptyDir", () => {
  it("distinguishes empty from non-empty directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "arena-empty-"));
    tempDirs.push(root);
    expect(await isEmptyDir(root)).toBe(true);
    await fs.writeFile(path.join(root, "x"), "y", "utf8");
    expect(await isEmptyDir(root)).toBe(false);
    expect(await isEmptyDir(path.join(root, "nope"))).toBe(false);
  });
});
