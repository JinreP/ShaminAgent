"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { DEMO_MERCHANTS } from "@/merchant/demo-merchants";
import { adminSchemas, type AdminResource, type DashboardSnapshot, type Versioned } from "@/merchant/private-contracts";
import styles from "./dashboard.module.css";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/merchant-demo/${path}`, { method, cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.fields ? `${data.error}: ${data.fields.map((f: { path: string; message: string }) => `${f.path} ${f.message}`).join("; ")}` : data.error);
  return data;
}
type Tab = AdminResource | "activity";
const labels: Record<Tab, string> = { profile: "Capability profile", inventory: "Parts inventory", service: "Repair services", slot: "Booking slots", settings: "Private negotiation", activity: "RFQs & transactions" };
const fieldLabels: Record<string, string> = { name: "Name", partNumber: "Demo part number", condition: "Condition", location: "Location", stock: "Units in stock", warranty: "Warranty", active: "Active", price: "Selling / labor price", minimumPrice: "Private minimum price", durationMinutes: "Duration (minutes)", customerSuppliedParts: "Customer-supplied parts", customerPartsTerms: "Customer parts policy", startsAt: "Starts at (ISO date with offset)", endsAt: "Ends at (ISO date with offset)", capacity: "Slot capacity", status: "Slot status", maxDiscountBps: "Maximum discount (basis points; 100 = 1%)", negotiationEnabled: "Negotiation enabled", humanApprovalRequired: "Require human approval", capabilities: "Public capabilities (one per line)" };
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
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...entry.record });
  const [error, setError] = useState("");
  function set(key: string, value: unknown) { setDraft(d => ({ ...d, [key]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    const checked = adminSchemas[resource].safeParse(draft);
    if (!checked.success) { setError(checked.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")); return; }
    await onSave(checked.data, entry.version);
  }
  return <form className={styles.editor} onSubmit={submit}>
    <div className={styles.editorHead}><h2>{entry.version ? "Edit record" : "Add record"}</h2><span>SIMULATED · version {entry.version}</span></div>
    <p className={styles.recordId}>{String(draft.id)}</p>
    <fieldset disabled={busy}>
      {Object.entries(draft).filter(([key]) => !["contractVersion", "id", "merchantId", "createdAt", "mode", "kind"].includes(key)).map(([key, value]) => {
        const label = fieldLabels[key] ?? key;
        if (typeof value === "boolean") return <label className={styles.check} key={key}><input type="checkbox" checked={value} onChange={e => set(key, e.target.checked)} />{label}</label>;
        if (key === "price" || key === "minimumPrice") {
          const money = value as { amountMinor: number; currency: string };
          return <label key={key}>{label} ({money.currency}, major units)<input required type="number" min="0" step="0.01" value={Number.isNaN(money.amountMinor) ? "" : money.amountMinor / 100} onChange={e => set(key, { ...money, amountMinor: Math.round(e.target.valueAsNumber * 100) })} /><small>Saved as integer minor units. Currency: {money.currency}</small></label>;
        }
        if (key === "capabilities") return <label key={key}>{label}<textarea required value={(value as string[]).join("\n")} onChange={e => set(key, e.target.value.split("\n"))} /></label>;
        if (key === "serviceIds") return <div key={key}><h3>Services offered in this slot</h3>{services.filter(s => s.record.active).map(s => <label className={styles.check} key={s.record.id}><input type="checkbox" checked={(value as string[]).includes(s.record.id)} onChange={e => set(key, e.target.checked ? [...value as string[], s.record.id] : (value as string[]).filter(id => id !== s.record.id))} />{s.record.name}</label>)}{services.length === 0 && <p>Add a service first.</p>}</div>;
        if (key === "compatibility" || key === "vehicles") {
          const rows = value as typeof vehicle[];
          return <div key={key}><h3>Vehicle compatibility</h3>{rows.map((row, i) => <div className={styles.vehicle} key={i}>{Object.entries(row).map(([field, fieldValue]) => <label key={field}>{field}<input required type={typeof fieldValue === "number" ? "number" : "text"} value={Number.isNaN(fieldValue) ? "" : fieldValue} onChange={e => set(key, rows.map((r, n) => n === i ? { ...r, [field]: typeof fieldValue === "number" ? e.target.valueAsNumber : e.target.value } : r))} /></label>)}<button type="button" className={styles.secondary} onClick={() => set(key, rows.filter((_, n) => n !== i))}>Remove vehicle</button></div>)}<button type="button" className={styles.secondary} onClick={() => set(key, [...rows, { ...vehicle }])}>Add vehicle</button></div>;
        }
        if (enums[key]) return <label key={key}>{label}<select value={String(value)} onChange={e => set(key, e.target.value)}>{enums[key].map(option => <option key={option}>{option}</option>)}</select></label>;
        return <label key={key}>{label}<input required type={typeof value === "number" ? "number" : "text"} min={typeof value === "number" ? 0 : undefined} step={typeof value === "number" ? 1 : undefined} value={Number.isNaN(value) ? "" : String(value)} onChange={e => set(key, typeof value === "number" ? e.target.valueAsNumber : e.target.value)} /></label>;
      })}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <button type="submit">{busy ? "Saving…" : "Save to MongoDB"}</button>
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
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Unable to load dashboard"); }
      finally { if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Operation failed"); }
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
  return <div className={styles.dashboard}>
    <header className={styles.header}><div><span className={styles.eyebrow}>ZAHAGENT / MERCHANT OPERATIONS</span><h1>Merchant workspace</h1><p>Five independent simulated merchants. Private data stays in this workspace.</p></div><Link href="/">Buyer demo ↗</Link></header>
    <div className={styles.banner}>SIMULATED DATA · Local demo administration only · Quotes do not reserve stock or slots</div>
    {error && <p role="alert" className={styles.error}>{error}</p>}{message && <p role="status" className={styles.success}>{message}</p>}
    {!authenticated ? <form className={styles.login} onSubmit={login}><h2>Open the merchant demo</h2><p>Use the local access key configured by the developer. Production access is disabled.</p><label>Demo merchant<select disabled={busy} value={selected} onChange={e => setSelected(e.target.value)}>{DEMO_MERCHANTS.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label><label>Demo access key<input disabled={busy} required type="password" autoComplete="off" value={accessKey} onChange={e => setAccessKey(e.target.value)} /></label><button disabled={busy}>{busy ? "Loading…" : "Open workspace"}</button></form> : <>
      <div className={styles.toolbar}><label>Demo merchant selector<select disabled={busy} value={selected} onChange={e => void switchMerchant(e.target.value)}>{DEMO_MERCHANTS.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label><button disabled={busy} className={styles.secondary} onClick={() => void run(async () => { setEdit(null); setSnapshot(await api("dashboard")); })}>Reload records</button><button disabled={busy} className={styles.secondary} onClick={() => void run(async () => { await api("session", "POST", { action: "logout" }); setSnapshot(null); setEdit(null); setAuthenticated(false); })}>Sign out</button></div>
      {snapshot && <><div className={styles.metrics}><div><small>Merchant type</small><strong>{snapshot.profile.record.kind}</strong></div><div><small>Inventory / services</small><strong>{snapshot.inventory.length + snapshot.services.length}</strong></div><div><small>Available slots</small><strong>{snapshot.slots.filter(s => s.record.status === "available").length}</strong></div><div><small>Transactions</small><strong>{snapshot.transactions.length}</strong></div></div>
      <nav className={styles.tabs} aria-label="Merchant management">{tabs.map(t => <button disabled={busy} key={t} aria-current={tab === t ? "page" : undefined} className={tab === t ? styles.selectedTab : styles.secondary} onClick={() => { setTab(t); setEdit(null); setMessage(""); }}>{labels[t]}</button>)}</nav>
      {tab === "activity" ? <div className={styles.activity}>{(["rfqs", "quotes", "transactions"] as const).map(key => <div className={styles.panel} key={key}><h2>{key === "rfqs" ? "RFQs" : key === "quotes" ? "Quotes" : "Transactions"}</h2><p>Read-only · up to 100 newest merchant-scoped records</p>{snapshot[key].length === 0 ? <p>No records yet. Processing will be added in later phases.</p> : snapshot[key].map(record => <article key={record.id}><strong>{record.id}</strong><p>{record.status} · {record.createdAt}</p>{"total" in record && <p>{record.total.currency} {(record.total.amountMinor / 100).toLocaleString()}</p>}</article>)}</div>)}</div> : <div className={styles.workarea}><div className={styles.panel}><h2>{labels[tab]}</h2><p>{tab === "profile" ? "Published through capability discovery. Inventory and prices are excluded." : "Private merchant data. Changes are persisted with audit events."}</p>{entries.map(entry => <button disabled={busy} className={styles.recordButton} key={entry.record.id} onClick={() => setEdit(entry)}><strong>{"name" in entry.record ? entry.record.name : "startsAt" in entry.record ? entry.record.startsAt : "Negotiation rules"}</strong><small>{"stock" in entry.record ? `${entry.record.stock} units` : "active" in entry.record ? (entry.record.active ? "Active" : "Inactive") : "status" in entry.record ? entry.record.status : "Private"} · v{entry.version}</small></button>)}{tab !== "profile" && (tab !== "settings" || !snapshot.settings) && <button disabled={busy} onClick={() => setEdit({ record: newRecord(tab, snapshot.merchantId), version: 0 })}>Add {tab === "settings" ? "settings" : tab}</button>}</div>
      {current && <Editor key={`${snapshot.merchantId}-${tab}-${current.record.id}-${current.version}`} resource={tab} entry={current} services={snapshot.services} busy={busy} onSave={async (record, version) => { await run(async () => { await api("dashboard", "PUT", { resource: tab, record, expectedVersion: version }); setSnapshot(await api("dashboard")); setEdit(null); setMessage("Saved to MongoDB with an audit event."); }); }} />}</div>}</>}
    </>}
  </div>;
}
