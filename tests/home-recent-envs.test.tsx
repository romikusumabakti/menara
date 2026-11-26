// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { RecentEnvsSection } = await import(
  "@/web/routes/$locale/_app/-components/home/recent-envs-section"
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("RecentEnvsSection", () => {
  it("renders no Backup button, even for a database env the user can back up", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <RecentEnvsSection
            environments={[
              {
                id: "e1",
                name: "ACME staging",
                path: "/ACME/staging",
                projectId: "p1",
                projectName: "ACME",
                hasDatabase: true,
                canBackup: true,
              },
            ]}
          />
        </IntlProvider>
      );
    });
    expect(container.querySelector("a[href='/ACME/staging']")).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
