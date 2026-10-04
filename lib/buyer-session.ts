import "server-only";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

const cookieName = "shamin_buyer_session";

export async function getBuyerSession() {
  const cookieStore = await cookies();
  const existing = cookieStore.get(cookieName)?.value;

  if (existing && /^[a-f0-9]{64}$/.test(existing)) {
    return existing;
  }

  const sessionId = randomBytes(32).toString("hex");

  cookieStore.set(cookieName, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return sessionId;
}
