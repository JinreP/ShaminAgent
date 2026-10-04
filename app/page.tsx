"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Goal = {
  vehicle: string;
  parts: string;
  tasks: string;
  budget: number;
  days: number;
  preference: string;
};

type Quote = {
  id: string;
  partsMerchant: string;
  repairMerchant: string;
  kind: string;
  parts: number;
  labor: number;
  total: number;
  days: number;
  warranty: string;
  token: string;
  revision: number;
  expiresAt: number;
  goal: Goal;
};

type Receipt = {
  id: string;
  orderId: string;
  bookingId: string;
  paymentId: string;
  quote: Quote;
  mode: string;
  status: string;
};

const sampleReport =
  "Toyota Prius 30. Урд бампер, зүүн урд гэрэл гэмтсэн. " +
  "Сэлбэг солих, бампер будах шаардлагатай.";

const initialGoal: Goal = {
  vehicle: "Toyota Prius 30",
  parts: "Урд бампер, зүүн урд гэрэл",
  tasks: "Солих, бампер будах",
  budget: 1500000,
  days: 3,
  preference: "Any",
};

const storageKey = "zahagent-buyer-demo-history-v1";

function money(value: number) {
  return new Intl.NumberFormat("mn-MN").format(value) + "₮";
}

async function api(action: string, payload: object) {
  const response = await fetch("/api/buyer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action,
      ...payload,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Серверийн алдаа.");
  }

  return data;
}

export default function Home() {
  const [report, setReport] = useState("");
  const [goal, setGoal] = useState<Goal>(initialGoal);
  const [step, setStep] = useState(1);

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [selected, setSelected] = useState<Quote | null>(null);

  const [target, setTarget] = useState(1480000);
  const [approved, setApproved] = useState(false);

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [history, setHistory] = useState<Receipt[]>([]);
  const [events, setEvents] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const lock = useRef(false);

  useEffect(() => {
    let cancelled = false;

    // Browser storage-ийн түүхийг mount-ийн дараа ачаална.
    queueMicrotask(() => {
      if (cancelled) return;

      try {
        const saved: unknown = JSON.parse(
          localStorage.getItem(storageKey) || "[]",
        );

        if (Array.isArray(saved)) {
          setHistory(saved as Receipt[]);
        }
      } catch {
        // History-ийн анхны утга [] тул дахин setState хийхгүй.
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  function log(text: string) {
    setEvents((old) => [...old, text]);
  }

  // Loading, алдаа, давхар даралтыг нэг газраас удирдана.
  async function run(work: () => Promise<void>) {
    if (lock.current) return;

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

  function newRequest() {
    setStep(1);
    setReport("");
    setGoal(initialGoal);
    setQuotes([]);
    setSelected(null);
    setReceipt(null);
    setApproved(false);
    setEvents([]);
    setError("");
    setMessage("");
  }

  function edit<K extends keyof Goal>(key: K, value: Goal[K]) {
    setGoal((old) => ({
      ...old,
      [key]: value,
    }));
  }

  async function getQuotes() {
    const data = await api("quotes", { goal });

    setQuotes(data.quotes);
    setSelected(null);
    setApproved(false);

    log("Хүсэлт батлагдсан. Demo merchant саналуудыг авсан.");
    setStep(3);
  }

  async function negotiate() {
    if (!selected) return;

    const data = await api("negotiate", {
      token: selected.token,
      target,
    });

    setSelected(data.quote);

    setQuotes((old) =>
      old.map((quote) => (quote.id === data.quote.id ? data.quote : quote)),
    );

    setApproved(false);
    setMessage(data.message);

    log(
      `Demo negotiation: ${money(selected.total)} → ${money(data.quote.total)}`,
    );
  }

  async function confirm() {
    if (!selected) return;

    const data = await api("confirm", {
      token: selected.token,
      approved,
      approvedTotal: selected.total,
    });

    setReceipt(data.receipt);

    log("Хэрэглэгч зөвшөөрсөн. Demo баримт үүссэн.");

    setHistory((old) => {
      const next = [
        data.receipt,
        ...old.filter((item) => item.id !== data.receipt.id),
      ].slice(0, 20);

      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage боломжгүй байсан ч баримтыг харуулна.
      }

      return next;
    });

    setStep(5);
  }

  return (
    <div className="shell">
      <aside>
        <Link className="brand" href="/">
          Zah<span>Agent</span>
        </Link>
        <p>Auto Repair & Parts</p>

        <button onClick={newRequest} disabled={busy}>
          ＋ Шинэ хүсэлт
        </button>

        <h3>Захиалгын түүх</h3>

        {history.length === 0 && <p>Захиалга байхгүй.</p>}

        {history.map((item) => (
          <button
            className="history"
            key={item.id}
            disabled={busy}
            onClick={() => {
              setReceipt(item);
              setStep(5);
              setError("");
            }}
          >
            {item.id}
            <small>{money(item.quote.total)} · Demo</small>
          </button>
        ))}

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

          <span className="badge">DEMO MODE</span>
        </header>

        <p className="notice">
          Demo өгөгдөлтэй ажиллана. OyuLLM, A2A, MCP болон бодит төлбөр
          холбогдоогүй.
        </p>

        <nav>
          {["Тайлан", "Хүсэлт", "Саналууд", "Батлах", "Баримт"].map(
            (label, index) => (
              <span className={step >= index + 1 ? "active" : ""} key={label}>
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
              Текстээ оруулаад мэдээллийг гараар батална. Demo жишээ нь Prius
              30-ийн бампер, зүүн гэрэл.
            </p>

            <textarea
              value={report}
              onChange={(event) => setReport(event.target.value)}
              placeholder="Тайлангийн текст…"
              rows={7}
            />

            <label className="upload">
              TXT файл оруулах
              <input
                type="file"
                accept=".txt,text/plain"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];

                  if (!file) return;

                  void run(async () => {
                    if (file.size > 1024 * 1024) {
                      throw new Error("TXT файл 1MB-аас бага байна.");
                    }

                    setReport(await file.text());
                  });
                }}
              />
            </label>

            <div className="actions">
              <button
                className="secondary"
                onClick={() => {
                  setReport(sampleReport);
                  setGoal(initialGoal);
                }}
              >
                Demo тайлан ашиглах
              </button>

              <button
                disabled={busy || !report.trim()}
                onClick={() => {
                  setStep(2);

                  log(
                    "Тайлангийн текст оруулсан. Мэдээллийг хэрэглэгч батална.",
                  );
                }}
              >
                Мэдээлэл батлах →
              </button>
            </div>
          </section>
        )}

        {/* 2. Засварын хүсэлт */}
        {step === 2 && (
          <section>
            <h2>Засварын хүсэлтээ батлаарай</h2>

            <p>Доорх утгууд нь demo жишээ. Таны тайлангаас AI-аар гаргаагүй.</p>

            <details>
              <summary>Оруулсан тайлан</summary>
              <p className="report">{report}</p>
            </details>

            <div className="grid">
              <label>
                Машин
                <input
                  value={goal.vehicle}
                  onChange={(event) => edit("vehicle", event.target.value)}
                />
              </label>

              <label>
                Төсөв (₮)
                <input
                  type="number"
                  min="1"
                  value={goal.budget}
                  onChange={(event) =>
                    edit("budget", Number(event.target.value))
                  }
                />
              </label>

              <label>
                Шаардлагатай сэлбэг
                <input
                  value={goal.parts}
                  onChange={(event) => edit("parts", event.target.value)}
                />
              </label>

              <label>
                Хэд хоногийн дотор?
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={goal.days}
                  onChange={(event) => edit("days", Number(event.target.value))}
                />
              </label>

              <label>
                Засварын ажил
                <input
                  value={goal.tasks}
                  onChange={(event) => edit("tasks", event.target.value)}
                />
              </label>

              <label>
                Сэлбэгийн сонголт
                <select
                  value={goal.preference}
                  onChange={(event) => edit("preference", event.target.value)}
                >
                  <option value="Any">Бүх төрөл</option>
                  <option>OEM</option>
                  <option>Aftermarket</option>
                  <option>Used</option>
                </select>
              </label>
            </div>

            <div className="actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setStep(1)}
              >
                Буцах
              </button>

              <button disabled={busy} onClick={() => run(getQuotes)}>
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
                        <dt>Бампер + зүүн гэрэл</dt>
                        <dd>{money(quote.parts)}</dd>
                      </div>

                      <div>
                        <dt>Солих + будах</dt>
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
                      disabled={busy}
                      onClick={() => {
                        setSelected(quote);

                        setTarget(Math.min(goal.budget, quote.total - 10000));

                        setApproved(false);
                        setMessage("");
                        setStep(4);
                      }}
                    >
                      Багц сонгох
                    </button>
                  </section>
                ))}
            </div>

            <button
              className="secondary"
              disabled={busy}
              onClick={() => setStep(2)}
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
              {selected.goal.parts} · {selected.goal.tasks}
            </p>

            <p>
              Баталгаа: {selected.warranty}. Demo merchant гаднын сэлбэг хүлээн
              авна.
            </p>

            {selected.revision === 1 && (
              <div className="negotiate">
                <label>
                  Тохиролцох зорилтот үнэ
                  <input
                    type="number"
                    min="1"
                    value={target}
                    onChange={(event) => setTarget(Number(event.target.value))}
                  />
                </label>

                <button disabled={busy} onClick={() => run(negotiate)}>
                  Үнэ тохиролцох
                </button>
              </div>
            )}

            <label className="approval">
              <input
                type="checkbox"
                checked={approved}
                onChange={(event) => setApproved(event.target.checked)}
              />
              {money(selected.total)} үнэтэй энэ багцын demo захиалга, booking,
              mock төлбөрийг зөвшөөрч байна.
            </label>

            <div className="actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setStep(3);
                  setMessage("");
                }}
              >
                Буцах
              </button>

              <button disabled={busy || !approved} onClick={() => run(confirm)}>
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
            </dl>

            <button onClick={newRequest}>Шинэ хүсэлт үүсгэх</button>
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
