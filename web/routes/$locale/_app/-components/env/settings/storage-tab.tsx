import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { normalizeKeyPrefix } from "@/lib/validation";
import { ApiError } from "@/web/api/client";
import {
  type EnvironmentStorageConfig,
  environmentStorageQuery,
  removeEnvironmentStorage,
  saveEnvironmentStorage,
  testEnvironmentStorage,
} from "@/web/api/environment-storage";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

const SECRET_REQUIRED = "s3SecretRequiredForLocationChange";

/**
 * The environment's one object storage. Stored values are shown without the
 * secret; a blank secret keeps it unless the endpoint, region, bucket, key
 * prefix, access key or path style changed. A storage that holds the instance
 * backups is shown as a notice (its values stay hidden) and can only be
 * removed.
 */
export function StorageTab({ environmentId }: { environmentId: string }) {
  const t = useTranslations("environmentSettings");
  const storage = useSuspenseQuery(environmentStorageQuery(environmentId)).data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("storageTitle")}</CardTitle>
        <CardDescription>{t("storageDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {storage?.isBackupDestination ? (
          <div className="flex flex-col gap-4">
            <Alert>
              <AlertDescription>{t("storageRestricted")}</AlertDescription>
            </Alert>
            <div className="flex justify-end">
              <RemoveStorage environmentId={environmentId} />
            </div>
          </div>
        ) : (
          <StorageForm
            key={storage ? "stored" : "unset"}
            environmentId={environmentId}
            storage={storage}
          />
        )}
      </CardContent>
    </Card>
  );
}

function RemoveStorage({ environmentId }: { environmentId: string }) {
  const t = useTranslations("environmentSettings");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function remove() {
    setRemoving(true);
    try {
      await removeEnvironmentStorage(environmentId);
      queryClient.setQueryData(
        environmentStorageQuery(environmentId).queryKey,
        null
      );
      toast.success(t("storageRemoved"));
      setOpen(false);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
      } else {
        throw error;
      }
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        {t("storageRemove")}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!removing) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("storageRemoveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("storageRemoveDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removing}
              onClick={() => void remove()}
            >
              {t("storageRemove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function StorageForm({
  environmentId,
  storage,
}: {
  environmentId: string;
  storage: EnvironmentStorageConfig | null;
}) {
  const t = useTranslations("s3Form");
  const tSettings = useTranslations("environmentSettings");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("actionErrors");
  const queryClient = useQueryClient();
  const stored = storage !== null;

  const schema = z.object({
    endpoint: z.string().trim().url(t("endpointInvalid")),
    region: z.string().trim().min(1, tCommon("required")),
    bucket: z.string().trim().min(1, tCommon("required")),
    keyPrefix: z
      .string()
      .refine((v) => normalizeKeyPrefix(v).ok, tErrors("s3KeyPrefixInvalid")),
    accessKeyId: z.string().trim().min(1, tCommon("required")),
    secretKey: stored ? z.string() : z.string().min(1, tCommon("required")),
    forcePathStyle: z.boolean(),
  });
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      endpoint: storage?.endpoint ?? "",
      region: storage?.region ?? "us-east-1",
      bucket: storage?.bucket ?? "",
      keyPrefix: storage?.keyPrefix ?? "",
      accessKeyId: storage?.accessKeyId ?? "",
      secretKey: "",
      forcePathStyle: storage?.forcePathStyle ?? true,
    },
  });
  const watched = form.watch();
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const resetTest = () => setTestState({ kind: "idle" });
  const loading = form.formState.isSubmitting;
  useUnsavedChanges(form.formState.isDirty && !loading);

  // Whether the typed values point the stored secret somewhere new (the
  // server's changesS3Location rule): then the secret must be typed again.
  const typedPrefix = normalizeKeyPrefix(watched.keyPrefix);
  const locationChanged =
    storage !== null &&
    (watched.endpoint.trim() !== storage.endpoint ||
      watched.region.trim() !== storage.region ||
      watched.bucket.trim() !== storage.bucket ||
      watched.accessKeyId.trim() !== storage.accessKeyId ||
      watched.forcePathStyle !== storage.forcePathStyle ||
      (typedPrefix.ok && typedPrefix.prefix !== storage.keyPrefix));
  const secretMissing =
    stored && locationChanged && watched.secretKey.length === 0;

  const probe = (values: Values) => ({
    endpoint: values.endpoint.trim(),
    region: values.region.trim(),
    bucket: values.bucket.trim(),
    accessKeyId: values.accessKeyId.trim(),
    ...(values.secretKey ? { secretKey: values.secretKey } : {}),
    forcePathStyle: values.forcePathStyle,
    keyPrefix: values.keyPrefix.trim() || null,
  });

  // A refusal with a code lands on its field; any other shows as a toast.
  function report(error: unknown) {
    if (error instanceof ApiError && error.code === SECRET_REQUIRED) {
      form.setError("secretKey", { message: error.message });
      return;
    }
    if (error instanceof ApiError && error.code === "s3KeyPrefixInvalid") {
      form.setError("keyPrefix", { message: error.message });
      return;
    }
    if (error instanceof ApiError && error.status !== 401) {
      toast.error(error.message);
      return;
    }
    throw error;
  }

  async function onTest() {
    const valid = await form.trigger([
      "endpoint",
      "region",
      "bucket",
      "accessKeyId",
      "keyPrefix",
    ]);
    if (!valid || secretMissing) {
      if (secretMissing) {
        form.setError("secretKey", { message: tErrors(SECRET_REQUIRED) });
      }
      return;
    }
    setTestState({ kind: "testing" });
    try {
      const result = await testEnvironmentStorage(
        environmentId,
        probe(form.getValues())
      );
      setTestState(
        result.ok
          ? { kind: "ok" }
          : {
              kind: "fail",
              message:
                result.code === "s3ProbeFailed"
                  ? result.message
                  : tErrors(result.code),
            }
      );
    } catch (error) {
      setTestState({ kind: "idle" });
      report(error);
    }
  }

  async function onSubmit(values: Values) {
    if (secretMissing) {
      form.setError("secretKey", { message: tErrors(SECRET_REQUIRED) });
      return;
    }
    try {
      const saved = await saveEnvironmentStorage(environmentId, probe(values));
      queryClient.setQueryData(
        environmentStorageQuery(environmentId).queryKey,
        saved
      );
      toast.success(tSettings("storageSaved"));
    } catch (error) {
      report(error);
      return;
    }
    form.reset({ ...values, secretKey: "" });
    resetTest();
  }

  const text = (
    name: "endpoint" | "bucket" | "region" | "keyPrefix" | "accessKeyId",
    label: string,
    options: { placeholder?: string; description?: string } = {}
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={`storage-${name}`}>{label}</FieldLabel>
          <Input
            autoComplete="off"
            placeholder={options.placeholder}
            {...field}
            id={`storage-${name}`}
            aria-invalid={fieldState.invalid}
            onChange={(e) => {
              resetTest();
              field.onChange(e);
            }}
          />
          {options.description && (
            <FieldDescription>{options.description}</FieldDescription>
          )}
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup>
        {text("endpoint", t("endpoint"), {
          placeholder: "https://s3.example.com",
        })}
        <div className="grid gap-4 sm:grid-cols-2">
          {text("bucket", t("bucket"))}
          {text("region", t("region"))}
        </div>
        {text("keyPrefix", t("keyPrefix"), {
          placeholder: "team-a/",
          description: t("keyPrefixDescription"),
        })}
        {text("accessKeyId", t("accessKeyId"))}
        <Controller
          name="secretKey"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="storage-secretKey">
                {t("secretKey")}
              </FieldLabel>
              <PasswordInput
                autoComplete="new-password"
                placeholder={stored ? t("secretKeyEditPlaceholder") : undefined}
                {...field}
                id="storage-secretKey"
                aria-invalid={fieldState.invalid}
                onChange={(e) => {
                  resetTest();
                  field.onChange(e);
                }}
              />
              {stored && (
                <FieldDescription>
                  {locationChanged
                    ? t("secretKeyRequiredHint")
                    : t("secretKeyKeepHint")}
                </FieldDescription>
              )}
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          name="forcePathStyle"
          control={form.control}
          render={({ field }) => (
            <Field
              orientation="horizontal"
              className="items-center justify-between gap-4"
            >
              <FieldContent>
                <FieldLabel htmlFor="storage-forcePathStyle">
                  {t("forcePathStyle")}
                </FieldLabel>
                <FieldDescription>
                  {t("forcePathStyleDescription")}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="storage-forcePathStyle"
                checked={field.value}
                onCheckedChange={(v) => {
                  resetTest();
                  field.onChange(v);
                }}
              />
            </Field>
          )}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onTest()}
            disabled={testState.kind === "testing" || loading}
          >
            {testState.kind === "testing" && (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            )}
            {t("testConnection")}
          </Button>
          <TestStatus state={testState} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          {stored && <RemoveStorage environmentId={environmentId} />}
          <Button type="submit" disabled={loading}>
            {loading
              ? t("submitting")
              : stored
                ? t("saveChanges")
                : t("create")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function TestStatus({ state }: { state: TestState }) {
  const t = useTranslations("s3Form");
  if (state.kind === "idle" || state.kind === "testing") return null;
  if (state.kind === "ok") {
    return (
      <span
        aria-live="polite"
        className="inline-flex items-center gap-1 text-sm text-success"
      >
        <CheckCircle2 className="size-4" />
        {t("testSuccess")}
      </span>
    );
  }
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1 break-all text-sm text-destructive"
    >
      <XCircle className="size-4 shrink-0" />
      <span>
        {t("testFailed")}: {state.message}
      </span>
    </span>
  );
}
