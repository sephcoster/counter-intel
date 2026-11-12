import { useCallback, useEffect, useRef, useState } from "react";

export type FocusState = "idle" | "working" | "ok" | "failed";

interface FocusBody {
  ok?: boolean;
  reason?: string;
  detail?: string;
  tmux?: string;
  attachCommand?: string;
  app?: string;
  via?: "tab" | "tmux" | "tmux-attach" | "app";
}

const MESSAGES: Record<string, string> = {
  "no-tty": "No terminal recorded for this session yet",
  "not-found": "No open tab matches this session's terminal",
  "no-terminal": "iTerm2 and Terminal are both closed",
  "tmux-gone": "That tmux pane is no longer there",
  "tmux-other-session": "Nothing is showing this tmux session",
  "tmux-client-unreachable": "Could not raise the terminal showing this tmux session",
  error: "Could not talk to the terminal",
  timeout: "The terminal took too long to respond. Check for a macOS Automation permission prompt, then try again.",
};

function describe(body: FocusBody): string {
  const base = MESSAGES[body.reason ?? ""] ?? body.detail ?? "Could not focus that tab";
  const scoped = body.tmux ? `${base} (${body.tmux})` : base;
  return body.detail && MESSAGES[body.reason ?? ""] ? `${scoped} — ${body.detail}` : scoped;
}

export function useFocus() {
  const [state, setState] = useState<FocusState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [attachCommand, setAttachCommand] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
    clearTimeout(resetTimer.current);
  }, []);

  const post = useCallback(async (sessionId: string, action: "focus" | "tmux-attach") => {
    if (pending.current) return;
    clearTimeout(resetTimer.current);
    const controller = new AbortController();
    pending.current = controller;
    const deadline = setTimeout(() => controller.abort(), 30_000);
    setState("working");
    setMessage(null);
    setAttachCommand(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/${action}`, { method: "POST", signal: controller.signal });
      const body = (await res.json()) as FocusBody;
      if (pending.current !== controller) return;
      if (res.ok && body.ok) {
        setState("ok");
        if (body.via === "tmux-attach") {
          setMessage(`Attached ${body.tmux} in a new ${body.app} window`);
        } else if (body.via === "app") {
          setMessage(`Raised ${body.app} — it exposes no way to pick the window, so check the front one`);
        }
        resetTimer.current = setTimeout(() => setState("idle"), 1200);
        return;
      }
      setState("failed");
      setMessage(describe(body));
      // Kept past the state reset so the command stays copyable while it's needed.
      setAttachCommand(body.attachCommand ?? null);
      resetTimer.current = setTimeout(() => setState("idle"), 4000);
    } catch (err) {
      if (pending.current !== controller) return;
      setState("failed");
      setMessage(controller.signal.aborted
        ? "The jump request timed out. The server may still finish it; check the terminal before retrying."
        : err instanceof Error ? err.message : String(err));
      resetTimer.current = setTimeout(() => setState("idle"), 4000);
    } finally {
      clearTimeout(deadline);
      if (pending.current === controller) pending.current = null;
    }
  }, []);

  const focus = useCallback((sessionId: string) => post(sessionId, "focus"), [post]);
  const attach = useCallback((sessionId: string) => post(sessionId, "tmux-attach"), [post]);

  return { state, message, attachCommand, focus, attach };
}
