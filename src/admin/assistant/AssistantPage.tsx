// Dedicated full-page Sisely AI experience, reached at /admin/assistant --
// replaces the earlier small slide-in panel (AssistantPanel.tsx, removed).
// This file is presentation/interaction ONLY: it wires the exact same
// engine (answerAssistantQuery/EMPTY_CONTEXT from ./assistant,
// formatAssistantAnswer from ./answerFormatter) that already existed --
// nothing about intent parsing, entity resolution, calculations, Firestore
// reads, or supported questions changes here.
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage, type Lang } from "../../context/LanguageContext";
import { AdminButton, Card, PageHeader, Spinner } from "../components/ui";
import AdminIcon from "../components/AdminIcons";
import { formatAssistantAnswer } from "./answerFormatter";
import { answerAssistantQuery, EMPTY_CONTEXT, type AssistantContext } from "./assistant";
import type { AssistantAnswer } from "./types";

type Message = { role: "user"; text: string } | { role: "assistant"; answer: AssistantAnswer };

const EXAMPLE_KEYS = ["admin.assistant.example1", "admin.assistant.example2", "admin.assistant.example3", "admin.assistant.example4"];

export default function AssistantPage() {
  const { t, lang, dir } = useLanguage();
  const navigate = useNavigate();
  const prefersReducedMotion = useReducedMotion();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [context, setContext] = useState<AssistantContext>(EMPTY_CONTEXT);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: prefersReducedMotion ? "auto" : "smooth" });
  }, [messages, loading, prefersReducedMotion]);

  async function ask(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: query }]);
    setLoading(true);
    const { answer, nextContext } = await answerAssistantQuery(query, context);
    setContext(nextContext);
    setMessages((m) => [...m, { role: "assistant", answer }]);
    setLoading(false);
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits; Shift+Enter inserts a newline instead (standard
    // multi-line-input convention) -- never submits an empty/whitespace-only
    // question.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(input);
    }
  }

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 14, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
    >
      <PageHeader
        title={t("admin.assistant.title")}
        description={t("admin.assistant.subtitle")}
        actions={
          <AdminButton variant="secondary" icon={dir === "rtl" ? "chevronRight" : "chevronLeft"} onClick={() => navigate("/admin")}>
            {t("admin.assistant.backToDashboard")}
          </AdminButton>
        }
      />

      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-blue-500 text-base font-extrabold tracking-wide text-white shadow-soft">
              AI
            </span>
            <p className="font-display text-2xl font-bold text-ink">{t("admin.assistant.welcome")}</p>
            <p className="max-w-md text-sm text-ink-faint">{t("admin.assistant.disclaimer")}</p>
          </div>
        )}

        <Card className="p-3 sm:p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
            className="flex flex-col gap-3"
          >
            <label htmlFor="lulua-assistant-input" className="sr-only">
              {t("admin.assistant.inputLabel")}
            </label>
            <textarea
              id="lulua-assistant-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={t("admin.assistant.inputPlaceholder")}
              disabled={loading}
              rows={3}
              className="w-full resize-none border-0 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint disabled:opacity-60 sm:text-lg"
            />
            <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
              <AdminButton type="submit" variant="primary" disabled={loading || !input.trim()} icon={dir === "rtl" ? "chevronLeft" : "chevronRight"}>
                {t("admin.assistant.send")}
              </AdminButton>
            </div>
          </form>
        </Card>

        {messages.length === 0 && (
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-faint">{t("admin.assistant.examplesTitle")}</p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_KEYS.map((key) => (
                <button
                  key={key}
                  onClick={() => ask(t(key))}
                  className="rounded-full border border-line bg-cream-dim px-3.5 py-2 text-sm font-semibold text-ink hover:border-blue-400 hover:text-blue-700"
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.length > 0 && (
          <div className="flex flex-col gap-5 pb-8">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <p key={i} className="text-base font-semibold text-ink">
                  {m.text}
                </p>
              ) : (
                <AssistantResult key={i} answer={m.answer} t={t} lang={lang} onPick={ask} />
              )
            )}
            {loading && (
              <div className="flex items-center gap-2 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-ink-faint">
                <Spinner className="h-4 w-4" />
                {t("admin.assistant.loading")}
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>
    </motion.div>
  );
}

function AssistantResult({
  answer,
  t,
  lang,
  onPick,
}: {
  answer: AssistantAnswer;
  t: (key: string) => string;
  lang: Lang;
  onPick: (text: string) => void;
}) {
  const text = formatAssistantAnswer(answer, t, lang);
  return (
    <div className="rounded-xl border border-line bg-paper p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-blue-600">
        <AdminIcon name="sparkle" className="h-3.5 w-3.5" />
        لؤلؤة AI
      </div>
      <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{text}</p>
      {answer.kind === "clarification" && answer.clarificationOptions && answer.clarificationOptions.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {answer.clarificationOptions.map((opt) => (
            <button
              key={opt}
              onClick={() => onPick(opt)}
              className="rounded-full border border-line bg-cream-dim px-2.5 py-1 text-xs font-semibold text-blue-700 hover:border-blue-400"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
