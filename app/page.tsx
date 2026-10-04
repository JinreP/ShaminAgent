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
  type BuyerReceipt,
} from "@/lib/buyer-types";

type Goal = z.infer<typeof buyerGoalSchema>;

// Санал дээр token заавал байна.
// Хадгалсан receipt дээр token шаардлагагүй.
const quoteSchema = buyerQuoteSchema.extend({
  token: z.string().min(1),
});

const quotesResponseSchema = z.object({
  quotes: z.array(quoteSchema),
});

const negotiationResponseSchema = z.object({
  quote: quoteSchema,
  message: z.string(),
});

const confirmResponseSchema = z.object({
  receipt: buyerReceiptSchema,
});

const parseResponseSchema = z.object({
  result: repairReportSchema,
  reportId: z.string().optional(),
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

export default function Home() {
  const [report, setReport] = useState("");
  const [goal, setGoal] = useState<Goal>({ ...initialGoal });
  const [step, setStep] = useState(1);

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [selected, setSelected] = useState<Quote | null>(null);

  const [target, setTarget] = useState(0);
  const [approved, setApproved] = useState(false);

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [history, setHistory] = useState<Receipt[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");

  const lock = useRef(false);

  // History хүсэлт session cookie үүсгэнэ.
  // Дуусах хүртэл шинэ API үйлдлүүдийг түр хүлээлгэнэ.
  const disabled = busy || historyLoading;

  useEffect(() => {
    const controller = new AbortController();

    async function loadHistory() {
      try {
        const raw = await requestJson("/api/buyer/history", {
          signal: controller.signal,
        });

        const parsed = buyerHistorySchema.safeParse(raw);

        if (!parsed.success) {
          throw new Error("Захиалгын түүхийн формат буруу байна.");
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
      } finally {
        if (!controller.signal.aborted) {
          setHistoryLoading(false);
        }
      }
    }

    void loadHistory();

    return () => controller.abort();
  }, []);

  function log(text: string) {
    setEvents((old) => [...old, text]);
  }

  async function run(work: () => Promise<void>) {
    if (lock.current || historyLoading) return;

    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");

    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Алдаа гарлаа.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function clearRequestResults() {
    setQuotes([]);
    setSelected(null);
    setReceipt(null);
    setApproved(false);
    setTarget(0);
  }

  function newRequest() {
    if (disabled) return;

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

    // Нөхцөл өөрчлөгдвөл өмнөх санал хүчингүй.
    clearRequestResults();
    setError("");
    setMessage("");
  }

  function enterManually() {
    if (disabled || !report.trim()) return;

    setGoal({ ...initialGoal });
    clearRequestResults();
    setWarnings([]);
    setError("");
    setMessage(
      "Тайлангаа хараад мэдээлэл, төсөв, хугацаагаа гараар бөглөөрэй.",
    );

    log("Хэрэглэгч хүсэлтээ гараар бөглөхөөр сонгосон.");
    setStep(2);
  }

  async function parseReport() {
    const text = report.trim();

    if (text.length < 10 || text.length > 12000) {
      throw new Error("Тайлангийн текст 10–12,000 тэмдэгт байна.");
    }

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

    const { result, reportId } = parsed.data;

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

    log(
      reportId
        ? "AI тайланг уншсан. Тайлан MongoDB-д хадгалагдсан."
        : "AI тайлангаас мэдээллийг гаргасан.",
    );

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

    const raw = await api("quotes", {
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

    setQuotes(parsed.data.quotes);
    setSelected(null);
    setReceipt(null);
    setApproved(false);

    log("Хүсэлт батлагдсан. Demo merchant саналуудыг авсан.");
    setStep(3);
  }

  async function negotiate() {
    if (!selected) return;

    const current = selected;

    if (!Number.isFinite(target) || target <= 0 || target >= current.total) {
      throw new Error("Зорилтот үнэ 0-ээс их, одоогийн үнээс бага байна.");
    }

    const raw = await api("negotiate", {
      token: current.token,
      target,
    });

    const parsed = negotiationResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("Үнэ тохиролцох хариултын формат буруу.");
    }

    const nextQuote = parsed.data.quote;

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
    if (!selected || !approved) {
      throw new Error("Эцсийн үнийг зөвшөөрнө үү.");
    }

    const raw = await api("confirm", {
      token: selected.token,
      approved: true,
      approvedTotal: selected.total,
    });

    const parsed = confirmResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error("Баримтын формат буруу байна.");
    }

    const savedReceipt = parsed.data.receipt;

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

  function selectQuote(quote: Quote) {
    setSelected(quote);
    setReceipt(null);

    setTarget(Math.max(1, Math.min(goal.budget, quote.total - 10000)));

    setApproved(false);
    setMessage("");
    setError("");
    setStep(4);
  }

  const targetValid =
    selected !== null &&
    Number.isFinite(target) &&
    target > 0 &&
    target < selected.total;

  return (
    <div className="shell">
      <aside>
        <Link className="brand" href="/">
          Zah<span>Agent</span>
        </Link>

        <p>Auto Repair &amp; Parts</p>

        <button onClick={newRequest} disabled={disabled}>
          ＋ Шинэ хүсэлт
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
            onClick={() => {
              setReceipt(item);
              setStep(5);
              setError("");
              setMessage("");
            }}
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
          Тайлангийн текстийг Gemini боловсруулна. Merchant саналууд demo
          өгөгдөлтэй. Бодит захиалга, booking болон төлбөр холбогдоогүй.
        </p>

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

        {/* 1. Тайлан */}
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

                  // Ижил файлыг дахин сонгох боломжтой.
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

                    if (text.trim().length > 12000) {
                      throw new Error(
                        "Тайлангийн текст 12,000 тэмдэгтээс бага байна.",
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
                onClick={enterManually}
              >
                Гараар бөглөх
              </button>

              <button
                disabled={
                  disabled ||
                  report.trim().length < 10 ||
                  report.trim().length > 12000
                }
                onClick={() => void run(parseReport)}
              >
                AI-аар мэдээлэл гаргах →
              </button>
            </div>
          </section>
        )}

        {/* 2. Засварын хүсэлт */}
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
                disabled={disabled || !goalValid}
                onClick={() => void run(getQuotes)}
              >
                Батлаад санал авах →
              </button>
            </div>
          </section>
        )}

        {/* 3. Санал харьцуулах */}
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

                    <button
                      disabled={disabled}
                      onClick={() => selectQuote(quote)}
                    >
                      Багц сонгох
                    </button>
                  </section>
                ))}
            </div>

            <button
              className="secondary"
              disabled={disabled}
              onClick={() => {
                setStep(2);
                setError("");
                setMessage("");
              }}
            >
              Нөхцөлөө өөрчлөх
            </button>
          </>
        )}

        {/* 4. Үнэ тохирох, батлах */}
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
              Баталгаа: {selected.warranty}. Demo merchant гаднын сэлбэг хүлээн
              авна.
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

            {selected.revision === 1 && (
              <div className="negotiate">
                <label>
                  Тохиролцох зорилтот үнэ
                  <input
                    disabled={disabled}
                    type="number"
                    min="1"
                    value={target === 0 ? "" : target}
                    onChange={(event) => setTarget(Number(event.target.value))}
                  />
                </label>

                <button
                  disabled={disabled || !targetValid}
                  onClick={() => void run(negotiate)}
                >
                  Үнэ тохиролцох
                </button>
              </div>
            )}

            <label className="approval">
              <input
                type="checkbox"
                disabled={disabled}
                checked={approved}
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
                disabled={disabled || !approved}
                onClick={() => void run(confirm)}
              >
                Confirm — Demo захиалах
              </button>
            </div>
          </section>
        )}

        {/* 5. Баримт */}
        {step === 5 && receipt && (
          <section>
            <span className="tag green">DEMO COMPLETED</span>

            <h2>Туршилтын баримт бэлэн боллоо</h2>

            <p>Энэ нь бодит резерв, booking эсвэл төлбөр биш.</p>

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
                <dt>Засварын хугацаа</dt>
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
