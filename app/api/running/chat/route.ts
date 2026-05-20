import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserId } from "@/lib/auth";
import { generateRunningChatReply } from "@/lib/claude-running-chat";

const BodySchema = z.object({
  message: z.string().min(1).max(1200),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(2000),
      }),
    )
    .max(20)
    .optional(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const json = await req.json();
    const parsed = BodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid request payload" },
        { status: 400 },
      );
    }

    const reply = await generateRunningChatReply(userId, {
      question: parsed.data.message,
      history: parsed.data.history,
    });

    return NextResponse.json({ ok: true, reply });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
