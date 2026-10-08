-- Improvement spec F-2 (docs/ai-assistant-improvement-spec.md).
-- Per-answer feedback for assistant replies. Facts stay immutable on
-- ChatMessage; votes live here for analytics. Cascades with the message.
CREATE TABLE "ChatFeedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFeedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChatFeedback_messageId_key" ON "ChatFeedback"("messageId");
CREATE INDEX "ChatFeedback_sessionId_idx" ON "ChatFeedback"("sessionId");
CREATE INDEX "ChatFeedback_studentId_idx" ON "ChatFeedback"("studentId");
ALTER TABLE "ChatFeedback" ADD CONSTRAINT "ChatFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatFeedback" ADD CONSTRAINT "ChatFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
