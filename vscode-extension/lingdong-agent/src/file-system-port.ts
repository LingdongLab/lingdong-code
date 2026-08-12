import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface FileStat {
  size: number;
  modifiedAt: number;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * 快照与恢复用到的文件操作抽象。
 * 抽出接口是为了让 change-tracker 与 snapshot-store 能脱离 VS Code 直接单测。
 */
export interface FileSystemPort {
  /** 文件不存在时返回 undefined，而不是抛错。 */
  read(absolutePath: string): Promise<Uint8Array | undefined>;
  write(absolutePath: string, data: Uint8Array): Promise<void>;
  remove(absolutePath: string): Promise<void>;
  removeDirectory(absolutePath: string): Promise<void>;
  /** 目标已存在时先删除再改名：Windows 上 rename 不会覆盖已存在的文件。 */
  rename(fromPath: string, toPath: string): Promise<void>;
  stat(absolutePath: string): Promise<FileStat | undefined>;
  exists(absolutePath: string): Promise<boolean>;
  ensureDirectory(absolutePath: string): Promise<void>;
  list(absolutePath: string): Promise<string[]>;
  listEntries(absolutePath: string): Promise<DirectoryEntry[]>;
}

export function createNodeFileSystem(): FileSystemPort {
  return {
    async read(absolutePath) {
      try {
        return await readFile(absolutePath);
      } catch {
        return undefined;
      }
    },
    async write(absolutePath, data) {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, data);
    },
    async remove(absolutePath) {
      await rm(absolutePath, { force: true });
    },
    async removeDirectory(absolutePath) {
      await rm(absolutePath, { force: true, recursive: true });
    },
    async rename(fromPath, toPath) {
      await mkdir(path.dirname(toPath), { recursive: true });
      await rm(toPath, { force: true });
      await rename(fromPath, toPath);
    },
    async stat(absolutePath) {
      try {
        const info = await stat(absolutePath);
        return { size: info.size, modifiedAt: info.mtimeMs };
      } catch {
        return undefined;
      }
    },
    async exists(absolutePath) {
      try {
        await access(absolutePath, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async ensureDirectory(absolutePath) {
      await mkdir(absolutePath, { recursive: true });
    },
    async list(absolutePath) {
      try {
        return await readdir(absolutePath);
      } catch {
        return [];
      }
    },
    async listEntries(absolutePath) {
      try {
        const entries = await readdir(absolutePath, { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      } catch {
        return [];
      }
    },
  };
}
