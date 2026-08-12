import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonLineDecoder, type JsonRpcMessage } from "./protocol.js";

export interface ProcessManagerOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 单次 stdin 写入的上限；见 send() 里的说明。默认 30 秒。 */
  writeTimeoutMs?: number;
}

/**
 * 往一个健康的子进程 stdin 写一行 JSON 是微秒级的事，
 * 这个值不是用来卡慢的，是用来把「永远不会回来」变成一个能报出去的错误。
 */
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

export interface ProcessManagerEvents {
  message: [JsonRpcMessage];
  invalidJson: [Error];
  stderr: [string];
  exit: [ProcessExit];
  error: [Error];
}

export declare interface ProcessManager {
  on<K extends keyof ProcessManagerEvents>(event: K, listener: (...args: ProcessManagerEvents[K]) => void): this;
  emit<K extends keyof ProcessManagerEvents>(event: K, ...args: ProcessManagerEvents[K]): boolean;
}

export class ProcessManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly decoder = new JsonLineDecoder();
  private closing = false;
  private exitPromise: Promise<ProcessExit> | undefined;

  constructor(private readonly options: ProcessManagerOptions) {
    super();
  }

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Grok ACP 子进程已经启动");

    const child = spawn(this.options.executable, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    child.on("error", (error) => this.emit("error", error));
    // 管道上的 error 没人听的话会直接变成未捕获异常打到扩展宿主上
    // （子进程被杀时那一下 EPIPE/EOF 就是典型）。断的是管道，等于断线，
    // 交给上层当断线处理，比让宿主崩掉体面得多。
    child.stdin.on("error", (error) => this.emit("error", error));
    child.stdout.on("error", (error) => this.emit("error", error));
    child.stderr.on("error", (error) => this.emit("error", error));

    this.exitPromise = new Promise<ProcessExit>((resolve) => {
      child.once("exit", (code, signal) => {
        const tail = this.decoder.finish();
        for (const message of tail.messages) this.emit("message", message);
        for (const error of tail.errors) this.emit("invalidJson", error);
        const result = { code, signal, expected: this.closing };
        this.emit("exit", result);
        resolve(result);
      });
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || !this.running || child.stdin.destroyed) {
      throw new Error("Grok ACP 子进程未运行");
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      /*
       * 子进程还活着、但已经不读自己的 stdin 时（管道缓冲区写满），
       * write 的回调既不会带错误回来，也不会回来。
       *
       * 上层那个静默看门狗守不住这种情况：它守的是「请求发出去之后收不到回应」，
       * 计时器挂在等待响应的那个 Promise 上。而这里是连发都没发出去，
       * 调用方还卡在 await send() 上，看门狗把它守的 Promise reject 了也没人在听。
       * 于是这一轮既不完成也不失败，界面就停在「正在思考」不动 —— 连错误都没有。
       */
      const timer = setTimeout(() => {
        reject(new Error("写入 Grok 子进程超时：进程还在，但已经不读输入了。"));
      }, this.options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS);
      timer.unref?.();
      child.stdin.write(line, "utf8", (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(timeoutMs = 3_000): Promise<ProcessExit | undefined> {
    const child = this.child;
    if (!child || !this.exitPromise) return undefined;
    this.closing = true;
    if (!child.stdin.destroyed) child.stdin.end();

    const timeout = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref();
    });
    let result = await Promise.race([this.exitPromise, timeout]);
    if (!result && this.running) {
      child.kill();
      result = await this.exitPromise;
    }
    return result;
  }

  private consumeStdout(chunk: string): void {
    const decoded = this.decoder.push(chunk);
    for (const message of decoded.messages) this.emit("message", message);
    for (const error of decoded.errors) this.emit("invalidJson", error);
  }
}
