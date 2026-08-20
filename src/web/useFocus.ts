import { useCallback, useState } from "react";

export type FocusState = "idle" | "working" | "ok" | "failed";

interface FocusBody {
  ok?: boolean;
  reason?: string;
  detail?: string;
  tmux?: string;
  attachCommand?: string;
  app?: string;
  via?: "tab" | "tmux" | "tmux-attach";
}

const MESSAGES: Record<string, string> = {
  "no-tty": "No terminal recorded for this session yet",
  "not-found": "No open tab matches this session's terminal",
  "no-terminal": "iTerm2 and Terminal are both closed",
  "tmux-gone": "That tmux pane is no longer there",
  "tmux-other-session": "Nothing is showing this tmux session",
  "tmux-client-unreachable": "Its tmux client is not a local terminal tab",
  error: "Could not talk to the terminal",
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

  const post = useCallback(async (sessionId: string, action: "focus" | "tmux-attach") => {
    setState("working");
    setMessage(null);
    setAttachCommand(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/${action}`, { method: "POST" });
      const body = (await res.json()) as FocusBody;
      if (res.ok && body.ok) {
        setState("ok");
        if (body.via === "tmux-attach") {
          setMessage(`Attached ${body.tmux} in a new ${body.app} window`);
        }
        setTimeout(() => setState("idle"), 1200);
        return;
      }
      setState("failed");
      setMessage(describe(body));
      // Kept past the state reset so the command stays copyable while it's needed.
      setAttachCommand(body.attachCommand ?? null);
      setTimeout(() => setState("idle"), 4000);
    } catch (err) {
      setState("failed");
      setMessage(err instanceof Error ? err.message : String(err));
      setTimeout(() => setState("idle"), 4000);
    }
  }, []);

  const focus = useCallback((sessionId: string) => post(sessionId, "focus"), [post]);
  const attach = useCallback((sessionId: string) => post(sessionId, "tmux-attach"), [post]);

  return { state, message, attachCommand, focus, attach };
}
