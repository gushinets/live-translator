import { expect, type APIRequestContext } from "@playwright/test";

export async function cleanupRealSessions(request: Pick<APIRequestContext, "get" | "post">, origin: string, attempts: ReadonlyMap<string, string>): Promise<void> {
  const headers = { Origin: origin };
  const results = await Promise.allSettled([
    ...Array.from(attempts.keys(), async id => {
      const cleanup = await request.post(`/api/live/session/${id}/cleanup`, { headers, data: { reason: "user_end" }, timeout: 5000 });
      expect([200, 404]).toContain(cleanup.status());
      if (cleanup.status() === 200) {
        await expect.poll(async () => {
          const response = await request.get(`/api/live/session/${id}`, { timeout: 2000 });
          const attempt = await response.json() as { state: string };
          return response.ok() && ["closed", "failed"].includes(attempt.state);
        }, { timeout: 30000 }).toBe(true);
      }
    }),
    ...Array.from(new Set(attempts.values()), async conversationId => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const conversation = await request.get(`/api/conversations/${conversationId}`, { timeout: 5000 });
        expect(conversation.ok()).toBe(true);
        const { version } = await conversation.json() as { version: number };
        const ended = await request.post(`/api/conversations/${conversationId}/end`, { headers, data: { expectedVersion: version, reason: "user_end" }, timeout: 5000 });
        if (ended.status() === 409 && attempt < 2) continue;
        expect(ended.ok()).toBe(true);
        return;
      }
    }),
  ]);
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Real Live session cleanup failed");
}
