"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { DEMO_MERCHANTS } from "@/merchant/demo-merchants";
import { adminSchemas, type AdminResource, type DashboardSnapshot, type Versioned } from "@/merchant/private-contracts";
import { fieldLabels, localizeKnownText, localizedFieldPath, localizedAdminFields, merchantErrorMessage, statusLabel, validationMessage } from "@/merchant/i18n";
import styles from "./dashboard.module.css";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/merchant-demo/${path}`, { method, cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.fields ? `${merchantErrorMessage(String(data.error))}: ${data.fields.map((f: { path: string; message: string }) => `${localizedFieldPath(f.path)} ${validationMessage(f.message)}`).join("; ")}` : merchantErrorMessage(String(data.error)));
  return data;
}
type Tab = AdminResource | "activity";
const labels: Record<Tab, string> = { profile: "Нийтийн танилцуулга", inventory: "Сэлбэгийн нөөц", service: "Засварын үйлчилгээ", slot: "Засварын цаг", settings: "Хувийн үнийн тохиргоо", activity: "Үнийн хүсэлт ба гүйлгээ" };
const enums: Record<string, string[]> = { condition: ["oem", "aftermarket", "used"], status: ["available", "blocked"], customerSuppliedParts: ["accepted", "inspection_required", "not_accepted"] };
const vehicle = { make: "Toyota", model: "Prius", generation: "30", yearFrom: 2009, yearTo: 2015 };
function newRecord(resource: AdminResource, merchantId: string) {
  const base = { contractVersion: "1", id: crypto.randomUUID(), merchantId, createdAt: new Date().toISOString(), mode: "simulated" };
  const price = { amountMinor: 0, currency: "MNT" };
  if (resource === "inventory") return { ...base, name: "", partNumber: "", condition: "aftermarket", compatibility: [vehicle], price, minimumPrice: price, stock: 0, warranty: "", active: true };
  if (resource === "service") return { ...base, name: "", vehicles: [vehicle], price, minimumPrice: price, durationMinutes: 60, warranty: "", active: true, customerSuppliedParts: "inspection_required", customerPartsTerms: "" };
  if (resource === "slot") return { ...base, serviceIds: [], startsAt: "", endsAt: "", capacity: 1, status: "available" };
  return { ...base, id: merchantId, maxDiscountBps: 0, negotiationEnabled: false, humanApprovalRequired: true };
}

function Editor({ resource, entry, services, onSave, busy }: { resource: AdminResource; entry: Versioned | { record: Record<string, unknown>; version: number }; services: DashboardSnapshot["services"]; onSave: (record: unknown, version: number) => Promise<void>; busy: boolean }) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => Object.fromEntries(Object.entries(entry.record).map(([key, value]) =>
    [key, ["name", "location", "warranty", "customerPartsTerms"].includes(key) && typeof value === "string" && value ? localizeKnownText(value, "") :
      key === "capabilities" ? (value as string[]).map(item => localizeKnownText(item, "")) : value])));
  const [error, setError] = useState("");
  function set(key: string, value: unknown) { setDraft(d => ({ ...d, [key]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    const checked = adminSchemas[resource].safeParse(draft);
    if (!checked.success) { setError(checked.error.issues.map(i => `${localizedFieldPath(i.path.join("."))}: ${validationMessage(i.message)}`).join("; ")); return; }
    const untranslated = localizedAdminFields(draft, resource);
    if (untranslated.length) { setError(`Монгол кириллээр оруулна уу: ${untranslated.map(field => fieldLabels[field]).join(", ")}.`); return; }
    await onSave(checked.data, entry.version);
  }
  return <form className={styles.editor} onSubmit={submit}>
    <div className={styles.editorHead}><h2>{entry.version ? "Бүртгэл засах" : "Бүртгэл нэмэх"}</h2><span>ТУРШИЛТ · хувилбар {entry.version}</span></div>
    <p className={styles.recordId}>{String(draft.id)}</p>
    <p>Нэр, тайлбар, байршил болон нөхцөлийг монгол кириллээр оруулна уу. Орчуулагдаагүй хуучин талбарыг хадгалахаас өмнө бөглөнө үү.</p>
    <fieldset disabled={busy}>
      {Object.entries(draft).filter(([key]) => !["contractVersion", "id", "merchantId", "createdAt", "mode", "kind"].includes(key)).map(([key, value]) => {
        const label = fieldLabels[key] ?? "Талбар";
        if (typeof value === "boolean") return <label className={styles.check} key={key}><input type="checkbox" checked={value} onChange={e => set(key, e.target.checked)} />{label}</label>;
        if (key === "price" || key === "minimumPrice") {
          const money = value as { amountMinor: number; currency: string };
          return <label key={key}>{label} ({money.currency}, үндсэн нэгж)<input required type="number" min="0" step="0.01" value={Number.isNaN(money.amountMinor) ? "" : money.amountMinor / 100} onChange={e => set(key, { ...money, amountMinor: Math.round(e.target.valueAsNumber * 100) })} /><small>Валютын жижиг нэгжээр бүхэл тоо болгон хадгална. Валют: {money.currency}</small></label>;
        }
        if (key === "capabilities") return <label key={key}>{label}<textarea required value={(value as string[]).join("\n")} onChange={e => set(key, e.target.value.split("\n"))} /></label>;
        if (key === "serviceIds") return <div key={key}><h3>Энэ цагт үзүүлэх үйлчилгээ</h3>{services.filter(s => s.record.active).map(s => <label className={styles.check} key={s.record.id}><input type="checkbox" checked={(value as string[]).includes(s.record.id)} onChange={e => set(key, e.target.checked ? [...value as string[], s.record.id] : (value as string[]).filter(id => id !== s.record.id))} />{localizeKnownText(s.record.name, "Засварын үйлчилгээ")}</label>)}{services.length === 0 && <p>Эхлээд үйлчилгээ нэмнэ үү.</p>}</div>;
        if (key === "compatibility" || key === "vehicles") {
          const rows = value as typeof vehicle[];
          return <div key={key}><h3>Тохирох автомашин</h3>{rows.map((row, i) => <div className={styles.vehicle} key={i}>{Object.entries(row).map(([field, fieldValue]) => <label key={field}>{fieldLabels[field] ?? "Талбар"}<input required type={typeof fieldValue === "number" ? "number" : "text"} value={Number.isNaN(fieldValue) ? "" : fieldValue} onChange={e => set(key, rows.map((r, n) => n === i ? { ...r, [field]: typeof fieldValue === "number" ? e.target.valueAsNumber : e.target.value } : r))} /></label>)}<button type="button" className={styles.secondary} onClick={() => set(key, rows.filter((_, n) => n !== i))}>Автомашин хасах</button></div>)}<button type="button" className={styles.secondary} onClick={() => set(key, [...rows, { ...vehicle }])}>Автомашин нэмэх</button></div>;
        }
        if (enums[key]) return <label key={key}>{label}<select value={String(value)} onChange={e => set(key, e.target.value)}>{enums[key].map(option => <option key={option} value={option}>{statusLabel(option)}</option>)}</select></label>;
        return <label key={key}>{label}<input required type={typeof value === "number" ? "number" : "text"} min={typeof value === "number" ? 0 : undefined} step={typeof value === "number" ? 1 : undefined} value={Number.isNaN(value) ? "" : String(value)} onChange={e => set(key, typeof value === "number" ? e.target.valueAsNumber : e.target.value)} /></label>;
      })}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <button type="submit">{busy ? "Хадгалж байна…" : "Хадгалах"}</button>
    </fieldset>
  </form>;
}
export default function MerchantDashboard() {
  const [selected, setSelected] = useState<string>(DEMO_MERCHANTS[0].id);
  const [accessKey, setAccessKey] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>("profile");
  const [edit, setEdit] = useState<Versioned | { record: Record<string, unknown>; version: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await api("session");
        if (cancelled) return;
        setAuthenticated(true); setSelected(session.merchantId);
        const data = await api("dashboard");
        if (!cancelled) setSnapshot(data);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? merchantErrorMessage(e.message) : "Худалдаачны самбарыг ачаалж чадсангүй."); }
      finally { if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (e) { setError(e instanceof Error ? merchantErrorMessage(e.message) : "Үйлдэл амжилтгүй боллоо."); }
    finally { setBusy(false); }
  }
  async function login(event: FormEvent) { event.preventDefault(); await run(async () => {
    await api("session", "POST", { action: "login", merchantId: selected, accessKey });
    setAccessKey(""); setAuthenticated(true); setSnapshot(await api("dashboard"));
  }); }
  async function switchMerchant(id: string) {
    setSnapshot(null); setEdit(null); setTab("profile");
    await run(async () => { await api("session", "POST", { action: "switch", merchantId: id }); setSelected(id); setSnapshot(await api("dashboard")); });
  }
  const entries: Versioned[] = !snapshot ? [] : tab === "profile" ? [snapshot.profile] : tab === "inventory" ? snapshot.inventory : tab === "service" ? snapshot.services : tab === "slot" ? snapshot.slots : tab === "settings" ? (snapshot.settings ? [snapshot.settings] : []) : [];
  const tabs: Tab[] = ["profile", ...(snapshot?.profile.record.kind === "repair" ? ["service", "slot"] as Tab[] : ["inventory"] as Tab[]), "settings", "activity"];
  const current = edit ?? entries[0] ?? null;
  return <div className={styles.dashboard} lang="mn">
    <header className={styles.header}><div><span className={styles.eyebrow}>ЗАХАГЕНТ / ХУДАЛДААЧНЫ ҮЙЛ АЖИЛЛАГАА</span><h1>Худалдаачны ажлын самбар</h1><p>Бие даасан таван туршилтын худалдаачин. Хувийн мэдээлэл энэ самбарт харагдана.</p></div><Link href="/">Худалдан авагчийн туршилт ↗</Link></header>
    <div className={styles.banner}>ТУРШИЛТЫН ӨГӨГДӨЛ · Зөвхөн дотоод туршилтын удирдлага · Үнийн санал нөөц болон цаг захиалахгүй</div>
    {error && <p role="alert" className={styles.error}>{error}</p>}{message && <p role="status" className={styles.success}>{message}</p>}
    {!authenticated ? <form className={styles.login} onSubmit={login}><h2>Худалдаачны туршилтыг нээх</h2><p>Хөгжүүлэгчийн тохируулсан дотоод хандалтын түлхүүрийг ашиглана уу. Бодит орчны хандалт хаалттай.</p><label>Туршилтын худалдаачин<select disabled={busy} value={selected} onChange={e => setSelected(e.target.value)}>{DEMO_MERCHANTS.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label><label>Туршилтын хандалтын түлхүүр<input disabled={busy} required type="password" autoComplete="off" value={accessKey} onChange={e => setAccessKey(e.target.value)} /></label><button disabled={busy}>{busy ? "Ачаалж байна…" : "Самбар нээх"}</button></form> : <>
      <div className={styles.toolbar}><label>Туршилтын худалдаачин сонгох<select disabled={busy} value={selected} onChange={e => void switchMerchant(e.target.value)}>{DEMO_MERCHANTS.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label><button disabled={busy} className={styles.secondary} onClick={() => void run(async () => { setEdit(null); setSnapshot(await api("dashboard")); })}>Бүртгэл дахин ачаалах</button><button disabled={busy} className={styles.secondary} onClick={() => void run(async () => { await api("session", "POST", { action: "logout" }); setSnapshot(null); setEdit(null); setAuthenticated(false); })}>Гарах</button></div>
      {snapshot && <><div className={styles.metrics}><div><small>Худалдаачны төрөл</small><strong>{statusLabel(snapshot.profile.record.kind)}</strong></div><div><small>Сэлбэг / үйлчилгээ</small><strong>{snapshot.inventory.length + snapshot.services.length}</strong></div><div><small>Боломжтой цаг</small><strong>{snapshot.slots.filter(s => s.record.status === "available").length}</strong></div><div><small>Гүйлгээ</small><strong>{snapshot.transactions.length}</strong></div></div>
      <nav className={styles.tabs} aria-label="Худалдаачны удирдлага">{tabs.map(t => <button disabled={busy} key={t} aria-current={tab === t ? "page" : undefined} className={tab === t ? styles.selectedTab : styles.secondary} onClick={() => { setTab(t); setEdit(null); setMessage(""); }}>{labels[t]}</button>)}</nav>
      {tab === "activity" ? <div className={styles.activity}>{(["rfqs", "quotes", "transactions"] as const).map(key => <div className={styles.panel} key={key}><h2>{key === "rfqs" ? "Үнийн хүсэлт" : key === "quotes" ? "Үнийн санал" : "Гүйлгээ"}</h2><p>Зөвхөн харах · энэ худалдаачны сүүлийн 100 хүртэлх бүртгэл</p>{snapshot[key].length === 0 ? <p>Одоогоор бүртгэл алга.</p> : snapshot[key].map(record => <article key={record.id}><strong>{record.id}</strong><p>{statusLabel(record.status)} · {new Date(record.createdAt).toLocaleString("mn-MN")}</p>{"total" in record && <p>{record.total.currency} {(record.total.amountMinor / 100).toLocaleString("mn-MN")}</p>}</article>)}</div>)}</div> : <div className={styles.workarea}><div className={styles.panel}><h2>{labels[tab]}</h2><p>{tab === "profile" ? "Нийтийн боломжийн хайлтаар нийтлэгдэнэ. Нөөц болон үнэ харагдахгүй." : "Худалдаачны хувийн мэдээлэл. Өөрчлөлт хяналтын бүртгэлийн хамт хадгалагдана."}</p>{entries.map(entry => <button disabled={busy} className={styles.recordButton} key={entry.record.id} onClick={() => setEdit(entry)}><strong>{"name" in entry.record ? localizeKnownText(entry.record.name, "Бүртгэл") : "startsAt" in entry.record ? new Date(entry.record.startsAt).toLocaleString("mn-MN") : "Үнийн тохиргоо"}</strong><small>{"stock" in entry.record ? `${entry.record.stock} ширхэг` : "active" in entry.record ? (entry.record.active ? "Идэвхтэй" : "Идэвхгүй") : "status" in entry.record ? statusLabel(entry.record.status) : "Хувийн"} · хувилбар {entry.version}</small></button>)}{tab !== "profile" && (tab !== "settings" || !snapshot.settings) && <button disabled={busy} onClick={() => setEdit({ record: newRecord(tab, snapshot.merchantId), version: 0 })}>{labels[tab]} нэмэх</button>}</div>
      {current && <Editor key={`${snapshot.merchantId}-${tab}-${current.record.id}-${current.version}`} resource={tab} entry={current} services={snapshot.services} busy={busy} onSave={async (record, version) => { await run(async () => { await api("dashboard", "PUT", { resource: tab, record, expectedVersion: version }); setSnapshot(await api("dashboard")); setEdit(null); setMessage("Өөрчлөлтийг хяналтын бүртгэлийн хамт хадгаллаа."); }); }} />}</div>}</>}
    </>}
  </div>;
}
