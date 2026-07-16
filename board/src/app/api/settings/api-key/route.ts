import { NextRequest, NextResponse } from "next/server";
import { getUsername } from "@/lib/auth";
import { storeApiKey, hasApiKey, deleteApiKey } from "@/lib/kv";

const MAX_KEY_LENGTH = 500;

export async function GET(req: NextRequest) {
  const username = await getUsername(req);
  if (!username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const exists = await hasApiKey(username);
  return NextResponse.json({ hasKey: exists });
}

export async function PUT(req: NextRequest) {
  const username = await getUsername(req);
  if (!username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiKey } = body;
  if (!apiKey || !apiKey.startsWith("sk-ant-") || apiKey.length > MAX_KEY_LENGTH) {
    return NextResponse.json(
      { error: "Invalid API key. Keys must start with sk-ant-." },
      { status: 400 }
    );
  }

  await storeApiKey(username, apiKey);
  return NextResponse.json({ hasKey: true });
}

export async function DELETE(req: NextRequest) {
  const username = await getUsername(req);
  if (!username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await deleteApiKey(username);
  return NextResponse.json({ hasKey: false });
}
