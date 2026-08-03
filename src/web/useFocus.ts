import { useCallback, useState } from "react";

export type FocusState = "idle" | "working" | "ok" | "failed";

const MESSAGES: Record<string, string> = {
  "no-tty": "No terminal recorded for this session yet",
  "not-found": "No open tab matches this session's terminal",
  "no-terminal": "iTerm2 and Terminal are both closed",
  error: "Could not talk to the terminal",
};

export function useFocus() {
  const [state, setState] = useState<FocusState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const focus = useCallback(async (sessionId: string) => {
    setState("working");
    setMessage(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/focus`, { method: "POST" });
      const body = await res.json();
      if (res.ok && body.ok) {
        setState("ok");
        setTimeout(() => setState("idle"), 1200);
        return;
      }
      setState("failed");
      setMessage(MESSAGES[body.reason] ?? body.detail ?? "Could not focus that tab");
      setTimeout(() => setState("idle"), 4000);
    } catch (err) {
      setState("failed");
      setMessage(err instanceof Error ? err.message : String(err));
      setTimeout(() => setState("idle"), 4000);
    }
  }, []);

  return { state, message, focus };
}
