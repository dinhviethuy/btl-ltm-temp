import path, { join } from "node:path";
import { ipcMain, dialog, app, Menu, BrowserWindow, shell } from "electron";
import { stat, readdir, lstat, mkdir, rename, unlink, rmdir, open, rm } from "node:fs/promises";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
class LocalFileSystem {
  currentDirectory;
  constructor(initialDirectory = process.cwd()) {
    this.currentDirectory = path.resolve(initialDirectory);
  }
  lpwd() {
    return this.currentDirectory;
  }
  async lcd(target) {
    if (!target.trim()) {
      throw new Error("Local path không được để trống");
    }
    const resolved = path.resolve(this.currentDirectory, target);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new Error(`Local path không tồn tại: ${resolved}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Local path không phải thư mục: ${resolved}`);
    }
    this.currentDirectory = resolved;
  }
  async lls(target) {
    const directory = target?.trim() ? path.resolve(this.currentDirectory, target) : this.currentDirectory;
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) {
      throw new Error(`Local path không phải thư mục: ${directory}`);
    }
    const entries = await readdir(directory, {
      withFileTypes: true
    });
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      let type;
      if (entry.isDirectory()) {
        type = "directory";
      } else if (entry.isSymbolicLink()) {
        type = "link";
      } else {
        type = "file";
      }
      files.push({
        name: entry.name,
        path: fullPath,
        type,
        size: info.size,
        modifiedAt: info.mtime
      });
    }
    return files;
  }
  resolvePath(target) {
    if (!target.trim()) throw new Error("Tên file không được để trống");
    if (/^[a-z]:($|[^\\/])/i.test(target)) throw new Error("Tên file không hợp lệ");
    const resolved = path.resolve(this.currentDirectory, target);
    const relative = path.relative(this.currentDirectory, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Đường dẫn đích nằm ngoài thư mục đã chọn");
    }
    const root = path.parse(target).root;
    for (const name of target.slice(root.length).split(/[\\/]/)) this.validateEntryName(name, "Tên file");
    return resolved;
  }
  async mkdir(target) {
    await mkdir(this.resolveEntryName(target, "Tên thư mục"));
  }
  async rename(from, to) {
    await rename(this.resolveEntryName(from, "Tên hiện tại"), this.resolveEntryName(to, "Tên mới"));
  }
  async move(from, toDirectory, overwrite = false, toName) {
    const source = this.resolveEntryName(from, "Tên file");
    const directory = this.resolveEntryName(toDirectory, "Tên thư mục đích");
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) throw new Error("Đích di chuyển không phải thư mục");
    const destinationName = toName ? path.basename(this.resolveEntryName(toName, "Tên mới")) : path.basename(source);
    const destination = this.resolvePath(path.join(directory, destinationName));
    let backup = null;
    try {
      const destinationStat = await lstat(destination);
      if (!overwrite) throw new Error(`Đã tồn tại mục cùng tên: ${destinationName}`);
      if (!destinationStat.isFile()) throw new Error("Không thể ghi đè lên thư mục cùng tên");
      backup = `${destination}.ftp-client-backup-${process.pid}-${Date.now()}`;
      await rename(destination, backup);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      await rename(source, destination);
    } catch (error) {
      if (backup) await rename(backup, destination).catch(() => void 0);
      throw error;
    }
    if (backup) await unlink(backup);
  }
  async deleteFile(target) {
    await unlink(this.resolveEntryName(target, "Tên file"));
  }
  async deleteDirectory(target) {
    await rmdir(this.resolveEntryName(target, "Tên thư mục"));
  }
  resolveEntryName(target, label) {
    this.validateEntryName(target, label);
    return this.resolvePath(target);
  }
  validateEntryName(name, label) {
    if (!name.trim()) throw new Error(`${label} không được để trống`);
    if (name === "." || name === "..") {
      throw new Error(`${label} chỉ được chứa tên mục, không được chứa đường dẫn`);
    }
    if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?: *\.| *$)/i.test(name)) {
      throw new Error(`${label} không hợp lệ`);
    }
  }
}
const metaSchema = z.object({ timestamp: z.string() });
const apiFailureSchema = z.object({
  success: z.literal(false),
  error: z.object({
    statusCode: z.number().int(),
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  }),
  meta: metaSchema.extend({ requestId: z.string(), path: z.string() })
});
function apiEnvelopeSchema(dataSchema) {
  return z.discriminatedUnion("success", [
    z.object({ success: z.literal(true), data: dataSchema, meta: metaSchema.extend({ total: z.number().optional() }) }),
    apiFailureSchema
  ]);
}
class ApiClientError extends Error {
  code;
  statusCode;
  constructor(code, message, statusCode) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
function sensitiveValues(init) {
  if (typeof init?.body !== "string") return [];
  try {
    const body = JSON.parse(init.body);
    if (body && typeof body === "object" && "password" in body) {
      const values = [body.password, "username" in body ? body.username : void 0];
      return values.filter((value) => typeof value === "string" && value.length > 0);
    }
  } catch {
  }
  return [];
}
function redact(message, secrets) {
  let safe = message;
  for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
  return safe;
}
class ApiClient {
  baseUrl;
  fetcher;
  constructor(baseUrl, fetcher = fetch) {
    this.fetcher = fetcher;
    try {
      this.baseUrl = new URL(baseUrl);
    } catch {
      throw new ApiClientError("INVALID_BASE_URL", "Địa chỉ API không hợp lệ");
    }
    if (!["http:", "https:"].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new ApiClientError("INVALID_BASE_URL", "Địa chỉ API không hợp lệ");
    }
  }
  async request(path2, init, schema) {
    return this.parseResponse(await this.requestResponse(path2, init), schema, init);
  }
  async requestResponse(path2, init) {
    const endpoint = new URL(path2.replace(/^\/+/, ""), `${this.baseUrl.toString().replace(/\/+$/, "")}/`);
    if (endpoint.origin !== this.baseUrl.origin || !endpoint.pathname.startsWith(`${this.baseUrl.pathname.replace(/\/+$/, "")}/`)) {
      throw new ApiClientError("INVALID_API_PATH", "Đường dẫn API không hợp lệ");
    }
    try {
      return await this.fetcher(endpoint.toString(), init);
    } catch {
      throw new ApiClientError("NETWORK_ERROR", "Không thể kết nối API server");
    }
  }
  async parseResponse(response, schema, init) {
    const secrets = sensitiveValues(init);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ApiClientError("INVALID_RESPONSE", "API server trả về dữ liệu không hợp lệ", response.status);
    }
    const parsed = apiEnvelopeSchema(schema).safeParse(body);
    if (!parsed.success) {
      throw new ApiClientError("INVALID_RESPONSE", "API server trả về dữ liệu không hợp lệ", response.status);
    }
    if (!parsed.data.success) {
      const { error } = parsed.data;
      throw new ApiClientError(error.code, redact(error.message, secrets), error.statusCode);
    }
    if (!response.ok) {
      throw new ApiClientError("INVALID_RESPONSE", "API server trả về trạng thái không hợp lệ", response.status);
    }
    return parsed.data.data;
  }
}
const remoteFileSchema = z.object({
  name: z.string(),
  type: z.enum(["file", "directory", "link"]),
  size: z.number().nonnegative(),
  permissions: z.string(),
  owner: z.string().optional(),
  group: z.string().optional(),
  modified: z.string().optional()
});
const remoteFileListSchema = z.array(remoteFileSchema);
const sessionSchema = z.object({
  sessionId: z.string().min(1),
  state: z.enum(["disconnected", "connected", "authenticated"]),
  url: z.string()
});
const transferIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const transferResultSchema = z.object({ transferId: transferIdSchema });
const transferInputSchema = transferResultSchema.extend({
  localPath: z.string().min(1),
  remotePath: z.string().min(1).regex(/^[^\x00-\x1f\x7f]+$/).refine((path2) => path2.trim().length > 0),
  totalBytes: z.number().int().nonnegative().optional()
});
const transferProgressSchema = z.object({
  transferId: transferIdSchema,
  transferredBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative().nullable(),
  bytesPerSecond: z.number().nonnegative()
});
const summarySchema = transferResultSchema.extend({
  direction: z.enum(["upload", "download"]),
  transferredBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative().nullable(),
  percentage: z.number().min(0).max(100).nullable()
});
const failureSchema = summarySchema.extend({ error: z.object({ code: z.string().min(1), message: z.string() }) });
const transferEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("transfer.progress"), data: summarySchema.extend({ bytesPerSecond: z.number().nonnegative() }) }),
  z.object({ event: z.literal("transfer.completed"), data: summarySchema }),
  z.object({ event: z.literal("transfer.failed"), data: failureSchema }),
  z.object({ event: z.literal("transfer.cancelled"), data: failureSchema })
]);
async function withDeadline(operation, milliseconds, timeout, controller = new AbortController()) {
  const timer = setTimeout(() => controller.abort(timeout), milliseconds);
  let abort;
  const aborted = new Promise((_resolve, reject) => {
    abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
  }
}
class TransferClient {
  client;
  active = /* @__PURE__ */ new Map();
  constructor(client) {
    this.client = client;
  }
  upload(sessionId, input) {
    return this.run(input, async (signal) => {
      const file = await stat(input.localPath);
      if (!file.isFile()) throw new ApiClientError("INVALID_LOCAL_FILE", "Đường dẫn tải lên phải là tệp");
      signal.throwIfAborted();
      const source = createReadStream(input.localPath, { signal });
      try {
        const init = {
          method: "POST",
          signal,
          duplex: "half",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(file.size),
            "x-transfer-id": input.transferId,
            "x-remote-path-encoded": encodeURIComponent(input.remotePath)
          },
          // Count queued bytes, not chunks, to preserve filesystem backpressure.
          body: Readable.toWeb(source, { strategy: {
            highWaterMark: source.readableHighWaterMark,
            size: (chunk) => chunk.byteLength
          } })
        };
        await this.client.request(`ftp/sessions/${encodeURIComponent(sessionId)}/uploads`, init, this.resultSchema(input.transferId));
      } finally {
        source.destroy();
        await finished(source).catch(() => void 0);
      }
    });
  }
  download(sessionId, input) {
    return this.run(input, async (signal) => {
      const params = new URLSearchParams({ transferId: input.transferId, remotePath: input.remotePath });
      const response = await this.client.requestResponse(`ftp/sessions/${encodeURIComponent(sessionId)}/downloads?${params}`, { signal });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/octet-stream") {
        await this.client.parseResponse(response, this.resultSchema(input.transferId));
        throw new ApiClientError("INVALID_RESPONSE", "API server không trả về luồng tệp");
      }
      if (!response.body) throw new ApiClientError("INVALID_RESPONSE", "API server không trả về luồng tệp");
      const partial = `${input.localPath}.ftp-client-part-${input.transferId}-${randomUUID()}`;
      let file;
      let published = false;
      try {
        file = await open(partial, "wx");
        await pipeline(Readable.fromWeb(response.body), file.createWriteStream(), { signal });
        signal.throwIfAborted();
        await rename(partial, input.localPath);
        published = true;
      } finally {
        await response.body.cancel().catch(() => void 0);
        await file?.close();
        if (file && !published) await rm(partial, { force: true });
      }
    });
  }
  async cancel(transferId) {
    transferIdSchema.parse(transferId);
    const active = this.active.get(transferId);
    if (!active) return this.requestCancellation(transferId);
    active.cancellation ??= this.requestCancellation(transferId);
    active.controller.abort();
    const [remote] = await Promise.allSettled([active.cancellation, active.done]);
    if (remote.status === "rejected") throw remote.reason;
  }
  async requestCancellation(transferId) {
    try {
      await withDeadline(
        (signal) => this.client.request(`ftp/transfers/${encodeURIComponent(transferId)}`, {
          method: "DELETE",
          signal
        }, this.resultSchema(transferId)),
        7500,
        new ApiClientError("FTP_TRANSFER_CANCEL_TIMEOUT", "Không xác nhận được việc hủy lượt truyền trong thời gian cho phép")
      );
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "FTP_TRANSFER_NOT_FOUND") return;
      if (error instanceof ApiClientError && error.code === "FTP_TRANSFER_CANCEL_TIMEOUT") throw error;
      throw new ApiClientError("FTP_TRANSFER_SETTLEMENT_FAILED", "Không xác nhận được việc dừng lượt truyền; cần kết nối lại FTP");
    }
  }
  async abortAll() {
    await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id)));
  }
  resultSchema(transferId) {
    return transferResultSchema.refine((result) => result.transferId === transferId);
  }
  async run(input, operation) {
    transferInputSchema.parse(input);
    if (this.active.has(input.transferId)) throw new ApiClientError("FTP_SESSION_CONFLICT", "Lượt truyền đang hoạt động");
    const controller = new AbortController();
    let complete;
    const done = new Promise((resolve) => {
      complete = resolve;
    });
    const active = { controller, done };
    this.active.set(input.transferId, active);
    try {
      await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new ApiClientError("FTP_TRANSFER_CANCELLED", "Lượt truyền đã bị hủy");
      throw error;
    } finally {
      try {
        if (controller.signal.aborted) await active.cancellation;
      } finally {
        this.active.delete(input.transferId);
        complete();
      }
    }
  }
}
const pathResultSchema = z.object({ path: z.string() });
const nameResultSchema = z.object({ name: z.string() });
const renameResultSchema = z.object({ from: z.string(), to: z.string() });
const disconnected = { state: "disconnected", url: null, username: null };
function ftpEndpoint(sessionId, suffix = "") {
  return `ftp/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}
function query(path2, recursive) {
  const params = new URLSearchParams({ path: path2 });
  if (recursive !== void 0) params.set("recursive", String(recursive));
  return `?${params}`;
}
class FtpApi {
  sessionId = null;
  connecting = null;
  connectController = null;
  generation = 0;
  username = null;
  url = null;
  client;
  transfers;
  socket;
  constructor(client, socket) {
    this.client = client;
    this.transfers = new TransferClient(client);
    this.socket = socket;
  }
  async connect(url) {
    if (this.sessionId || this.connecting) {
      throw new ApiClientError("FTP_SESSION_CONFLICT", "Phiên FTP đã được kết nối hoặc đang kết nối");
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiClientError("INVALID_FTP_URL", "Địa chỉ FTP không hợp lệ");
    }
    if (parsed.protocol !== "ftp:" || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new ApiClientError("INVALID_FTP_URL", "Địa chỉ FTP không hợp lệ");
    }
    const port = parsed.port ? Number(parsed.port) : 21;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiClientError("INVALID_FTP_URL", "Cổng FTP không hợp lệ");
    const generation = this.generation;
    const controller = new AbortController();
    this.connectController = controller;
    const connecting = withDeadline(async (signal) => {
      const session = await this.client.request("ftp/sessions", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: parsed.hostname.replace(/^\[|\]$/g, ""), port })
      }, sessionSchema);
      if (generation !== this.generation || signal.aborted) {
        await this.deleteSession(session.sessionId).catch(() => console.warn("Late FTP session cleanup could not be confirmed"));
        throw new ApiClientError("FTP_SESSION_CANCELLED", "Kết nối FTP đã bị hủy");
      }
      this.sessionId = session.sessionId;
      this.username = null;
      this.url = session.url;
      if (session.state !== "disconnected") this.socket?.connect(session.sessionId);
      return this.snapshot(session);
    }, 1e4, new ApiClientError("FTP_CONNECTION_TIMEOUT", "Kết nối FTP quá thời gian chờ"), controller);
    this.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
      if (this.connectController === controller) this.connectController = null;
    }
  }
  async deleteSession(sessionId) {
    try {
      await withDeadline(
        (signal) => this.client.request(ftpEndpoint(sessionId), { method: "DELETE", signal }, sessionSchema),
        1e4,
        new ApiClientError("FTP_CLEANUP_TIMEOUT", "Dọn dẹp phiên FTP quá thời gian chờ")
      );
    } catch (error) {
      if (!(error instanceof ApiClientError && error.code === "FTP_SESSION_NOT_FOUND")) throw error;
    }
  }
  async login(credentials) {
    const session = await this.call("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials)
    }, sessionSchema);
    this.username = credentials.username;
    return this.snapshot(session);
  }
  async disconnect() {
    const sessionId = this.sessionId;
    const connecting = this.connecting;
    const stopped = this.clear();
    const results = await Promise.allSettled([stopped, connecting, sessionId ? this.deleteSession(sessionId) : void 0]);
    if (results[2].status === "rejected") console.warn("FTP server session cleanup could not be confirmed");
    return disconnected;
  }
  async state() {
    if (!this.sessionId) return disconnected;
    return this.snapshot(await this.call("", {}, sessionSchema));
  }
  pwd() {
    return this.call("/pwd", {}, z.string());
  }
  async list(path2) {
    const files = await this.call(`/files${path2 === void 0 ? "" : query(path2)}`, {}, remoteFileListSchema);
    return files.map((file) => ({ ...file, raw: "" }));
  }
  async cwd(path2) {
    await this.call("/cwd", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: path2 }) }, z.string());
  }
  async cdup() {
    await this.call("/cdup", { method: "POST" }, z.string());
  }
  async mkdir(name) {
    await this.call("/directories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }, nameResultSchema);
  }
  async deleteFile(path2) {
    await this.call(`/files${query(path2)}`, { method: "DELETE" }, pathResultSchema);
  }
  async deleteDirectory(path2) {
    await this.call(`/directories${query(path2, true)}`, { method: "DELETE" }, pathResultSchema);
  }
  async rename(input) {
    await this.call("/entries", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, renameResultSchema);
  }
  upload(input) {
    return this.withSession((id) => this.transfers.upload(id, input));
  }
  download(input) {
    return this.withSession((id) => this.transfers.download(id, input));
  }
  async cancelTransfer(transferId) {
    const generation = this.generation;
    try {
      await this.transfers.cancel(transferId);
    } catch (error) {
      if (this.generation === generation && error instanceof ApiClientError && ["FTP_TRANSFER_CANCEL_TIMEOUT", "FTP_TRANSFER_SETTLEMENT_FAILED"].includes(error.code)) await this.clear();
      throw error;
    }
  }
  onTransferProgress(listener) {
    return this.socket?.onProgress(listener) ?? (() => void 0);
  }
  async call(suffix, init, schema) {
    return this.withSession((id) => this.client.request(ftpEndpoint(id, suffix), init, schema));
  }
  async withSession(operation) {
    if (!this.sessionId) throw new ApiClientError("FTP_SESSION_NOT_FOUND", "Chưa kết nối FTP");
    const sessionId = this.sessionId;
    const generation = this.generation;
    try {
      const result = await operation(sessionId);
      if (this.generation !== generation) throw new ApiClientError("FTP_SESSION_CANCELLED", "Phiên FTP đã kết thúc");
      return result;
    } catch (error) {
      if (this.generation === generation && error instanceof ApiClientError && ["FTP_SESSION_NOT_FOUND", "FTP_TRANSFER_CANCEL_TIMEOUT", "FTP_TRANSFER_SETTLEMENT_FAILED"].includes(error.code)) await this.clear();
      throw error;
    }
  }
  snapshot(session) {
    if (session.state === "disconnected") {
      void this.clear();
      return disconnected;
    }
    this.url = session.url;
    return {
      state: session.state,
      url: this.url,
      username: session.state === "authenticated" ? this.username : null
    };
  }
  clear() {
    this.generation++;
    this.connectController?.abort(new ApiClientError("FTP_SESSION_CANCELLED", "Kết nối FTP đã bị hủy"));
    this.sessionId = null;
    this.username = null;
    this.url = null;
    this.socket?.disconnect();
    return this.transfers.abortAll();
  }
}
function transferSocketBaseUrl(apiBaseUrl, configured) {
  let url;
  try {
    url = new URL(configured ?? apiBaseUrl);
  } catch {
    throw new ApiClientError("INVALID_BASE_URL", "Địa chỉ WebSocket không hợp lệ");
  }
  const protocols = configured ? ["ws:", "wss:"] : ["http:", "https:"];
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ApiClientError("INVALID_BASE_URL", "Địa chỉ WebSocket không hợp lệ");
  }
  if (!configured) {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/";
  }
  return url.toString();
}
class TransferSocket {
  baseUrl;
  createSocket;
  logger;
  listeners = /* @__PURE__ */ new Set();
  sessionId = null;
  socket = null;
  cleanupSocket = null;
  retry = null;
  retries = 0;
  constructor(baseUrl, createSocket = (url) => new WebSocket(url), logger = console) {
    this.baseUrl = transferSocketBaseUrl("http://localhost", baseUrl);
    this.createSocket = createSocket;
    this.logger = logger;
  }
  onProgress(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  connect(sessionId) {
    this.disconnect();
    this.sessionId = sessionId;
    this.retries = 0;
    this.open();
  }
  disconnect() {
    this.sessionId = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.closeSocket();
  }
  closeSocket() {
    const socket = this.socket;
    this.socket = null;
    this.cleanupSocket?.();
    this.cleanupSocket = null;
    socket?.close();
  }
  scheduleRetry() {
    if (!this.sessionId || this.retry || this.retries >= 5) return;
    const delay = 250 * 2 ** this.retries++;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, delay);
  }
  open() {
    if (!this.sessionId) return;
    const url = new URL("transfers", `${this.baseUrl.replace(/\/+$/, "")}/`);
    url.searchParams.set("sessionId", this.sessionId);
    let socket;
    try {
      socket = this.createSocket(url.toString());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    const message = (event) => {
      if (this.socket !== socket || !this.sessionId) return;
      let parsed;
      try {
        const payload = event.data;
        if (typeof payload !== "string") throw new Error("Non-text event");
        parsed = transferEventSchema.safeParse(JSON.parse(payload));
      } catch {
        this.logger.warn("Ignored malformed FTP transfer event");
        return;
      }
      if (!parsed.success) {
        this.logger.warn("Ignored malformed FTP transfer event");
        return;
      }
      if (parsed.data.event === "transfer.progress") {
        const progress = transferProgressSchema.parse(parsed.data.data);
        for (const listener of this.listeners) listener(progress);
      }
    };
    const close = (event) => {
      if (this.socket !== socket) return;
      this.closeSocket();
      if (event.code === 1008) this.sessionId = null;
      else this.scheduleRetry();
    };
    const error = () => {
      if (this.socket !== socket) return;
      this.closeSocket();
      this.scheduleRetry();
    };
    socket.addEventListener("message", message);
    socket.addEventListener("close", close);
    socket.addEventListener("error", error);
    this.cleanupSocket = () => {
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", close);
      socket.removeEventListener("error", error);
    };
  }
}
const IPC_CHANNEL = {
  ftp: {
    connect: "ftp:connect",
    login: "ftp:login",
    disconnect: "ftp:disconnect",
    state: "ftp:state",
    pwd: "ftp:pwd",
    list: "ftp:list",
    cwd: "ftp:cwd",
    cdup: "ftp:cdup",
    upload: "ftp:upload",
    download: "ftp:download",
    cancelTransfer: "ftp:cancel-transfer",
    transferProgress: "ftp:transfer-progress",
    mkdir: "ftp:mkdir",
    deleteFile: "ftp:delete-file",
    deleteDirectory: "ftp:delete-directory",
    rename: "ftp:rename"
  },
  local: {
    pwd: "local:pwd",
    list: "local:list",
    cwd: "local:cwd",
    resolvePath: "local:resolve-path",
    chooseDirectory: "local:choose-directory",
    mkdir: "local:mkdir",
    rename: "local:rename",
    move: "local:move",
    deleteFile: "local:delete-file",
    deleteDirectory: "local:delete-directory"
  }
};
const registrations = /* @__PURE__ */ new WeakMap();
function registerFtpIpc(ftp, ipc, windows = () => []) {
  registrations.get(ipc)?.();
  const channels = IPC_CHANNEL.ftp;
  ipc.handle(channels.connect, (_event, url) => ftp.connect(url));
  ipc.handle(channels.login, (_event, credentials) => ftp.login(credentials));
  ipc.handle(channels.disconnect, () => ftp.disconnect());
  ipc.handle(channels.state, () => ftp.state());
  ipc.handle(channels.pwd, () => ftp.pwd());
  ipc.handle(channels.list, (_event, path2) => ftp.list(path2));
  ipc.handle(channels.cwd, (_event, path2) => ftp.cwd(path2));
  ipc.handle(channels.cdup, () => ftp.cdup());
  ipc.handle(channels.upload, (_event, input) => ftp.upload(input));
  ipc.handle(channels.download, (_event, input) => ftp.download(input));
  ipc.handle(channels.cancelTransfer, (_event, id) => ftp.cancelTransfer(id));
  ipc.handle(channels.mkdir, (_event, path2) => ftp.mkdir(path2));
  ipc.handle(channels.deleteFile, (_event, path2) => ftp.deleteFile(path2));
  ipc.handle(channels.deleteDirectory, (_event, path2) => ftp.deleteDirectory(path2));
  ipc.handle(channels.rename, (_event, input) => ftp.rename(input));
  const unsubscribe = ftp.onTransferProgress((progress) => {
    for (const window of windows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channels.transferProgress, progress);
    }
  });
  const registered = Object.values(channels).filter((channel) => channel !== channels.transferProgress);
  const dispose = () => {
    if (registrations.get(ipc) !== dispose) return;
    unsubscribe();
    for (const channel of registered) ipc.removeHandler(channel);
    registrations.delete(ipc);
  };
  registrations.set(ipc, dispose);
  return dispose;
}
function registerLocalIpc(local) {
  const channels = IPC_CHANNEL.local;
  ipcMain.handle(channels.pwd, () => local.lpwd());
  ipcMain.handle(channels.list, async (_event, path2) => {
    const files = await local.lls(path2);
    return files.map((file) => ({ ...file, modifiedAt: file.modifiedAt.toISOString() }));
  });
  ipcMain.handle(channels.cwd, async (_event, path2) => {
    await local.lcd(path2);
  });
  ipcMain.handle(channels.resolvePath, (_event, path2) => local.resolvePath(path2));
  ipcMain.handle(channels.chooseDirectory, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: local.lpwd(),
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(channels.mkdir, async (_event, path2) => {
    await local.mkdir(path2);
  });
  ipcMain.handle(channels.rename, async (_event, input) => {
    await local.rename(input.from, input.to);
  });
  ipcMain.handle(
    channels.move,
    async (_event, input) => {
      await local.move(input.from, input.toDirectory, input.overwrite, input.toName);
    }
  );
  ipcMain.handle(channels.deleteFile, async (_event, path2) => {
    await local.deleteFile(path2);
  });
  ipcMain.handle(channels.deleteDirectory, async (_event, path2) => {
    await local.deleteDirectory(path2);
  });
  return () => {
    for (const channel of Object.values(channels)) ipcMain.removeHandler(channel);
  };
}
function createExternalLinkHandler(openExternal, onError = () => console.warn("Could not open external link")) {
  return ({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "http:" || protocol === "https:") {
        void Promise.resolve().then(() => openExternal(url)).catch(onError);
      }
    } catch {
    }
    return { action: "deny" };
  };
}
function createShutdownHandler(dispose, quit) {
  let pending = false;
  let complete = false;
  return (event) => {
    if (complete) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    void (async () => {
      try {
        await dispose();
      } catch {
        console.warn("Could not finish FTP client cleanup during shutdown");
      } finally {
        complete = true;
        quit();
      }
    })();
  };
}
let disposeIpc = null;
function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3efe6",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  window.removeMenu();
  window.once("ready-to-show", () => {
    window.show();
  });
  window.webContents.setWindowOpenHandler(createExternalLinkHandler((url) => shell.openExternal(url)));
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const local = new LocalFileSystem(app.getPath("downloads"));
  const disposeLocal = registerLocalIpc(local);
  const apiBaseUrl = process.env.FTP_API_BASE_URL ?? "http://127.0.0.1:3000/api";
  const socket = new TransferSocket(transferSocketBaseUrl(apiBaseUrl, process.env.FTP_WS_BASE_URL));
  const ftp = new FtpApi(new ApiClient(apiBaseUrl), socket);
  const disposeFtp = registerFtpIpc(ftp, ipcMain, () => BrowserWindow.getAllWindows());
  disposeIpc = async () => {
    disposeFtp();
    disposeLocal();
    await ftp.disconnect();
  };
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("before-quit", createShutdownHandler(async () => {
  await disposeIpc?.();
  disposeIpc = null;
}, () => app.quit()));
