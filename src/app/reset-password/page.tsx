"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

export default function ResetPasswordPage() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") || "");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Unable to reset password.");
      setSuccess(true);
      setMessage(data.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to reset password.");
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
            <i className="fa-solid fa-lock" />
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(30,5,5,.65)", marginBottom: 6 }}>STARS</div>
          <h1 style={{ fontSize: 23, fontWeight: 900, color: "#1a0505" }}>Reset password</h1>
          <p style={{ fontSize: 13, color: "rgba(30,5,5,.75)", marginTop: 8, lineHeight: 1.6 }}>Choose a new password for your account.</p>
        </div>
        {success ? (
          <div className="info-box" style={{ position: "relative", zIndex: 3, marginTop: 24, textAlign: "center", background: "rgba(235,255,240,.6)", borderColor: "rgba(21,128,61,.25)", color: "#166534", lineHeight: 1.6 }}>
            <i className="fa-solid fa-circle-check" style={{ marginRight: 6 }} />{message}
          </div>
        ) : (
          <form onSubmit={submit} style={{ position: "relative", zIndex: 3, marginTop: 24 }}>
            <label className="input-label" htmlFor="new-password">New password</label>
            <div style={{ position: "relative" }}>
              <i className="fa-solid fa-lock" style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(30,5,5,.62)", fontSize: 13, pointerEvents: "none" }} />
              <input id="new-password" type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" className="glass-input" style={{ paddingLeft: 38 }} />
            </div>
            <label className="input-label" htmlFor="confirm-password" style={{ marginTop: 14 }}>Confirm new password</label>
            <div style={{ position: "relative" }}>
              <i className="fa-solid fa-shield-halved" style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "rgba(30,5,5,.62)", fontSize: 13, pointerEvents: "none" }} />
              <input id="confirm-password" type="password" required minLength={6} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Re-enter your new password" className="glass-input" style={{ paddingLeft: 38 }} />
            </div>
            {message && <p style={{ marginTop: 10, fontSize: 12, color: "#991b1b", lineHeight: 1.5 }}>{message}</p>}
            <button type="submit" disabled={submitting || !token} className="btn-maroon" style={{ width: "100%", marginTop: 18, padding: 13, borderRadius: 14 }}>
              <i className="fa-solid fa-key" style={{ marginRight: 8 }} />{submitting ? "RESETTING..." : "RESET PASSWORD"}
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
