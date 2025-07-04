import { and, asc, eq, inArray } from "drizzle-orm";
import { htmlToText } from "html-to-text";
import { cache } from "react";
import { authenticateWidget } from "@/app/api/widget/utils";
import { db } from "@/db/client";
import { conversationMessages, conversations, files, MessageMetadata } from "@/db/schema";
import { authUsers } from "@/db/supabaseSchema/auth";
import { getFirstName, hasDisplayName } from "@/lib/auth/authUtils";
import { getFileUrl } from "@/lib/data/files";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const authResult = await authenticateWidget(request);
  if (!authResult.success) {
    return Response.json({ error: authResult.error }, { status: 401 });
  }

  let baseCondition;
  if (authResult.session.isAnonymous && authResult.session.anonymousSessionId) {
    baseCondition = eq(conversations.anonymousSessionId, authResult.session.anonymousSessionId);
  } else if (authResult.session.email) {
    baseCondition = eq(conversations.emailFrom, authResult.session.email);
  } else {
    return Response.json({ error: "Not authorized - Invalid session" }, { status: 401 });
  }

  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.slug, slug), baseCondition),
    with: {
      messages: {
        where: inArray(conversationMessages.role, ["user", "ai_assistant", "staff"]),
        orderBy: [asc(conversationMessages.createdAt)],
      },
    },
  });

  if (!conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const originalConversation =
    (conversation?.mergedIntoId &&
      (await db.query.conversations.findFirst({
        where: eq(conversations.id, conversation.mergedIntoId),
      }))) ||
    conversation;

  const attachments = await db.query.files.findMany({
    where: and(
      inArray(
        files.messageId,
        conversation.messages.map((m) => m.id),
      ),
      eq(files.isInline, false),
    ),
  });

  const incompleteGuideSessions = await db.query.guideSessions.findMany({
    where: (gs) => and(eq(gs.conversationId, conversation.id)),
    with: { events: true },
  });

  const activeGuideSessions = incompleteGuideSessions.filter(
    (session) => !session.events.some((event) => event.type === "completed"),
  );

  const formattedMessages = await Promise.all(
    conversation.messages.map(async (message) => ({
      id: message.id.toString(),
      role: message.role === "staff" || message.role === "ai_assistant" ? "assistant" : message.role,
      content: message.cleanedUpText || htmlToText(message.body ?? "", { wordwrap: false }),
      createdAt: message.createdAt.toISOString(),
      reactionType: message.reactionType,
      reactionFeedback: message.reactionFeedback,
      annotations: message.userId ? await getUserAnnotation(message.userId) : undefined,
      experimental_attachments: (message.metadata as MessageMetadata)?.includesScreenshot
        ? attachments.filter((a) => a.messageId === message.id)
        : [],
    })),
  );

  const guideSessionMessages = activeGuideSessions.map((session) => ({
    id: `guide_session_${session.id}`,
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool-invocation",
        toolInvocation: {
          toolName: "guide_user",
          toolCallId: `guide_session_${session.id}`,
          state: "call",
          args: {
            pendingResume: true,
            sessionId: session.uuid,
            title: session.title,
            instructions: session.instructions,
          },
        },
      },
    ],
    createdAt: session.createdAt.toISOString(),
  }));

  const allMessages = [...formattedMessages, ...guideSessionMessages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return Response.json({
    messages: allMessages,
    // We don't want to include staff-uploaded attachments in the AI messages, but we need to show them in the UI
    allAttachments: await Promise.all(
      attachments.map(async (a) => ({
        messageId: a.messageId?.toString(),
        name: a.name,
        presignedUrl: await getFileUrl(a),
      })),
    ),
    isEscalated: !originalConversation.assignedToAI,
  });
}

const getUserAnnotation = cache(async (userId: string) => {
  const user = await db.query.authUsers.findFirst({
    where: eq(authUsers.id, userId),
  });
  return user ? [{ user: { name: hasDisplayName(user) ? getFirstName(user) : undefined } }] : undefined;
});
