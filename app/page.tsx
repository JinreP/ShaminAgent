"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { repairReportSchema } from "@/lib/repair-report";
import {
  buyerGoalSchema,
  buyerQuoteSchema,
  buyerReceiptSchema,
  buyerHistorySchema,
  buyerCheckoutSchema,
  savedRequestsResponseSchema,
  savedRequestResponseSchema,
  type BuyerReceipt,
  type SavedRequestSummary,
} from "@/lib/buyer-types";

type Goal = z.infer<typeof buyerGoalSchema>;

const quoteSchema = buyerQuoteSchema.extend({
  token: z.string().uuid(),
});

const quotesResponseSchema = z.object({
  issues: z.array(z.string()).optional(),
  quotes: z.array(quoteSchema),
});

const negotiationResponseSchema = z.object({
  quote: quoteSchema,
  message: z.string(),
  pending: z.boolean().optional(),
});

const confirmResponseSchema = z.object({
  receipt: buyerReceiptSchema.optional(),
  checkout: buyerCheckoutSchema.optional(),
  message: z.string().optional(),
}).refine(value => Boolean(value.receipt) !== Boolean(value.checkout));

const parseResponseSchema = z.object({
  result: repairReportSchema,
  requestId: z.string().uuid(),
});

const draftResponseSchema = z.object({
  requestId: z.string().uuid(),
});

type Quote = z.infer<typeof quoteSchema>;
type Receipt = BuyerReceipt;

const sampleReport = [
  "Toyota Prius 30 автомашины оношилгооны тайлан.",
  "",
  "Урд бампер хагарсан.",
  "Зүүн урд гэрлийн их бие гэмтсэн.",
  "",
  "Урд бампер болон зүүн урд гэрлийг солих шаардлагатай.",
  "Шинэ бамперийг машины өнгөөр будах шаардлагатай.",
].join("\n");

const initialGoal: Goal = {
  vehicle: "",
  parts: "",
  tasks: "",
  budget: 0,
  days: 0,
  preference: "Any",
};

const requestStatusLabels = {
  draft: "Мэдээлэл батлах",
  quoted: "Санал авсан",
  completed: "Дууссан",
} as const;

function money(value: number) {
  return new Intl.NumberFormat("mn-MN").format(value) + "₮";
}

function errorMessage(value: unknown, fallback: string) {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }

  return fallback;
}

async function requestJson(
  url: string,
  options?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
  });

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new Error("Серверээс JSON хариулт ирсэнгүй. API route-аа шалгаарай.");
  }

  if (!response.ok) {
    throw new Error(errorMessage(data, `Серверийн алдаа: ${response.status}`));
  }

  return data;
}

function api(action: string, payload: Record<string, unknown>) {
  return requestJson("/api/buyer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action,
      ...payload,
    }),
  });
}
function readCurrentTime(): number {
  return Date.now();
}

export default function Home() {
  const [report, setReport] = useState("");
  const [goal, setGoal] = useState<Goal>({ ...initialGoal });
  const [step, setStep] = useState(1);
  const [requestId, setRequestId] = useState<string | null>(null);

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [selected, setSelected] = useState<Quote | null>(null);
  const [expiredTokens, setExpiredTokens] = useState<string[]>([]);

  const [target, setTarget] = useState(0);
  const [approved, setApproved] = useState(false);
  const [checkout, setCheckout] = useState<z.infer<typeof buyerCheckoutSchema> | null>(null);
  const [pendingTarget, setPendingTarget] = useState<number | null>(null);

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [history, setHistory] = useState<Receipt[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");

  const [savedRequests, setSavedRequests] = useState<SavedRequestSummary[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState("");

  const [events, setEvents] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const lock = useRef(false);
  const disabled = busy || historyLoading || requestsLoading;

  useEffect(() => {
    const controller = new AbortController();

    async function loadWorkspace() {
      // Session cookie үүсгэх эхний хүсэлтийн дараа
      // хадгалсан хүсэлтүүдийг дарааллаар уншина.
      try {
        const raw = await requestJson("/api/buyer/history", {
          signal: controller.signal,
        });

        const parsed = buyerHistorySchema.safeParse(raw);

        if (!parsed.success) {
          throw new Error("Захиалгын түүхийн формат буруу.");
        }

        if (!controller.signal.aborted) {
          setHistory(parsed.data.history);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setHistoryError(
            error instanceof Error
              ? error.message
              : "Захиалгын түүхийг уншиж чадсангүй.",
          );
        }
      }

      if (controller.signal.aborted) return;

      try {
        const raw = await requestJson("/api/buyer/requests", {
          signal: controller.signal,
        });

        const parsed = savedRequestsResponseSchema.safeParse(raw);

        if (!parsed.success) {
          throw new Error("Хүсэлтүүдийн жагсаалтын формат буруу.");
        }

        if (!controller.signal.aborted) {
          setSavedRequests(parsed.data.requests);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setRequestsError(
            error instanceof Error
              ? error.message
              : "Хүсэлтүүдийг уншиж чадсангүй.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setHistoryLoading(false);
          setRequestsLoading(false);
        }
      }
    }

    void loadWorkspace();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const active = quotes.filter(
      (quote) => !expiredTokens.includes(quote.token),
    );

    if (active.length === 0) return;

    const nextExpiry = Math.min(...active.map((quote) => quote.expiresAt));

    const timer = window.setTimeout(
      () => {
        const now = readCurrentTime();
        setExpiredTokens(
          quotes
            .filter((quote) => quote.expiresAt <= now)
            .map((quote) => quote.token),
        );
      },
      Math.min(Math.max(0, nextExpiry - readCurrentTime()), 2_147_483_647),
    );

    return () => window.clearTimeout(timer);
  }, [quotes, expiredTokens]);

  function log(text: string) {
    setEvents((old) => [...old, text]);
  }

  async function refreshRequestList() {
    try {
      const raw = await requestJson("/api/buyer/requests");
      const parsed = savedRequestsResponseSchema.safeParse(raw);

      if (!parsed.success) {
        throw new Error("Хүсэлтүүдийн жагсаалтын формат буруу.");
      }

      setSavedRequests(parsed.data.requests);
      setRequestsError("");
    } catch (error) {
      setRequestsError(
        error instanceof Error
          ? error.message
          : "Хүсэлтүүдийг шинэчилж чадсангүй.",
      );
    }
  }

  async function run(work: () => Promise<void>, refreshRequests = false) {
    if (lock.current || historyLoading || requestsLoading) return;

    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");

    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Алдаа гарлаа.");
    } finally {
      if (refreshRequests) {
        await refreshRequestList();
      }

      lock.current = false;
      setBusy(false);
    }
  }

  function clearRequestResults() {
    setCheckout(null);
    setPendingTarget(null);
    setQuotes([]);
    setSelected(null);
    setExpiredTokens([]);
    setReceipt(null);
    setApproved(false);
    setTarget(0);
  }

  function newRequest() {
    if (disabled) return;

    setRequestId(null);
    setStep(1);
    setReport("");
    setGoal({ ...initialGoal });
    clearRequestResults();
    setWarnings([]);
    setEvents([]);
    setError("");
    setMessage("");
  }

  function changeReport(value: string) {
    setReport(value);
    setRequestId(null);
    setGoal({ ...initialGoal });
    clearRequestResults();
    setWarnings([]);
    setEvents([]);
    setError("");
    setMessage("");
  }

  function edit<K extends keyof Goal>(key: K, value: Goal[K]) {
    setGoal((old) => ({
      ...old,
      [key]: value,
    }));

    clearRequestResults();
    setError("");
    setMessage("");
  }

  async function enterManually() {
    const text = report.trim();

    if (!text || text.length > 12000) {
      throw new Error("Тайлангийн текст 1–12,000 тэмдэгт байна.");
    }

    setRequestId(null);
    setGoal({ ...initialGoal });
    clearRequestResults();
    setWarnings([]);

    const raw = await api("draft", {
      report: text,
    });

    const parsed = draftResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("Хүсэлт үүсгэх хариултын формат буруу.");
    }

    setRequestId(parsed.data.requestId);
    setMessage(
      "Тайлангаа хараад мэдээлэл, төсөв, хугацаагаа гараар бөглөөрэй.",
    );

    log(`Гараар бөглөх хүсэлт үүссэн: ${parsed.data.requestId}`);
    setStep(2);
  }

  async function parseReport() {
    const text = report.trim();

    if (text.length < 10 || text.length > 12000) {
      throw new Error("Тайлангийн текст 10–12,000 тэмдэгт байна.");
    }

    setRequestId(null);
    setGoal({ ...initialGoal });
    clearRequestResults();
    setWarnings([]);

    const raw = await requestJson("/api/buyer/parse-report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        report: text,
      }),
    });

    const parsed = parseResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("AI-ийн мэдээллийн формат буруу байна.");
    }

    const { result, requestId: savedRequestId } = parsed.data;

    setRequestId(savedRequestId);
    setGoal({
      ...initialGoal,
      vehicle: result.vehicle,
      parts: result.parts,
      tasks: result.tasks,
    });
    setWarnings(result.warnings);

    setMessage(
      "AI-ийн гаргасан мэдээллийг шалгаад төсөв, хугацаагаа оруулаарай.",
    );

    log(`AI тайлан хадгалагдсан. Хүсэлт: ${savedRequestId}`);
    setStep(2);
  }

  const goalValid =
    Boolean(goal.vehicle.trim()) &&
    Boolean(goal.parts.trim()) &&
    Boolean(goal.tasks.trim()) &&
    Number.isFinite(goal.budget) &&
    goal.budget > 0 &&
    Number.isInteger(goal.days) &&
    goal.days >= 1 &&
    goal.days <= 30 &&
    ["Any", "OEM", "Aftermarket", "Used"].includes(goal.preference);

  async function getQuotes() {
    if (!goalValid) {
      throw new Error(
        "Машин, сэлбэг, засварын ажил, төсөв, хугацаагаа бөглөөрэй.",
      );
    }

    if (!requestId) {
      throw new Error(
        "Хүсэлт үүсээгүй байна. Тайлангаа дахин боловсруулаарай.",
      );
    }

    const raw = await api("quotes", {
      requestId,
      goal: {
        ...goal,
        vehicle: goal.vehicle.trim(),
        parts: goal.parts.trim(),
        tasks: goal.tasks.trim(),
      },
    });

    const parsed = quotesResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("Merchant саналын формат буруу байна.");
    }

    setExpiredTokens([]);
    setCheckout(null);
    setPendingTarget(null);
    setQuotes(parsed.data.quotes);
    setSelected(null);
    setReceipt(null);
    setApproved(false);
    setTarget(0);

    setMessage(parsed.data.issues?.join("\n") ?? "Merchant саналуудыг авлаа.");
    log("Хүсэлт батлагдсан. Merchant A2A саналуудыг авсан.");
    setStep(3);
  }

  async function reloadRequestQuotes() {
    await getQuotes();
    setMessage("Шинэ саналуудыг авлаа.");
  }
  function assertActiveQuote(quote: Quote) {
    if (quote.expiresAt <= readCurrentTime()) {
      setExpiredTokens((old) => [...new Set([...old, quote.token])]);
      setApproved(false);

      throw new Error("Саналын хугацаа дууссан. Дахин санал аваарай.");
    }
  }

  function selectQuote(quote: Quote) {
    if (disabled) return;

    try {
      assertActiveQuote(quote);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Саналыг сонгож чадсангүй.",
      );
      return;
    }

    setSelected(quote);
    setReceipt(null);
    setTarget(Math.max(1, Math.min(goal.budget, quote.total - 10000)));
    setApproved(false);
    setMessage("");
    setError("");
    setStep(4);
  }

  const selectedExpired =
    selected !== null && expiredTokens.includes(selected.token);

  const targetValid =
    selected !== null &&
    (!selectedExpired || pendingTarget !== null) &&
    Number.isFinite(target) &&
    target > 0 &&
    target < selected.total;

  async function negotiate() {
    if (!selected) {
      throw new Error("Багцаа сонгоорой.");
    }

    if (!requestId) {
      throw new Error("Хүсэлтийн дугаар олдсонгүй.");
    }

    const current = selected;

    if (pendingTarget === null) assertActiveQuote(current);

    if (current.revision !== 1) {
      throw new Error("Demo дээр нэг удаа үнэ тохиролцоно.");
    }

    if (!Number.isFinite(target) || target <= 0 || target >= current.total) {
      throw new Error("Зорилтот үнэ 0-ээс их, одоогийн үнээс бага байна.");
    }

    const raw = await api("negotiate", {
      requestId,
      token: current.token,
      target,
    });

    const parsed = negotiationResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("Үнэ тохиролцох хариултын формат буруу.");
    }

    const nextQuote = parsed.data.quote;

    setPendingTarget(parsed.data.pending ? target : null);
    setSelected(nextQuote);
    setQuotes((old) =>
      old.map((quote) => (quote.id === nextQuote.id ? nextQuote : quote)),
    );
    setApproved(false);
    setMessage(parsed.data.message);

    log(
      `Demo negotiation: ${money(current.total)} → ${money(nextQuote.total)}`,
    );
  }

  async function confirm() {
    if (!selected || (!checkout && !approved)) {
      throw new Error("Эцсийн үнийг зөвшөөрнө үү.");
    }

    if (!requestId) {
      throw new Error("Хүсэлтийн дугаар олдсонгүй.");
    }

    if (!checkout) assertActiveQuote(selected);

    const raw = await api("confirm", {
      requestId,
      token: selected.token,
      approved: true,
      approvedTotal: selected.total,
    });

    const parsed = confirmResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("Баримтын формат буруу байна.");
    }

    if (parsed.data.checkout) {
      setCheckout(parsed.data.checkout);
      setMessage(parsed.data.message ?? "Зөвшөөрлийн хуудсыг нээж батлаарай.");
      log("Merchant зөвшөөрөл хүлээж байна.");
      return;
    }
    const savedReceipt = parsed.data.receipt;
    if (!savedReceipt) throw new Error("Merchant баримт ирсэнгүй.");
    setCheckout(null);

    setReceipt(savedReceipt);
    setHistory((old) =>
      [
        savedReceipt,
        ...old.filter((item) => item.id !== savedReceipt.id),
      ].slice(0, 20),
    );

    log("Хэрэглэгч зөвшөөрсөн. Demo баримт хүлээн авсан.");
    setStep(5);
  }

  async function refreshHistory() {
    const raw = await requestJson("/api/buyer/history");
    const parsed = buyerHistorySchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("Захиалгын түүхийн формат буруу.");
    }

    setHistory(parsed.data.history);
    setHistoryError("");
    setMessage("Захиалгын түүх шинэчлэгдлээ.");
  }

  function openReceipt(item: Receipt) {
    if (disabled) return;

    const matchingRequest = savedRequests.find(
      (request) => request.id.toUpperCase() === item.id.toUpperCase(),
    );

    clearRequestResults();
    setRequestId(matchingRequest?.id ?? null);
    setGoal({ ...item.quote.goal });
    setReport("");
    setWarnings([]);
    setEvents([]);
    setReceipt(item);
    setError("");
    setMessage("");
    setStep(5);
  }

  async function resumeRequest(id: string) {
    const raw = await requestJson(
      `/api/buyer/requests?id=${encodeURIComponent(id)}`,
    );

    const parsed = savedRequestResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("Хадгалсан хүсэлтийн формат буруу.");
    }

    const saved = parsed.data.request;

    if (saved.status === "completed" && !saved.receipt) {
      throw new Error("Дууссан хүсэлтийн баримт олдсонгүй.");
    }

    const restoredGoal: Goal = saved.goal
      ? { ...saved.goal }
      : {
          ...initialGoal,
          vehicle: saved.extracted?.vehicle ?? "",
          parts: saved.extracted?.parts ?? "",
          tasks: saved.extracted?.tasks ?? "",
        };

    const now = readCurrentTime();

    const expired = saved.quotes
      .filter((quote) => quote.expiresAt <= now)
      .map((quote) => quote.token);

    setCheckout(saved.checkout ?? null);
    setPendingTarget(saved.pendingTarget ?? null);
    setRequestId(saved.id);
    setReport(saved.report);
    setGoal(restoredGoal);
    setQuotes(saved.quotes);
    setSelected(null);
    setReceipt(null);
    setApproved(false);
    setTarget(0);
    setWarnings(saved.extracted?.warnings ?? []);
    setExpiredTokens(expired);
    setEvents([]);
    setError("");

    if (saved.status === "completed" && saved.receipt) {
      setReceipt(saved.receipt);
      setStep(5);
      setMessage("Хадгалсан баримтыг нээлээ.");
    } else if (saved.status === "quoted") {
      const selectedQuote = saved.selectedQuote;

      if (
        selectedQuote &&
        (selectedQuote.expiresAt > now || saved.checkout || saved.pendingTarget !== undefined) &&
        saved.quotes.some((quote) => quote.token === selectedQuote.token)
      ) {
        setSelected(selectedQuote);
        setTarget(
          Math.max(
            1,
            saved.pendingTarget ?? Math.min(restoredGoal.budget, selectedQuote.total - 10000),
          ),
        );
        setStep(4);
        setMessage(
          "Хадгалсан багцыг нээлээ. Хэлэлцээ эсвэл зөвшөөрлийн төлөвөө шалгаад үргэлжлүүлээрэй.",
        );
      } else {
        setStep(3);

        const hasActiveQuote = saved.quotes.some(
          (quote) => quote.expiresAt > now,
        );

        setMessage(
          hasActiveQuote
            ? "Хадгалсан саналуудыг нээлээ."
            : "Саналуудын хугацаа дууссан. Дахин санал аваарай.",
        );
      }
    } else {
      setStep(2);
      setMessage(
        "Хадгалсан тайланг нээлээ. Мэдээлэл, төсөв, хугацаагаа батлаарай.",
      );
    }

    log("Хадгалсан хүсэлтийг нээсэн.");
  }

  return (
    <div className="shell">
      <aside>
        <Link className="brand" href="/">
          Zah<span>Agent</span>
        </Link>

        <p>Auto Repair & Parts</p>

        <button onClick={newRequest} disabled={disabled}>
          ＋ Шинэ хүсэлт
        </button>

        <h3>Хадгалсан хүсэлтүүд</h3>

        {requestsLoading && <p role="status">Хүсэлтүүд ачаалж байна…</p>}

        {requestsError && <p role="alert">{requestsError}</p>}

        {!requestsLoading && !requestsError && savedRequests.length === 0 && (
          <p>Хадгалсан хүсэлт байхгүй.</p>
        )}

        {savedRequests.map((item) => (
          <button
            className="history"
            key={item.id}
            disabled={disabled}
            aria-pressed={requestId === item.id}
            onClick={() => void run(() => resumeRequest(item.id))}
          >
            {item.vehicle}
            <small>
              {requestStatusLabels[item.status]}
              {item.budget > 0 ? ` · ${money(item.budget)}` : ""}
            </small>
            <small>{item.id.slice(0, 8)}</small>
          </button>
        ))}

        <button
          className="history"
          disabled={disabled}
          onClick={() => void run(refreshRequestList)}
        >
          Хүсэлтүүд шинэчлэх
        </button>

        <h3>Захиалгын түүх</h3>

        {historyLoading && <p role="status">Түүх ачаалж байна…</p>}

        {historyError && <p role="alert">{historyError}</p>}

        {!historyLoading && !historyError && history.length === 0 && (
          <p>Захиалга байхгүй.</p>
        )}

        {history.map((item) => (
          <button
            className="history"
            key={item.id}
            disabled={disabled}
            onClick={() => openReceipt(item)}
          >
            {item.id}
            <small>{money(item.quote.total)} · Demo</small>
          </button>
        ))}

        <button
          className="history"
          disabled={disabled}
          onClick={() => void run(refreshHistory)}
        >
          Түүх шинэчлэх
        </button>

        <div className="aside-note">
          Buyer workspace
          <br />
          One goal. Coordinated merchants.
        </div>
      </aside>

      <main>
        <header>
          <div>
            <small>BUYER WORKSPACE</small>
            <h1>
              Машинаа засуулах ажлыг
              <br />
              нэг хүсэлтээр зохицуул.
            </h1>
          </div>
          <span className="badge">DEMO COMMERCE</span>
        </header>

        <p className="notice">
          Тайланг Gemini боловсруулна. Buyer нь Merchant агентуудаас A2A-аар санал авч, MCP-аар туршилтын захиалга, засварын цаг бүртгэнэ. Төлбөр mock хэвээр.
        </p>

        {requestId && (
          <p>
            Хүсэлтийн дугаар: <strong>{requestId}</strong>
          </p>
        )}

        <nav aria-label="Хүсэлтийн үе шат">
          {["Тайлан", "Хүсэлт", "Саналууд", "Батлах", "Баримт"].map(
            (label, index) => (
              <span
                className={step >= index + 1 ? "active" : ""}
                aria-current={step === index + 1 ? "step" : undefined}
                key={label}
              >
                {index + 1}. {label}
              </span>
            ),
          )}
        </nav>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {message && (
          <div className="success" role="status">
            {message}
          </div>
        )}

        {busy && <p role="status">Хүсэлт боловсруулж байна…</p>}

        {step === 1 && (
          <section>
            <h2>Даатгалын үнэлгээ / оношилгооны тайлан</h2>

            <p>
              Тайлангийн текстээ оруулах эсвэл TXT файл сонгоорой. AI мэдээллийг
              гаргасны дараа та шалгаж батална.
            </p>

            <textarea
              aria-label="Тайлангийн текст"
              value={report}
              disabled={disabled}
              maxLength={12000}
              onChange={(event) => changeReport(event.target.value)}
              placeholder="Оношилгооны тайлангийн текст…"
              rows={7}
            />

            <p>{report.length.toLocaleString()} / 12,000 тэмдэгт</p>

            <label className="upload">
              TXT файл оруулах
              <input
                type="file"
                accept=".txt,text/plain"
                disabled={disabled}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";

                  if (!file) return;

                  void run(async () => {
                    if (!file.name.toLowerCase().endsWith(".txt")) {
                      throw new Error("TXT файл сонгоорой.");
                    }

                    if (file.size > 1024 * 1024) {
                      throw new Error("TXT файл 1MB-аас бага байна.");
                    }

                    const text = await file.text();

                    if (text.length > 12000) {
                      throw new Error(
                        "Тайлангийн текст 12,000 тэмдэгтээс ихгүй байна.",
                      );
                    }

                    changeReport(text);
                  });
                }}
              />
            </label>

            <div className="actions">
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => changeReport(sampleReport)}
              >
                Demo тайлан ашиглах
              </button>

              <button
                className="secondary"
                disabled={disabled || !report.trim()}
                onClick={() => void run(enterManually, true)}
              >
                Гараар бөглөх
              </button>

              <button
                disabled={
                  disabled ||
                  report.trim().length < 10 ||
                  report.trim().length > 12000
                }
                onClick={() => void run(parseReport, true)}
              >
                AI-аар мэдээлэл гаргах →
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h2>Засварын хүсэлтээ батлаарай</h2>

            <p>
              Машин, сэлбэг, хийх ажлыг тайлантайгаа тулгаж шалгаарай. Хоосон
              талбарыг бөглөж, төсөв болон хүссэн хугацаагаа оруулна уу.
            </p>

            {warnings.length > 0 && (
              <div className="notice">
                <strong>Шалгах мэдээлэл</strong>
                <ul>
                  {warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <details>
              <summary>Оруулсан тайлан</summary>
              <p className="report">{report}</p>
            </details>

            <div className="grid">
              <label>
                Машин
                <input
                  disabled={disabled}
                  value={goal.vehicle}
                  maxLength={200}
                  placeholder="Жишээ: Toyota Prius 30"
                  onChange={(event) => edit("vehicle", event.target.value)}
                />
              </label>

              <label>
                Төсөв (₮)
                <input
                  disabled={disabled}
                  type="number"
                  min="1"
                  value={goal.budget === 0 ? "" : goal.budget}
                  placeholder="Жишээ: 1500000"
                  onChange={(event) =>
                    edit("budget", Number(event.target.value))
                  }
                />
              </label>

              <label>
                Шаардлагатай сэлбэг
                <input
                  disabled={disabled}
                  value={goal.parts}
                  maxLength={2000}
                  placeholder="Тайланд дурдсан сэлбэгүүд"
                  onChange={(event) => edit("parts", event.target.value)}
                />
              </label>

              <label>
                Хэд хоногийн дотор?
                <input
                  disabled={disabled}
                  type="number"
                  min="1"
                  max="30"
                  step="1"
                  value={goal.days === 0 ? "" : goal.days}
                  placeholder="Жишээ: 3"
                  onChange={(event) => edit("days", Number(event.target.value))}
                />
              </label>

              <label>
                Засварын ажил
                <input
                  disabled={disabled}
                  value={goal.tasks}
                  maxLength={2000}
                  placeholder="Солих, засах, будах зэрэг ажил"
                  onChange={(event) => edit("tasks", event.target.value)}
                />
              </label>

              <label>
                Сэлбэгийн сонголт
                <select
                  disabled={disabled}
                  value={goal.preference}
                  onChange={(event) => edit("preference", event.target.value)}
                >
                  <option value="Any">Бүх төрөл</option>
                  <option value="OEM">OEM</option>
                  <option value="Aftermarket">Aftermarket</option>
                  <option value="Used">Used</option>
                </select>
              </label>
            </div>

            <p className="notice">
              Одоогийн demo merchant зөвхөн Prius 30-ийн урд бампер, зүүн урд
              гэрэл солих болон бампер будах хүсэлтийг дэмжинэ.
            </p>

            <div className="actions">
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => {
                  setStep(1);
                  setError("");
                  setMessage("");
                }}
              >
                Буцах
              </button>

              <button
                disabled={disabled || !goalValid || !requestId}
                onClick={() => void run(getQuotes, true)}
              >
                Батлаад санал авах →
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <>
            <div className="section-heading">
              <h2>Сэлбэг + засварын багцууд</h2>
              <span>Төсөв: {money(goal.budget)}</span>
            </div>

            {quotes.length === 0 && <section>Тохирох санал олдсонгүй.</section>}

            <div className="cards">
              {[...quotes]
                .sort((a, b) => a.total - b.total)
                .map((quote, index) => (
                  <section className="quote" key={quote.id}>
                    <div className="quote-top">
                      <span className="tag">{quote.kind}</span>

                      {index === 0 && (
                        <span className="tag green">Хамгийн хямд</span>
                      )}
                    </div>

                    <h2>{quote.partsMerchant}</h2>
                    <p>Засвар: {quote.repairMerchant}</p>

                    <dl>
                      <div>
                        <dt>{quote.goal.parts}</dt>
                        <dd>{money(quote.parts)}</dd>
                      </div>
                      <div>
                        <dt>{quote.goal.tasks}</dt>
                        <dd>{money(quote.labor)}</dd>
                      </div>
                      <div>
                        <dt>Хугацаа</dt>
                        <dd>{quote.days} хоног</dd>
                      </div>
                      <div>
                        <dt>Баталгаа</dt>
                        <dd>{quote.warranty}</dd>
                      </div>
                    </dl>

                    <strong className="price">{money(quote.total)}</strong>

                    <p
                      className={
                        quote.total <= goal.budget && quote.days <= goal.days
                          ? "fit"
                          : "unfit"
                      }
                    >
                      {quote.total <= goal.budget
                        ? "✓ Төсөвт багтана"
                        : `Төсвөөс ${money(quote.total - goal.budget)} илүү`}
                      <br />
                      {quote.days <= goal.days
                        ? "✓ Хугацаанд багтана"
                        : "Хугацаанаас хэтэрнэ"}
                    </p>

                    {expiredTokens.includes(quote.token) && (
                      <p className="unfit">
                        Саналын хугацаа дууссан. Дахин санал аваарай.
                      </p>
                    )}

                    <button
                      disabled={disabled || expiredTokens.includes(quote.token)}
                      onClick={() => selectQuote(quote)}
                    >
                      Багц сонгох
                    </button>
                  </section>
                ))}
            </div>

            <div className="actions">
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => {
                  setStep(2);
                  setApproved(false);
                  setError("");
                  setMessage("");
                }}
              >
                Нөхцөлөө өөрчлөх
              </button>

              <button
                disabled={disabled || !goalValid || !requestId}
                onClick={() => void run(reloadRequestQuotes, true)}
              >
                Дахин санал авах
              </button>
            </div>
          </>
        )}

        {step === 4 && selected && (
          <section>
            <h2>Сонгосон багц</h2>

            <p>
              {selected.partsMerchant} + {selected.repairMerchant}
            </p>

            <div className="summary">
              <div>
                <small>Нийт үнэ</small>
                <strong>{money(selected.total)}</strong>
              </div>
              <div>
                <small>Хугацаа</small>
                <strong>{selected.days} хоног</strong>
              </div>
              <div>
                <small>Сэлбэг</small>
                <strong>{selected.kind}</strong>
              </div>
            </div>

            <p>
              {selected.goal.vehicle}
              <br />
              {selected.goal.parts} · {selected.goal.tasks}
            </p>

            <p>
              Нөхцөл: {selected.warranty}
            </p>

            <p
              className={
                selected.total <= selected.goal.budget &&
                selected.days <= selected.goal.days
                  ? "fit"
                  : "unfit"
              }
            >
              {selected.total <= selected.goal.budget
                ? "✓ Төсөвт багтана"
                : `Төсвөөс ${money(
                    selected.total - selected.goal.budget,
                  )} илүү`}
              <br />
              {selected.days <= selected.goal.days
                ? "✓ Хугацаанд багтана"
                : "Хүссэн хугацаанаас хэтэрнэ"}
            </p>

            {selectedExpired && !checkout && pendingTarget === null && (
              <p className="unfit">
                Саналын хугацаа дууссан. Дахин санал аваарай.
              </p>
            )}

            <button
              className="secondary"
              disabled={disabled || !goalValid || !requestId || checkout !== null || pendingTarget !== null}
              onClick={() => void run(reloadRequestQuotes, true)}
            >
              Дахин санал авах
            </button>

            {selected.revision === 1 && !checkout && (
              <div className="negotiate">
                <label>
                  Тохиролцох зорилтот үнэ
                  <input
                    disabled={disabled || selectedExpired || pendingTarget !== null}
                    type="number"
                    min="1"
                    value={target === 0 ? "" : target}
                    onChange={(event) => setTarget(Number(event.target.value))}
                  />
                </label>

                <button
                  disabled={disabled || !targetValid}
                  onClick={() => void run(negotiate, true)}
                >
                  {pendingTarget !== null ? "Хэлэлцээний хариу шалгах" : "Үнэ тохиролцох"}
                </button>
              </div>
            )}

            {selected.merchant && (
              <div className="notice">
                <p>Засварын цаг: {selected.merchant.booking.startsAt} → {selected.merchant.booking.endsAt}</p>
                <details><summary>Сэлбэг, засварын нөхцөл</summary>
                  <p className="report">{selected.merchant.parts.quote.terms}</p>
                  <p className="report">{selected.merchant.repair.quote.terms}</p>
                </details>
              </div>
            )}
            {checkout && (
              <div className="notice">
                <p>Захиалгын дугаар: {checkout.transactionId}</p>
                <p>Merchant хуудсыг нээж Зөвшөөрөх товчийг дарсны дараа энд үргэлжлүүлнэ.</p>
                {checkout.approvalUrl && (
                  <a className="secondary" href={checkout.approvalUrl} target="_blank" rel="noopener noreferrer">
                    Merchant зөвшөөрлийн хуудас нээх ↗
                  </a>
                )}
              </div>
            )}
            <label className="approval">
              <input
                type="checkbox"
                disabled={disabled || (selectedExpired && !checkout) || pendingTarget !== null}
                checked={approved && (!selectedExpired || checkout !== null)}
                onChange={(event) => setApproved(event.target.checked)}
              />
              {money(selected.total)} үнэтэй, {selected.days} хоногийн
              хугацаатай энэ багцын demo захиалга, booking, mock төлбөрийг
              зөвшөөрч байна.
            </label>

            <div className="actions">
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => {
                  setStep(3);
                  setApproved(false);
                  setMessage("");
                  setError("");
                }}
              >
                Буцах
              </button>

              <button
                disabled={disabled || pendingTarget !== null || (!checkout && (!approved || selectedExpired))}
                onClick={() => void run(confirm, true)}
              >
                {checkout ? "Зөвшөөрөл шалгаад захиалга үргэлжлүүлэх" : "Confirm — Зөвшөөрлийн холбоос авах"}
              </button>
            </div>
          </section>
        )}

        {step === 5 && receipt && (
          <section>
            <span className="tag green">DEMO COMPLETED</span>
            <h2>Туршилтын баримт бэлэн боллоо</h2>
            <p>{receipt.source === "merchant" ? "Merchant MongoDB-д туршилтын захиалга, booking бүртгэгдсэн. Төлбөр нь mock." : "Хуучин demo баримт. Merchant захиалгатай холбогдоогүй."}</p>

            <strong className="price">{money(receipt.quote.total)}</strong>

            <dl>
              <div>
                <dt>Баримтын дугаар</dt>
                <dd>{receipt.id}</dd>
              </div>
              <div>
                <dt>Машин</dt>
                <dd>{receipt.quote.goal.vehicle}</dd>
              </div>
              <div>
                <dt>Сэлбэг</dt>
                <dd>{receipt.quote.goal.parts}</dd>
              </div>
              <div>
                <dt>Засварын ажил</dt>
                <dd>{receipt.quote.goal.tasks}</dd>
              </div>
              <div>
                <dt>Сэлбэгийн дэлгүүр</dt>
                <dd>{receipt.quote.partsMerchant}</dd>
              </div>
              <div>
                <dt>Засварын газар</dt>
                <dd>{receipt.quote.repairMerchant}</dd>
              </div>
              <div>
                <dt>Захиалга</dt>
                <dd>{receipt.orderId}</dd>
              </div>
              <div>
                <dt>Booking</dt>
                <dd>{receipt.bookingId}</dd>
              </div>
              <div>
                <dt>Mock payment</dt>
                <dd>{receipt.paymentId}</dd>
              </div>
              <div>
                <dt>Хугацаа</dt>
                <dd>{receipt.quote.days} хоног</dd>
              </div>
              <div>
                <dt>Баталгаа</dt>
                <dd>{receipt.quote.warranty}</dd>
              </div>
            </dl>

            <button disabled={disabled} onClick={newRequest}>
              Шинэ хүсэлт үүсгэх
            </button>
          </section>
        )}

        {events.length > 0 && (
          <section className="timeline">
            <h3>Үйлдлийн явц</h3>
            <ol>
              {events.map((event, index) => (
                <li key={index}>{event}</li>
              ))}
            </ol>
          </section>
        )}
      </main>
    </div>
  );
}
