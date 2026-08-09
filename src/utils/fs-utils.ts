/**
 * 配置、checkpoint、Hook 状态和诊断日志共用的文件系统工具。
 *
 * 查询/辅助日志函数多采用 fail-open，返回 false/null 或吞掉异常；`writeJsonFile` 则把最终
 * 写入失败抛给调用者，防止上层误认为关键状态已经持久化。异步函数均返回 Promise。
 */

// 同步 fs 仅用于构造阶段读取安装版本；常规 I/O 使用下方 promises API。
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
  // 先确保目标父目录存在；ensureDir 是 best-effort，失败会在真正 writeFile 时以异常体现。
  await ensureDir(dir);
  // 两空格缩进便于人工排障，末尾换行符合项目状态文件约定。
  const text = `${JSON.stringify(data, null, 2)}\n`;
  // PID + 毫秒时间戳降低同一目录并发写时临时文件重名概率。
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    // 临时文件完整写完后再 rename，读取者只会看到旧完整文件或新完整文件。
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, path);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // 父目录可能在 ensureDir 与 write/rename 之间被并发清理；重新创建后重试一次。
    if (code === 'ENOENT') {
      // 先清掉可能存在的首轮临时文件，再用新名字重试，防止旧文件长期残留。
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
 * 清理由原子写入中断（例如进程在 rename 前退出）留下的 `.tmp` 文件。
 *
 * 清理按文件年龄而不是 PID：重启时两个 daemon 可能短暂重叠，新临时文件可能属于另一个
 * 存活进程。误删会让对方 rename 报 ENOENT，因此只删除超过 `maxAgeMs` 的文件。
 *
 * @param dir 使用原子 JSON 写入的目录。
 * @param maxAgeMs 最小保留时间，默认 60 秒。
 */
export async function cleanStaleTmpFiles(dir: string, maxAgeMs = 60_000): Promise<void> {
  const now = Date.now();
  try {
    // 异步读取指定目录 dir 下的所有文件 / 文件夹名称列表
    const entries = await fsp.readdir(dir);
    for (const f of entries) {
      // 如果文件名不满足 *.数字.数字.tmp 格式，跳过当前循环，不执行后续处理
      if (!/\.(\d+)\.\d+\.tmp$/.test(f)) continue;
      const full = nodePath.join(dir, f);
      try {
        // 异步获取 full 路径对应文件 / 目录的元信息（文件状态）
        const st = await fsp.stat(full);
        // 最后修改时间戳小于1分钟，跳过继续
        if (now - st.mtimeMs < maxAgeMs) continue;
        //  删除最后修改时间戳大于1分钟的文件（不能删文件夹）
        await fsp.unlink(full).catch(() => {});
      } catch {}
    }
  } catch {}
}

/**
 * 向文件追加一行，并按需创建父目录。
 *
 * 该 API 用于辅助日志，采用 best-effort；失败会被吞掉，不适合关键状态持久化。
 */
export async function appendLine(path: string, line: string): Promise<void> {
  try {
    // 多次调用 appendFile 由操作系统追加；本工具没有跨进程锁或 fsync 保证。
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
    // recursive: true的作用就是自动创建多级父目录以及目录已存在不会抛异常
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
 * 从 `dataDir/current` 指针读取已安装版本。
 *
 * 读取顺序为当前版本目录的 `VERSION`、源码树 `package.json`、最终 `unknown`。本函数同步
 * 执行，适合在 logger/flusher 构造阶段立即生成稳定版本标签。
 */
export function readInstalledVersion(dataDir: string): string {
  try {
    // current 文件保存版本目录名，而不是完整路径。
    const currentFile = nodePath.join(dataDir, 'current');
    const name = fs.readFileSync(currentFile, 'utf-8').trim();
    const versionFile = nodePath.join(dataDir, 'versions', name, 'VERSION');
    const content = fs.readFileSync(versionFile, 'utf-8');
    const match = content.match(/^version=(.+)$/m);
    if (match) return match[1];
  } catch { /* 安装指针缺失或损坏时继续尝试源码 package.json。 */ }
  try {
    // `import.meta.url` 指向当前 ESM 模块，向上两级回到包根目录。
    const localPkg = nodePath.join(nodePath.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json');
    const raw = fs.readFileSync(localPkg, 'utf-8');
    return JSON.parse(raw).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 返回本地日历日期 `YYYY-MM-DD`，供按天轮转的日志文件名使用。
 */
export function getTodayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
