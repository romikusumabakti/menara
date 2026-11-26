// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0000000000e1";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: vi.fn() }));
vi.mock("@/web/api/environment-storage", () => ({
  environmentStorageQuery: (id: string) => ({
    queryKey: ["environment-storage", id],
    queryFn: () => mocks.get(),
  }),
  saveEnvironmentStorage: mocks.save,
  removeEnvironmentStorage: mocks.remove,
  testEnvironmentStorage: mocks.test,
}));

import { ApiError } from "@/web/api/client";
import { StorageTab } from "../web/routes/$locale/_app/-components/env/settings/storage-tab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = enMessages.environmentSettings;
const s3 = enMessages.s3Form;

const stored = {
  environmentId: ENV_ID,
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "acme-files",
  keyPrefix: "team-a/",
  accessKeyId: "AKIAEXAMPLE",
  forcePathStyle: true,
  hasSecret: true,
  isBackupDestination: false,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={enMessages}>
          <StorageTab environmentId={ENV_ID} />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await settle();
}

const input = (id: string) =>
  document.querySelector<HTMLInputElement>(`#storage-${id}`);
const button = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].find(
    (el) => el.textContent?.trim() === text
  );

async function click(el: HTMLElement | null | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => el.click());
  await settle();
}

function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error("input not found");
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  mocks.get.mockResolvedValue(null);
  mocks.save.mockResolvedValue(stored);
  mocks.remove.mockResolvedValue(undefined);
  mocks.test.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function fillNew() {
  type(input("endpoint"), "https://s3.example.com");
  type(input("bucket"), "acme-files");
  type(input("accessKeyId"), "AKIAEXAMPLE");
  type(input("secretKey"), "s3cret");
  await settle();
}

describe("Settings › Storage tab", () => {
  it("unset: an empty form without a name, and Save sends no name", async () => {
    await mount();
    expect(input("name")).toBeNull();
    expect(input("endpoint")?.value).toBe("");
    expect(button(t.storageRemove)).toBeUndefined();
    await fillNew();
    await click(button(s3.create));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const [id, body] = mocks.save.mock.calls[0] ?? [];
    expect(id).toBe(ENV_ID);
    expect(body).not.toHaveProperty("name");
    expect(body).toMatchObject({
      endpoint: "https://s3.example.com",
      bucket: "acme-files",
      secretKey: "s3cret",
    });
  });

  it("a first save requires the secret", async () => {
    await mount();
    type(input("endpoint"), "https://s3.example.com");
    type(input("bucket"), "acme-files");
    type(input("accessKeyId"), "AKIAEXAMPLE");
    await settle();
    await click(button(s3.create));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("set: fields are filled and the secret field says it is stored", async () => {
    mocks.get.mockResolvedValue(stored);
    await mount();
    expect(input("endpoint")?.value).toBe("https://s3.example.com");
    expect(input("bucket")?.value).toBe("acme-files");
    expect(input("keyPrefix")?.value).toBe("team-a/");
    expect(input("secretKey")?.value).toBe("");
    expect(input("secretKey")?.placeholder).toBe(s3.secretKeyEditPlaceholder);
  });

  it("set: saving an unchanged location keeps the secret", async () => {
    mocks.get.mockResolvedValue(stored);
    await mount();
    await click(button(s3.saveChanges));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]?.[1]).not.toHaveProperty("secretKey");
  });

  it("set: a changed bucket needs the secret again", async () => {
    mocks.get.mockResolvedValue(stored);
    await mount();
    type(input("bucket"), "other-bucket");
    await settle();
    await click(button(s3.saveChanges));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      enMessages.actionErrors.s3SecretRequiredForLocationChange
    );
  });

  it("Test connection calls the test endpoint and shows the result", async () => {
    mocks.get.mockResolvedValue(stored);
    await mount();
    await click(button(s3.testConnection));
    expect(mocks.test).toHaveBeenCalledWith(
      ENV_ID,
      expect.objectContaining({ bucket: "acme-files" })
    );
    expect(document.body.textContent).toContain(s3.testSuccess);
  });

  it("a refused save (backup overlap) shows the server message", async () => {
    mocks.get.mockResolvedValue(stored);
    mocks.save.mockRejectedValue(
      new ApiError(409, "Overlaps the backups", "s3BackupDestinationOverlap")
    );
    await mount();
    await click(button(s3.saveChanges));
    expect(mocks.toastError).toHaveBeenCalledWith("Overlaps the backups");
  });

  it("Remove asks for confirmation, then removes", async () => {
    mocks.get.mockResolvedValue(stored);
    await mount();
    await click(button(t.storageRemove));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(t.storageRemoveTitle);
    const confirm = [...document.querySelectorAll<HTMLElement>("button")]
      .filter((el) => el.textContent?.trim() === t.storageRemove)
      .at(-1);
    await click(confirm);
    expect(mocks.remove).toHaveBeenCalledWith(ENV_ID);
  });

  it("restricted: a notice replaces the fields and Remove stays", async () => {
    mocks.get.mockResolvedValue({ ...stored, isBackupDestination: true });
    await mount();
    expect(document.body.textContent).toContain(t.storageRestricted);
    expect(input("endpoint")).toBeNull();
    expect(document.body.textContent).not.toContain("acme-files");
    expect(button(t.storageRemove)).toBeDefined();
  });
});
