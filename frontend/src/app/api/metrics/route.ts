import { NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://backend:8000";

export async function GET() {
  const requestUrl = `${BACKEND_URL.replace(/\/$/, "")}/api/metrics`;

  try {
    const response = await fetch(requestUrl, {
      cache: "no-store"
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
    }

    const data = await response.json();
    return NextResponse.json(data, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
