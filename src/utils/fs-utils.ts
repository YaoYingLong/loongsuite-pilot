import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

/**
 * 判断路径是否存在且为普通文件。不存在、无权限或 stat 失败时统一返回 false。
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * 判断路径是否存在且为目录。不存在、无权限或 stat 失败时统一返回 false。
 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读取并解析 JSON 文件；文件不存在、无权读取或内容解析失败时统一返回 null 适合读取允许缺失或损坏后降级的配置与状态快照。
 * <T>：表示泛型
 * fs/promises：异步读取文件，以 UTF-8 编码读出文本字符串
 * export：可以在别的文件 import 导入
 * async：异步函数，调用必须加 await，返回一定是 Promise
 * Promise<X>：async 函数返回 Promise，最终兑现的值类型是 X
 * T | null：联合类型，两种可能结果：成功 = T；失败 = null
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await fsp.readFile(path, 'utf8');
    // 将文本反序列化为 JS 对象，并断言为类型 T
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * 以“同目录临时文件 + rename”的方式原子写入格式化 JSON，并确保父目录存在。
 * 最终失败会继续抛给调用方，避免上层误以为实例期望状态已经持久化成功。
 */
export async function writeJsonFile(
  path: string,
  data: unknown
): Promise<void> {
  const dir = nodePath.dirname(path);
  await ensureDir(dir);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, path);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // 父目录可能在 ensureDir 与 write/rename 之间被并发清理；重新创建后重试一次。
    if (code === 'ENOENT') {
      await fsp.unlink(tmp).catch(() => {});
      await ensureDir(dir);
      const tmp2 = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fsp.writeFile(tmp2, text, 'utf8');
        await fsp.rename(tmp2, path);
      } catch (retryErr) {
        await fsp.unlink(tmp2).catch(() => {});
        throw retryErr;
      }
    } else if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      // Windows 上目标文件可能被杀毒软件、索引器或并发 I/O 短暂锁定。
      // 临时文件已经成功写入时，短暂等待后重试 rename；否则直接保留原始错误。
      const tmpExists = await fsp.stat(tmp).then(() => true, () => false);
      if (!tmpExists) throw err;
      await new Promise(r => setTimeout(r, 50));
      try {
        await fsp.rename(tmp, path);
      } catch {
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
    } else {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

/**
 * Removes stale `.tmp` files left behind by interrupted atomic writes (e.g. process
 * killed mid-rename). Call once at startup for directories that use writeJsonFile.
 *
 * Cleanup is **age-based**, not pid-based: a fresh `.tmp` (any pid) may belong to a
 * concurrent live process — e.g. two daemon instances overlapping during a restart.
 * Deleting it would break that process's `rename(tmp, path)` with ENOENT, failing
 * the collection cycle. Only remove tmp files older than `maxAgeMs` (a tmp that old
 * is definitely not mid-rename, since rename is instantaneous).
 */
export async function cleanStaleTmpFiles(dir: string, maxAgeMs = 60_000): Promise<void> {
  const now = Date.now();
  try {
    const entries = await fsp.readdir(dir);
    for (const f of entries) {
      if (!/\.(\d+)\.\d+\.tmp$/.test(f)) continue;
      const full = nodePath.join(dir, f);
      try {
        const st = await fsp.stat(full);
        if (now - st.mtimeMs < maxAgeMs) continue;
        await fsp.unlink(full).catch(() => {});
      } catch {}
    }
  } catch {}
}

/**
 * Appends a line (with trailing newline) to a file, creating parent dirs as needed.
 */
export async function appendLine(path: string, line: string): Promise<void> {
  try {
    await ensureDir(nodePath.dirname(path));
    await fsp.appendFile(
      path,
      line.endsWith('\n') ? line : `${line}\n`,
      'utf8'
    );
  } catch {}
}

/**
 * 递归创建目录。空路径、当前目录和文件系统根目录无需创建；失败按尽力而为处理。
 */
export async function ensureDir(path: string): Promise<void> {
  if (!path || path === '.' || path === nodePath.parse(path).root) {
    return;
  }
  try {
    await fsp.mkdir(path, { recursive: true });
  } catch {}
}

/**
 * 将独立的 `~` 或路径开头的 `~/` 展开为当前用户主目录；Windows 同时支持 `~\`。 出现在路径其他位置的 `~` 保持原样。
 */
export function resolveHome(filepath: string): string {
  if (filepath === '~') {
    return os.homedir();
  }
  if (filepath.startsWith('~/') || filepath.startsWith(`~${nodePath.sep}`)) {
    // 将目录转换为绝对路径，filepath.slice(2)表示截掉2个前面两个字符串
    return nodePath.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

/**
 * Reads the installed package version from the dataDir's `current` pointer,
 * falling back to the local package.json, then to 'unknown'.
 */
export function readInstalledVersion(dataDir: string): string {
  try {
    const currentFile = nodePath.join(dataDir, 'current');
    const name = fs.readFileSync(currentFile, 'utf-8').trim();
    const versionFile = nodePath.join(dataDir, 'versions', name, 'VERSION');
    const content = fs.readFileSync(versionFile, 'utf-8');
    const match = content.match(/^version=(.+)$/m);
    if (match) return match[1];
  } catch { /* ignore */ }
  try {
    const localPkg = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json');
    const raw = fs.readFileSync(localPkg, 'utf-8');
    return JSON.parse(raw).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Local calendar date as `YYYY-MM-DD`.
 */
export function getTodayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
