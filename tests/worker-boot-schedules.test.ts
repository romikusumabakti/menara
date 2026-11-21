import { describe, expect, it, vi } from "vitest";

// Every recurring job is re-registered on boot (their schedulers live in
// Redis, which may have been flushed). This guards the queue names and the
// per-link Jira sweeps across renames. The daily instance backup is registered
// separately by syncInstanceBackupOnBoot (server/index.ts), not by the worker.
vi.mock("@/lib/jobs/deploy", () => ({
  failStaleDeployments: vi.fn(async () => 0),
}));
vi.mock("@/lib/provisioning/repository", () => ({
  failStaleProvisionRuns: vi.fn(async () => 0),
}));
vi.mock("@/lib/teardown/repository", () => ({
  failStaleTeardownRuns: vi.fn(async () => 0),
}));
vi.mock("@/lib/jobs/processor", () => ({ processJob: vi.fn() }));
vi.mock("@/lib/deploy/lock-release", () => ({
  sweepExpiredLocks: vi.fn(async () => 0),
}));
const queue = vi.hoisted(() => ({
  TASKS_QUEUE: "test",
  createRedisConnection: vi.fn(),
  scheduleJiraSweep: vi.fn(async () => {}),
  scheduleDeployLockSweep: vi.fn(async () => {}),
  scheduleInstanceUpdateCheck: vi.fn(async () => {}),
  scheduleEnvironmentArchivePrune: vi.fn(async () => {}),
  scheduleAssistantUploadPrune: vi.fn(async () => {}),
  scheduleAssistantTemporaryPrune: vi.fn(async () => {}),
}));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ projectId: "p-1" }, { projectId: "p-2" }],
      }),
    }),
  },
}));
vi.mock("bullmq", () => ({
  Worker: class {
    on() {}
    async close() {}
  },
}));

describe("startWorker schedules", () => {
  it("registers every job scheduler at boot", async () => {
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    vi.spyOn(process, "once").mockImplementation(() => process);
    const { startWorker } = await import("@/lib/jobs/worker");
    expect(startWorker()).not.toBeNull();

    await vi.waitFor(() => {
      expect(queue.scheduleDeployLockSweep).toHaveBeenCalledTimes(1);
      expect(queue.scheduleInstanceUpdateCheck).toHaveBeenCalledTimes(1);
      expect(queue.scheduleEnvironmentArchivePrune).toHaveBeenCalledTimes(1);
      expect(queue.scheduleAssistantUploadPrune).toHaveBeenCalledTimes(1);
      expect(queue.scheduleAssistantTemporaryPrune).toHaveBeenCalledTimes(1);
      expect(queue.scheduleJiraSweep).toHaveBeenCalledWith("p-1");
      expect(queue.scheduleJiraSweep).toHaveBeenCalledWith("p-2");
    });
  });
});
