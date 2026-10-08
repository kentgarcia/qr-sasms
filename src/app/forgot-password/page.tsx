"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Unable to send the reset email.");
      setSent(true);
      setMessage(data?.message || "If that email exists, a reset link has been sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send the reset email.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, position: "relative", overflow: "hidden" }}>
      <div className="bg-scene" />
      <div className="orb orb-1" /><div className="orb orb-2" /><div className="orb orb-3" /><div className="orb orb-4" />
      <section className="modal-box" style={{ maxWidth: 420, zIndex: 1 }}>
        <div style={{ position: "relative", zIndex: 3, textAlign: "center" }}>
          <div style={{ width: 54, height: 54, margin: "0 auto 14px", borderRadius: "50%", display: "grid", placeItems: "center", background: "rgba(139,26,26,.76)", border: "1px solid rgba(245,197,24,.55)", color: "#F5C518", fontSize: 21 }}>
            <i className="fa-solid fa-key" />
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(30,5,5,.65)", marginBottom: 6 }}>STARS</div>
          <h1 style={{ fontSize: 23, fontWeight: 900, color: "#1a0505" }}>Forgot password?</h1>
          <p style={{ fontSize: 13, color: "rgba(30,5,5,.75)", marginTop: 8, lineHeight: 1.6 }}>Enter your account email and we&apos;ll send a secure reset link.</p>
        </div>
        {sent ? (
          <div className="info-box" style={{ position: "relative", zIndex: 3, marginTop: 24, textAlign: "center", background: "rgba(235,255,240,.6)", borderColor: "rgba(21,128,61,.25)", color: "#166534", lineHeight: 1.6 }}>{message}</div>
        ) : (
          <form onSubmit={submit} style={{ position: "relative", zIndex: 3, marginTop: 24 }}>
            <label className="input-label" htmlFor="email">Email address</label>
            <div style={{ position: "relative" }}>
              <i className="fa-solid fa-envelope" style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(30,5,5,.62)", fontSize: 13, pointerEvents: "none" }} />
              <input id="email" className="glass-input" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" style={{ paddingLeft: 38 }} />
            </div>
            {message && <p style={{ marginTop: 10, fontSize: 12, color: "#991b1b", lineHeight: 1.5 }}>{message}</p>}
            <button className="btn-maroon" type="submit" disabled={submitting} style={{ width: "100%", marginTop: 18, padding: 13, borderRadius: 14, opacity: submitting ? .7 : 1 }}>
              <i className="fa-solid fa-paper-plane" style={{ marginRight: 8 }} />{submitting ? "SENDING..." : "SEND RESET LINK"}
            </button>
          </form>
        )}
        <p style={{ position: "relative", zIndex: 3, textAlign: "center", marginTop: 20, fontSize: 13, color: "rgba(30,5,5,.75)" }}>
          <Link href="/" style={{ color: "#D4A017", fontWeight: 800, textDecoration: "none" }}><i className="fa-solid fa-arrow-left" style={{ marginRight: 6 }} />Back to sign in</Link>
        </p>
      </section>
    </main>
  );
}
