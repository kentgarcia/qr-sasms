import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";

export const SESSION_COOKIE = "stars_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; 

function secretKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    
    throw new Error(
      "AUTH_SECRET is not set. Copy .env.example to .env and set AUTH_SECRET."
    );
  }
  return new TextEncoder().encode(secret);
}


export type SessionPayload = {
  uid: string; 
  studentId: string | null; 
  email: string;
  name: string;
  role: "student" | "admin" | "super_admin" | "scanner";
  approved: boolean;
};

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySession(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}


export async function getSession(): Promise<SessionPayload | null> {
  const store = cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function setSessionCookie(payload: SessionPayload) {
  const token = await signSession(payload);
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}
export function toClientUser(u: {
  studentId: string | null;
  email: string;
  name: string;
  role: string;
  course?: string | null;
  year?: string | null;
  approved?: boolean;
}) {
  return {
    id: u.studentId || u.email,
    email: u.email,
    name: u.name,
    role: u.role.toLowerCase(),
    course: u.course || undefined,
    year: u.year || undefined,
  };
}

export function clearSessionCookie() {
  cookies().set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
