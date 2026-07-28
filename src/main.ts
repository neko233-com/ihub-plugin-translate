const PLUGIN_ID = "ihub-plugin-translate";
const FRAME_REQUEST_CHANNEL = "ihub-plugin-bridge/v1";
const FRAME_RESPONSE_CHANNEL = "ihub-host-bridge/v1";
const FRAME_CALL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SOURCE_LENGTH = 30_000;

type StatusTone = "ready" | "working" | "success" | "error";

interface TranslationResponse {
  translatedText: string;
}

/** Opaque, one-shot context reference attached to a user-confirmed command. */
interface LauncherContextInvocation {
  contextId: string;
  expiresInMs: number;
}

interface LauncherContextPayload {
  text?: string;
  files: unknown[];
  image?: unknown;
}

interface CommandInvocation {
  requestId: string;
  commandId: string;
  launcherContext?: LauncherContextInvocation;
}

interface CommandResult {
  message?: string;
  close?: boolean;
}

type CommandHandler = (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing Translate element: #${id}`);
  }
  return element as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isTranslationResponse(value: unknown): value is TranslationResponse {
  return isRecord(value) && typeof value.translatedText === "string";
}

let hostCallSequence = 0;
const commandHandlers = new Map<string, CommandHandler>();

function callHost<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (window.parent === window) {
    return Promise.reject(new Error("The iHub host bridge is unavailable in a standalone browser preview."));
  }

  return new Promise<T>((resolve, reject) => {
    const id = `translate-${Date.now().toString(36)}-${(hostCallSequence++).toString(36)}`;
    let timeout: number | null = null;
    const cleanup = () => {
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
      window.removeEventListener("message", onMessage);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || !isRecord(event.data)) {
        return;
      }
      const response = event.data;
      if (
        response.channel !== FRAME_RESPONSE_CHANNEL
        || response.type !== "response"
        || response.id !== id
      ) {
        return;
      }
      cleanup();
      if (response.ok === true) {
        resolve(response.result as T);
      } else {
        reject(new Error(typeof response.error === "string" ? response.error : "iHub host call failed."));
      }
    };

    timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("iHub host call timed out."));
    }, FRAME_CALL_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      {
        channel: FRAME_REQUEST_CHANNEL,
        type: "call",
        id,
        request: { pluginId: PLUGIN_ID, method, params },
      },
      "*",
    );
  });
}

const ihub = {
  commands: {
    async register(
      definition: { id: string; title: string; subtitle?: string; keywords?: string[] },
      handler: CommandHandler,
    ): Promise<void> {
      if (commandHandlers.has(definition.id)) {
        throw new Error(`Duplicate Translate command: ${definition.id}`);
      }
      commandHandlers.set(definition.id, handler);
      try {
        await callHost<void>("commands.register", { definition: definition as unknown as Record<string, unknown> });
      } catch (error) {
        commandHandlers.delete(definition.id);
        throw error;
      }
    },
  },
  launcherContext: {
    consume: (contextId: string) =>
      callHost<LauncherContextPayload>("launcherContext.consume", { contextId }),
  },
};

const form = requiredElement<HTMLFormElement>("translate-form");
const endpoint = requiredElement<HTMLInputElement>("endpoint");
const apiKey = requiredElement<HTMLInputElement>("api-key");
const sourceLanguage = requiredElement<HTMLSelectElement>("source-language");
const targetLanguage = requiredElement<HTMLSelectElement>("target-language");
const sourceText = requiredElement<HTMLTextAreaElement>("source-text");
const translatedText = requiredElement<HTMLTextAreaElement>("translated-text");
const sourceCount = requiredElement<HTMLElement>("source-count");
const resultCount = requiredElement<HTMLElement>("result-count");
const translateButton = requiredElement<HTMLButtonElement>("translate");
const cancelButton = requiredElement<HTMLButtonElement>("cancel");
const copyButton = requiredElement<HTMLButtonElement>("copy");
const clearSessionButton = requiredElement<HTMLButtonElement>("clear-session");
const statusOutput = requiredElement<HTMLOutputElement>("status");

let activeRequest: AbortController | null = null;
let translationSequence = 0;

function setStatus(message: string, tone: StatusTone = "ready"): void {
  statusOutput.textContent = message;
  statusOutput.dataset.tone = tone;
}

function updateCounters(): void {
  sourceCount.textContent = `${sourceText.value.length.toLocaleString()} / ${MAX_SOURCE_LENGTH.toLocaleString()}`;
  resultCount.textContent = translatedText.value.length > 0
    ? `${translatedText.value.length.toLocaleString()} characters`
    : "尚无结果";
  copyButton.disabled = translatedText.value.trim().length === 0 || activeRequest !== null;
}

function setBusy(busy: boolean): void {
  translateButton.disabled = busy;
  cancelButton.hidden = !busy;
  endpoint.disabled = busy;
  apiKey.disabled = busy;
  sourceLanguage.disabled = busy;
  targetLanguage.disabled = busy;
  sourceText.disabled = busy;
  clearSessionButton.disabled = busy;
  translateButton.textContent = busy ? "正在翻译…" : "翻译";
  updateCounters();
}

function normalizeEndpoint(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("请先填写你选择的 LibreTranslate 兼容 HTTPS endpoint。");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("endpoint 必须是完整 HTTPS URL。");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("为了保护传输内容，endpoint 必须使用 HTTPS。");
  }
  if (parsed.username || parsed.password) {
    throw new Error("请不要把账号或密码写入 endpoint；如服务需要密钥，请使用 API key 字段。");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("endpoint 不能包含 query 或 hash；请使用干净的服务地址。");
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.endsWith("/translate") ? pathname : `${pathname}/translate`;
  return parsed;
}

function buildPayload(): Record<string, string> {
  const text = sourceText.value.trim();
  if (!text) {
    throw new Error("请输入要翻译的文本。");
  }
  if (text.length > MAX_SOURCE_LENGTH) {
    throw new Error(`文本不能超过 ${MAX_SOURCE_LENGTH.toLocaleString()} 个字符。`);
  }

  const payload: Record<string, string> = {
    q: text,
    source: sourceLanguage.value,
    target: targetLanguage.value,
    format: "text",
  };
  const key = apiKey.value.trim();
  if (key) {
    payload.api_key = key;
  }
  return payload;
}

async function translate(): Promise<void> {
  if (activeRequest) {
    return;
  }

  let target: URL;
  let payload: Record<string, string>;
  try {
    target = normalizeEndpoint(endpoint.value);
    payload = buildPayload();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "请检查翻译输入。", "error");
    return;
  }

  const requestSequence = ++translationSequence;
  const controller = new AbortController();
  activeRequest = controller;
  setBusy(true);
  setStatus("正在向你选择的服务发送这一次翻译请求…", "working");
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(target.toString(), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data: unknown = await response.json();
    if (!isTranslationResponse(data) || data.translatedText.trim().length === 0) {
      throw new Error("The selected service returned no translatedText value.");
    }
    if (requestSequence !== translationSequence) {
      return;
    }
    translatedText.value = data.translatedText;
    setStatus("翻译完成。结果仍只在当前页面，点击“复制结果”才会写入剪贴板。", "success");
  } catch (error) {
    if (requestSequence !== translationSequence) {
      return;
    }
    if (controller.signal.aborted) {
      setStatus("请求已取消或在 30 秒后超时。没有新的结果被复制或保存。", "ready");
    } else {
      // Do not echo a server error body: providers may include submitted text or
      // credentials in diagnostics. Keep network failure feedback local and generic.
      setStatus("翻译请求失败。请确认 endpoint 兼容 LibreTranslate、允许 CORS，并检查服务端凭据。", "error");
    }
  } finally {
    window.clearTimeout(timeout);
    if (activeRequest === controller) {
      activeRequest = null;
      setBusy(false);
    }
  }
}

async function copyResult(): Promise<void> {
  const value = translatedText.value;
  if (!value.trim()) {
    setStatus("还没有可复制的翻译结果。", "error");
    return;
  }

  try {
    if (window.parent !== window) {
      await callHost<void>("clipboard.writeText", { value });
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      translatedText.focus();
      translatedText.select();
      if (!document.execCommand("copy")) {
        throw new Error("Browser clipboard fallback was rejected.");
      }
      window.getSelection()?.removeAllRanges();
    }
    setStatus("已复制翻译结果。插件没有读取剪贴板内容。", "success");
  } catch {
    setStatus("无法写入剪贴板。请检查 iHub 的 clipboard.write 授权，或手动选择并复制结果。", "error");
  }
}

function clearSession(): void {
  translationSequence += 1;
  activeRequest?.abort();
  activeRequest = null;
  endpoint.value = "";
  apiKey.value = "";
  sourceText.value = "";
  translatedText.value = "";
  sourceLanguage.value = "auto";
  targetLanguage.value = "zh";
  setBusy(false);
  updateCounters();
  setStatus("已清除当前页面的 endpoint、API key、文本和结果。", "ready");
  endpoint.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void translate();
});
cancelButton.addEventListener("click", () => activeRequest?.abort());
copyButton.addEventListener("click", () => void copyResult());
clearSessionButton.addEventListener("click", clearSession);
sourceText.addEventListener("input", updateCounters);
translatedText.addEventListener("input", updateCounters);

function parseCommandInvocation(value: unknown): CommandInvocation | null {
  if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.commandId !== "string") {
    return null;
  }
  const rawTransfer = value.launcherContext;
  if (rawTransfer === undefined) {
    return { requestId: value.requestId, commandId: value.commandId };
  }
  if (
    !isRecord(rawTransfer)
    || typeof rawTransfer.contextId !== "string"
    || typeof rawTransfer.expiresInMs !== "number"
    || !Number.isFinite(rawTransfer.expiresInMs)
  ) {
    return null;
  }
  return {
    requestId: value.requestId,
    commandId: value.commandId,
    launcherContext: {
      contextId: rawTransfer.contextId,
      expiresInMs: rawTransfer.expiresInMs,
    },
  };
}

async function receiveLauncherText(invocation: CommandInvocation): Promise<CommandResult> {
  const transfer = invocation.launcherContext;
  if (!transfer) {
    sourceText.focus();
    setStatus("已从 iHub 命令面板打开。先填写你信任的 HTTPS endpoint，再点击翻译。", "ready");
    return { message: "Translate is ready.", close: false };
  }

  // A new explicit handoff must never let an older network response overwrite
  // its local prefill. Aborting is best-effort; the sequence is authoritative.
  translationSequence += 1;
  activeRequest?.abort();
  const payload = await ihub.launcherContext.consume(transfer.contextId);
  if (typeof payload.text !== "string") {
    throw new Error("此次交接没有可翻译的文本。");
  }
  const originalLength = payload.text.length;
  sourceText.value = payload.text.slice(0, MAX_SOURCE_LENGTH);
  translatedText.value = "";
  updateCounters();
  const wasTruncated = originalLength > sourceText.value.length;
  if (endpoint.value.trim()) {
    sourceText.focus();
  } else {
    endpoint.focus();
  }
  setStatus(
    wasTruncated
      ? `已接收文本并在本页限制为 ${MAX_SOURCE_LENGTH.toLocaleString()} 个字符。选择 HTTPS endpoint 后，点击“翻译”才会发送内容。`
      : "已接收本次文本。选择 HTTPS endpoint 后，点击“翻译”才会发送内容。",
    "success",
  );
  return { message: "Selected text received. Choose an endpoint before translating.", close: false };
}

async function completeCommand(invocation: CommandInvocation, ok: boolean, result: CommandResult, failure?: string): Promise<void> {
  await callHost<void>("commands.complete", {
    requestId: invocation.requestId,
    ok,
    result: result as unknown as Record<string, unknown>,
    error: failure ?? null,
  });
}

async function dispatchCommand(value: unknown): Promise<void> {
  const invocation = parseCommandInvocation(value);
  if (!invocation) {
    return;
  }
  const handler = commandHandlers.get(invocation.commandId);
  if (!handler) {
    await completeCommand(invocation, false, {}, `Unknown Translate command: ${invocation.commandId}`);
    return;
  }
  try {
    await completeCommand(invocation, true, await handler(invocation));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    setStatus(`无法接收启动器文本：${failure}`, "error");
    await completeCommand(invocation, false, {}, failure);
  }
}

async function activatePlugin(): Promise<void> {
  await ihub.commands.register(
    {
      id: "open-translate",
      title: "Open Translate",
      subtitle: "Translate only after you choose an HTTPS LibreTranslate-compatible endpoint",
      keywords: ["translate", "translation", "语言", "翻译"],
    },
    receiveLauncherText,
  );
  await ihub.commands.register(
    {
      id: "translate-launcher-text",
      title: "Translate selected text",
      subtitle: "Receive one explicit text handoff, then choose an HTTPS translation endpoint",
      keywords: ["translate", "selection", "text", "context", "语言", "翻译", "文本"],
    },
    receiveLauncherText,
  );
  await callHost<unknown>("lifecycle.ready");
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isRecord(event.data)) {
    return;
  }
  const message = event.data;
  if (
    message.channel === FRAME_RESPONSE_CHANNEL
    && message.type === "event"
    && message.name === `ihub://plugin/${PLUGIN_ID}/command`
  ) {
    void dispatchCommand(message.payload);
  }
});

window.addEventListener("pagehide", () => {
  activeRequest?.abort();
  apiKey.value = "";
  void callHost<unknown>("lifecycle.dispose").catch(() => undefined);
});

updateCounters();
setStatus("尚未连接服务。", "ready");
void activatePlugin().catch((error) => {
  setStatus(`Translate 插件无法启动：${error instanceof Error ? error.message : String(error)}`, "error");
});
