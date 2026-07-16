import { NextResponse } from "next/server";

const API_URL = process.env.API_URL || "http://localhost:3001";
const API_SECRET = process.env.API_SECRET || "";

export async function POST() {
  if (!API_SECRET) {
    return NextResponse.json({ error: "API_SECRET not configured" }, { status: 500 });
  }

  try {
    const res = await fetch(`${API_URL}/api/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
      },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Backend rejected resume request" }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }
}
