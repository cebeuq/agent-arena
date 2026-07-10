import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type BrowseEntry = {
  name: string;
  fullPath: string;
  isGitRepo: boolean;
  hidden: boolean;
};

export type DirectoryListing = {
  dir: string;
  parent?: string;
  entries: BrowseEntry[];
  error?: string;
};

// A directory is treated as a git repository when it contains a .git entry
// (a dir for a normal checkout, a file for a worktree). Cheap existence check
// so listing a folder with many children stays fast.
function isGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

// Lists the sub-directories of `dir` for the folder picker. Files are omitted;
// this is a folder chooser. Non-hidden folders sort first, then hidden, each
// case-insensitively. Unreadable directories return an error instead of
// throwing so the picker can show a message and let the user go back up.
export async function listDirectory(dir: string): Promise<DirectoryListing> {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  const result: DirectoryListing = {
    dir: resolved,
    parent: parent === resolved ? undefined : parent,
    entries: []
  };

  let dirents;
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    result.error = `Cannot read ${resolved}: ${(error as Error).message}`;
    return result;
  }

  const entries: BrowseEntry[] = [];
  for (const dirent of dirents) {
    // Follow symlinked directories too (common for /tmp on macOS, dev mounts).
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(path.join(resolved, dirent.name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) {
      continue;
    }
    const fullPath = path.join(resolved, dirent.name);
    entries.push({
      name: dirent.name,
      fullPath,
      isGitRepo: isGitRepo(fullPath),
      hidden: dirent.name.startsWith(".")
    });
  }

  entries.sort((left, right) => {
    if (left.hidden !== right.hidden) {
      return left.hidden ? 1 : -1;
    }
    return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
  });

  result.entries = entries;
  return result;
}

// True when the directory exists and has no visible-or-hidden children — a
// safe target for creating a fresh git project (createNewProject refuses a
// non-empty folder).
export async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch {
    return false;
  }
}
