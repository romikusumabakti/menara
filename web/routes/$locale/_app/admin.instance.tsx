import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getInstanceBackupsQuery,
  getInstanceUpdatesQuery,
} from "@/web/api/instance";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { BackupsTab } from "./-components/admin/instance/backups-tab";
import { BrandingTab } from "./-components/admin/instance/branding-tab";
import { McpTab } from "./-components/admin/instance/mcp-tab";
import { SshKeyTab } from "./-components/admin/instance/ssh-key-tab";
import { UpdatesTab } from "./-components/admin/instance/updates-tab";
import { ListPending } from "./-components/list-pending";

const TABS = ["backups", "updates", "ssh-key", "branding", "mcp"] as const;
type InstanceTab = (typeof TABS)[number];

// Admin → Instance: this instance's own backups, updates, SSH key, branding
// and MCP server. The SSH key tab's routes check org server:manage, which
// every instance:manage role has. `?tab=` opens a tab (Account › Connected
// apps links to the MCP one).
export const Route = createFileRoute("/$locale/_app/admin/instance")({
  validateSearch: (search: Record<string, unknown>): { tab?: InstanceTab } => ({
    tab: TABS.includes(search.tab as InstanceTab)
      ? (search.tab as InstanceTab)
      : undefined,
  }),
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { instance: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    // The update check may wait on GitHub: started here, not awaited; the
    // Updates tab suspends on it alone.
    void queryClient.prefetchQuery(getInstanceUpdatesQuery());
    await loaderQuery(queryClient, getInstanceBackupsQuery());
  },
  pendingComponent: () => <ListPending />,
  component: InstancePage,
});

function InstancePage() {
  const t = useTranslations("instance");
  const { tab } = Route.useSearch();
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Tabs defaultValue={tab ?? "backups"} className="w-full">
        <TabsList>
          <TabsTrigger value="backups">{t("tabBackups")}</TabsTrigger>
          <TabsTrigger value="updates">{t("tabUpdates")}</TabsTrigger>
          <TabsTrigger value="ssh-key">{t("tabSshKey")}</TabsTrigger>
          <TabsTrigger value="branding">{t("tabBranding")}</TabsTrigger>
          <TabsTrigger value="mcp">{t("tabMcp")}</TabsTrigger>
        </TabsList>
        <TabsContent value="backups">
          <BackupsTab />
        </TabsContent>
        <TabsContent value="updates">
          <Suspense fallback={<ListPending />}>
            <UpdatesTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="ssh-key">
          <Suspense fallback={<ListPending />}>
            <SshKeyTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="branding">
          <Suspense fallback={<ListPending />}>
            <BrandingTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="mcp">
          <Suspense fallback={<ListPending />}>
            <McpTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </>
  );
}
